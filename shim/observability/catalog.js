/**
 * Bundle introspection.
 *
 * THE PROBLEM
 * -----------
 * The container runs upstream's compiled bundle (a bundled Electron main
 * process) under a shim, with no source tree and no route table we own. There
 * is no supported hook to say 'give me your request log'. So this module walks
 * a namespace graph looking for the objects we need, using structural
 * signatures rather than import paths - paths differ per upstream build, the
 * shapes are stable:
 *
 *   log store    an object with array-typed 'logs'-ish field AND an
 *                add-push-append method, or an array of row-shaped objects
 *   statistics   an object with 'totalRequests' / 'successRequests' or a
 *                'getStatistics' function
 *   ipc handlers an object holding the handler map the shim will install
 *                channels into
 *
 * THREE-LEVEL DISCOVERY (the same ladder shim/selfheal/ walks)
 * -----------------------------------------------------------
 *   1. the graph we were handed (gateway's require() of the bundle entry);
 *   2. when that graph is the headless bootstrap - it exports nothing and only
 *      starts the server - the Rollup chunk next to it,
 *      upstream/main/chunks/server-*.js, is require()d and the REAL export
 *      object used instead. The hash in the file name changes on every
 *      upstream build, so the file is found by glob and recognised by its
 *      exports, never by a hard-coded path;
 *   3. when the class of the store we want is module-local (it is: upstream
 *      never exports RequestLogManager, only the StoreManager instance that
 *      holds it), the wired INSTANCE is used. Its own add/update methods are
 *      the write path, so wrapping them needs no access to the class.
 *
 * Every step reports what it did, and a step that finds nothing is never
 * fatal: the install continues with whatever is reachable.
 *
 * WHAT WE NEVER DO
 * ----------------
 *   * We do not require() anything outside our own directory: a wrong path
 *     would abort the boot.
 *   * We do not mutate during the walk; candidates are collected first and
 *     only the caller installs anything.
 *   * We do not trust a deep traversal to be cheap: the walk is breadth-first,
 *     bounded in depth, nodes, and visited count, and it skips huge objects
 *     (modules with compiled source, buffers...).
 *
 * The walk is also used at boot to REPORT what it found, so a future upstream
 * change is visible in the container log instead of as silently missing data.
 */

'use strict'

const fs = require('fs')
const path = require('path')

const MAX_NODES = 6000
const MAX_DEPTH = 7
const MAX_CHILDREN = 60

/** Skip these keys: they are big, useless, or cyclic. */
const SKIP_KEYS = new Set([
  'parent', 'root', 'module', 'modules', 'children', 'source', 'code',
  '_compile', 'constructor', 'prototype', '__proto__', 'socket', 'req', 'res',
  'request', 'response', 'client', 'agent', 'handle', 'stream',
])

const LOG_ARRAY_NAMES = ['logs', 'requestLogs', 'entries', 'items', 'list', 'records', 'logList', 'history']
const LOG_METHOD_NAMES = ['addLog', 'addRequestLog', 'pushLog', 'add', 'push', 'append', 'record', 'log']
const ROW_KEYS = ['statusCode', 'responseStatus', 'latency', 'isStream', 'accountId']
/** Unambiguous 'this object accepts a request-log row' method names. */
const LOG_ADD_METHODS = ['addLog', 'addRequestLog', 'pushLog', 'recordRequestLog', 'appendLog', 'writeLog']

/**
 * Keys on a manager/container object that may hold the log-store INSTANCE.
 * Upstream names it exactly this (storeManager.requestLogManager); the other
 * spellings cost nothing and cover a rename.
 */
const MANAGER_KEYS = ['requestLogManager', 'requestLogger', 'logManager', 'requestLogsManager']

/** A directory of Rollup chunks, and the module that re-exports the bundle. */
const CHUNKS_DIR = 'chunks'

function isArr(v) {
  return Array.isArray(v)
}

function isObj(v) {
  return v !== null && typeof v === 'object'
}

function safeGet(obj, key) {
  try {
    return obj ? obj[key] : undefined
  } catch {
    return undefined
  }
}

function looksLikeLogRow(value) {
  if (!isObj(value)) return false
  let hits = 0
  for (const key of ROW_KEYS) {
    if (safeGet(value, key) !== undefined) hits += 1
  }
  return hits >= 2
}

/** Score how much a value looks like the request-log store, 0 = not at all. */
function scoreLogStore(value) {
  if (!isObj(value)) return 0
  let score = 0
  if (isArr(value) && value.length && looksLikeLogRow(value[value.length - 1])) score += 6
  // A store that has not recorded anything yet is still the store: on a fresh
  // container the log is empty, and requiring a row would report 'none' and
  // leave a live install un-instrumented until the next restart.
  const emptyAdd = LOG_ADD_METHODS.some((name) => typeof safeGet(value, name) === 'function')
  if (!score && emptyAdd) score += 4
  for (const name of LOG_ARRAY_NAMES) {
    const arr = safeGet(value, name)
    if (isArr(arr)) score += arr.length && looksLikeLogRow(arr[arr.length - 1]) ? 8 : 3
  }
  for (const name of LOG_METHOD_NAMES) {
    if (typeof safeGet(value, name) === 'function') {
      score += name === 'addLog' || name === 'addRequestLog' || name === 'pushLog' ? 5 : 2
    }
  }
  return score
}

/** Score how much a value looks like the statistics provider. */
function scoreStatistics(value) {
  if (!isObj(value)) return 0
  let score = 0
  if (typeof safeGet(value, 'totalRequests') === 'number') score += 4
  if (typeof safeGet(value, 'successRequests') === 'number') score += 4
  if (typeof safeGet(value, 'failedRequests') === 'number') score += 2
  if (typeof safeGet(value, 'avgLatency') === 'number') score += 2
  if (typeof safeGet(value, 'getStatistics') === 'function') score += 6
  if (typeof safeGet(value, 'getStats') === 'function') score += 4
  return score
}

/** Is this object the headless bootstrap (starts the server, exports nothing)? */
function isHeadlessEntry(graph) {
  if (!graph || typeof graph !== 'object') return true
  let keys = []
  try {
    keys = Object.keys(graph)
  } catch {
    return true
  }
  return keys.length === 0
}

/**
 * Level 2: when the graph is the headless bootstrap, load the Rollup chunk that
 * carries the real classes.
 *
 * The file name contains a build hash (server-D4GzIgCk.js today, something else
 * after the next deploy), so candidates are globbed and recognised by SHAPE -
 * an object that exports AccountManager / ProxyServer / storeManager - not by
 * name. Anything unreadable, un-requireable or unrecognisable is skipped with a
 * reason; a failed require here never aborts the boot.
 *
 * @param {object} graph the export object we were handed
 * @param {object} [options] { dir, requireModule, log, force }
 * @returns {{graph: object, source: string, scanned: string[],
 *            skipped: Array<{file: string, reason: string}>}}
 */
function resolveChunk(graph, options) {
  const opts = options || {}
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const scanned = []
  const skipped = []
  if (!isHeadlessEntry(graph) && !opts.force) {
    return { graph, source: 'graph', scanned, skipped }
  }
  const dir = opts.dir || (opts.modulesDir ? path.join(opts.modulesDir, CHUNKS_DIR) : null)
  const requireModule = typeof opts.requireModule === 'function' ? opts.requireModule : (p) => require(p)
  if (!dir) {
    skipped.push({ file: '(none)', reason: 'no modules directory to scan' })
    return { graph, source: 'graph', scanned, skipped }
  }
  let names = []
  try {
    names = fs.readdirSync(dir).filter((name) => /^server-.*[.]js$/.test(name)).sort()
  } catch (err) {
    skipped.push({ file: dir, reason: 'cannot read chunks directory' })
    return { graph, source: 'graph', scanned, skipped }
  }
  for (const name of names) {
    const file = path.join(dir, name)
    scanned.push(name)
    let chunk = null
    try {
      chunk = requireModule(file)
    } catch (err) {
      skipped.push({ file: name, reason: 'require failed: ' + (err && err.message ? err.message : err) })
      continue
    }
    if (!chunk || typeof chunk !== 'object') {
      skipped.push({ file: name, reason: 'not an export object' })
      continue
    }
    if (looksLikeBundleGraph(chunk)) {
      log('upstream graph resolved from chunks/' + name)
      return { graph: chunk, source: 'chunks/' + name, scanned, skipped }
    }
    skipped.push({ file: name, reason: 'no AccountManager/storeManager/ProxyServer export' })
  }
  return { graph, source: 'graph', scanned, skipped }
}

/** The exports every rollup server chunk carries; two of four is enough. */
function looksLikeBundleGraph(value) {
  if (!value || typeof value !== 'object') return false
  let hits = 0
  for (const name of ['AccountManager', 'ProxyServer', 'storeManager', 'ProviderManager']) {
    const v = safeGet(value, name)
    if (v && (typeof v === 'object' || typeof v === 'function')) hits += 1
  }
  return hits >= 2
}

/**
 * Level 3: the log store is created by StoreManager but never exported as a
 * class, so a graph walk can only ever see the wired INSTANCE - which is all we
 * need: its add/update methods are upstream's write path.
 *
 * @param {object} graph a (resolved) export object
 * @returns {{value: object, path: string}|null}
 */
function findLogManager(graph) {
  if (!graph || typeof graph !== 'object') return null
  let keys = []
  try {
    keys = Object.keys(graph)
  } catch {
    return null
  }
  const deferred = []
  for (const key of keys) {
    const value = safeGet(graph, key)
    if (!value || typeof value !== 'object') continue
    for (const name of MANAGER_KEYS) {
      const held = safeGet(value, name)
      if (held && typeof held === 'object') return { value: held, path: key + '.' + name }
      // LAZY: StoreManager declares 'requestLogManager: null' in its constructor
      // and only fills it once initialize() has run - which happens after the
      // shim installs us. Dropping the null would mean "nothing found" on every
      // boot, forever, because a null is not a getter that can be watched.
      // Remember the path instead and read it again on every write/read.
      if (held === null) deferred.push({ owner: value, key: name, path: key + '.' + name })
    }
  }
  if (deferred.length) {
    return {
      value: null,
      path: deferred[0].path,
      deferred: deferred[0],
      resolve: () => {
        const held = safeGet(deferred[0].owner, deferred[0].key)
        return held && typeof held === 'object' ? held : null
      },
    }
  }
  return null
}

/**
 * Live row lookup on a manager instance: upstream keeps the rows on
 * 'requestLogs' and exposes getRequestLogs(limit, filter), and the rows array
 * is REPLACED whenever it is trimmed to maxEntries - so callers must re-resolve
 * instead of caching the array.
 */
function managerRows(manager) {
  if (!manager || typeof manager !== 'object') return null
  for (const name of LOG_ARRAY_NAMES) {
    const rows = safeGet(manager, name)
    if (isArr(rows)) return rows
  }
  return null
}

/**
 * Walk a namespace graph and collect candidates.
 *
 * @param {object} root       usually the upstream export object
 * @param {object} [options]
 * @param {number} [options.maxDepth]
 * @param {number} [options.maxNodes]
 * @returns {{logStores: Array<{path: string, value: object, score: number}>,
 *            statistics: Array<{path: string, value: object, score: number}>,
 *            paths: string[]}}
 */
function explore(root, options) {
  const opts = options || {}
  const maxDepth = Number(opts.maxDepth) > 0 ? Number(opts.maxDepth) : MAX_DEPTH
  const maxNodes = Number(opts.maxNodes) > 0 ? Number(opts.maxNodes) : MAX_NODES

  const logStores = []
  const statistics = []
  const paths = []
  const visited = new Set()
  const queue = [{ value: root, path: '', depth: 0 }]
  let visitedCount = 0

  while (queue.length && visitedCount < maxNodes) {
    const node = queue.shift()
    const value = node.value
    if (!isObj(value) && typeof value !== 'function') continue
    if (visited.has(value)) continue
    visited.add(value)
    visitedCount += 1
    if (node.path) paths.push(node.path)

    const logScore = scoreLogStore(value)
    if (logScore >= 5) logStores.push({ path: node.path || '(root)', value, score: logScore })
    const statScore = scoreStatistics(value)
    if (statScore >= 6) statistics.push({ path: node.path || '(root)', value, score: statScore })
    if (node.depth >= maxDepth) continue

    let keys = []
    try {
      keys = Object.keys(value)
    } catch {
      keys = []
    }
    if (keys.length > MAX_CHILDREN) keys = keys.slice(0, MAX_CHILDREN)
    for (const key of keys) {
      if (SKIP_KEYS.has(key)) continue
      const child = safeGet(value, key)
      if (!isObj(child) && typeof child !== 'function') continue
      if (visited.has(child)) continue
      queue.push({ value: child, path: node.path ? node.path + '.' + key : key, depth: node.depth + 1 })
    }
  }

  logStores.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  statistics.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return { logStores, statistics, paths, visited: visitedCount }
}

/**
 * Locate the object that actually holds the rows, plus the methods that add
 * to it. Returns null when the candidate is a bare array (handled by the
 * caller with request-log.wrapStore).
 */
function rowsHolder(candidate) {
  if (!candidate) return null
  const value = candidate.value || candidate
  if (isArr(value)) return { rows: value, owner: null, via: 'array' }
  for (const name of LOG_ARRAY_NAMES) {
    const arr = safeGet(value, name)
    if (isArr(arr)) return { rows: arr, owner: value, via: name }
  }
  return null
}

/**
 * Ask the self-heal layer what it thinks of a failure, without depending on
 * its internals.
 *
 * CONTRACT (this is the boundary the task drew): self-heal owns account
 * cooling. It is free to know provider-specific error shapes that a generic
 * table cannot. We therefore accept, in order:
 *
 *   1. graph.selfheal.classifyFailure(message) -> category string
 *   2. graph.selfheal.authErrors.classify({message}) -> {category}
 *   3. graph.selfheal.authErrors.classifyError(message) -> string
 *
 * Any of them may be missing or throw; the caller then keeps our own answer.
 *
 * @returns {(message: string, row: object) => (string|null)|null}
 */
function selfHealClassifier(graph) {
  const selfheal = graph && (graph.selfheal || safeGet(graph, 'selfheal'))
  if (!selfheal) return null
  const fn = safeGet(selfheal, 'classifyFailure')
  if (typeof fn === 'function') {
    return (message) => normaliseCategory(fn(message))
  }
  const authErrors = safeGet(selfheal, 'authErrors') || safeGet(selfheal, 'auth-errors')
  if (authErrors && typeof safeGet(authErrors, 'classify') === 'function') {
    return (message) => {
      const out = authErrors.classify({ message })
      return normaliseCategory(out && (out.category || out.clazz || out))
    }
  }
  if (authErrors && typeof safeGet(authErrors, 'classifyError') === 'function') {
    return (message) => normaliseCategory(authErrors.classifyError(message))
  }
  return null
}

/**
 * Self-heal's vocabulary is its own ('server', 'client', 'auth', 'unknown').
 * Map what it says onto ours; anything we do not know becomes null, so our
 * answer stands.
 */
function normaliseCategory(value) {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (v === 'auth' || v === 'authentication' || v === 'unauthorized') return 'auth'
  if (v === 'captcha' || v === 'challenge' || v === 'risk') return 'captcha'
  if (v === 'rate-limit' || v === 'rate_limit' || v === 'ratelimit' || v === 'quota') return 'rate-limit'
  if (v === 'network' || v === 'timeout' || v === 'transport') return 'network'
  if (v === 'server' || v === 'provider-5xx' || v === 'provider_5xx' || v === '5xx') return 'provider-5xx'
  if (v === 'client' || v === 'client-error' || v === 'client_error' || v === '4xx') return 'client-error'
  return null
}

/**
 * Read the live manager behind a candidate from findLogManager(). Returns null
 * while the owner has not initialized it yet.
 */
function resolveManager(candidate) {
  if (!candidate) return null
  if (typeof candidate.resolve === 'function') {
    let held = null
    try {
      held = candidate.resolve()
    } catch {
      held = null
    }
    return held && typeof held === 'object' ? held : null
  }
  return candidate.value && typeof candidate.value === 'object' ? candidate.value : null
}

module.exports = {
  MANAGER_KEYS,
  resolveManager,
  CHUNKS_DIR,
  isHeadlessEntry,
  resolveChunk,
  looksLikeBundleGraph,
  findLogManager,
  managerRows,
  MAX_NODES,
  MAX_DEPTH,
  SKIP_KEYS,
  explore,
  rowsHolder,
  scoreLogStore,
  scoreStatistics,
  looksLikeLogRow,
  selfHealClassifier,
  normaliseCategory,
  safeGet,
}
