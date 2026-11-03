#!/usr/bin/env node
/**
 * Documentation claims that can be checked by a machine.
 *
 * Documentation rots in a specific way: the prose stays plausible while the
 * numbers in it become wrong (a script renamed, a default changed, a route that
 * moved). Nothing fails, nobody notices, and the person who follows the README
 * gets a confusing error.
 *
 * So every testable claim in README.md is turned into an assertion here, and
 * tests/lint.sh runs this file. Prose is not checked -- only things that have
 * exactly one right answer.
 *
 *   node tests/docs_claims.js        # exit 0 = every claim still true
 *
 * Needs only node. No dependencies, no network, no container.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CLAIMS = []

function claim(what, ok, detail) {
  CLAIMS.push({ what, ok: !!ok, detail })
}

// A checkout that lacks the files this checker reads (a tarball without webui/,
// a partial export) must produce a readable FAIL per claim, not a stack trace.
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch (e) {
    return ''
  }
}
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

/* ------------------------------------------------------------------ docs */

const README = read('README.md')
const README_LINES = README.split('\n')

/** The body of a '### <heading>' section, up to the next heading of that level or higher. */
function section(doc, heading, level) {
  const marker = new Array(level + 1).join('#') + ' ' + heading
  const lines = doc.split('\n')
  const start = lines.findIndex((l) => l.trim() === marker)
  if (start === -1) return null
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (new RegExp('^#{1,' + level + '} ').test(l)) break
    body.push(l)
  }
  return body.join('\n')
}

/* ---------------------------------------------- 1. scripts: docs vs disk */

// Every script the README's 'tests/ 下的每个脚本' table promises to explain.
const TEST_SCRIPTS = [
  'tests/lint.sh',
  'tests/docs_claims.js',
  'tests/smoke.sh',
  'tests/auth_probe.sh',
  'tests/auth_selftest.js',
  'tests/local_harness.js',
  'tests/selfheal.test.js',
  'tests/observability.test.js',
  'tests/observability_integration.js',
  'tests/observability_smoke.sh',
  'tests/observability_realdata.js',
]

for (const f of TEST_SCRIPTS) {
  claim(f + ' exists', exists(f))
}

const testsTable = section(README, '\x60tests/\x60 下的每个脚本', 3) || ''
for (const f of TEST_SCRIPTS) {
  claim('README documents ' + f, testsTable.includes(f))
}

// Nothing in tests/ may be missing from the list above: a script that ships
// undocumented is exactly the drift this file exists to catch.
const onDisk = exists('tests')
  ? fs.readdirSync(path.join(ROOT, 'tests')).filter((n) => /\.(sh|js)$/.test(n)).sort()
  : []
const listed = new Set(TEST_SCRIPTS.map((f) => path.basename(f)))
for (const f of onDisk) {
  claim('tests/' + f + ' is accounted for in this checker', listed.has(f),
    'add it to TEST_SCRIPTS in tests/docs_claims.js, then to the README table')
}

// Directories the README's tree claims to contain.
for (const d of ['shim/selfheal', 'shim/observability', 'webui', 'tests', '.github/workflows']) {
  claim('directory ' + d + '/ exists', exists(d))
}

/* ------------------------------------------ 2. README endpoint inventory */

const EXEMPT = ['/health', '/__login', '/__auth/status']
for (const e of EXEMPT) {
  claim('README says ' + e + ' is exempt from auth', README.includes(e))
}
for (const prefix of ['/stats', '/v0/', '/v1/', '/api/', '/management/']) {
  claim('README lists ' + prefix + ' among the guarded paths', README.includes(prefix))
}

/* ------------------------------------------------- 3. tuning defaults */

// Three files are the source of truth for everything below. In a partial tree
// (tarball export, sparse checkout) they may be absent; say so once instead of
// reporting a dozen derived claims, which buries the real reason.
const NEEDED = ['webui/auth.js', 'webui/server.js', 'shim/selfheal/index.js', 'shim/health.js']
const missing = NEEDED.filter((f) => !exists(f))
if (missing.length) {
  claim('this checkout contains the files the docs describe', false,
    'missing: ' + missing.join(', ') + ' -- run this checker in a full checkout, not a partial export')
  report()
}

const auth = read('webui/auth.js')
const pickInt = (src, name, re) => {
  const m = src.match(re)
  return m ? m[1] : undefined
}
const DEFAULTS = {
  IPC_RATE_PER_MIN: pickInt(auth, 'IPC_RATE_PER_MIN', /IPC_RATE_PER_MIN\s*=\s*envInt\(\s*'CHAT2API_IPC_RATE_PER_MIN'\s*,\s*(\d+)/),
  IPC_BURST: pickInt(auth, 'IPC_BURST', /IPC_BURST\s*=\s*envInt\(\s*'CHAT2API_IPC_BURST'\s*,\s*(\d+)/),
  AUTH_FAIL_LIMIT: pickInt(auth, 'AUTH_FAIL_LIMIT', /AUTH_FAIL_LIMIT\s*=\s*envInt\(\s*'CHAT2API_AUTH_FAIL_LIMIT'\s*,\s*(\d+)/),
  AUTH_LOCK_SECONDS: pickInt(auth, 'AUTH_LOCK_SECONDS', /AUTH_LOCK_MS\s*=\s*envInt\(\s*'CHAT2API_AUTH_LOCK_SECONDS'\s*,\s*(\d+)/),
}

for (const name of Object.keys(DEFAULTS)) {
  claim('webui/auth.js still defines ' + name, DEFAULTS[name] !== undefined)
  if (DEFAULTS[name] === undefined) continue
  // The number only counts as documented if it sits on a line that names the knob.
  const documented = README_LINES.some((l) => l.includes(name) && l.includes(DEFAULTS[name]))
  claim('README quotes ' + name + '=' + DEFAULTS[name], documented,
    'the table row or bullet must carry the value the code uses')
}

// The self-check budget is quoted in prose ("1.5 秒"), so pin it to the code.
const health = read('shim/health.js')
const budget = pickInt(health, 'DEFAULT_BUDGET_MS', /const DEFAULT_BUDGET_MS = Number\(process\.env\.CHAT2API_HEALTH_BUDGET_MS \|\| (\d{3,})\)/)
claim('shim/health.js still defines a report budget', budget !== undefined)
if (budget !== undefined) {
  const secs = String(Number(budget) / 1000)
  claim('README quotes the ' + secs + 's self-check budget', README.includes(secs + ' 秒'))
}

// Self-heal knobs quoted in the README must still be read by the code.
const selfheal = read('shim/selfheal/index.js')
const SELFHEAL_ENVS = [
  'CHAT2API_SELFHEAL',
  'CHAT2API_SELFHEAL_COOLDOWN_MS',
  'CHAT2API_SELFHEAL_COOLDOWN_MAX_MS',
  'CHAT2API_SELFHEAL_DEGRADED_COOLDOWN_MS',
  'CHAT2API_ACCOUNT_RECHECK_SEC',
  'CHAT2API_SELFHEAL_REVALIDATE_FRESH_MS',
  'CHAT2API_SELFHEAL_TIMEOUT_MS',
  'CHAT2API_SELFHEAL_SWEEP_SPACING_MS',
  'CHAT2API_SELFHEAL_SWEEP_MAX_ACCOUNTS',
  'CHAT2API_SELFHEAL_AUTO_STATUS',
]
for (const env of SELFHEAL_ENVS) {
  claim('README lists ' + env, README.includes(env))
  const short = env.replace('CHAT2API_', '')
  claim('shim/selfheal reads ' + env, selfheal.includes(env) || selfheal.includes(short))
}

/* --------------------------------------------- 4. API surface in README */

const server = read('webui/server.js')
for (const route of ['/health', '/__login', '/__auth/status', '/__preload.js', '/__ipc', '/__ipc/events']) {
  claim('webui/server.js serves ' + route, server.includes(route))
}
claim('README documents the /management alias', README.includes('/management/accounts'))
claim('webui/server.js defines the /v0/management upstream prefix', server.includes('/v0/management'))
// Only docs that are supposed to exist: AUTH.md is optional (its content may
// live in the README), UPSTREAM.md is part of the repo by contract.
claim('UPSTREAM.md exists', exists('UPSTREAM.md'))
claim('README tree mentions shim/selfheal', README.includes('selfheal/'))
claim('README tree mentions shim/observability', README.includes('observability/'))

// Failure categories the README quotes must come from the classifier itself,
// otherwise a renamed category leaves the docs describing something that no
// longer exists.
const classify = read('shim/observability/failure-classify.js')
const CATEGORIES = ['auth', 'captcha', 'rate-limit', 'network', 'provider-5xx', 'client-error', 'unknown']
for (const c of CATEGORIES) {
  claim("classifier defines category '" + c + "'", classify.includes("'" + c + "'") || classify.includes('"' + c + '"'))
  claim("README documents category '" + c + "'", README.includes(c))
}

/* ------------------------------------------------------------- report */

function report() {
  const failed = CLAIMS.filter((c) => !c.ok)
  for (const c of failed) {
    console.log('  FAIL  ' + c.what + (c.detail ? ' -- ' + c.detail : ''))
  }
  if (failed.length) {
    console.log('')
    console.log(failed.length + ' of ' + CLAIMS.length + ' documentation claims are stale')
    process.exit(1)
  }
  console.log('  ' + CLAIMS.length + ' documentation claims still hold')
  process.exit(0)
}

report()
