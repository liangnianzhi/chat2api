/**
 * Container supervisor.
 *
 * Runs the Chat2API gateway and the single front server that exposes it.
 *
 * WHY A SUPERVISOR RATHER THAN TWO CONTAINERS
 * -------------------------------------------
 * The front server owns the one public port: it serves the console at / and
 * proxies everything else to the gateway, which listens on loopback only. That
 * gives the container a single address for both the UI and the API, matching how
 * the desktop app presented them.
 *
 * Design notes:
 *   * The gateway is the primary process: if it exits, the container exits.
 *   * The front server is best-effort: if it fails to start, the gateway keeps
 *     serving API traffic and the failure is logged loudly.
 *   * Both are terminated together on SIGTERM so upstream's log flush runs.
 */

'use strict'

const { spawn } = require('child_process')
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

const children = []
let shuttingDown = false

function start(name, args) {
  const child = spawn(process.execPath, args, {
    env: process.env,
    stdio: 'inherit',
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`[supervisor] ${name} exited (code=${code} signal=${signal})`)
    if (name === 'gateway') {
      // The gateway is the reason this container exists.
      shutdown('gateway-exit', code == null ? 1 : code)
    }
  })
  child.on('error', (err) => {
    console.error(`[supervisor] failed to start ${name}:`, err.message)
    if (name === 'gateway') shutdown('gateway-spawn-error', 1)
  })
  children.push({ name, child })
  return child
}

function shutdown(reason, exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[supervisor] shutting down (${reason})`)
  for (const { name, child } of children) {
    if (child.exitCode === null && !child.killed) {
      console.log(`[supervisor] sending SIGTERM to ${name}`)
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }
  }
  // Give children a moment to flush, then exit.
  setTimeout(() => process.exit(exitCode == null ? 0 : exitCode), 4000).unref()
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */
// Install the shim *before* loading the gateway bundle, so every
// require('electron') - including inside Rollup's shared chunks - resolves to
// our implementation instead of the real Electron package.
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

// Hand control to the compiled upstream entry point, which starts the proxy.
require(GATEWAY_ENTRY)

/* ------------------------------------------------------------------ */
/* Front server                                                        */
/* ------------------------------------------------------------------ */
if (ENABLE_FRONT) {
  if (fs.existsSync(FRONT_ENTRY)) {
    const publicPort = process.env.CHAT2API_PORT || '8080'
    const internalPort = process.env.CHAT2API_INTERNAL_PORT || '18080'
    if (publicPort === internalPort) {
      console.error('[supervisor] CHAT2API_PORT equals CHAT2API_INTERNAL_PORT - '
        + 'the front server and the gateway would fight for the same port.')
    } else {
      setTimeout(() => {
        if (!shuttingDown) start('front', [FRONT_ENTRY])
      }, 1500) // let the gateway bind first so the proxy has a target
    }
  } else {
    console.error('[supervisor] front server entry not found at', FRONT_ENTRY,
      '- continuing without a UI')
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
