#!/usr/bin/env node
/**
 * Unit tests for the observability modules (shim/observability/*).
 *
 * No framework: plain node + assert, so it runs inside the container
 * (node tests/observability.test.js) and on a developer machine where the
 * repo has no node_modules.
 *
 * WHAT IS COVERED
 *   * failure-classify: the six required categories on real error strings taken
 *     from production (each is a regression test for a failure we actually saw)
 *   * request-log: annotation of a row, provider-response excerpt truncation,
 *     frozen rows, the wrapper contract
 *   * stats: percentile correctness, grouping, and the promise that merging
 *     into upstream's payload never removes an existing field
 *   * catalog: finding a log store / statistics provider in a namespace graph
 *     and reading the self-heal classifier without depending on it
 *   * install: end-to-end install against a fake bundle + fake http handler,
 *     and the /v0/management/statistics response
 */

'use strict'

const assert = require('assert')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OBS = path.join(ROOT, 'shim', 'observability')
const classify = require(path.join(OBS, 'failure-classify.js'))
const requestLog = require(path.join(OBS, 'request-log.js'))
const stats = require(path.join(OBS, 'stats.js'))
const catalog = require(path.join(OBS, 'catalog.js'))
const install = require(path.join(OBS, 'install.js'))

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    process.stdout.write('  ok   ' + name + '\n')
  } catch (err) {
    failures.push({ name, err })
    process.stdout.write('  FAIL ' + name + '\n       ' + (err && err.message ? err.message.split('\n')[0] : err) + '\n')
  }
}

function group(name) {
  process.stdout.write('\n' + name + '\n')
}

// ---------------------------------------------------------------------------
// failure-classify: production failures as fixtures
// ---------------------------------------------------------------------------

group('failure-classify: the failures we actually saw')

test('deepseek dead token -> auth', () => {
  const out = classify.classify({
    message: 'Failed to acquire token: "{"code":401,"msg":"invalid token"}" Failed',
  })
  assert.strictEqual(out.category, 'auth')
  assert.match(out.matched, /invalid token|failed to acquire token/)
})

test('qwen 403 is auth, and a bare Forbidden counts too', () => {
  // The production row only carried axios' wording: 'Request failed with status
  // code 403'. The number is the whole evidence, and 403 from these providers
  // means the credential was rejected - so it belongs to selfheal's business,
  // not to client-error (which is 'this request shape is wrong').
  assert.strictEqual(classify.classify('Request failed with status code 403').category, 'auth')
  assert.strictEqual(classify.classify('Forbidden: model not allowed for this key').category, 'auth')
  // Ambiguity is resolved in favour of a human-facing cause whenever the wording
  // is explicit: a captcha demand is never an auth failure.
  assert.strictEqual(classify.classify('captcha required, access forbidden').category, 'captcha')
})

test('deepseek token failure with no status still auth', () => {
  assert.strictEqual(classify.classify({ message: 'Failed to acquire token: Failed (invalid token)' }).category, 'auth')
})

test('bare "HTTP 500" (zai) -> provider-5xx, not unknown', () => {
  const out = classify.classify({ message: 'HTTP 500' })
  assert.strictEqual(out.category, 'provider-5xx')
  assert.strictEqual(out.status, 500)
})

test('a status with no explanation at all -> unknown, and says why', () => {
  // We refuse to invent a cause: a 500 row whose error text we cannot read is
  // reported as unknown, and the row itself records httpStatus + the fact that
  // the provider's body never arrived.
  const out = classify.classify({ status: 500 })
  assert.strictEqual(out.category, 'unknown')
  // 'HTTP 502' is the same shape - gateway gave up, no body - and is likewise
  // not pinned on the provider.
  assert.strictEqual(classify.classify({ message: 'HTTP 502' }).category, 'unknown')
  assert.strictEqual(classify.classify({ message: 'HTTP 502', status: 502 }).category, 'unknown')
  assert.strictEqual(classify.classify({ message: 'Service Unavailable' }).category, 'provider-5xx')
  // Any explanation we recognise plus a 5xx is enough to blame the provider.
  assert.strictEqual(classify.classify({ status: 500, message: 'internal server error' }).category, 'provider-5xx')
})

test('qwen risk-control captcha -> captcha, never auth', () => {
  for (const message of [
    '{"code":"CAPTCHA_REQUIRED","message":"请完成安全验证"}',
    'failed to complete risk control verification',
    '需要验证码验证',
  ]) {
    assert.strictEqual(classify.classify({ message }).category, 'captcha', message)
  }
})

test('captcha wins over a 403 status', () => {
  assert.strictEqual(classify.classify({ message: 'captcha required', status: 403 }).category, 'captcha')
})

test('qwen 403 with no wording -> auth', () => {
  assert.strictEqual(classify.classify({ status: 403 }).category, 'auth')
  assert.strictEqual(classify.classify({ status: 401 }).category, 'auth')
})

test('429 -> rate-limit', () => {
  assert.strictEqual(classify.classify({ status: 429 }).category, 'rate-limit')
  assert.strictEqual(classify.classify({ message: 'Too many requests, slow down' }).category, 'rate-limit')
  assert.strictEqual(classify.classify({ message: 'insufficient balance' }).category, 'rate-limit')
})

test('network errors -> network', () => {
  for (const message of [
    'connect ECONNREFUSED 127.0.0.1:443',
    'socket hang up',
    'getaddrinfo ENOTFOUND api.deepseek.com',
    'timeout of 60000ms exceeded',
  ]) {
    assert.strictEqual(classify.classify({ message }).category, 'network', message)
  }
})

test('400 model-not-supported is client-error, not unknown', () => {
  const out = classify.classify({ status: 400, message: 'invalid request: model not supported' })
  assert.strictEqual(out.category, 'client-error')
  assert.strictEqual(out.retryable, false)
})

test('local 503 "no available account" is not blamed on the provider', () => {
  assert.strictEqual(classify.classify({ status: 503, message: 'no available account' }).category, 'unknown')
})

test('upstream 503 with a server message is provider-5xx', () => {
  assert.strictEqual(classify.classify({ status: 503, message: 'service unavailable' }).category, 'provider-5xx')
})

test('EVERY category is in the documented vocabulary', () => {
  const seen = new Set()
  const samples = [
    'invalid token', 'captcha', 'too many requests', 'ECONNRESET', 'HTTP 503', 'HTTP 400', 'weird',
  ]
  for (const s of samples) seen.add(classify.classify({ message: s }).category)
  for (const c of seen) assert.ok(classify.CATEGORIES.indexOf(c) !== -1, 'unknown category ' + c)
  assert.deepStrictEqual(
    classify.CATEGORIES.slice(0, 6),
    ['auth', 'captcha', 'rate-limit', 'network', 'provider-5xx', 'client-error'],
  )
  assert.strictEqual(classify.CATEGORIES[6], 'unknown')
})

test('classify never throws on junk input', () => {
  for (const input of [null, undefined, 0, '', [], {}, Symbol('x'), { get message() { throw new Error('boom') } }]) {
    const out = classify.classify(input)
    assert.ok(typeof out.category === 'string' && out.category.length, String(input))
  }
})

// ---------------------------------------------------------------------------
// request-log annotation
// ---------------------------------------------------------------------------

group('request-log: annotation')

test('successful row is annotated "none"', () => {
  const row = { statusCode: 200, latency: 120 }
  assert.strictEqual(requestLog.annotate(row), 'none')
  assert.strictEqual(row.failureCategory, 'none')
})

test('zai row keeps the cause and says the body is missing', () => {
  const row = { statusCode: 500, errorMessage: 'HTTP 500', latency: 18000 }
  assert.strictEqual(requestLog.annotate(row), 'provider-5xx')
  assert.strictEqual(row.failureCategory, 'provider-5xx')
  assert.strictEqual(row.providerResponseMissing, true)
  assert.strictEqual(row.httpStatus, 500)
})

test('provider response is captured from err.response.data and truncated', () => {
  const big = 'x'.repeat(9000)
  const row = { statusCode: 500, errorMessage: 'HTTP 500' }
  requestLog.annotate(row, {
    bodyLimit: 2048,
    error: { response: { status: 500, data: '{"error":{"message":"' + big + '"}}' } },
  })
  assert.ok(row.providerResponse, 'expected an excerpt')
  assert.ok(row.providerResponse.length <= 2048, 'length ' + row.providerResponse.length)
  assert.ok(!row.providerResponseMissing, 'must not claim the body is missing when we have it')
})

test('provider headers are kept in the excerpt (request id / retry-after)', () => {
  const row = { statusCode: 429, errorMessage: 'rate limited' }
  requestLog.annotate(row, {
    error: { status: 429, headers: { 'retry-after': '30', 'x-request-id': 'abc123' }, data: '{"error":"quota"}' },
  })
  assert.match(row.providerResponse, /retry-after: 30/)
  assert.match(row.providerResponse, /x-request-id: abc123/)
})

test('body limit is honoured and 1-2 KB is the default', () => {
  assert.strictEqual(requestLog.DEFAULT_BODY_LIMIT, 2048)
  const row = { statusCode: 500, errorMessage: 'HTTP 500' }
  requestLog.annotate(row, { error: { data: 'y'.repeat(5000) } })
  assert.ok(row.providerResponse.length <= 2048)
})

test('failureReason is bounded', () => {
  const row = { statusCode: 500, errorMessage: 'E'.repeat(4000) }
  requestLog.annotate(row, { reasonLimit: 240 })
  assert.ok(row.failureReason.length <= 240, String(row.failureReason.length))
})

test('an existing providerResponse is not overwritten', () => {
  const row = { statusCode: 500, errorMessage: 'HTTP 500', providerResponse: 'from upstream' }
  requestLog.annotate(row, { error: { data: 'other' } })
  assert.strictEqual(row.providerResponse, 'from upstream')
})

test('a frozen row is left alone instead of throwing', () => {
  const row = Object.freeze({ statusCode: 500, errorMessage: 'HTTP 500' })
  assert.doesNotThrow(() => requestLog.annotate(row))
  assert.strictEqual(row.failureCategory, undefined)
})

test('self-heal hint is consulted only for failures whose cause we cannot read', () => {
  const calls = []
  const hint = (msg) => { calls.push(msg); return 'auth' }
  // No cause, no status: our table has nothing to say, self-heal may.
  const unknown = { statusCode: 0, errorMessage: 'Token rejected by DEEPSEEK-PROVIDER-X' }
  requestLog.annotate(unknown, { selfHealHint: hint })
  assert.strictEqual(unknown.failureCategory, 'auth')
  assert.strictEqual(calls.length, 1)

  // A status IS a cause: 5xx is the provider's fault, no need to ask.
  const confident = { statusCode: 500, errorMessage: 'HTTP 500' }
  requestLog.annotate(confident, { selfHealHint: hint })
  assert.strictEqual(confident.failureCategory, 'provider-5xx')
  assert.strictEqual(calls.length, 1, 'a confident answer must not ask self-heal')

  // Only a message that IS a status is a cause; an unexplained message on a
  // 500 row stays unknown so provider-specific knowledge gets a chance.
  const bare = { statusCode: 500, errorMessage: 'mystery failure' }
  requestLog.annotate(bare, { selfHealHint: hint })
  assert.strictEqual(bare.failureCategory, 'auth', 'no cause of our own -> self-heal decides')
  assert.strictEqual(calls.length, 2)
})

test('a throwing self-heal hint cannot break logging', () => {
  const row = { statusCode: 0, errorMessage: 'mystery' }
  assert.doesNotThrow(() => requestLog.annotate(row, { selfHealHint: () => { throw new Error('boom') } }))
  assert.strictEqual(row.failureCategory, 'unknown')
})

group('request-log: wrapping the store')

test('wrapStore wraps adders and backfills existing rows', () => {
  const store = {
    logs: [
      { statusCode: 500, errorMessage: 'Failed to acquire token: "invalid token"' },
      { statusCode: 500, errorMessage: 'HTTP 500' },
      { statusCode: 200 },
    ],
    addLog(row) { this.logs.push(row); return row },
  }
  const result = requestLog.wrapStore(store)
  assert.deepStrictEqual(result.wrapped, ['addLog'])
  assert.strictEqual(result.annotated, 3)
  assert.deepStrictEqual(store.logs.map((r) => r.failureCategory), ['auth', 'provider-5xx', 'none'])

  store.addLog({ statusCode: 403, errorMessage: '' })
  assert.strictEqual(store.logs[3].failureCategory, 'auth')
})

test('wrapping twice does not double-wrap', () => {
  const store = { logs: [], addLog(row) { this.logs.push(row) } }
  requestLog.wrapStore(store)
  const first = store.addLog
  requestLog.wrapStore(store)
  assert.strictEqual(store.addLog, first)
})

test('the wrapper still returns the original value and survives a throwing adder', () => {
  const store = { logs: [], addLog(row) { throw new Error('disk full') } }
  requestLog.wrapStore(store)
  assert.throws(() => store.addLog({ statusCode: 500 }), /disk full/)
})

test('wrapStore on a bare array annotates in place', () => {
  const rows = [{ statusCode: 401, errorMessage: 'unauthorized' }]
  const result = requestLog.wrapStore(rows)
  assert.strictEqual(result.wrapped.length, 0)
  assert.strictEqual(rows[0].failureCategory, 'auth')
})

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

group('stats: percentiles and grouping')

const rows = [
  { statusCode: 200, latency: 100, accountId: 'a1', accountName: 'deepseek-1', providerId: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat' },
  { statusCode: 200, latency: 200, accountId: 'a1', accountName: 'deepseek-1', providerId: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat' },
  { statusCode: 500, latency: 18000, accountId: 'a1', accountName: 'deepseek-1', providerId: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat', failureCategory: 'auth' },
  { statusCode: 500, latency: 120, accountId: 'a2', accountName: 'zai-1', providerId: 'zai', providerName: 'Z.ai', model: 'glm-4.6', failureCategory: 'provider-5xx' },
  { statusCode: 500, latency: 300, accountId: 'a2', accountName: 'zai-1', providerId: 'zai', providerName: 'Z.ai', model: 'glm-4.6', failureCategory: 'provider-5xx' },
  { statusCode: 200, latency: 400, accountId: 'a2', accountName: 'zai-1', providerId: 'zai', providerName: 'Z.ai', model: 'glm-4.6' },
]

test('percentile is nearest-rank on sorted input', () => {
  assert.strictEqual(stats.percentile([], 50), null)
  assert.strictEqual(stats.percentile([100], 95), 100)
  assert.strictEqual(stats.percentile([1, 2, 3, 4], 50), 2)
  assert.strictEqual(stats.percentile([1, 2, 3, 4], 95), 4)
  assert.strictEqual(stats.percentile([10, 20, 30], 50), 20)
})

test("the row's own status word decides success, not a lone statusCode", () => {
  // A stalled token acquire can fail before any HTTP status exists, yet upstream
  // still stamps the row with something. Counting by the word first is what
  // keeps the failure count honest.
  const agg = stats.aggregate([
    { status: 'success', statusCode: 200, latency: 1000 },
    { status: 'error', statusCode: 200, latency: 18000, errorMessage: 'Failed to acquire token: "x" Failed (invalid token)' },
    { status: 'error', latency: 19000, errorMessage: 'HTTP 500' },
  ])
  assert.strictEqual(agg.totalRequests, 3)
  assert.strictEqual(agg.successRequests, 1)
  assert.strictEqual(agg.failedRequests, 2)
})

test('aggregate counts successes and failures', () => {
  const agg = stats.aggregate(rows, { now: 1700000000000 })
  assert.strictEqual(agg.totalRequests, 6)
  assert.strictEqual(agg.successRequests, 3)
  assert.strictEqual(agg.failedRequests, 3)
  assert.deepStrictEqual(agg.failureCategories, { auth: 1, 'provider-5xx': 2 })
})

test('p95 exposes the 18s auth stall', () => {
  const agg = stats.aggregate(rows, { now: 1700000000000 })
  assert.strictEqual(agg.latencies.p50, 200)
  assert.strictEqual(agg.latencies.p95, 18000)
})

test('per-account grouping carries success count and percentiles', () => {
  const agg = stats.aggregate(rows, { now: 1700000000000 })
  const zai = agg.byAccount.find((b) => b.id === 'a2')
  assert.strictEqual(zai.requests, 3)
  assert.strictEqual(zai.success, 1)
  assert.strictEqual(zai.failed, 2)
  assert.strictEqual(zai.p50, 300)
  assert.deepStrictEqual(zai.failureCategories, { 'provider-5xx': 2 })
  const ds = agg.byAccount.find((b) => b.id === 'a1')
  assert.strictEqual(ds.p95, 18000)
})

test('per-provider grouping', () => {
  const agg = stats.aggregate(rows, { now: 1700000000000 })
  const deepseek = agg.byProvider.find((b) => b.id === 'deepseek')
  assert.strictEqual(deepseek.requests, 3)
  assert.strictEqual(deepseek.failed, 1)
  assert.strictEqual(deepseek.successRate, 0.6667)
})

test('per-category grouping counts and times each class', () => {
  const agg = stats.aggregate(rows, { now: 1700000000000 })
  const auth = agg.byCategory.find((b) => b.category === 'auth')
  assert.strictEqual(auth.requests, 1)
  assert.strictEqual(auth.p95, 18000)
})

test('a bounded window keeps only the newest rows', () => {
  const agg = stats.aggregate(rows, { now: 1700000000000, since: { limit: 2 } })
  assert.strictEqual(agg.totalRequests, 2)
  assert.strictEqual(agg.scope.counted, 2)
})

test('latency stored in seconds is normalised to ms', () => {
  const agg = stats.aggregate([{ statusCode: 200, latency: 1.5, timestamp: Date.now() }])
  assert.strictEqual(agg.latencies.p50, 1500)
})

test('junk latency does not poison the percentiles', () => {
  const agg = stats.aggregate([
    { statusCode: 200, latency: 'not-a-number' },
    { statusCode: 200, latency: -5 },
    { statusCode: 200, latency: 100 },
  ])
  assert.strictEqual(agg.latencies.samples, 1)
  assert.strictEqual(agg.latencies.p50, 100)
})

group('stats: merging into the upstream payload')

test('merge never removes an upstream field', () => {
  const upstream = {
    totalRequests: 101,
    successRequests: 50,
    failedRequests: 51,
    avgLatency: 3600,
    requestsPerMinute: 1.7,
    activeConnections: 0,
    modelUsage: { 'deepseek-chat': 12 },
    providerUsage: { deepseek: 12 },
    accountUsage: { a1: 12 },
    dailyStats: [{ date: '2026-11-01', requests: 3 }],
  }
  const before = JSON.parse(JSON.stringify(upstream))
  const agg = stats.aggregate(rows, { now: 1700000000000 })
  const merged = stats.merge(upstream, agg)
  for (const key of Object.keys(before)) {
    assert.deepStrictEqual(merged[key], before[key], 'upstream field ' + key + ' was changed')
  }
  assert.strictEqual(merged.byAccount.length, 2)
  assert.strictEqual(merged.failureCategories.auth, 1)
  assert.strictEqual(merged.latency.p95, 18000)
  // Flat spellings too: a dashboard that only reads top-level numbers should
  // not have to know about our nested object.
  assert.strictEqual(merged.p50, merged.latency.p50)
  assert.strictEqual(merged.p95, 18000)
  assert.strictEqual(merged.avgLatencyP95, 18000)
})

test('merge fills the counters when upstream has none', () => {
  const merged = stats.merge({}, stats.aggregate(rows, { now: 1700000000000 }))
  assert.strictEqual(merged.totalRequests, 6)
  assert.strictEqual(merged.successRequests, 3)
  assert.strictEqual(merged.failedRequests, 3)
})

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

group('catalog: finding things in a bundle graph')

function fakeBundle() {
  const logStore = {
    logs: [{ statusCode: 500, errorMessage: 'HTTP 500', latency: 100 }],
    addLog(row) { this.logs.push(row); return row },
  }
  const statistics = {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    avgLatency: 0,
    getStatistics() { return { totalRequests: 0, successRequests: 0, failedRequests: 0 } },
  }
  return { proxies: { proxyServer: { logs: logStore, stats: statistics } }, unrelated: { a: 1 } }
}

test('explore finds the log store and the statistics provider', () => {
  const survey = catalog.explore(fakeBundle())
  assert.ok(survey.logStores.length >= 1, 'no log store found')
  assert.ok(survey.statistics.length >= 1, 'no statistics provider found')
  assert.match(survey.logStores[0].path, /logs/)
})

test('explore is bounded and survives cycles', () => {
  const a = { name: 'a' }
  const b = { name: 'b', a }
  a.b = b
  const survey = catalog.explore(a, { maxDepth: 3 })
  assert.ok(survey.visited <= catalog.MAX_NODES)
})

test('rowsHolder resolves the array behind a store', () => {
  const store = { logs: [1, 2, 3], addLog() {} }
  const holder = catalog.rowsHolder(store)
  assert.strictEqual(holder.rows, store.logs)
  assert.strictEqual(holder.via, 'logs')
  assert.strictEqual(catalog.rowsHolder([1, 2]).via, 'array')
  assert.strictEqual(catalog.rowsHolder({ nothing: 1 }), null)
})

test('self-heal classifier is optional and mapped onto our vocabulary', () => {
  assert.strictEqual(catalog.selfHealClassifier(null), null)
  assert.strictEqual(catalog.selfHealClassifier({}), null)

  const viaMethod = catalog.selfHealClassifier({ selfheal: { classifyFailure: () => 'server' } })
  assert.strictEqual(viaMethod('x'), 'provider-5xx')

  const viaAuthErrors = catalog.selfHealClassifier({
    selfheal: { authErrors: { classify: () => ({ category: 'auth' }) } },
  })
  assert.strictEqual(viaAuthErrors('x'), 'auth')

  const unknownWord = catalog.selfHealClassifier({ selfheal: { classifyFailure: () => 'somethingelse' } })
  assert.strictEqual(unknownWord('x'), null, 'an unknown word must not become a category')
})

test('self-heal hint that throws is contained by catalog caller', () => {
  const hint = catalog.selfHealClassifier({ selfheal: { classifyFailure: () => { throw new Error('boom') } } })
  assert.throws(() => hint('x'), /boom/)
  // request-log contains it (asserted above); this documents the split.
})

// ---------------------------------------------------------------------------
// install: end to end with a fake bundle
// ---------------------------------------------------------------------------

group('install: end to end')

function fakeShim() {
  const handlers = new Map()
  return {
    ipcMain: {
      handle(channel, fn) { handlers.set(channel, fn) },
      removeHandler(channel) { handlers.delete(channel) },
    },
    __handlers: handlers,
    __httpHandler: () => null,
  }
}

function fakeResponse() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(body) { if (body) this.body += String(body); this.ended = true },
  }
  return res
}

test('install wraps the store, registers channels and reports ready', () => {
  install.reset()
  const bundle = fakeBundle()
  const shim = fakeShim()
  const lines = []
  const report = install.install({ graph: bundle, shim, log: (m) => lines.push(m), now: 1700000000000 })

  assert.strictEqual(report.installed, true)
  assert.strictEqual(report.ready, true)
  assert.ok(report.channels.indexOf('c2a:obs:statistics') !== -1)
  assert.ok(lines.some((l) => /request-log\/instrumentation ready/.test(l)), 'readiness marker missing')

  const store = bundle.proxies.proxyServer.logs
  assert.strictEqual(store.logs[0].failureCategory, 'provider-5xx', 'existing row must be backfilled')
  store.addLog({ statusCode: 500, errorMessage: 'Failed to acquire token: "invalid token"', latency: 18000 })
  assert.strictEqual(store.logs[1].failureCategory, 'auth')
})

test('install is idempotent', () => {
  install.reset()
  const bundle = fakeBundle()
  const shim = fakeShim()
  install.install({ graph: bundle, shim, log: () => {} })
  const added = bundle.proxies.proxyServer.logs.addLog
  const second = install.install({ graph: bundle, shim, log: () => {} })
  assert.strictEqual(bundle.proxies.proxyServer.logs.addLog, added)
  assert.strictEqual(second.ready, true)
})

test('the statistics IPC channel returns our aggregates', () => {
  install.reset()
  const bundle = fakeBundle()
  const shim = fakeShim()
  install.install({ graph: bundle, shim, log: () => {} })
  const payload = shim.__handlers.get('c2a:obs:statistics')({}, {})
  assert.strictEqual(payload.observed.totalRequests, 1)
  assert.strictEqual(payload.failureCategories['provider-5xx'], 1)
  assert.ok(Array.isArray(payload.byAccount))
  assert.ok(payload.latency && 'p95' in payload.latency)
})

test('the request-logs channel pages rows and filters by category', () => {
  install.reset()
  const bundle = fakeBundle()
  const shim = fakeShim()
  install.install({ graph: bundle, shim, log: () => {} })
  const store = bundle.proxies.proxyServer.logs
  store.addLog({ statusCode: 401, errorMessage: 'unauthorized' })
  const page = shim.__handlers.get('c2a:obs:request-logs')({}, { limit: 10 })
  assert.strictEqual(page.stored, 2)
  assert.strictEqual(page.rows.length, 2)
  const onlyAuth = shim.__handlers.get('c2a:obs:request-logs')({}, { failureCategory: 'auth' })
  assert.strictEqual(onlyAuth.total, 1)
  assert.strictEqual(onlyAuth.rows[0].failureCategory, 'auth')
})

test('the annotate channel annotates a foreign row', () => {
  install.reset()
  const shim = fakeShim()
  install.install({ graph: fakeBundle(), shim, log: () => {} })
  const row = { statusCode: 403, errorMessage: '' }
  const out = shim.__handlers.get('c2a:obs:annotate')({}, row)
  assert.strictEqual(out.failureCategory, 'auth')
  assert.strictEqual(row.failureCategory, 'auth')
})

test('the HTTP route hook answers /v0/management/statistics', () => {
  install.reset()
  const shim = fakeShim()
  // A fake upstream handler that records whether it was called.
  let downstream = 0
  const upstreamHandler = (req, res) => { downstream += 1; res.writeHead(404); res.end('upstream') }
  shim.__httpHandler = () => upstreamHandler
  install.install({ graph: fakeBundle(), shim, log: () => {}, routeHookOnly: true })

  const req = { method: 'GET', url: '/v0/management/statistics' }
  const res = fakeResponse()
  const handled = install.answerStatistics(req, res, {})
  assert.strictEqual(handled, true)
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(downstream, 0, 'the upstream handler must not run for our path')
  const payload = JSON.parse(res.body)
  assert.strictEqual(payload.failureCategories['provider-5xx'], 1)
})

test('the route hook leaves other paths to upstream', () => {
  install.reset()
  const shim = fakeShim()
  shim.__httpHandler = () => () => {}
  install.install({ graph: fakeBundle(), shim, log: () => {} })
  const handled = install.answerStatistics({ method: 'POST', url: '/v0/management/statistics' }, fakeResponse(), {})
  assert.strictEqual(handled, false, 'POST is not ours')
  assert.strictEqual(install.answerStatistics({ method: 'GET', url: '/v0/management/accounts' }, fakeResponse(), {}), false)
})

test('install survives a bundle with nothing to instrument', () => {
  install.reset()
  const lines = []
  const shim = fakeShim()
  shim.__httpHandler = () => null   // no captured handler either
  const report = install.install({ graph: { nothing: {} }, shim, log: (m) => lines.push(m) })
  assert.strictEqual(report.installed, true)
  // Channels alone do not count as ready: nothing can be read through them.
  assert.strictEqual(report.findings.logStorePath, undefined)
  assert.strictEqual(report.rows, 0)
  assert.ok(lines.some((l) => /idle/.test(l)))
})

test('install survives a null graph and a missing shim', () => {
  install.reset()
  assert.doesNotThrow(() => install.install({ graph: null, shim: null, log: () => {} }))
  assert.strictEqual(install.report().installed, true)
})

// --- credential redaction ---------------------------------------------------
test('provider excerpts never carry credentials', () => {
  const cases = [
    'Authorization: Bearer sk-abcdefghijklmnop1234567890',
    '{"access_token":"sk-proj-AAAABBBBCCCCDDDD1111"}',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'cookie=__Secure-next-auth.session-token=abcdef1234567890abcdef',
    'x-api-key: 0123456789abcdef',
    '{"password":"hunter2hunter2"}',
    'https://api.x.com/v1/q?api_key=SECRET12345&other=1',
  ]
  for (const raw of cases) {
    const out = requestLog.excerptOf(raw, 400)
    assert.ok(out.includes('[REDACTED]'), 'expected redaction in: ' + out)
    assert.strictEqual(/sk-(?:proj-)?[A-Za-z0-9_-]{12,}/.test(out), false, 'sk- key leaked: ' + out)
    assert.strictEqual(/eyJ[A-Za-z0-9_-]{8,}\./.test(out), false, 'jwt leaked: ' + out)
    assert.strictEqual(/SECRET12345/.test(out), false, 'query secret leaked: ' + out)
    assert.strictEqual(/hunter2/.test(out), false, 'password leaked: ' + out)
  }
})

test('redaction leaves ordinary error text alone', () => {
  const plain = 'ok body without secrets: {"error":{"message":"boom"}}'
  assert.strictEqual(requestLog.excerptOf(plain, 400), plain)
  const wordy = 'data: {"choices":[{"delta":{"content":"Bearer is a great word"}}]}'
  assert.strictEqual(requestLog.excerptOf(wordy, 400), wordy)
})

test('a redacted provider response still classifies as before', () => {
  const row = { status: 'error', statusCode: 500, providerName: 'zai', latency: 10 }
  requestLog.annotate(row, { error: new Error('HTTP 500'), bodyLimit: 2048 })
  assert.strictEqual(row.failureCategory, 'provider-5xx')
  assert.strictEqual(row.providerResponseMissing, true)
})


// --- status wording ---------------------------------------------------------
test('axios-style status messages are read, not guessed', () => {
  // 'Request failed with status code N' is axios' wording: the status IS the
  // whole evidence, just like the bare 'HTTP 500' upstream produces.
  assert.strictEqual(classify.classify('Request failed with status code 403').category, 'auth')
  assert.strictEqual(classify.classify('Request failed with status code 403 (Forbidden)').category, 'auth')
  assert.strictEqual(classify.classify('Request failed with status code 404').category, 'client-error')
  // Markers still win when the text explains itself.
  assert.strictEqual(classify.classify('status code 429 too many requests').category, 'rate-limit')
  // Unanchored mentions of a status stay unexplained on purpose.
  assert.strictEqual(classify.classify('upstream said status code 502').category, 'unknown')
})

test('an empty store that accepts rows is still found', () => {
  // A fresh container has recorded nothing yet; requiring a row would report
  // 'none' and leave the install idle for the whole first boot.
  const store = { logs: [], addLog(row) { this.logs.push(row) } }
  const survey = catalog.explore({ store }, {})
  assert.strictEqual(survey.logStores.length, 1)
  assert.strictEqual(survey.logStores[0].value, store)
})

test('a generic push() alone is not enough to be a log store', () => {
  const thing = { push(value) { this.value = value } }
  assert.strictEqual(catalog.explore({ thing }, {}).logStores.length, 0)
})

test('upstream counters win, our counters fill the gap, observed says which', () => {
  const agg = stats.aggregate([{ statusCode: 200, latency: 100, failureCategory: 'none' }])
  const withUpstream = stats.merge({ totalRequests: 9, successRequests: 8, failedRequests: 1 }, agg, {})
  assert.strictEqual(withUpstream.totalRequests, 9)
  assert.strictEqual(withUpstream.observed.totalRequests, 1)
  assert.strictEqual(withUpstream.observed.source, 'request-log')

  const empty = stats.merge({}, agg, {})
  assert.strictEqual(empty.totalRequests, 1)
  assert.strictEqual(empty.successRequests, 1)
  assert.strictEqual(empty.avgLatency, 100)
})

// ---------------------------------------------------------------------------

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n')
if (failures.length) {
  for (const f of failures) {
    process.stdout.write('\nFAILED: ' + f.name + '\n' + (f.err && f.err.stack ? f.err.stack : f.err) + '\n')
  }
  process.exit(1)
}
