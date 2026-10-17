/**
 * Container supervisor.
 *
 * Loads the electron shim, hands control to the compiled upstream entry point
 * (which registers the IPC handlers and starts the proxy), then starts the front
 * server that owns the single public port.
 *
 * WHY EVERYTHING IS IN ONE PROCESS
 * ---------------------------------
 * The shim records upstream's ipcMain.handle registrations, and the front server
 * dispatches the browser's IPC calls into that registry. A separate process could
 * not see it, so the front server is required here rather than spawned.
 *
 * WHY THIS WAITS FOR THE CAPTURE
 * ------------------------------
 * The proxy is configured for the same port as the front server; the shim
 * intercepts that bind so it is never really taken. That only works while the
 * first bind on that port is the proxy's.
 *
 * An earlier version started the front server after a fixed 1.5s delay. If the
 * proxy had not reached its listen() by then, the front server's own bind became
 * the intercepted one - so the front server reported itself up without ever
 * binding, and the container served nothing.
 *
 * Waiting for the captured handler removes that race entirely.
 */

'use strict'

const path = require('path')
const fs = require('fs')

function envBool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase())
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const APP_DIR = process.env.CHAT2API_APP_DIR || '/app'
const GATEWAY_ENTRY = process.env.CHAT2API_BUNDLE
  || path.join(APP_DIR, 'upstream', 'main', 'headless.js')
const SHIM_PATH = process.env.CHAT2API_SHIM
  || path.join(APP_DIR, 'shim', 'electron-shim.js')
const FRONT_ENTRY = path.join(APP_DIR, 'webui', 'server.js')

const ENABLE_FRONT = envBool('CHAT2API_ENABLE_WEBUI', true)
const CAPTURE_TIMEOUT_MS = parseInt(process.env.CHAT2API_CAPTURE_TIMEOUT_MS || '20000', 10)

let shuttingDown = false

function shutdown(reason, exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[supervisor] shutting down (${reason})`)
  setTimeout(() => process.exit(exitCode == null ? 0 : exitCode), 4000).unref()
}

/* ------------------------------------------------------------------ */
/* Install the shim before anything loads the gateway bundle.          */
/* Every require('electron') - including inside Rollup's shared chunks */
/* - resolves to our implementation rather than the real package.      */
/* ------------------------------------------------------------------ */
const Module = require('module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return originalLoad.call(this, SHIM_PATH, parent, isMain)
  }
  return originalLoad.call(this, request, parent, isMain)
}

const shim = require(SHIM_PATH)
if (!shim.__isShim) {
  console.error('[gateway] FATAL: electron shim failed to load from', SHIM_PATH)
  process.exit(1)
}
console.log('[gateway] electron shim active')

function captured() {
  try {
    return typeof shim.__httpHandler === 'function' && shim.__httpHandler() !== null
  } catch {
    return false
  }
}

// Starts the store, reconciles config, registers IPC handlers and starts the
// proxy. See shim/headless-entry.ts.
require(GATEWAY_ENTRY)

/* ------------------------------------------------------------------ */
/* Front server - one public port for the UI and the API              */
/* ------------------------------------------------------------------ */
async function startFrontServer() {
  if (!ENABLE_FRONT) {
    console.log('[supervisor] front server disabled (CHAT2API_ENABLE_WEBUI=false)')
    return
  }
  if (!fs.existsSync(FRONT_ENTRY)) {
    console.error('[supervisor] front server not found at', FRONT_ENTRY, '- continuing without a UI')
    return
  }

  const deadline = Date.now() + CAPTURE_TIMEOUT_MS
  while (Date.now() < deadline && !shuttingDown) {
    if (captured()) {
      console.log('[supervisor] proxy handler captured; starting the front server')
      break
    }
    await sleep(200)
  }

  if (!captured()) {
    // Start it anyway: the UI can then explain the failure, and the healthcheck
    // failing makes the problem visible instead of silent.
    console.error('[supervisor] no proxy handler captured within '
      + `${CAPTURE_TIMEOUT_MS}ms - the proxy did not start. Starting the front server anyway; `
      + 'API requests will answer 503. Check the log above for the cause.')
  }
  if (shuttingDown) return

  try {
    require(FRONT_ENTRY).start()
  } catch (err) {
    console.error('[supervisor] failed to start the front server:',
      err && err.stack ? err.stack : err)
  }
}

void startFrontServer()

process.on('SIGTERM', () => shutdown('SIGTERM', 0))
process.on('SIGINT', () => shutdown('SIGINT', 0))
process.on('uncaughtException', (err) => {
  console.error('[supervisor] uncaught exception:', err && err.stack ? err.stack : err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[supervisor] unhandled rejection:', reason)
})
