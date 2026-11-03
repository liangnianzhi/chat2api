#!/usr/bin/env node
/**
 * Integration test: observability against the REAL shim and the REAL wiring,
 * with a request-log store shaped the way the bundle actually shapes it.
 *
 * The unit test (tests/observability.test.js) proves the pieces work on fakes.
 * This one proves they work through the seams the container really uses:
 *
 *   - shim/electron-shim.js exports __setHttpHandler / __httpHandler, and
 *     __installStatisticsHook reaches shim/observability/install.js;
 *   - shim/gateway.js installs observability after self-heal, before the front
 *     server, behind a guard, and retries once when the bundle had no store;
 *   - the Dockerfile ships and asserts the modules;
 *   - a captured HTTP request to /v0/management/statistics is answered with
 *     upstream's fields intact plus our additions, while every other path
 *     falls through to upstream's handler untouched;
 *   - the IPC channels the web UI reaches through POST /__ipc answer too.
 *
 * Run:  node tests/observability_integration.js
 * No network, no Docker, no root, no container.
 */
'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SHIM_PATH = path.join(ROOT, 'shim', 'electron-shim.js')
const OBS_PATH = path.join(ROOT, 'shim', 'observability')

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok   ' + name)
  } catch (err) {
    failed++
    failures.push({ name, err })
    console.log('  FAIL ' + name + '\n         ' + (err && err.message))
  }
}

/** A fresh copy of every module, so one test cannot leak state into the next. */
function freshRequire() {
  const shimPath = require.resolve(SHIM_PATH)
  const savedShim = require.cache[shimPath]
  delete require.cache[shimPath]
  for (const key of Object.keys(require.cache)) {
    if (key.indexOf(OBS_PATH) === 0) delete require.cache[key]
  }
  const shim = require(SHIM_PATH)
  const observability = require(OBS_PATH)
  return { shim, observability, restore: () => { if (savedShim) require.cache[shimPath] = savedShim } }
}

/** The store shape the bundle has: a rows array plus adder methods. */
function makeStore() {
  const rows = [
    // Written BEFORE instrumentation: must be backfilled, not left blank.
    {
      id: 'old-1', timestamp: '2026-11-02T10:00:00.000Z', status: 'failed',
      responseStatus: 500, providerName: 'deepseek', accountName: 'ds-1', model: 'deepseek-chat',
      latency: 18000,
      error: 'Failed to acquire token: "{\"code\":401,\"msg\":\"invalid token\"}" Failed',
    },
  ]
  return {
    logs: rows,
    addLog(row) { rows.unshift(row); return row },
    clearLogs() { rows.length = 0 },
  }
}

const UPSTREAM_STATS = {
  totalRequests: 101,
  successRequests: 50,
  failedRequests: 51,
  avgLatency: 3200,
  requestsPerMinute: 3,
  activeConnections: 1,
  modelUsage: { 'deepseek-chat': 42 },
  providerUsage: { deepseek: 60, zai: 7 },
  accountUsage: { 'ds-1': 60 },
  dailyStats: [{ date: '2026-11-02', requests: 101 }],
}

/* ------------------------------------------------------------------ *
 * The shim must load on its own, before anything else exists.
 * ------------------------------------------------------------------ */
console.log('\nshim seam')

test('shim loads standalone and exports the observability seam', () => {
  const { shim } = freshRequire()
  assert.strictEqual(shim.__isShim, true)
  assert.strictEqual(typeof shim.__setHttpHandler, 'function')
  assert.strictEqual(typeof shim.__httpHandler, 'function')
  assert.strictEqual(typeof shim.__installStatisticsHook, 'function')
})

test('__setHttpHandler swaps the handler that __httpHandler reports', () => {
  const { shim } = freshRequire()
  const original = shim.__httpHandler()
  const mine = function mine() { return 'mine' }
  assert.strictEqual(shim.__setHttpHandler(mine), mine)
  assert.strictEqual(shim.__httpHandler(), mine)
  // A non-function is ignored rather than clearing the handler: a typo must
  // never take the proxy offline.
  shim.__setHttpHandler(null)
  assert.strictEqual(shim.__httpHandler(), mine)
  shim.__setHttpHandler('not a handler')
  assert.strictEqual(shim.__httpHandler(), mine)
})

test('__installStatisticsHook installs without a bundle and does not throw', () => {
  const { shim } = freshRequire()
  const before = shim.__httpHandler()
  const report = shim.__installStatisticsHook()
  assert.ok(report, 'install returned nothing')
  // Nothing to instrument: no store, and with no captured handler there is no
  // route to wrap either, so the chain must be exactly as it was.
  assert.strictEqual(report.active, false)
  assert.strictEqual(shim.__httpHandler(), before)
})

test('__installStatisticsHook wraps a captured handler once it exists', () => {
  const { shim } = freshRequire()
  const upstream = function upstream() { return 'upstream' }
  shim.__setHttpHandler(upstream)
  const report = shim.__installStatisticsHook()
  assert.strictEqual(report.active, true)
  assert.strictEqual(report.routeHook, 'http-listener')
  const hooked = shim.__httpHandler()
  assert.notStrictEqual(hooked, upstream, 'handler was not wrapped')
  assert.strictEqual(hooked.__observabilityWrapped.original, upstream,
    'the original handler must be reachable from the hook')
})

/* ------------------------------------------------------------------ *
 * Gateway wiring.
 * ------------------------------------------------------------------ */
console.log('\ngateway wiring')

test('gateway installs observability after self-heal and before the front server', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shim', 'gateway.js'), 'utf8')
  const selfhealCall = src.indexOf('\ninstallSelfHeal()')
  const obsCall = src.indexOf('\ninstallObservability()')
  const front = src.indexOf('startFrontServer()')
  assert.ok(selfhealCall > 0, 'installSelfHeal() call not found')
  assert.ok(obsCall > selfhealCall, 'observability is not installed after self-heal')
  assert.ok(front > obsCall, 'front server starts before observability is installed')
  const start = src.indexOf('function installObservability()')
  const end = src.indexOf('\n', src.indexOf('return ', src.indexOf('catch (err)', start)))
  const body = src.slice(start, obsCall)
  assert.ok(/existsSync\(\s*OBSERVABILITY_ENTRY\s*\)/.test(body), 'no existsSync guard')
  assert.ok(/catch\s*\(/.test(body), 'installObservability has no try/catch')
})

test('Dockerfile copies and asserts the observability modules', () => {
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
  assert.ok(/COPY shim\/observability\/ /.test(docker), 'observability not copied into the image')
  for (const f of ['install.js', 'failure-classify.js', 'request-log.js', 'stats.js', 'catalog.js']) {
    assert.ok(docker.includes('/app/shim/observability/' + f),
      'runtime assertion for ' + f + ' is missing')
    assert.ok(fs.existsSync(path.join(OBS_PATH, f)), f + ' does not exist')
  }
})

/* ------------------------------------------------------------------ *
 * The request-log store, backfill and classification.
 * ------------------------------------------------------------------ */
console.log('\nrequest-log store')

test('install wraps a realistic store and backfills existing rows', () => {
  const { shim, observability } = freshRequire()
  const store = makeStore()
  const report = observability.install({ graph: { requestLogs: store }, shim })
  assert.ok(report.active, 'install did not activate')
  assert.ok(report.findings.logStorePath, 'no store path reported')
  const old = store.logs[store.logs.length - 1]
  assert.strictEqual(old.failureCategory, 'auth', 'pre-existing row was not classified')
  assert.ok(old.providerResponse, 'pre-existing row got no provider excerpt')
  assert.strictEqual(typeof old.classifiedAt, 'number')
})

test('new failing rows are classified as they are written', () => {
  const { shim, observability } = freshRequire()
  const store = makeStore()
  observability.install({ graph: { requestLogs: store }, shim })
  store.addLog({ id: 'new-1', status: 'failed', responseStatus: 500, latency: 120,
    providerName: 'zai', accountName: 'zai-1', error: 'HTTP 500' })
  assert.strictEqual(store.logs[0].failureCategory, 'provider-5xx')
  assert.strictEqual(store.logs[0].failureReason, 'HTTP 500')
  // The captcha rejection is a 200 with an error body: the proxy marks the row
  // failed (there is no completion), and the body is what classifies it.
  store.addLog({ id: 'c1', status: 'failed', providerName: 'qwen-ai',
    error: '{"code":"CAPTCHA_REQUIRED","message":"请完成安全验证"}' })
  store.addLog({ id: 'r1', status: 'failed', responseStatus: 429, providerName: 'deepseek',
    error: 'HTTP 429 Too Many Requests' })
  const byId = {}
  for (const row of store.logs) byId[row.id] = row.failureCategory
  assert.strictEqual(byId.c1, 'captcha')
  assert.strictEqual(byId.r1, 'rate-limit')
})

test('a successful row is marked "none", not left blank', () => {
  const { shim, observability } = freshRequire()
  const store = makeStore()
  observability.install({ graph: { requestLogs: store }, shim })
  store.addLog({ id: 's1', status: 'success', responseStatus: 200, latency: 400 })
  assert.strictEqual(store.logs[0].failureCategory, 'none')
})

/* ------------------------------------------------------------------ *
 * HTTP: what a management client actually receives.
 * ------------------------------------------------------------------ */
console.log('\nHTTP route hook')

function callHandler(handler, method, urlPath) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: {},
      chunks: [],
      writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; return this },
      setHeader(key, value) { this.headers[key] = value },
      write(chunk) { this.chunks.push(Buffer.from(chunk)) },
      end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); resolve(this) },
    }
    try {
      const out = handler({ method, url: urlPath, headers: {} }, res)
      if (out && typeof out.then === 'function') out.catch(reject)
    } catch (err) {
      reject(err)
    }
  })
}

async function httpSection() {
  const { shim, observability } = freshRequire()
  const store = makeStore()
  store.addLog({ id: 'n1', status: 'success', responseStatus: 200, latency: 900,
    providerName: 'deepseek', accountName: 'ds-1', model: 'deepseek-chat' })
  store.addLog({ id: 'n2', status: 'failed', responseStatus: 500, latency: 18000,
    providerName: 'deepseek', accountName: 'ds-1', model: 'deepseek-chat', error: 'HTTP 500' })

  // Upstream's captured handler: records what it was asked for, and answers
  // anything we do not intercept with its own payload.
  const seen = []
  const upstream = function upstreamHandler(req, res) {
    seen.push(req.url)
    const body = Buffer.from(JSON.stringify({ from: 'upstream', path: req.url }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(body)
  }
  shim.__setHttpHandler(upstream)

  const report = observability.install({
    graph: { requestLogs: store, statistics: UPSTREAM_STATS },
    shim,
  })
  assert.strictEqual(report.routeHook, 'http-listener', 'route hook not installed')
  const hook = shim.__httpHandler()

  const res = await callHandler(hook, 'GET', '/v0/management/statistics')
  const parsed = JSON.parse(Buffer.concat(res.chunks).toString('utf8'))

  test('/statistics keeps every upstream field', () => {
    assert.strictEqual(res.statusCode, 200)
    for (const key of Object.keys(UPSTREAM_STATS)) {
      assert.deepStrictEqual(parsed[key], UPSTREAM_STATS[key], 'upstream field ' + key + ' changed')
    }
  })

  test('/statistics adds the failure split and the percentiles', () => {
    assert.ok(parsed.failureCategories, 'no failureCategories')
    assert.ok(Array.isArray(parsed.byAccount) && parsed.byAccount.length, 'no byAccount')
    assert.ok(Array.isArray(parsed.byProvider) && parsed.byProvider.length, 'no byProvider')
    assert.strictEqual(typeof parsed.p50, 'number')
    assert.strictEqual(typeof parsed.p95, 'number')
    assert.strictEqual(parsed.p95, parsed.latency.p95)
    assert.ok(res.headers['X-C2A-Observability'], 'no marker header')
  })

  test('/statistics groups per account with counts and percentiles', () => {
    const ds = parsed.byAccount.find((bucket) => bucket.name === 'ds-1')
    assert.ok(ds, 'account ds-1 missing from byAccount')
    assert.strictEqual(ds.requests, 3)
    assert.strictEqual(ds.success, 1)
    assert.strictEqual(ds.failed, 2)
    assert.strictEqual(ds.p95, 18000)
    const deepseek = parsed.byProvider.find((bucket) => bucket.name === 'deepseek')
    assert.strictEqual(deepseek.requests, 3)
  })

  test('/statistics counts failures per category', () => {
    assert.strictEqual(parsed.failureCategories.auth, 1)
    assert.strictEqual(parsed.failureCategories['provider-5xx'], 1)
    const auth = parsed.byCategory.find((bucket) => bucket.category === 'auth')
    assert.strictEqual(auth.requests, 1)
    assert.strictEqual(auth.p95, 18000, 'the 18s auth stall must be visible in the category latency')
  })

  const other = await callHandler(hook, 'GET', '/v0/management/accounts')
  test('every other path reaches upstream untouched', () => {
    const body = JSON.parse(Buffer.concat(other.chunks).toString('utf8'))
    assert.strictEqual(body.from, 'upstream')
    assert.ok(seen.includes('/v0/management/accounts'), 'upstream never saw the request')
    assert.ok(!seen.includes('/v0/management/statistics'), 'upstream was consulted for statistics')
  })

  const alias = await callHandler(hook, 'GET', '/management/statistics')
  test('the /management alias is answered too', () => {
    assert.strictEqual(alias.statusCode, 200)
    assert.ok(JSON.parse(Buffer.concat(alias.chunks).toString('utf8')).byProvider)
  })

  const post = await callHandler(hook, 'POST', '/v0/management/statistics')
  test('a non-GET on /statistics is left to upstream', () => {
    assert.strictEqual(JSON.parse(Buffer.concat(post.chunks).toString('utf8')).from, 'upstream')
  })

  const head = await callHandler(hook, 'HEAD', '/v0/management/statistics')
  test('HEAD /statistics answers with headers and no body', () => {
    assert.strictEqual(head.statusCode, 200)
    assert.strictEqual(Buffer.concat(head.chunks).length, 0)
    assert.ok(head.headers['X-C2A-Observability'])
  })

  /* IPC: the channel the web UI reaches through POST /__ipc. */
  console.log('\nIPC channels')

  test('all four channels are registered on the shim ipcMain', () => {
    const handlers = shim.__ipcHandlers
    assert.ok(handlers, 'shim has no ipcHandlers map')
    const channels = []
    for (const key of handlers.keys()) {
      if (String(key).indexOf(observability.IPC_PREFIX) === 0) channels.push(key)
    }
    assert.deepStrictEqual(channels.sort(), [
      observability.CHANNELS.annotate,
      observability.CHANNELS.info,
      observability.CHANNELS.requestLogs,
      observability.CHANNELS.statistics,
    ])
  })

  test('the statistics channel agrees with the HTTP endpoint', () => {
    const handler = shim.__ipcHandlers.get(observability.CHANNELS.statistics)
    const viaIpc = handler({}, null)
    assert.strictEqual(viaIpc.totalRequests, parsed.totalRequests)
    assert.deepStrictEqual(viaIpc.providerUsage, parsed.providerUsage)
    assert.strictEqual(viaIpc.byAccount.length, parsed.byAccount.length)
  })

  test('the info channel reports what was instrumented', () => {
    const info = shim.__ipcHandlers.get(observability.CHANNELS.info)({}, null)
    assert.strictEqual(info.installed, true)
    assert.strictEqual(info.active, true)
    assert.strictEqual(info.routeHook, 'http-listener')
    assert.deepStrictEqual(info.channels.sort(), Object.keys(observability.CHANNELS).map((k) => observability.CHANNELS[k]).sort())
  })

  test('the request-logs channel filters by failure category', () => {
    const page = shim.__ipcHandlers.get(observability.CHANNELS.requestLogs)({}, { failureCategory: 'auth' })
    assert.ok(page.rows.length >= 1)
    for (const row of page.rows) assert.strictEqual(row.failureCategory, 'auth')
  })
}

/* ------------------------------------------------------------------ *
 * Discovery ladder 2 + 3: the shapes the REAL bundle has.
 *
 * The shipped bundle is /app/upstream/main/headless.js, which exports
 * nothing, next to a hashed chunk (server-D4GzIgCk.js today) that exports the
 * AccountManager / ProxyServer / storeManager. The request-log manager is an
 * INSTANCE on storeManager and its class is module-local:
 *
 *   storeManager = { store, requestLogManager: null, ... }
 *   class RequestLogManager { requestLogs; addRequestLog(entry); updateRequestLog(id, updates); getRequestLogs(limit, filter) }
 *
 * and the row is written in two steps: add() stores an entry that has no
 * status yet and RETURNS THE STORED COPY, then update() merges the outcome -
 * statusCode, latency, errorMessage. An annotation that only looks at add()
 * never sees a failure.
 * ------------------------------------------------------------------ */
console.log("\ndiscovery on the bundle's real shape")

/** A stand-in for upstream's RequestLogManager, behaviour included. */
function makeRealManager() {
  const sanitize = (entry) => Object.assign({}, entry, { userInput: entry.userInput })
  const manager = {
    requestLogs: [],
    initialized: true,
    nextId: 1,
    addRequestLog(entry) {
      const stored = Object.assign(sanitize(entry), { id: 'log-' + (this.nextId++) })
      this.requestLogs.push(stored)
      if (this.requestLogs.length > 3) this.requestLogs = this.requestLogs.slice(-3)
      return stored
    },
    updateRequestLog(id, updates) {
      const index = this.requestLogs.findIndex((entry) => entry.id === id)
      if (index === -1) return false
      this.requestLogs[index] = Object.assign({}, this.requestLogs[index], updates)
      return true
    },
    getRequestLogs(limit) {
      const copy = this.requestLogs.map((entry) => Object.assign({}, entry))
      return typeof limit === 'number' ? copy.slice(-limit) : copy
    },
  }
  return manager
}

/** A chunk directory + a headless entry, exactly as the container has them. */
function makeModularBundle() {
  const os = require('os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2a-chunks-'))
  const manager = makeRealManager()
  const chunkPath = path.join(dir, 'server-D4GzIgCk.js')
  // Written as a real module so require() runs for real (no fake require seam
  // here: the point is that the ladder finds a file it has never been told the
  // name of).
  fs.writeFileSync(chunkPath, [
    "'use strict'",
    'function AccountManager() {}',
    'function ProxyServer() {}',
    'const storeManager = { isInitialized: true, requestLogManager: globalThis.__c2aTestManager }',
    'exports.AccountManager = AccountManager',
    'exports.ProxyServer = ProxyServer',
    'exports.storeManager = storeManager',
    '',
  ].join('\n'))
  globalThis.__c2aTestManager = manager
  const headless = {} // upstream's headless entry exports nothing at all
  return { headless, manager, dir, cleanup: () => { try { fs.unlinkSync(chunkPath); fs.rmdirSync(dir) } catch { /* ignore */ } } }
}

test('level 2: a headless entry with no exports is resolved through chunks/', () => {
  const bundle = makeModularBundle()
  try {
    const { shim, observability } = freshRequire()
    const report = observability.install({ graph: bundle.headless, modulesDir: path.dirname(bundle.dir), chunksDir: bundle.dir, shim })
    assert.strictEqual(report.findings.discovery.graphSource, 'chunks/server-D4GzIgCk.js',
      'the chunk was not recognised: ' + JSON.stringify(report.findings.discovery))
    // level2 explores the chunk it just required and walks straight to
    // storeManager.requestLogManager, so the manager fallback is not needed.
    assert.ok(report.findings.discovery.level === 'level2' || report.findings.discovery.level === 'level3',
      'level was ' + report.findings.discovery.level)
    assert.strictEqual(report.findings.logStorePath, 'storeManager.requestLogManager')
    assert.strictEqual(report.active, true)
  } finally {
    bundle.cleanup()
    delete globalThis.__c2aTestManager
  }
})

test('level 3: both writes of upstream are wrapped, so a failure lands with its category', () => {
  const bundle = makeModularBundle()
  try {
    const { shim, observability } = freshRequire()
    observability.install({ graph: bundle.headless, chunksDir: bundle.dir, shim })
    const manager = bundle.manager
    // What upstream does for a failed request: add first, complete later.
    const stored = manager.addRequestLog({ timestamp: Date.now(), status: 'error', model: 'deepseek-chat', accountName: 'ds-1' })
    assert.strictEqual(stored.failureCategory, 'unknown', 'the add payload was not annotated')
    assert.strictEqual(manager.updateRequestLog(stored.id, {
      statusCode: 500,
      latency: 18000,
      errorMessage: 'Failed to acquire token: "{\\"code\\":401,\\"msg\\":\\"invalid token\\"}" Failed',
    }), true)
    const row = manager.requestLogs[0]
    assert.strictEqual(row.failureCategory, 'auth', 'the completion write was not classified')
    assert.ok(row.failureReason, 'no reason recorded')
    // The reader hands out copies; those must be annotated too.
    const copy = manager.getRequestLogs(1)[0]
    assert.strictEqual(copy.failureCategory, 'auth')
    assert.strictEqual(copy.failureReason, row.failureReason)
  } finally {
    bundle.cleanup()
    delete globalThis.__c2aTestManager
  }
})

test('level 3: rows replaced by the maxEntries trim are still the ones counted', () => {
  const bundle = makeModularBundle()
  try {
    const { shim, observability } = freshRequire()
    observability.install({ graph: bundle.headless, chunksDir: bundle.dir, shim })
    const manager = bundle.manager
    // The manager replaces its array when it trims (requestLogs = slice(-3));
    // a cached array would report the previous four requests forever.
    for (let i = 0; i < 6; i += 1) {
      const stored = manager.addRequestLog({ timestamp: Date.now(), status: 'error' })
      manager.updateRequestLog(stored.id, { statusCode: 500, errorMessage: 'HTTP 500', latency: 900 })
    }
    const payload = observability.statisticsPayload({})
    assert.strictEqual(payload.observed.totalRequests, 3, 'the live row array was not re-resolved')
    assert.strictEqual(payload.observed.failedRequests, 3)
    assert.strictEqual(payload.failureCategories['provider-5xx'], 3, JSON.stringify(payload.failureCategories))
  } finally {
    bundle.cleanup()
    delete globalThis.__c2aTestManager
  }
})

test('level 2 skips a chunk it cannot require, and says why', () => {
  const os = require('os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2a-chunks-'))
  try {
    fs.writeFileSync(path.join(dir, 'server-BROKEN01.js'), 'this is not javascript (')
    const { shim, observability } = freshRequire()
    const report = observability.install({ graph: {}, chunksDir: dir, shim })
    const skipped = report.findings.discovery.skipped
    assert.strictEqual(skipped.length, 1, JSON.stringify(report.findings.discovery))
    assert.strictEqual(skipped[0].file, 'server-BROKEN01.js')
    assert.ok(/require failed/.test(skipped[0].reason), skipped[0].reason)
    assert.strictEqual(report.findings.discovery.level, 'none')
  } finally {
    try {
      fs.unlinkSync(path.join(dir, 'server-BROKEN01.js'))
      fs.rmdirSync(dir)
    } catch { /* ignore */ }
  }
})

test('a provider that has counted nothing yet cannot publish 0 next to real failures', () => {
  // Seen in the container: the statistics provider object exists and reports
  // totalRequests: 0 while the request log already holds rows. Merging blindly
  // would show '0 requests' beside a non-zero failure split.
  const { shim, observability } = freshRequire()
  const store = []
  const manager = {
    requestLogs: store,
    addRequestLog(entry) { const row = Object.assign({}, entry, { id: 'z' + store.length }); store.push(row); return row },
    updateRequestLog(id, patch) { const i = store.findIndex((r) => r.id === id); if (i < 0) return false; store[i] = Object.assign({}, store[i], patch); return true },
    getRequestLogs(n) { return store.slice(-(n || 100)) },
  }
  observability.install({ graph: { requestLogManager: manager }, shim, routeHook: false, statistics: { totalRequests: 0, successRequests: 0, failedRequests: 0 } })
  const row = manager.addRequestLog({ timestamp: Date.now(), status: 'error', providerName: 'DeepSeek' })
  manager.updateRequestLog(row.id, { statusCode: 500, errorMessage: 'Failed to acquire token: "x" Failed (invalid token)' })
  const payload = observability.statisticsPayload({})
  assert.strictEqual(payload.totalRequests, 1, 'a zeroed provider must not win over the log: ' + JSON.stringify(payload))
  assert.strictEqual(payload.failedRequests, 1)
  assert.strictEqual(payload.failureCategories.auth, 1)
})

test('the FIRST failing write is classified: the owner is armed, not polled', () => {
  // Strongest form of the late-manager case: not one reader runs before the
  // first write. Without arming, that write lands unclassified and the operator
  // loses exactly the failure they were debugging.
  const os = require('os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2a-arm-'))
  fs.writeFileSync(path.join(dir, 'server-ARM00001.js'), [
    "'use strict'",
    'exports.AccountManager = function AccountManager() {}',
    'exports.ProxyServer = function ProxyServer() {}',
    'exports.storeManager = globalThis.__c2aArmStore',
    '',
  ].join('\n'))
  globalThis.__c2aArmStore = { isInitialized: false, requestLogManager: null }
  try {
    const { shim, observability } = freshRequire()
    observability.install({ graph: {}, chunksDir: dir, shim })
    // Upstream initializes its store: a plain assignment, exactly like
    // 'this.requestLogManager = new RequestLogManager(...)'.
    globalThis.__c2aArmStore.requestLogManager = makeRealManager()
    const manager = globalThis.__c2aArmStore.requestLogManager
    const failed = manager.addRequestLog({ timestamp: Date.now(), status: 'error', providerName: 'DeepSeek' })
    assert.strictEqual(failed.failureCategory, 'unknown', 'arming did not catch the assignment')
    manager.updateRequestLog(failed.id, { statusCode: 500, errorMessage: 'Failed to acquire token: Authorization Failed (invalid token)', latency: 18000 })
    const row = manager.getRequestLogs(1)[0]
    assert.strictEqual(row.failureCategory, 'auth')
    assert.strictEqual(row.providerResponse.includes('invalid token'), true, 'the upstream body was dropped')
    assert.strictEqual(row.httpStatus, 500)
  } finally {
    delete globalThis.__c2aArmStore
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test('a manager that is declared null at boot is wrapped on first use', () => {
  // The container's real order: StoreManager is constructed with
  // 'requestLogManager: null', the shim installs us, and only then does
  // initialize() create the RequestLogManager. A one-shot probe at install
  // time therefore sees nothing and the whole layer stays idle for the rest of
  // the process's life - which is exactly what happened on the NAS.
  const os = require('os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2a-late-'))
  const chunkPath = path.join(dir, 'server-LATE0001.js')
  const storeManager = { isInitialized: false, requestLogManager: null }
  fs.writeFileSync(chunkPath, [
    "'use strict'",
    'exports.AccountManager = function AccountManager() {}',
    'exports.ProxyServer = function ProxyServer() {}',
    'exports.storeManager = globalThis.__c2aLateStore',
    '',
  ].join('\n'))
  globalThis.__c2aLateStore = storeManager
  try {
    const { shim, observability } = freshRequire()
    const report = observability.install({ graph: {}, chunksDir: dir, shim })
    assert.strictEqual(report.findings.logStorePath, 'storeManager.requestLogManager',
      'the declared-but-null manager was not remembered: ' + JSON.stringify(report.findings))
    assert.strictEqual(report.findings.wrapped, undefined, 'nothing may report as wrapped before it exists')

    // Upstream boots: the manager appears.
    storeManager.requestLogManager = makeRealManager()
    storeManager.isInitialized = true
    // Read through the accessor, exactly as upstream does inside its own
    // class ('this.requestLogManager.addRequestLog(...)'): the wrapper swaps the
    // METHODS on the instance and cannot reach a reference someone captured
    // earlier.
    const manager = storeManager.requestLogManager
    const stored = manager.addRequestLog({ timestamp: Date.now(), status: 'error', providerName: 'DeepSeek' })
    assert.strictEqual(stored.failureCategory, 'unknown',
      'the late-wrapped adder was not called: ' + JSON.stringify(observability.report().findings))
    storeManager.requestLogManager.updateRequestLog(stored.id, { statusCode: 500, errorMessage: 'HTTP 500' })
    assert.strictEqual(storeManager.requestLogManager.requestLogs[0].failureCategory, 'provider-5xx')
    assert.strictEqual(observability.statisticsPayload({}).observed.totalRequests, 1)
  } finally {
    try {
      fs.unlinkSync(chunkPath)
      fs.rmdirSync(dir)
    } catch { /* ignore */ }
    delete globalThis.__c2aLateStore
  }
})

/* ------------------------------------------------------------------ *
 * Hostile input: nothing here may throw into the proxy.
 * ------------------------------------------------------------------ */
console.log('\nrobustness')

test('a throwing store adder keeps its own error', () => {
  const { shim, observability } = freshRequire()
  const store = { logs: [], addLog() { throw new Error('boom') } }
  observability.install({ graph: { requestLogs: store }, shim })
  let seen = null
  try { store.addLog({ id: 'x', status: 'failed' }) } catch (err) { seen = err }
  assert.ok(seen && seen.message === 'boom', 'the wrapper replaced or swallowed the store error')
})

test('a graph full of getters that throw does not break install', () => {
  const { shim, observability } = freshRequire()
  const graph = {}
  Object.defineProperty(graph, 'logs', { get() { throw new Error('nope') }, enumerable: true })
  Object.defineProperty(graph, 'statistics', { get() { throw new Error('nope') }, enumerable: true })
  const report = observability.install({ graph, shim })
  assert.ok(report, 'install must return a report even when the graph fights back')
})

test('a second install after the first did nothing still works', () => {
  const { shim, observability } = freshRequire()
  const idle = observability.install({ graph: null, shim })
  assert.strictEqual(idle.active, false)
  const store = makeStore()
  const second = observability.install({ graph: { requestLogs: store }, shim })
  assert.strictEqual(second.active, true, 'the late retry was refused')
  assert.strictEqual(store.logs[store.logs.length - 1].failureCategory, 'auth')
})

test('a channels-only install stays retryable (real gateway boot order)', () => {
  // Reproduces the container: at install time the bundle has no store yet and
  // the shim has no captured HTTP handler, so only the IPC channels can be
  // registered. That must report active:false, or the gateway's one retry is
  // never scheduled and the layer stays half-installed for the whole boot.
  const { shim: realShim, observability } = freshRequire()
  // A real shim with no captured handler yet: exactly the boot-time state.
  realShim.__setHttpHandler(null)
  const ipcMain = { handlers: new Map(), handle(name, fn) { this.handlers.set(name, fn) } }
  const shim = { ipcMain, __ipcHandlers: ipcMain.handlers, __httpHandler: () => null }
  const early = observability.install({ graph: {}, shim, statistics: null })
  assert.strictEqual(early.channels.length > 0, true, 'no channels registered')
  assert.strictEqual(early.routeHook, 'unavailable', 'the shim has no handler yet, so no route hook')
  assert.strictEqual(early.active, false, 'channels-only install must stay retryable')

  // The late retry then finds the store and the route.
  const store = makeStore()
  let handler = function original(req, res) { res.end('upstream') }
  const lateShim = { ipcMain, __ipcHandlers: ipcMain.handlers, __httpHandler: () => handler, __setHttpHandler: (fn) => { handler = fn } }
  const late = observability.install({ graph: { requestLogs: store }, shim: lateShim })
  assert.strictEqual(late.active, true)
  assert.strictEqual(late.routeHook, 'http-listener')
  assert.strictEqual(store.logs[store.logs.length - 1].failureCategory, 'auth')
})

async function main() {
  await httpSection()
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  if (failed) {
    for (const f of failures) console.log('\n--- ' + f.name + '\n' + (f.err && f.err.stack))
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('integration test crashed:', err && err.stack)
  process.exitCode = 1
})
