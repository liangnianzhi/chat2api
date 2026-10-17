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
 * The gateway bundle is the reason the container exists: if it fails, the
 * container exits.
 */

'use strict'

const path = require('path')
const fs = require('fs')

function envBool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase())
}

const APP_DIR = process.env.CHAT2API_APP_DIR || '/app'
const GATEWAY_ENTRY = process.env.CHAT2API_BUNDLE
  || path.join(APP_DIR, 'upstream', 'main', 'headless.js')
const SHIM_PATH = process.env.CHAT2API_SHIM
  || path.join(APP_DIR, 'shim', 'electron-shim.js')
const FRONT_ENTRY = path.join(APP_DIR, 'webui', 'server.js')

const ENABLE_FRONT = envBool('CHAT2API_ENABLE_WEBUI', true)

let shuttingDown = false

function shutdown(reason, exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[supervisor] shutting down (${reason})`)
  // The gateway installs its own SIGTERM handling to flush upstream's buffered
  // log writers; re-raising gives it the chance to run.
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

// Starts the store, reconciles config, registers IPC handlers and starts the
// proxy. See shim/headless-entry.ts.
require(GATEWAY_ENTRY)

/* ------------------------------------------------------------------ */
/* Front server - one public port for the UI and the API              */
/* ------------------------------------------------------------------ */
if (ENABLE_FRONT) {
  if (!fs.existsSync(FRONT_ENTRY)) {
    console.error('[supervisor] front server not found at', FRONT_ENTRY, '- continuing without a UI')
  } else {
    const publicPort = process.env.CHAT2API_PORT || '8080'
    const internalPort = process.env.CHAT2API_INTERNAL_PORT || '18080'
    if (publicPort === internalPort) {
      console.error('[supervisor] CHAT2API_PORT equals CHAT2API_INTERNAL_PORT - '
        + 'the front server and the gateway would fight for the same port.')
    } else {
      setTimeout(() => {
        if (shuttingDown) return
        try {
          require(FRONT_ENTRY).start()
        } catch (err) {
          console.error('[supervisor] failed to start the front server:',
            err && err.stack ? err.stack : err)
        }
      }, 1500) // let the gateway bind first so the proxy has a target
    }
  }
} else {
  console.log('[supervisor] front server disabled (CHAT2API_ENABLE_WEBUI=false)')
}

process.on('SIGTERM', () => shutdown('SIGTERM', 0))
process.on('SIGINT', () => shutdown('SIGINT', 0))
process.on('uncaughtException', (err) => {
  console.error('[supervisor] uncaught exception:', err && err.stack ? err.stack : err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[supervisor] unhandled rejection:', reason)
})
