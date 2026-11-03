/**
 * Observability installation.
 *
 * WHERE IT RUNS
 * -------------
 * shim/gateway.js requires this module right after the upstream bundle is
 * loaded and right before the front server starts:
 *
 *   const upstreamExports = require(GATEWAY_ENTRY)   // the bundle
 *   installSelfHeal(upstreamExports)                 // self-heal's layer
 *   installObservability(upstreamExports)            // <- this file
 *   void startFrontServer()
 *
 * At that moment the bundle's modules exist but no request has been served, so
 * the request-log store already exists and can be wrapped before its first
 * row. That is the only hook in the container that sees both the log and the
 * statistics without patching compiled JavaScript.
 *
 * WHAT IT DOES (idempotent, never fatal)
 * --------------------------------------
 *   1. finds the log store and the statistics provider: the graph we were
 *      handed, or - when that is only the headless bootstrap that exports
 *      nothing - the Rollup chunk next to it, and finally the wired manager
 *      INSTANCE (upstream never exports RequestLogManager as a class, so the
 *      instance is the only reachable handle; its add/update methods are the
 *      write path, which is all we need);
 *   2. wraps the log store's adders so every row carries failureCategory,
 *      failureReason and - when the provider answered - a truncated
 *      providerResponse;
 *   3. backfills already-stored rows, so the failures that motivated this
 *      work appear in the statistics without waiting for new traffic;
 *   4. installs an in-process route hook that adds our aggregates to
 *      GET /v0/management/statistics (existing fields untouched);
 *   5. registers IPC channels so the web UI (and tests) can read the
 *      aggregates directly, without a second port;
 *   6. logs one line per finding, plus a final readiness marker.
 *
 * WHY A ROUTE HOOK AND NOT A NEW ENDPOINT
 * ---------------------------------------
 * smoke.sh asserts the deployment has exactly one published port and that the
 * API is served in-process. A second HTTP listener would violate both, and the
 * upstream API server lives inside the bundle where we cannot add routes.
 * Instead we look for the handler function that serves the API, wrap it once,
 * and answer for /v0/management/statistics ourselves - falling through to the
 * original handler for everything else. If no such handler is reachable, the
 * IPC channels still work and the hook reports why.
 */

'use strict'

const { CATEGORIES } = require('./failure-classify')
const catalog = require('./catalog')
const requestLog = require('./request-log')
const stats = require('./stats')
const { timingSafeEqual } = require('crypto')

/** Log prefix; smoke.sh greps for this shape, keep it stable. */
const TAG = '[observability]'

/** Channel namespace for the IPC surface. */
const IPC_PREFIX = 'c2a:obs:'

/** Channels registered by this module. */
const CHANNELS = {
  info: IPC_PREFIX + 'info',
  requestLogs: IPC_PREFIX + 'request-logs',
  statistics: IPC_PREFIX + 'statistics',
  annotate: IPC_PREFIX + 'annotate',
}

/** A single store of installation state, so a second call is a no-op. */
const state = {
  installed: false,
  ready: false,
  findings: {},
  logStore: null,
  rows: null,
  statisticsProvider: null,
  routeHook: null,
  // True once an install actually wrapped something. A run that found nothing
  // to instrument stays retryable: the gateway may install before the bundle
  // has built its log store, and the late retry is what catches it.
  active: false,
  channels: [],
  errors: [],
  startedAt: null,
  /** Failure category per row id, for rows written by an update-by-id path. */
  writerIndex: new Map(),
  /** True once upstream's live write path has been wrapped (see state.activator). */
  wrappedLive: false,
  /** A deferred manager candidate whose owner had not initialized it yet. */
  pendingManager: null,
  /** Re-runs the wrap; returns true when the write path is live. */
  activator: null,
}

/** Small logger that never throws and honours a quiet flag. */
function makeLog(options) {
  const sink = options && typeof options.log === 'function'
    ? options.log
    : (msg) => { try { console.log(msg) } catch { /* ignore */ } }
  return (msg) => {
    try { sink(TAG + ' ' + msg) } catch { /* ignore */ }
  }
}

function record(err, log) {
  const msg = err && err.message ? err.message : String(err)
  state.errors.push(msg)
  if (state.errors.length > 20) state.errors.shift()
  log('error: ' + msg)
}

/**
 * The discovery ladder, in one place.
 *
 * LEVEL 1  the graph handed to us (gateway's require of the bundle entry);
 * LEVEL 2  that graph is the headless bootstrap (0 exports) -> require the
 *          Rollup chunk upstream/main/chunks/server-*.js, found by glob and
 *          recognised by its exports (never by a hard-coded hash);
 * LEVEL 3  the log store class is module-local, so the class can never be
 *          found - the wired instance (storeManager.requestLogManager) is,
 *          and its methods are what upstream calls to write a row.
 *
 * Every level records what it did in state.findings, so the container log says
 * which of the three worked and why the others did not. Nothing here throws.
 */
function discover(opts, log) {
  const survey = { level: 'none', graphSource: 'graph', logManager: null, stats: [], nodes: 0, scanned: [], skipped: [] }
  if (opts.logStore) {
    survey.level = 'level1'
    survey.logManager = { value: opts.logStore, path: 'options.logStore' }
    return survey
  }
  if (!opts.graph) return survey

  // Level 1: the object the gateway handed us.
  let graph = opts.graph
  let walk = catalog.explore(graph, { maxDepth: opts.maxDepth, maxNodes: opts.maxNodes })
  survey.nodes = walk.visited
  survey.logCandidates = walk.logStores.slice(0, 5).map((c) => ({ path: c.path, score: c.score }))
  survey.stats = walk.statistics
  if (walk.logStores.length) {
    survey.level = 'level1'
    survey.logManager = walk.logStores[0]
    return survey
  }

  // Level 2: the chunk that holds the real classes.
  const resolved = catalog.resolveChunk(graph, {
    modulesDir: opts.modulesDir,
    dir: opts.chunksDir,
    requireModule: opts.requireModule,
    force: true,
    log,
  })
  survey.scanned = resolved.scanned
  survey.skipped = resolved.skipped
  survey.graphSource = resolved.source
  if (resolved.source !== 'graph') {
    graph = resolved.graph
    walk = catalog.explore(graph, { maxDepth: opts.maxDepth, maxNodes: opts.maxNodes })
    survey.nodes += walk.visited
    survey.logCandidates = walk.logStores.slice(0, 5).map((c) => ({ path: c.path, score: c.score }))
    if (walk.statistics.length) survey.stats = walk.statistics
    if (walk.logStores.length) {
      // A winning candidate may be an outer object that merely DECLARES the
      // manager ('storeManager.requestLogManager: null' at boot). Keep the
      // manager's own path in that case, so the write path can be resolved
      // lazily instead of being reported as wrapped and then doing nothing.
      const deferred = catalog.findLogManager(graph)
      if (deferred && deferred.resolve && !deferred.value) {
        survey.level = 'level3'
        survey.logManager = { value: null, path: deferred.path, score: 99, deferred: deferred.deferred, resolve: deferred.resolve }
      } else {
        survey.level = 'level2'
        survey.logManager = walk.logStores[0]
      }
      survey.graph = graph
      return survey
    }
  }
  survey.graph = graph

  // Level 3: the wired instance. It may still be 'declared but null' at boot
  // (StoreManager fills requestLogManager in initialize(), which runs after we
  // install), so the candidate is kept as a deferred accessor and re-read on
  // every write instead of being probed once here.
  const instance = catalog.findLogManager(graph)
  if (instance) {
    survey.level = 'level3'
    survey.logManager = { value: instance.value, path: instance.path, score: 99, deferred: instance.deferred, resolve: instance.resolve }
    survey.graph = graph
    return survey
  }
  return survey
}

/**
 * Install observability.
 *
 * @param {object} options
 * @param {object} [options.graph] the upstream export object (required)
 * @param {object} [options.shim] the electron shim (for ipcMain); optional
 * @param {object} [options.logStore] explicit store (tests, or a future hook)
 * @param {object} [options.statistics] explicit statistics provider
 * @param {string} [options.modulesDir] upstream 'main' dir holding chunks/
 * @param {string} [options.chunksDir] override for the chunks dir itself
 * @param {(p: string) => any} [options.requireModule] require() seam (tests)
 * @param {boolean} [options.routeHook] set false to skip the HTTP hook
 * @param {number} [options.bodyLimit] provider-response cap, default 2048
 * @param {() => number} [options.now] clock
 * @param {(msg: string) => void} [options.log] log sink
 * @returns {object} the installation report (also kept in state)
 */
function install(options) {
  const opts = options || {}
  const log = makeLog(opts)
  if (state.active) {
    log('already installed, nothing to do')
    return report()
  }
  state.installed = true
  state.startedAt = typeof opts.now === 'function' ? opts.now() : Date.now()

  const graph = opts.graph || null
  const shim = opts.shim || resolveShim()
  const annotateOptions = {
    bodyLimit: Number(opts.bodyLimit) > 0 ? Number(opts.bodyLimit) : requestLog.DEFAULT_BODY_LIMIT,
    now: opts.now,
    // Shared with request-log's update-by-id wrapper: a completion write and
    // the reader that follows it must agree on the verdict even when they see
    // different objects (upstream deep-copies rows on the way out).
    index: state.writerIndex,
  }

  // 1. Find the log store ------------------------------------------------
  const survey = discover(opts, log)
  state.findings.discovery = {
    level: survey.level,
    graphSource: survey.graphSource,
    scanned: survey.scanned,
    skipped: survey.skipped,
    logStorePath: survey.logManager ? survey.logManager.path : null,
  }
  state.findings.nodes = survey.nodes
  if (survey.logCandidates) state.findings.logCandidates = survey.logCandidates
  const found = survey.logManager || null
  if (survey.stats && survey.stats.length) {
    state.findings.statistics = survey.stats.slice(0, 5).map((c) => ({ path: c.path, score: c.score }))
    if (!opts.statistics) {
      state.statisticsProvider = survey.stats[0].value
      state.findings.statisticsPath = survey.stats[0].path
    }
  }
  if (opts.statistics) state.statisticsProvider = opts.statistics
  // The chunk we resolved may be the only graph that carries anything at all;
  // the self-heal classifier is looked up there too.
  const hintedGraph = survey.graph || opts.graph

  // The self-heal layer may know provider-specific error shapes. We only ask
  // it when our own table says 'unknown', and we never decide account state.
  const hint = catalog.selfHealClassifier(hintedGraph)
  if (hint) annotateOptions.selfHealHint = (message, row) => hint(message, row)

  // 2. Wrap it -----------------------------------------------------------
  if (found) {
    state.findings.logStorePath = found.path
    // The candidate can come from two places: 'found' (this install's discovery)
    // or state.pendingManager (kept from an earlier install that found the
    // manager declared-but-null). Both need the same lazy resolution.
    const candidate = () => (catalog.resolveManager(found) ? found : state.pendingManager)

    // 'installable()' answers 'is upstream's write path reachable right now?'
    // It is re-asked on every annotate pass, because upstream builds the
    // manager after us and may replace it (a logout/login cycle does).
    const isReady = () => {
      const live = catalog.resolveManager(candidate())
      if (!live) return false
      // Already wrapped by us? Then the write path is live no matter what else
      // the object looks like.
      const adders = ['addRequestLog', 'addLog', 'pushLog', 'appendLog', 'updateRequestLog']
      if (adders.some((n) => catalog.safeGet(live, n) && catalog.safeGet(live, n).__observabilityWrapped)) return true
      return !!(typeof catalog.safeGet(live, 'addRequestLog') === 'function'
        || typeof catalog.safeGet(live, 'updateRequestLog') === 'function'
        || catalog.managerRows(live))
    }
    state.activator = () => {
      const live = catalog.resolveManager(candidate())
      if (!live) return false
      // Per-instance, not global: upstream may replace the manager (logout and
      // login build a new one), and the replacement needs its own wrap.
      if (state.wrappedSet && state.wrappedSet.has(live)) {
        state.logStore = live
        return true
      }
      try {
        // A manager instance (addRequestLog/updateRequestLog/getRequestLogs) is
        // upstream's real write path; anything else gets the generic store
        // wrapper. Both are idempotent, so a retry after a partial install is
        // safe.
        const isManager = typeof catalog.safeGet(live, 'addRequestLog') === 'function'
          || typeof catalog.safeGet(live, 'updateRequestLog') === 'function'
        const result = isManager
          ? requestLog.wrapManager(live, annotateOptions)
          : requestLog.wrapStore(live, annotateOptions)
        state.logStore = live
        state.wrappedLive = true
        if (!(state.wrappedSet instanceof WeakSet)) state.wrappedSet = new WeakSet()
        state.wrappedSet.add(live)
        state.plan = candidate()
        state.findings.wrapped = result.wrapped
        state.findings.backfilled = (state.findings.backfilled || 0) + (result.annotated || 0)
        state.findings.boundRows = result.bound || []
        const holder = catalog.rowsHolder({ value: live }) || catalog.managerRows(live)
        state.rows = holder ? holder.rows || holder : null
        log('request log found at "' + found.path + '" (' + survey.level + ')'
          + (result.wrapped.length ? ', wrapped ' + result.wrapped.join('/') : ', no adder to wrap')
          + (result.bound && result.bound.length ? ', writers by id: ' + result.bound.join('/') : '')
          + (result.annotated ? ', backfilled ' + result.annotated + ' existing row(s)' : ''))
        return true
      } catch (err) {
        record(err, log)
        return false
      }
    }
    state.logStore = catalog.resolveManager(candidate()) || null
    state.findings.logStoreReady = isReady()
    if (!state.activator()) {
      state.plan = found;
      // Expected on a fresh boot: StoreManager is constructed but not yet
      // initialized when the shim runs. Say so once, plainly, and keep trying
      // from the write path and from the IPC/statistics readers.
      log('request log declared at "' + found.path + '" (' + survey.level + ') but not initialized yet;'
        + ' annotation activates on first use')
      state.pendingManager = found
      // Arm the owner: upstream is about to assign the manager it declared as
      // null, and that assignment is the earliest possible moment to wrap it.
      // Without this, the first failing request of the process's life is
      // recorded unclassified and only the second one counts.
      const owner = found && found.deferred && found.deferred.owner
      if (owner) {
        try {
          const armed = requestLog.wrapArmOwner(owner, found.deferred.key, annotateOptions)
          state.findings.armed = armed
          if (armed) log('armed "' + found.path + '": the manager is wrapped the moment upstream creates it')
        } catch (err) {
          record(err, log)
        }
      }
    } else {
      state.pendingManager = found
    }
  } else {
    log('warn: no request-log store found in the bundle graph; annotation is idle')
    if (state.findings.logCandidates && state.findings.logCandidates.length) {
      log('near misses: ' + state.findings.logCandidates.map((c) => c.path + '(' + c.score + ')').join(', '))
    } else {
      log('scanned ' + (state.findings.nodes || 0) + ' graph node(s), no candidate at all')
    }
    const discovery = state.findings.discovery || {}
    if (discovery.scanned && discovery.scanned.length) {
      log('chunks scanned: ' + discovery.scanned.join(', '))
    }
    if (discovery.skipped && discovery.skipped.length) {
      log('chunks skipped: ' + discovery.skipped.map((x) => x.file + ' (' + x.reason + ')').join('; '))
    }
  }

  // 3. HTTP route hook ---------------------------------------------------
  if (opts.routeHook !== false) {
    try {
      state.routeHook = installRouteHook(opts, log)
    } catch (err) {
      record(err, log)
    }
  }

  // 4. IPC channels ------------------------------------------------------
  if (shim) {
    try {
      state.channels = installIpc(shim, opts, log)
    } catch (err) {
      record(err, log)
    }
  }

  // 5. Readiness ---------------------------------------------------------
  const routeKind = state.routeHook ? state.routeHook.kind : null
  const wrappedRoute = routeKind === 'http-listener' || routeKind === 'express-app'
  state.ready = !!(state.rows || state.statisticsProvider || wrappedRoute || state.channels.length)
  // 'active' drives the gateway's one-shot retry. IPC channels alone are not
  // enough: at install time the upstream proxy has not started yet and neither
  // the log store nor the HTTP handler exists, so channels-only must stay
  // retryable or the first boot loses the store and the route forever.
  state.active = !!(state.rows || state.statisticsProvider || wrappedRoute)
  if (state.ready) {
    log('request-log/instrumentation ready (store=' + (state.findings.logStorePath || 'none')
      + ', route=' + (state.routeHook ? state.routeHook.kind : 'none')
      + ', channels=' + state.channels.length + ')')
  } else {
    log('warn: request-log/instrumentation idle - nothing to instrument')
  }
  return report()
}

function resolveShim() {
  try {
    return require('../electron-shim.js')
  } catch {
    return null
  }
}

/**
 * Wrap the bundle's API request handler so /v0/management/statistics answers
 * with our aggregates merged in.
 *
 * Two shapes are supported:
 *   kind: 'http-listener'  the shim captured the node http handler (the shim's
 *                          __httpHandler()); we wrap that function
 *   kind: 'express-app'    the bundle exposes an express-ish app; we insert a
 *                          middleware before its routes
 * Anything else reports kind: 'unavailable' and leaves the endpoint alone.
 */
function installRouteHook(opts, log) {
  const shim = opts.shim || resolveShim()
  const handler = shim && typeof shim.__httpHandler === 'function' ? shim.__httpHandler() : null
  if (typeof handler !== 'function') {
    log('warn: no HTTP handler available; /v0/management/statistics left as upstream')
    return { kind: 'unavailable' }
  }
  if (handler.__observabilityWrapped) return handler.__observabilityWrapped

  const hook = function observabilityHttpHook(req, res) {
    let intercepted = false
    try {
      intercepted = answerStatistics(req, res, opts)
    } catch (err) {
      record(err, log)
    }
    if (intercepted) return undefined
    return handler.call(this, req, res)
  }
  hook.__observabilityWrapped = { kind: 'http-listener', original: handler }
  // Install it into the object the shim consults, so every later lookup sees
  // the hook. The shim reads its handler lazily (__httpHandler()), so replacing
  // the reference is enough; when it holds a direct reference we also patch
  // the shim's own variable through its supported setter, if any.
  if (typeof shim.__setHttpHandler === 'function') {
    shim.__setHttpHandler(hook)
    log('HTTP handler wrapped via __setHttpHandler')
  } else {
    try {
      shim.__observabilityHttpHook = hook
    } catch { /* ignore */ }
    log('HTTP handler hook registered (shim.__observabilityHttpHook)')
  }
  return { kind: 'http-listener', hook, original: handler }
}

const STATS_PATHS = new Set([
  '/v0/management/statistics',
  '/management/statistics',
])

/** Answer /management/statistics from our aggregates; true when handled. */
/** Answer /management/statistics from our aggregates; true when handled. */
function answerStatistics(req, res, opts) {
  if (!req || !res) return false
  const method = String(req.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return false
  let pathname = '/'
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    pathname = url.pathname.replace(/\/+$/, '') || '/'
  } catch {
    return false
  }
  if (!STATS_PATHS.has(pathname)) return false
  // This hook sits IN FRONT of upstream's handler, so upstream's own auth never
  // runs for a request we answer: answering without a check would publish the
  // management surface to anyone who can reach the port. So the check below
  // mirrors managementAuthMiddleware from the bundle: /v0/management answers 404
  // while the management API is disabled (the default), 500 when it is enabled
  // but has no secret, and 401 otherwise unless the Bearer secret matches. Being
  // stricter than upstream would fail a healthy deployment; being looser is the
  // hole this commit exists to close.
  const guard = checkManagementAuth(req, opts)
  if (guard.status !== 200) {
    return replyJson(res, method, guard.status, {
      success: false,
      error: { code: guard.code, message: guard.message },
    }, { 'WWW-Authenticate': 'Bearer realm="chat2api-management"' })
  }
  return replyJson(res, method, 200, statisticsPayload(opts), {
    'X-C2A-Observability': 'statistics',
  })
}

/** Write one JSON reply; false when the response is already unusable. */
function replyJson(res, method, status, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  }, extraHeaders || {})
  try {
    res.writeHead(status, headers)
    if (method === 'HEAD') res.end()
    else res.end(body)
  } catch {
    return false
  }
  return true
}

/* ------------------------------------------------------------------ */
/* Management auth - the rule the endpoint behind us would apply        */
/* ------------------------------------------------------------------ */

/** The management config block upstream keeps in its store, or null. */
function managementConfig(opts) {
  try {
    if (opts && opts.managementConfig) return opts.managementConfig
    const mgr = opts && opts.storeManager
    if (mgr && typeof mgr.getConfig === 'function') {
      const cfg = mgr.getConfig()
      if (cfg && typeof cfg === 'object') return cfg.managementApi || null
    }
  } catch { /* an unreadable store is reported below, not thrown */ }
  return null
}

function timingSafeMatch(presented, expected) {
  const a = Buffer.from(String(presented))
  const b = Buffer.from(String(expected))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Bearer token, or the X-Management-Secret header upstream also accepts. */
function presentedSecret(req) {
  const headers = (req && req.headers) || {}
  const auth = String(headers.authorization || headers.Authorization || '')
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)
  if (bearer) return bearer[1].trim()
  const direct = headers['x-management-secret'] || headers['X-Management-Secret']
  return direct ? String(direct).trim() : ''
}

/**
 * May this request read management data? { status: 200 } when yes, otherwise the
 * status and the body to refuse with.
 *
 * Deliberately the SAME rule as the bundle's managementAuthMiddleware, including
 * the parts that are less convenient: a disabled management API answers 404, not
 * 200, because that is what /v0/management/accounts answers on a fresh instance
 * (and what smoke.sh checks for, over both prefixes). Statistics that answered
 * 200 where its sibling answers 404 would misreport the instance's state.
 */
function checkManagementAuth(req, opts) {
  const cfg = managementConfig(opts)
  if (!cfg || !cfg.enableManagementApi) {
    return { status: 404, code: 'management_api_disabled', message: 'Management API is not enabled' }
  }
  const expected = String(cfg.managementApiSecret || '')
  if (!expected) {
    return { status: 500, code: 'management_api_misconfigured', message: 'Management API secret is not configured' }
  }
  const presented = presentedSecret(req)
  if (!presented) {
    return { status: 401, code: 'missing_authentication', message: 'Authentication required. Provide Authorization: Bearer <secret> or X-Management-Secret header' }
  }
  if (!timingSafeMatch(presented, expected)) {
    return { status: 401, code: 'invalid_secret', message: 'Invalid management API secret' }
  }
  return { status: 200 }
}

/**
 * Build the /statistics payload: upstream's own numbers (when we can reach
 * them) plus ours. Every upstream field keeps its name and meaning; we only
 * add keys.
 */
function statisticsPayload(opts) {
  const now = typeof (opts && opts.now) === 'number' ? opts.now : Date.now()
  let base = null
  const provider = state.statisticsProvider
  if (provider) {
    try {
      if (typeof provider.getStatistics === 'function') base = provider.getStatistics()
      else if (typeof provider.getStats === 'function') base = provider.getStats()
      else if (!Array.isArray(provider)) base = provider
    } catch (err) {
      base = null
    }
  }
  const rows = currentRows()
  // Upstream's statistics provider is often still a zeroed object the instant
  // after it is created ('totalRequests: 0' while the log already has rows).
  // Trusting it would publish 0 requests next to a non-zero failure split, so
  // an all-zero provider is treated as 'no numbers yet' and ours fill in.
  const copy = shallowCopy(base)
  if (isEmptyProvider(copy) && rows.length) base = null
  const agg = stats.aggregate(rows, { now })
  // Merge into a copy: upstream's own statistics object is a live object, and
  // mutating it would make every read accumulate our additions on top of each
  // other (and could confuse upstream code reading its own counters).
  return stats.merge(shallowCopy(base), agg, { source: rows.length ? 'request-log' : 'none' })
}

/**
 * One level of copying is enough: merge() only replaces or adds top-level
 * keys, and the nested objects it copies (usage maps, dailyStats) are never
 * written to in place.
 */
/** Upstream provider object that exists but has counted nothing yet. */
function isEmptyProvider(value) {
  if (!value || typeof value !== 'object') return false
  const total = value.totalRequests
  const success = value.successRequests
  const failed = value.failedRequests
  return total === 0 && (success === undefined || success === 0) && (failed === undefined || failed === 0)
}

function shallowCopy(value) {
  if (!value || typeof value !== 'object') return {}
  try {
    return Object.assign({}, value)
  } catch {
    return {}
  }
}

/**
 * The live row array, re-resolved on every read.
 *
 * Upstream REPLACES the array when it trims the log to maxEntries
 * ('this.requestLogs = trimRequestLogsToMaxEntries(...)'), so a cached array
 * silently goes stale - and a stale array would quietly report the request log
 * of ten minutes ago. Reading through the manager each time costs one property
 * read and is always current.
 */
function currentRows() {
  // First use is often the first failure we are asked to explain - and on a
  // fresh boot that is also the moment upstream has finished initializing the
  // log manager. Wrap it here rather than waiting for a restart.
  if (!state.wrappedLive && state.activator) {
    try {
      state.activator()
    } catch (err) {
      record(err, makeLog({}))
    }
  }
  if (state.logStore) {
    const holder = catalog.rowsHolder(state.logStore)
    if (holder && Array.isArray(holder.rows)) {
      state.rows = holder.rows
      return holder.rows
    }
    const rows = catalog.managerRows(state.logStore)
    if (Array.isArray(rows)) {
      state.rows = rows
      return rows
    }
  }
  if (Array.isArray(state.rows)) return state.rows
  return []
}

/**
 * Register IPC channels. The shim's ipcMain is the only channel the web UI can
 * reach without a second port (webui/server.js POST /__ipc dispatches to these
 * handlers), so this is how the frontend reads the aggregates.
 */
function installIpc(shim, opts, log) {
  const ipcMain = shim && shim.ipcMain
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    log('warn: no ipcMain.handle; management API cannot reach the aggregates')
    return []
  }
  const handlers = {
    [CHANNELS.info]: () => publicReport(),
    [CHANNELS.requestLogs]: (event, query) => requestLogsPage(query),
    [CHANNELS.statistics]: (event, query) => statisticsPayload(Object.assign({}, opts, query && query.now ? { now: query.now } : {})),
    [CHANNELS.annotate]: (event, row) => {
      requestLog.annotate(row, { bodyLimit: requestLog.DEFAULT_BODY_LIMIT })
      return { failureCategory: row && row.failureCategory }
    },
  }
  const registered = []
  for (const channel of Object.keys(handlers)) {
    try {
      ipcMain.handle(channel, handlers[channel])
      registered.push(channel)
    } catch (err) {
      record(err, log)
    }
  }
  log('IPC channels: ' + registered.map((c) => c.replace(IPC_PREFIX, '')).join(', '))
  return registered
}

/** A bounded page of annotated rows for the UI / tests. */
function requestLogsPage(query) {
  const q = query || {}
  const rows = currentRows()
  const limit = Math.max(1, Math.min(1000, Number(q.limit) || 100))
  const offset = Math.max(0, Number(q.offset) || 0)
  const filtered = q.failureCategory
    ? rows.filter((row) => row && row.failureCategory === q.failureCategory)
    : rows
  // Newest first by default (the UI shows the last failure at the top); the
  // slice is taken from the tail without copying the whole array.
  const effective = q.order === 'oldest'
    ? filtered.slice(offset, offset + limit)
    : filtered.slice(Math.max(0, filtered.length - offset - limit), Math.max(0, filtered.length - offset))
  return {
    total: filtered.length,
    stored: rows.length,
    offset,
    limit,
    rows: effective,
  }
}

/** The public view of the installation (safe over IPC). */
function publicReport() {
  return {
    installed: state.installed,
    ready: state.ready,
    startedAt: state.startedAt,
    findings: Object.assign({}, state.findings),
    channels: state.channels.slice(),
    // A plain string, never null: a caller reading report().routeHook should not
    // have to guard against both 'no hook' and 'hook that says unavailable'.
    routeHook: state.routeHook && state.routeHook.kind ? state.routeHook.kind : 'none',
    active: state.active,
    rows: currentRows().length,
    errors: state.errors.slice(),
    categories: CATEGORIES.slice(),
  }
}

function report() {
  return publicReport()
}

/** Test hook: forget everything (used by tests, never by the container). */
function reset() {
  state.installed = false
  state.ready = false
  state.active = false
  state.findings = {}
  state.logStore = null
  state.rows = null
  state.statisticsProvider = null
  state.routeHook = null
  state.channels = []
  state.errors = []
  state.startedAt = null
  state.writerIndex = new Map()
  state.wrappedLive = false
  state.pendingManager = null
  state.activator = null
}

module.exports = {
  TAG,
  IPC_PREFIX,
  CHANNELS,
  STATS_PATHS,
  install,
  report,
  reset,
  statisticsPayload,
  currentRows,
  answerStatistics,
  requestLogsPage,
  state,
}
