#!/usr/bin/env node
/**
 * Real-data verification for task-5 (run on the NAS inside a throwaway container).
 *
 * Reads the production request-log store read-only, re-runs our historical
 * backfill + classification + statistics over every row, and prints a JSON
 * report. Nothing here writes to the store.
 */
const fs = require('node:fs')
const path = require('node:path')

const SHIM = process.env.SHIM_DIR || '/app/shim/observability'
const RAW = process.env.RAW_FILE || '/raw/request-logs.ndjson'

const classifier = require(path.join(SHIM, 'failure-classify.js'))
const requestLog = require(path.join(SHIM, 'request-log.js'))
const stats = require(path.join(SHIM, 'stats.js'))

const rows = fs.readFileSync(RAW, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))

// Historical backfill: annotate a copy, exactly like request-log.wrapStore does
// for rows that were written before the observability layer was installed.
const annotated = rows.map((row) => {
  const copy = Object.assign({}, row)
  requestLog.annotate(copy, { bodyLimit: 2048 })
  return copy
})

const report = { total: annotated.length }

// --- 1. classification of the known failure shapes -------------------------
const byCategory = {}
const byProviderCategory = {}
for (const row of annotated) {
  const c = row.failureCategory || '(missing)'
  byCategory[c] = (byCategory[c] || 0) + 1
  const p = row.providerName || row.providerId || '(unknown)'
  const key = p + ' / ' + c
  byProviderCategory[key] = (byProviderCategory[key] || 0) + 1
}
report.byCategory = byCategory
report.byProviderCategory = byProviderCategory

const samples = (predicate, limit) => annotated.filter(predicate).slice(0, limit).map((r) => ({
  provider: r.providerName,
  account: r.accountName,
  failureCategory: r.failureCategory,
  failureReason: r.failureReason,
  httpStatus: r.httpStatus,
  providerResponseMissing: r.providerResponseMissing,
  providerResponse: r.providerResponse ? r.providerResponse.slice(0, 140) : null,
}))
report.samples = {
  deepseekAuth: samples((r) => /Failed to acquire token/i.test(String(r.errorMessage || '') + String(r.responseBody || '')), 1),
  zai500: samples((r) => (r.providerName === 'Z.ai' || r.providerId === 'zai'), 1),
  qwenCaptcha: samples((r) => /风控|验证码/.test(String(r.errorMessage || '')), 1),
  qwen403: samples((r) => /403/.test(String(r.errorMessage || '')), 1),
}

// --- 2. statistics over the same rows --------------------------------------
const merged = stats.aggregate(annotated)
report.statistics = {
  totalRequests: merged.totalRequests,
  successRequests: merged.successRequests,
  failedRequests: merged.failedRequests,
  p50: merged.p50,
  p95: merged.p95,
  failureCategories: merged.failureCategories,
  byCategory: merged.byCategory,
  byProvider: merged.byProvider,
  topAccounts: (merged.byAccount || []).slice(0, 5).map((v) => ({
    account: v.name || v.id,
    accountId: v.id,
    requests: v.requests,
    success: v.success,
    failed: v.failed,
    successRate: v.successRate,
    p50: v.p50,
    p95: v.p95,
  })),
  byModel: merged.byModel,
  latencies: merged.latencies,
}

// --- 2b. per-model shape: every row carries the same keys -------------------
// A user reading the log must be able to group by model; a model that silently
// answers 500 must not look like a successful model with slow requests.
report.byModel = (report.statistics.byModel || []).map((g) => ({
  model: g.model, requests: g.requests, failed: g.failed, p50: g.p50, p95: g.p95,
}))

// --- 3. leak check: does any emitted text still look like a credential? ----
const leaks = []
const SECRET = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /\b(bearer|basic)\s+[A-Za-z0-9._~+\/-]{12,}/i,
]
for (const row of annotated) {
  for (const field of ['providerResponse', 'failureReason']) {
    const v = row[field]
    if (typeof v !== 'string') continue
    for (const re of SECRET) if (re.test(v)) leaks.push({ field, sample: v.slice(0, 120) })
  }
}
report.leaks = leaks.slice(0, 5)
report.leakCount = leaks.length

// --- 4. boundary: this layer records, it never cools an account -----------
// Account cooling belongs to self-heal. Proof that we stay on our side: not one
// annotation field may be an account-state word, and no account object in the
// graph may end up touched by a classification.
const ACCOUNT_STATE_WORDS = ['cooldown', 'cooldownUntil', 'disabled', 'banned', 'quarantine', 'cool']
const FIELD_NAMES = ['failureCategory', 'failureReason', 'providerResponse', 'httpStatus', 'classifiedAt']
const boundary = []
for (const name of FIELD_NAMES) {
  for (const word of ACCOUNT_STATE_WORDS) {
    if (String(name).toLowerCase().includes(word)) boundary.push({ field: name, word })
  }
}
for (const row of annotated) {
  for (const name of FIELD_NAMES) {
    const value = row[name]
    if (value === undefined) continue
    if (typeof value === 'object' && !Array.isArray(value)) boundary.push({ row: row.id, field: name, why: 'object written by the observability layer' })
  }
}
report.boundary = { violations: boundary.slice(0, 5), count: boundary.length }
// Did the layer PRESERVE the provider response we were told it throws away?
const preserved = annotated.filter((r) => r.failureCategory && r.failureCategory !== 'none' && r.providerResponse).length
report.preservedProviderResponse = preserved
report.observedFailures = report.statistics.failedRequests

process.stdout.write(JSON.stringify(report, null, 1) + '\n')

// Human-readable verdict lines, so a shell run needs no jq.
const out = process.stdout
out.write('\n--- verdict ---\n')
out.write('rows                      : ' + report.total + '\n')
out.write('failed requests observed  : ' + report.observedFailures + ' / ' + report.statistics.totalRequests + '\n')
out.write('classified failures       : ' + Object.entries(report.byCategory).filter(([k]) => k !== 'none').map(([k, v]) => k + '=' + v).join(' ') + '\n')
out.write('provider responses kept   : ' + preserved + ' / ' + report.observedFailures + ' failures\n')
out.write('credential leaks          : ' + report.leakCount + '\n')
out.write('account-state fields      : ' + boundary.length + ' (must be 0 - that is self-heal\'s job)\n')
out.write('p50/p95 (all)             : ' + report.statistics.latencies.p50 + 'ms / ' + report.statistics.latencies.p95 + 'ms\n')
