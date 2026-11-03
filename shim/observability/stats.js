/**
 * Statistics over the request log.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Upstream's /v0/management/statistics can only count what it stored, and it
 * stores 'success' as 'statusCode < 400'. That number is useless for the
 * failure we actually have: 51 of 101 requests fail, all of them as an empty
 * 'HTTP 500' with no cause. This module rebuilds the aggregate from the
 * request log (which we now annotate at write time - see request-log.js) so
 * the endpoint can answer:
 *
 *   * how many requests failed, split by failureCategory,
 *   * per account and per provider: success count + latency p50/p95,
 *   * the same per-category latency, because a fixed 18 s wait on a dead token
 *     and a 200 ms captcha rejection are different problems.
 *
 * The module is pure: it takes rows and returns numbers. That keeps it
 * testable without the bundle (tests/observability.test.js).
 */

'use strict'

/** Percentiles an operator can ask for; the endpoint reports all of these. */
const QUANTILES = [50, 95]

/** Buckets of the latency histogram, in ms - finer where requests usually are. */
const EDGES = [
  50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000,
  8000, 10000, 15000, 20000, 30000, 60000, 120000, 300000,
]

/** Latency values above this are treated as junk, not as slow requests. */
const MAX_LATENCY = 24 * 60 * 60 * 1000

/** Convert a latency field to milliseconds, or null when it is unusable. */
function toMillis(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0 || n > MAX_LATENCY) return null
  // Sub-millisecond floats cannot be a JS duration in ms (a timer or a clock
  // difference always yields integers): they are seconds, e.g. 1.5 -> 1500.
  if (!Number.isInteger(n) && n < 1000) return Math.round(n * 1000)
  return n
}

/**
 * Append v to a sorted array, keeping it sorted.
 * A histogram of 20 buckets could not tell 18 s from 30 s in the tail, and the
 * tail is exactly where our failures live, so exact values are kept. The log
 * is bounded (see catalog.js - the buffer is capped), so this stays small.
 */
function insertSorted(list, value) {
  if (!list.length || value >= list[list.length - 1]) {
    list.push(value)
    return
  }
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid] < value) lo = mid + 1
    else hi = mid
  }
  list.splice(lo, 0, value)
}

/** Nearest-rank percentile on an already sorted array. */
function percentile(sorted, p) {
  if (!sorted.length) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[idx]
}

/** A fresh accumulator. */
function newBucket() {
  return {
    requests: 0,
    success: 0,
    failed: 0,
    latencies: [],
    failureCategories: {},
    totalLatency: 0,
  }
}

/** One row → the facts the aggregate needs. */
function factsOf(row) {
  if (!row || typeof row !== 'object') return null
  const statusCode = Number(row.statusCode || row.responseStatus || 0) || 0
  // The row's own 'status' word decides first: upstream marks a row 'error' the
  // moment the request fails, and some providers (a stalled token acquire) die
  // before any HTTP status exists, so an error row may legitimately carry 200.
  const word = typeof row.status === 'string' ? row.status.toLowerCase() : ''
  let ok
  if (word === 'error' || word === 'failed' || word === 'failure') ok = false
  else if (word === 'success' || word === 'ok' || word === 'completed') ok = true
  else if (row.statusCode !== undefined || row.responseStatus !== undefined) ok = statusCode > 0 && statusCode < 400
  else ok = !word
  const latency = toMillis(row.latency)
  const category = row.failureCategory && row.failureCategory !== 'none'
    ? String(row.failureCategory)
    : (ok ? 'none' : 'unknown')
  return {
    ok,
    latency,
    category,
    accountId: String(row.accountId || ''),
    accountName: String(row.accountName || row.accountId || 'unnamed'),
    providerId: String(row.providerId || ''),
    providerName: String(row.providerName || row.providerId || 'unnamed'),
    // Providers are inconsistent about casing ('GLM-5.3' / 'glm-5.3' are one
    // model), and a grouping that splits them is worse than no grouping.
    model: String(row.actualModel || row.model || 'unknown').trim().toLowerCase() || 'unknown',
  }
}

/** Accumulate one row into one bucket. */
function addTo(bucket, fact) {
  bucket.requests += 1
  if (fact.ok) bucket.success += 1
  else bucket.failed += 1
  if (fact.latency !== null) {
    insertSorted(bucket.latencies, fact.latency)
    bucket.totalLatency += fact.latency
  }
  if (!fact.ok) {
    bucket.failureCategories[fact.category] = (bucket.failureCategories[fact.category] || 0) + 1
  }
}

/** Report a bucket: counters plus percentiles, no sorted arrays leaked out. */
function closeBucket(bucket) {
  const n = bucket.latencies.length
  const out = {}
  // Identity first where the bucket has one: byAccount rows are useless to a
  // UI without the account they describe. Keys the bucket does not have are
  // omitted rather than emitted as undefined, so a JSON client sees a clean
  // object and deep equality between runs is stable.
  if (bucket.id !== undefined) out.id = bucket.id
  if (bucket.name !== undefined) out.name = bucket.name
  if (bucket.category !== undefined) out.category = bucket.category
  if (bucket.model !== undefined) out.model = bucket.model
  Object.assign(out, {
    requests: bucket.requests,
    success: bucket.success,
    failed: bucket.failed,
    successRate: bucket.requests ? round(bucket.success / bucket.requests) : null,
    samples: n,
    p50: percentile(bucket.latencies, 50),
    p95: percentile(bucket.latencies, 95),
    avgLatency: n ? Math.round(bucket.totalLatency / n) : null,
  })
  if (Object.keys(bucket.failureCategories).length) {
    out.failureCategories = Object.assign({}, bucket.failureCategories)
  }
  return out
}

function round(x) {
  return Math.round(x * 10000) / 10000
}

/**
 * Aggregate rows.
 *
 * @param {Array<object>} rows request-log rows (oldest or newest first, both fine)
 * @param {object} [options]
 * @param {{from?: number, to?: number, limit?: number}} [options.since] keep only
 *        rows inside a time window; 'limit' keeps the newest N inside it
 * @param {() => number} [options.now] clock, for rows without a timestamp
 * @returns {object} the aggregate
 */
function aggregate(rows, options) {
  const opts = options || {}
  const now = typeof opts.now === 'function' ? opts.now() : Date.now()
  const list = Array.isArray(rows) ? rows : []

  // Normalise timestamps once; upstream stores either ms or a Date/ISO string.
  const normalised = []
  for (const row of list) {
    const fact = factsOf(row)
    if (!fact) continue
    normalised.push({ row, fact, at: stampOf(row, now) })
  }

  let kept = normalised
  const win = opts.since || null
  if (win && (win.from || win.to)) {
    kept = normalised.filter((e) => {
      if (!e.at) return false
      if (win.from && e.at < win.from) return false
      if (win.to && e.at > win.to) return false
      return true
    })
  }
  if (win && Number(win.limit) > 0 && kept.length > win.limit) {
    kept = kept.slice(-Number(win.limit))
  }

  const totals = newBucket()
  const byCategory = new Map()
  const byAccount = new Map()
  const byProvider = new Map()
  const byModel = new Map()

  for (const entry of kept) {
    const f = entry.fact
    addTo(totals, f)
    bumpMap(byCategory, f.category, f, { category: f.category })
    bumpMap(byAccount, f.accountId || 'unknown', f, { id: f.accountId || 'unknown', name: f.accountName, providerId: f.providerId, providerName: f.providerName })
    bumpMap(byProvider, f.providerId || 'unknown', f, { id: f.providerId || 'unknown', name: f.providerName })
    bumpMap(byModel, f.model, f, { model: f.model })
  }

  const closed = (map) => {
    const out = []
    for (const bucket of map.values()) out.push(closeBucket(bucket))
    return out
  }

  const result = {
    scope: {
      window: win && (win.from || win.to) ? { from: win.from || null, to: win.to || null } : null,
      considered: list.length,
      counted: kept.length,
    },
    totalRequests: totals.requests,
    successRequests: totals.success,
    failedRequests: totals.failed,
    successRate: totals.requests ? round(totals.success / totals.requests) : null,
    latencies: closeBucket(totals),
    failureCategories: sortedCategories(totals.failureCategories),
    byCategory: closed(byCategory).sort(byRequestsDesc),
    byAccount: closed(byAccount).sort(byRequestsDesc),
    byProvider: closed(byProvider).sort(byRequestsDesc),
    byModel: closed(byModel).sort(byRequestsDesc),
  }
  // 'latencies' duplicates counters on purpose: it is the exact shape the
  // per-account/per-provider rows have, so a client can read one code path.
  return result
}

function sortedCategories(map) {
  const out = {}
  Object.keys(map)
    .sort((a, b) => map[b] - map[a] || a.localeCompare(b))
    .forEach((k) => { out[k] = map[k] })
  return out
}

function byRequestsDesc(a, b) {
  return (b.requests || 0) - (a.requests || 0) || String(a.name || a.id || '').localeCompare(String(b.name || b.id || ''))
}

function bumpMap(map, key, fact, identify) {
  let bucket = map.get(key)
  if (!bucket) {
    bucket = newBucket()
    if (identify && identify.id !== undefined) bucket.id = identify.id
    if (identify && identify.name !== undefined) bucket.name = identify.name
    if (identify && identify.category !== undefined) bucket.category = identify.category
    if (identify && identify.model !== undefined) bucket.model = identify.model
    if (identify && identify.providerId !== undefined) bucket.providerId = identify.providerId
    if (identify && identify.providerName !== undefined) bucket.providerName = identify.providerName
    map.set(key, bucket)
  }
  addTo(bucket, fact)
}

/** Timestamp in ms, or null. Accepts ms, Date, ISO string, seconds. */
function stampOf(row, now) {
  const raw = row.timestamp !== undefined ? row.timestamp
    : row.at !== undefined ? row.at
      : row.createdAt
  if (raw === undefined || raw === null) return now || null
  if (raw instanceof Date) return raw.getTime()
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    // 10 digits = seconds; anything shorter is treated as an offset from now
    // (upstream stores 'elapsed' on a few rows) only when it is tiny.
    if (raw > 1e11) return raw
    if (raw > 1e9) return raw * 1000
    return now ? now - raw : null
  }
  const asNum = Number(raw)
  if (Number.isFinite(asNum) && String(raw).trim() !== '') return stampOf({ timestamp: asNum }, now)
  const parsed = Date.parse(String(raw))
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Merge our aggregate into a payload in place so that every field upstream
 * already computes survives untouched: we only add keys, never replace them.
 *
 * @param {object} base upstream's statistics object (mutated)
 * @param {object} extra aggregate() output
 * @param {{rows: Array<object>}} [meta] for the 'source' note
 */
function merge(base, extra, meta) {
  const at = base && typeof base === 'object' ? base : {}
  const our = extra || {}

  // Upstream's counters stay authoritative (they cover traffic this process
  // did not log, and clients already read them). When upstream has none at
  // all - an empty store, a provider that was never wired - ours fill in, and
  // 'observed' always says which numbers are ours, so the two sources are
  // never silently mixed.
  const upstreamKnown = typeof at.totalRequests === 'number'
  if (!upstreamKnown) {
    at.totalRequests = our.totalRequests
    at.successRequests = our.successRequests
    at.failedRequests = our.failedRequests
    if (at.avgLatency === undefined) at.avgLatency = our.latencies.avgLatency
  }

  at.observed = {
    totalRequests: our.totalRequests,
    successRequests: our.successRequests,
    failedRequests: our.failedRequests,
    successRate: our.successRate,
    source: (meta && meta.source) || 'request-log',
  }
  at.latency = {
    samples: our.latencies.samples,
    p50: our.latencies.p50,
    p95: our.latencies.p95,
    avg: our.latencies.avgLatency,
  }
  // Flat spellings as well: dashboards and ad-hoc scripts reach for plain
  // numbers far more often than for a nested object.
  at.p50 = our.latencies.p50
  at.p95 = our.latencies.p95
  at.avgLatencyP50 = our.latencies.p50
  at.avgLatencyP95 = our.latencies.p95
  at.failureCategories = our.failureCategories
  at.byCategory = our.byCategory
  at.byAccount = our.byAccount
  at.byProvider = our.byProvider
  at.byModel = our.byModel
  at.window = our.scope
  return at
}

module.exports = {
  QUANTILES,
  EDGES,
  MAX_LATENCY,
  toMillis,
  percentile,
  aggregate,
  merge,
  stampOf,
  factsOf,
}
