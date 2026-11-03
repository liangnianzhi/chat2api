/**
 * Structured self-check behind GET /health.
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * webui/server.js already dispatches /health to upstream's Koa app, which answers
 * a flat {"status":"running","uptime":N,"statistics":{...}}. That is enough for a
 * liveness probe but answers none of the questions an operator actually has after
 * a restart: which upstream build is this, can the data volume be written, are any
 * accounts broken, when did the last health sweep run.
 *
 * This module answers those, and nothing else. It never mutates state, never
 * blocks and never throws - a health endpoint that can throw is worse than none.
 *
 * RETURNING 503
 * -------------
 * The Docker HEALTHCHECK and any external monitor key off the exit status, so the
 * response must be a real success/failure signal rather than a JSON body that
 * always says "fine". 503 is returned only for conditions that make the gateway
 * unable to do its job (proxy not running, data volume not writable). Warnings -
 * no accounts, every account broken, account checks disabled - degrade the body
 * but keep the container healthy: restarting would not fix any of them, and a
 * restart loop would only hide the real cause.
 *
 * SOURCES OF TRUTH
 * ----------------
 *   upstream   /app/UPSTREAM_INFO, written by the build (never guessed at runtime)
 *   store      the data directory, probed with a real write
 *   accounts   globalThis.__chat2apiSelfHeal.snapshot(), published by the optional
 *              account-health module; absent that, the count comes from the account
 *              list that shim/gateway.js snapshots in the background (one read a
 *              minute, not one per probe - a probe must not load the request path
 *              in order to answer), and per-account state is then unknown
 *
 * The self-heal module is optional on purpose: this file must ship and work even
 * when it is not installed.
 */

'use strict'

const fs = require('fs')
const path = require('path')

const APP_DIR = process.env.CHAT2API_APP_DIR || path.join(__dirname, '..')
const UPSTREAM_INFO_FILE = process.env.CHAT2API_UPSTREAM_INFO
  || path.join(APP_DIR, 'UPSTREAM_INFO')
const DATA_DIR = process.env.CHAT2API_HOME
  || path.join(process.env.HOME || '/data', '.chat2api')
const PROBE_FILE = path.join(DATA_DIR, '.health-probe')
const APP_VERSION = process.env.CHAT2API_VERSION || '0.0.0-container'

// Hard ceiling for one /health report; see collect().
const DEFAULT_BUDGET_MS = Number(process.env.CHAT2API_HEALTH_BUDGET_MS || 1500)
const STARTED_AT = Date.now()

/* ------------------------------------------------------------------ *
 * Small helpers - each one swallows its own failure
 * ------------------------------------------------------------------ */
function readText(file, limit) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return limit && raw.length > limit ? raw.slice(0, limit) : raw
  } catch {
    return null
  }
}

/** Parse the key=value file the build writes. Unknown keys are kept. */
function parseUpstreamInfo(text) {
  const out = {}
  if (!text) return out
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i <= 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/**
 * Prove the data volume can be written, not merely reached.
 *
 * A read-only check would pass on a volume where the app fails at its first
 * write, which is exactly the failure the entrypoint's chown exists to prevent.
 * The probe file is removed again; a leftover is harmless (it is overwritten).
 */
function probeStore() {
  const result = {
    dir: DATA_DIR,
    readable: false,
    writable: false,
    freeMB: null,
    error: null,
  }

  try {
    fs.accessSync(DATA_DIR, fs.constants.R_OK)
    result.readable = true
  } catch (err) {
    result.error = 'not readable: ' + (err && err.message ? err.message : String(err))
    return result
  }

  try {
    fs.writeFileSync(PROBE_FILE, String(Date.now()), { mode: 0o600 })
    fs.unlinkSync(PROBE_FILE)
    result.writable = true
  } catch (err) {
    result.error = 'not writable: ' + (err && err.message ? err.message : String(err))
  }

  // statfs answers the "disk full / quota gone" case a write can still succeed at
  // (small file, no room for the next account). Optional: Node 18.15+.
  try {
    const st = fs.statfsSync(DATA_DIR)
    result.freeMB = Math.round((st.bsize * st.bavail) / 1048576)
  } catch {
    /* the write probe above is the real check */
  }

  return result
}

function memoryMB() {
  try {
    const m = process.memoryUsage()
    return {
      rss: Math.round(m.rss / 1048576),
      heapUsed: Math.round(m.heapUsed / 1048576),
      heapTotal: Math.round(m.heapTotal / 1048576),
    }
  } catch {
    return null
  }
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/* ------------------------------------------------------------------ *
 * Account state
 *
 * Preferred source: the account-health module's synchronous snapshot. It is
 * deliberately called without await - a health check must not queue behind
 * whatever the sweeper is doing.
 * ------------------------------------------------------------------ */
function selfHealSnapshot() {
  try {
    const hook = globalThis.__chat2apiSelfHeal
    if (!hook || typeof hook.snapshot !== 'function') return null
    const snap = hook.snapshot()
    return snap && typeof snap === 'object' ? snap : null
  } catch {
    return null
  }
}

/**
 * Fallback: the account list that gateway.js refreshes in the background.
 *
 * Only the count is used. Upstream keeps the provider-specific status field
 * inside an opaque account object whose shape differs per provider, and guessing
 * at it here would report numbers that are wrong in exactly the case that
 * matters (a broken account). "unknown" is honest; a fabricated 0 is not.
 */
function accountsFromCache(ctx) {
  const empty = { total: null, active: null, error: null, source: 'unavailable' }
  try {
    if (!ctx || typeof ctx.listAccounts !== 'function') return empty
    const all = ctx.listAccounts()
    if (!Array.isArray(all)) return empty
    return { total: all.length, active: null, error: null, source: 'account-list-count-only' }
  } catch {
    return empty
  }
}

/**
 * A sweep that has never run, or a config that switched the sweeper off, means
 * upstream will keep handing out accounts that are already known to be broken.
 * Kept deliberately loose: a fresh container has not swept yet, so only an
 * explicit off-switch counts as a warning.
 */
function sweepActive(snap) {
  const cfg = snap && snap.config && typeof snap.config === "object" ? snap.config : null
  if (cfg && cfg.enabled === false) return false
  if (snap && snap.sweep && typeof snap.sweep === "object") {
    if (snap.sweep.scheduled === false && snap.sweep.inFlight !== true) return false
    if ((snap.sweep.sweepCount || 0) > 0) return true
  }
  if (snap && snap.lastSweepAt) return true
  // Container just started and nothing has run yet: not proof of a problem.
  return true
}

/*
 * Account records get set to error state by default when an account is parked,
 * which is visible on the management page and is NOT a malfunction - it is the
 * record of a decision. Deployments that would rather keep the record clean can
 * switch it off; say so once, with the exact variable name.
 */
/*
 * selfheal publishes a tiny stable read surface (info()) next to snapshot().
 * info() is what tells 'not installed' apart from 'installed but switched off',
 * and it stays small even when the account cache is huge. snapshot() is still
 * used for the account numbers; info() only decides which warning to raise.
 */
function selfHealInfo(hook) {
  try {
    if (!hook || typeof hook.info !== 'function') return null
    const i = hook.info()
    return i && typeof i === 'object' ? i : null
  } catch {
    return null
  }
}
function autoStatusWarn(enabled) {
  const v = String(process.env.CHAT2API_SELFHEAL_AUTO_STATUS === undefined ? "1" : process.env.CHAT2API_SELFHEAL_AUTO_STATUS).trim().toLowerCase()
  const on = !(v === "0" || v === "false" || v === "no" || v === "off")
  if (!enabled) return null
  if (!on) return null
  return "被冷却的账号在管理页会显示 error（CHAT2API_SELFHEAL_AUTO_STATUS=0 可改为只冷却不改记录）"
}

/*
 * Proxy status without await.
 *
 * Order matters: the self-heal layer keeps a reference to the proxy status
 * manager, which is the same object the UI reads, so the probe and the page
 * cannot disagree. Only when that is unavailable does the IPC channel get a
 * chance, and only a synchronously settled answer counts.
 */
async function readProxyStatusAsync(ctx) {
  return readProxyStatus(ctx)
}

function readProxyStatus(ctx) {
  // The account-health layer already holds upstream's ProxyStatusManager (its graph
  // probe found it) and publishes a synchronous reader, so prefer it: same source as
  // the UI, no promise, and it cannot block the probe.
  const hook = globalThis.__chat2apiSelfHeal
  try {
    if (hook && typeof hook.proxyStatus === 'function') {
      const v = normaliseProxyStatus(hook.proxyStatus())
      if (v) return v
    }
  } catch {
    /* fall through to the IPC channel */
  }
  try {
    if (ctx && typeof ctx.proxyStatus === 'function') {
      const v = normaliseProxyStatus(ctx.proxyStatus())
      if (v) return v
    }
  } catch {
    return null
  }
  return null
}

/*
 * Two shapes have to read the same way: upstream's own status object ({status:
 * 'running'}) and the health hook's ({running: true}). Neither is wrong, and a probe
 * that only understands one of them reports 'unknown' forever - which is exactly the
 * bug that made every container look unhealthy.
 *
 * Always answers with {running: boolean, status: string, port, ...}, or null when
 * nothing usable came back. A manager object (with getRunningStatus) is also accepted,
 * since that is what the manager itself exposes.
 */
function normaliseProxyStatus(raw) {
  let v = raw
  if (v && typeof v.getStatus === 'function') {
    try {
      v = v.getStatus()
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object') return null
  let running
  if (typeof v.running === 'boolean') running = v.running
  else if (typeof v.status === 'string') running = v.status === 'running'
  else return null
  return Object.assign({}, v, {
    running,
    status: typeof v.status === 'string' ? v.status : running ? 'running' : 'stopped'
  })
}

/* ------------------------------------------------------------------ *
 * Probe
 * ------------------------------------------------------------------ */
async function collectReport(ctx, partial) {
  const report = partial || {}
  const warnings = []
  const checks = []

  const info = parseUpstreamInfo(readText(UPSTREAM_INFO_FILE, 64 * 1024))
  const upstream = {
    version: info.VERSION || null,
    ref: info.REF || null,
    fetchedAt: info.FETCHED_AT || null,
    // Written by the image build; null when the image came from elsewhere.
    imageBuiltAt: info.BUILT_AT || null,
    appVersion: APP_VERSION,
  }
  if (!upstream.version) {
    warnings.push('UPSTREAM_INFO is missing or has no VERSION - this image was not built by the standard Dockerfile')
  }

  // Recorded before use, so a budget cut mid-report still has the store verdict.
  const store = probeStore()
  report.store = store
  checks.push({ name: 'store', ok: store.readable && store.writable, detail: store.error })
  if (!store.readable) warnings.push('data volume is not readable: ' + store.dir)
  else if (!store.writable) warnings.push('data volume is not writable - accounts and config cannot be saved: ' + store.dir)
  else if (store.freeMB !== null && store.freeMB < 100) warnings.push('data volume has only ' + store.freeMB + ' MB free')

  // Upstream's own liveness signal. The account-health layer already holds the
  // proxy status manager (its graph probe found it), so prefer that: it is a plain
  // synchronous read. The IPC channel is the fallback, and it is only consulted
  // when it can answer without a promise - upstream registers most of these as
  // async, and 'proxy: unknown' would make every container look failing.
  const proxyStatus = readProxyStatus(ctx)
  report.proxyStatus = proxyStatus
  // A probe that cannot read the state must not claim the service is down: a failing
  // check there would make Docker restart a container that is serving fine. Only a
  // readable 'not running' fails; not readable is a warning and the report degrades.
  const proxyKnown = !!proxyStatus
  const running = !!(proxyStatus && proxyStatus.running)
  checks.push({
    name: 'proxy',
    ok: running || !proxyKnown,
    known: proxyKnown,
    detail: proxyKnown ? proxyStatus.status : 'unknown',
  })
  if (!proxyKnown) {
    warnings.push('proxy status is not readable from this build - the probe cannot tell whether the service is serving')
  } else if (!running) {
    warnings.push('proxy is not running (' + proxyStatus.status + ') - the service is not serving yet')
  }
  // Report the port actually advertised, not the one the process binds: a
  // mismatch here is what makes a browser talk to the wrong place behind NAT.
  const port = proxyStatus && Number.isFinite(proxyStatus.port)
    ? proxyStatus.port
    : Number(process.env.CHAT2API_PORT || 8082)


  const snap = selfHealSnapshot()
  report.snapshot = snap
  let accounts
  let lastSweepAt = null
  let sweep = null
  if (snap && snap.accounts && typeof snap.accounts === 'object') {
    accounts = {
      total: numOrNull(snap.accounts.total),
      active: numOrNull(snap.accounts.active),
      error: numOrNull(snap.accounts.error),
      inactive: numOrNull(snap.accounts.inactive),
      cooling: numOrNull(snap.accounts.cooling),
      source: 'selfheal',
    }
    lastSweepAt = numOrNull(snap.lastSweepAt)
    sweep = snap.sweep && typeof snap.sweep === 'object' ? snap.sweep : null
  } else {
    accounts = accountsFromCache(ctx)
  }

  if (accounts.total === 0) {
    warnings.push('no accounts configured - open the web UI at / to add one')
  } else if (accounts.total !== null && accounts.error !== null && accounts.error >= accounts.total) {
    warnings.push('every account is in error state - check credentials')
  }
  // Two facts a headless/Docker deployment must surface: there is no provider
  // health checker of its own here, and nothing repairs a broken account without
  // the self-heal layer. Restarting the container does not change either.
  const healInfo = snap === null ? null : selfHealInfo(globalThis.__chat2apiSelfHeal)
  const healEnabled = healInfo && typeof healInfo.enabled === 'boolean'
    ? healInfo.enabled
    : !(snap && snap.config && typeof snap.config === 'object' && snap.config.enabled === false)
  if (!healEnabled) {
    warnings.push('self-heal is disabled (CHAT2API_SELFHEAL=0): broken accounts will not be parked automatically')
  }
  if (snap === null) {
    warnings.push('self-heal is not installed: broken accounts are only detected on request, not in the background')
  } else if (snap.installed && Array.isArray(snap.installed.missing) && snap.installed.missing.length) {
    warnings.push('self-heal is installed but could not attach to: ' + snap.installed.missing.join(', '))
  }
  if (snap === null && accounts.total !== null && accounts.total > 0) {
    warnings.push('autoCheckAccounts state is unknown in this build (no account-health hook) - check Data & Account settings')
  } else if (snap !== null && !sweepActive(snap)) {
    warnings.push('autoCheckAccounts looks off (no health sweep has run): bad accounts will stay in the pool')
  }
  const autoStatus = autoStatusWarn(healEnabled)
  if (autoStatus) warnings.push(autoStatus)
  if (upstream.ref && upstream.ref !== 'main') {
    // Expected, not a problem: the Dockerfile pins a commit (see UPSTREAM.lock) so
    // a rebuild cannot silently pick up upstream changes. Reported for traceability.
    warnings.push('upstream ref is pinned to "' + upstream.ref + '" (lock file), not branch main')
  }

  const ok = checks.every((c) => c.ok)

  return {
    status: ok ? (running ? 'running' : 'degraded') : 'failing',
    ok,
    // Shape kept compatible with upstream's /health, so probes that grep for
    // "status":"running" or read statistics keep working.
    upstream,
    store,
    accounts,
    lastSweepAt,
    sweep,
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
    memoryMB: memoryMB(),
    port,
    statistics: proxyStatus && proxyStatus.statistics ? proxyStatus.statistics : null,
    checks,
    warnings,
    at: new Date().toISOString(),
  }
}

/*
 * The public probe: collect the report, but never let it hang.
 *
 * Every reader here is meant to be synchronous, so the only way this grows a
 * wait is something unexpected holding a promise. A health check that blocks the
 * HTTP server is worse than one that admits it could not check in time, so a
 * budget covers the whole report and a degraded answer goes out instead.
 */
async function collect(ctx, budgetMs, partial) {
  const limit = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : DEFAULT_BUDGET_MS
  let timer = null
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), limit)
  })
  try {
    return await Promise.race([collectReport(ctx, partial), budget])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Serialise with a hard time budget.
 *
 * The IPC fallback goes through upstream's store, which is fast when healthy but
 * can stall. A health endpoint that hangs makes the container look dead; one that
 * answers "degraded, accounts unknown" does not.
 */
async function buildReport(ctx, budgetMs) {
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : DEFAULT_BUDGET_MS
  // Probe results land here as they are produced, so a report that runs past the
  // budget can still answer with everything that was already collected instead of
  // pretending nothing is known. NOT a fallback body: the caller gets real data.
  const partial = {}
  let timer = null
  const expired = new Promise((resolve) => {
    // Deliberately NOT unref'd: a pending only-timeout handle is the sole thing
    // keeping this call alive, and unref'ing it outvoted the timer itself.
    timer = setTimeout(() => {
      partial.budgetExceeded = true
      resolve(null)
    }, budget)
  })
  let report = null
  try {
    report = await Promise.race([collect(ctx, budget, partial), expired])
  } catch (err) {
    report = null
    partial.error = err && err.message ? err.message : String(err)
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!report) return partialReport(partial, budget)
  // A report completed exactly as the budget ran out: still flag it, the caller
  // deserves to know the probe was on the edge.
  if (partial.budgetExceeded) report.budgetExceeded = true
  return report
}
/*
 * The report when the budget ran out before collection finished.
 *
 * Everything the partial collector recorded is kept - a store verdict and a proxy
 * state are exactly what a probe needs, and withholding them because the account
 * list was slow would be the worst of both worlds. status is 'degraded' (HTTP 200):
 * slow is not broken, and a 503 here makes Docker restart a working service.
 */
function partialReport(partial, budgetMs) {
  const store = partial.store || null
  const proxyStatus = partial.proxyStatus || null
  const snap = partial.snapshot || null
  const warnings = []
  if (!partial.budgetExceeded) {
    warnings.push('self-check could not finish: ' + (partial.error || 'unknown error'))
  } else {
    warnings.push('self-check did not finish within ' + budgetMs + ' ms - partial report')
  }
  // Only a hard stop is re-checked here: reading the data volume is a single
  // syscall pair and is what decides 503 below.
  let storeNow = store
  if (!storeNow) {
    try {
      storeNow = probeStore()
    } catch {
      storeNow = { dir: null, readable: false, writable: false, freeMB: null, error: 'probe failed' }
    }
  }
  if (!storeNow.readable) {
    warnings.push('data volume is not readable: ' + storeNow.dir)
  } else if (!storeNow.writable) {
    warnings.push('data volume is not writable - accounts and config cannot be saved: ' + storeNow.dir)
  }
  return {
    status: 'degraded',
    ok: false,
    budgetExceeded: true,
    upstream: parseUpstreamInfo(readText(UPSTREAM_INFO_FILE, 64 * 1024)),
    store: storeNow,
    accounts: { total: null, active: null, error: null, source: 'timeout' },
    lastSweepAt: snap ? numOrNull(snap.lastSweepAt) : null,
    sweep: snap && snap.sweep ? snap.sweep : null,
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
    memoryMB: memoryMB(),
    proxyStatus: proxyStatus || null,
    checks: [
      { name: 'store', ok: !!(storeNow.readable && storeNow.writable), detail: storeNow.error },
      { name: 'proxy', ok: !proxyStatus || !!proxyStatus.running, known: !!proxyStatus, detail: proxyStatus ? proxyStatus.status : 'unknown' },
    ],
    warnings,
    at: new Date().toISOString(),
  }
}


module.exports = {
  buildReport,
  probeStore,
  parseUpstreamInfo,
  memoryMB,
  startedAt: STARTED_AT,
}
