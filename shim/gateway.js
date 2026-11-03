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
const upstreamExports = require(GATEWAY_ENTRY)

/* ------------------------------------------------------------------ */
/* Account self-heal - see shim/selfheal/                             */
/*                                                                    */
/* Installed after the bundle so the classes it patches exist, and    */
/* before the front server so no request is ever served unguarded.    */
/* Every failure here is logged and swallowed: a broken self-heal must */
/* never take the proxy down with it.                                 */
/* ------------------------------------------------------------------ */
const SELFHEAL_ENTRY = path.join(APP_DIR, 'shim', 'selfheal.js')
function installSelfHeal() {
  try {
    if (!fs.existsSync(SELFHEAL_ENTRY)) {
      console.log('[supervisor] self-heal layer not found at', SELFHEAL_ENTRY, '- continuing without it')
      return
    }
    const selfheal = require(SELFHEAL_ENTRY)
    const config = selfheal.resolveConfig()
    if (!config.enabled) {
      console.log('[supervisor] account self-heal disabled by CHAT2API_SELFHEAL')
      return
    }
    selfheal.install({ graph: upstreamExports })
    // The store is initialised synchronously by the bundle above, so the
    // sweep can start immediately; it validates accounts through the same
    // AccountManager the request path uses.
    selfheal.start()

    process.on('SIGTERM', () => selfheal.stop())
    process.on('SIGINT', () => selfheal.stop())
  } catch (err) {
    console.error('[supervisor] account self-heal failed to install:',
      err && err.stack ? err.stack : err)
  }
}
installSelfHeal()

/* ------------------------------------------------------------------ */
/* Request-log observability - see shim/observability/                 */
/*                                                                    */
/* Installed right after the bundle and right after self-heal, so the  */
/* request-log store is wrapped before its first row is written and the */
/* classification can consult self-heal's verdict as a tie-breaker.    */
/* It only RECORDS: account cooling stays self-heal's business.        */
/* Failures are logged and swallowed - observability must never be     */
/* able to take the proxy down.                                        */
/* ------------------------------------------------------------------ */
const OBSERVABILITY_ENTRY = path.join(APP_DIR, 'shim', 'observability')
function installObservability() {
  try {
    if (!fs.existsSync(OBSERVABILITY_ENTRY)) {
      console.log('[supervisor] observability not found at', OBSERVABILITY_ENTRY, '- continuing without it')
      return null
    }
    const observability = require(OBSERVABILITY_ENTRY)
    // Tell the discovery ladder where the bundle's chunks live. The bundle we
    // hold is only the headless bootstrap (it exports nothing), and the log
    // store's class lives in a hashed chunk next to main/index.js - so the
    // directory is passed in rather than guessed from a hard-coded file name.
    const modulesDir = path.join(path.dirname(GATEWAY_ENTRY))
    const result = observability.install({ graph: upstreamExports, modulesDir })
    // The bundle may not have built its request-log store yet when we get
    // here. An install that wrapped nothing reports active:false, and one
    // late retry after the front server is up is what catches that case -
    // after that we stop, so nothing can keep re-wrapping.
    if (result && result.active === false) {
      setTimeout(() => {
        try {
          observability.install({ graph: upstreamExports, modulesDir })
        } catch (err) {
          console.error('[supervisor] observability retry failed:', err && err.message)
        }
      }, 15000).unref()
    }
    return result
  } catch (err) {
    console.error('[supervisor] observability failed to install:',
      err && err.stack ? err.stack : err)
    return null
  }
}
installObservability()

/* ------------------------------------------------------------------ */
/* Startup self-check - what this process is, and what will bite      */
/*                                                                    */
/* Printed once, on one line per fact, right before the front server  */
/* starts: the operator reading a NAS log should not have to grep the */
/* build in order to learn which upstream it runs, and a silently    */
/* disabled check or a missing secret is worth saying out loud.      */
/* Everything here is best-effort: a self-check that can fail the     */
/* process is worse than none, so each step is guarded.              */
/* ------------------------------------------------------------------ */
const ACCOUNT_SNAPSHOT_TTL_MS = 60 * 1000
const ACCOUNT_CHANNEL = 'accounts:getAll'

/**
 * Publish the account list for /health: shim/health.js reads the global and
 * never awaits it, so the probe cannot end up queued behind the store.
 *
 * The list is read through the same IPC channel the UI uses rather than from an
 * upstream class: that channel is the only account access this process is
 * guaranteed to have, whatever the bundle decides to export.
 */
function refreshAccountSnapshot() {
  try {
    const entry = shim.__ipcHandlers && shim.__ipcHandlers.get(ACCOUNT_CHANNEL)
    const handler = entry && (typeof entry === 'function' ? entry : entry.handler)
    if (typeof handler !== 'function') return
    Promise.resolve()
      .then(() => handler({ sender: null, senderFrame: null }, false))
      .then((list) => {
        if (Array.isArray(list)) globalThis.__chat2apiAccounts = list
      })
      .catch(() => { /* /health reports "unknown" instead of a fabricated 0 */ })
  } catch {
    /* same */
  }
}

function readUpstreamInfo() {
  try {
    const text = fs.readFileSync(path.join(APP_DIR, 'UPSTREAM_INFO'), 'utf8')
    const out = {}
    for (const line of text.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    return out
  } catch {
    return null
  }
}

function logStartupSelfCheck() {
  const warnings = []
  try {
    const info = readUpstreamInfo()
    if (info) {
      console.log('[startup] UPSTREAM_INFO: version=' + (info.VERSION || 'unknown')
        + ' ref=' + (info.REF || 'unknown')
        + ' fetchedAt=' + (info.FETCHED_AT || 'unknown')
        + (info.BUILT_AT ? ' builtAt=' + info.BUILT_AT : ''))
    } else {
      warnings.push('UPSTREAM_INFO is missing - this image was not built by the standard Dockerfile')
    }
  } catch (err) {
    warnings.push('could not read UPSTREAM_INFO: ' + (err && err.message))
  }

  // Accounts: the cached count, or "unknown" - never a fabricated 0.
  // Read once here as well, so the first log line already carries the numbers
  // instead of "unknown"; the periodic refresh only keeps it current.
  try {
    const list = globalThis.__chat2apiAccounts
    if (Array.isArray(list)) {
      const bad = list.filter((a) => a && (a.status === 'error' || a.status === 'expired')).length
      console.log('[startup] accounts: ' + list.length + ' total, ' + bad + ' in error/expired state')
      if (list.length === 0) warnings.push('no accounts are configured - open / to add one')
      if (list.length > 0 && bad === list.length) warnings.push('every account is in error/expired state - check credentials')
    } else {
      console.log('[startup] accounts: unknown at this moment (/health will report it once ' +
        'the account list has been read)')
    }
  } catch (err) {
    warnings.push('could not summarise accounts: ' + (err && err.message))
  }

  // Critical configuration that is off, and what turning it off costs.
  try {
    const selfheal = globalThis.__chat2apiSelfHeal
    const snap = selfheal && typeof selfheal.snapshot === 'function' ? selfheal.snapshot() : null
    if (snap && snap.config && snap.config.enabled === false) {
      warnings.push('account health checks are OFF (CHAT2API_SELFHEAL=0): dead accounts are ' +
        'no longer parked or repaired; requests will keep failing against them')
    } else if (!snap) {
      warnings.push('account self-heal is not installed: dead accounts are not parked automatically')
    } else if (snap.installed && Array.isArray(snap.installed.missing) && snap.installed.missing.length) {
      warnings.push('account self-heal is partially installed, missing: ' + snap.installed.missing.join(', '))
    }
  } catch (err) {
    warnings.push('could not read self-heal state: ' + (err && err.message))
  }

  try {
    const secret = process.env.CHAT2API_MANAGEMENT_SECRET
    const secretFile = path.join(process.env.CHAT2API_HOME || '/data/.chat2api',
      '.management-secret')
    if (!secret && !fs.existsSync(secretFile)) {
      warnings.push('no management secret yet: it is generated on first use (stored in ' +
        'CHAT2API_HOME/.management-secret); API clients need it as a Bearer token')
    }
    if (String(process.env.CHAT2API_REQUIRE_AUTH || '').toLowerCase() === 'false') {
      warnings.push('CHAT2API_REQUIRE_AUTH=false - the port is open to anyone who can reach it')
    }
  } catch { /* best effort */ }

  for (const w of warnings) console.warn('[startup] WARNING: ' + w)
  console.log('[startup] self-check done: ' + warnings.length + ' warning(s)')
}

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

  // Prime the account snapshot first (it resolves out of band), so the startup
  // self-check below normally has numbers to print; the periodic refresh then
  // keeps it current for /health.
  refreshAccountSnapshot()
  const accountTimer = setInterval(refreshAccountSnapshot, ACCOUNT_SNAPSHOT_TTL_MS)

  try {
    logStartupSelfCheck()
  } catch (err) {
    console.warn('[startup] self-check failed to run:', err && err.message)
  }
  accountTimer.unref()

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
