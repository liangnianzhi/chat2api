#!/usr/bin/env node
/**
 * Access-control self-test.
 *
 * Burns its own throwaway server (tests/local_harness.js) and asserts the rules
 * from webui/auth.js over real HTTP: what is refused, what is allowed, and what
 * the browser page flow can do once it holds a cookie.
 *
 *   node tests/auth_selftest.js
 *
 * Exit code 0 = all assertions passed, 1 = at least one failed.
 * Needs only Node >= 18 (built-in fetch); no image, no dependencies.
 */
'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const HARNESS = path.join(__dirname, 'local_harness.js')
const PORT = parseInt(process.env.C2A_TEST_PORT || '18082', 10)
const BASE = 'http://127.0.0.1:' + PORT
const SECRET = 'selftest-secret-0123456789abcdef'

let passed = 0
const failures = []

function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name) } else {
    failures.push(name + (detail ? ' -- ' + detail : ''))
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''))
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
}

async function req(p, opts) {
  opts = opts || {}
  const res = await fetch(BASE + p, {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body,
    redirect: 'manual',
  })
  const text = await res.text()
  return { status: res.status, text, headers: res.headers, setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [] }
}

const JSON_H = { 'Content-Type': 'application/json' }
function bearer(extra) { return Object.assign({ Authorization: 'Bearer ' + SECRET }, extra || {}) }
function ipcBody(channel, args) { return JSON.stringify({ channel: channel, args: args || [] }) }

const PIN_GATE = ['--env', 'CHAT2API_REQUIRE_AUTH=1']

function startHarness(extraArgs) {
  const args = [HARNESS, '--port', String(PORT), '--secret', SECRET].concat(PIN_GATE)
    .concat(PIN_GATE)
    .concat(extraArgs || [])
  // 'inherit' stdio: it must work under a confined shell (piped stdio is denied),
  // and the harness log is read straight off the terminal anyway.
  const child = spawn(process.execPath, args, { stdio: 'inherit' })
  return { child }
}

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000)
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/health')
      if (r.status === 200) return true
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

async function stopHarness(h) {
  if (!h || !h.child || h.child.exitCode !== null) return
  await new Promise((resolve) => {
    h.child.once('exit', resolve)
    try { h.child.kill('SIGTERM') } catch (e) { resolve() }
    setTimeout(resolve, 4000)
  })
}

/* ------------------------------------------------------------------ */
async function phaseGate() {
  console.log('\n[1] unauthenticated access is refused')
  eq('GET /health stays open (healthcheck, monitoring)', (await req('/health')).status, 200)
  const healthRes = await req('/health')
  let healthBody = {}
  try { healthBody = JSON.parse(healthRes.text) } catch (e) { healthBody = {} }
  ok('GET /health reports the gate posture without credentials',
    healthBody.auth && healthBody.auth.required === true && Array.isArray(healthBody.auth.recent))
  eq('the digest says the gate is enforced (not merely required)',
    healthBody.auth && healthBody.auth.mode, 'enforced')
  ok('the /health digest carries no credential',
    !healthRes.text.includes(SECRET) && !JSON.stringify(healthBody).includes(SECRET))
  eq('GET /__login stays open (it issues the session)', (await req('/__login')).status, 200)
  eq('GET /__auth/status stays open', (await req('/__auth/status')).status, 200)

  // A person who types the address into the bar must land somewhere they can
  // act: HTML with a link to /__login, never a bare JSON line.
  const landing = await req('/', { headers: { Accept: 'text/html,application/xhtml+xml' } })
  eq('an unauthenticated browser navigating to / gets 401 (not 403/404)', landing.status, 401)
  ok('that 401 renders a page with a link to /__login',
    landing.text.indexOf('/__login') !== -1 && landing.text.toLowerCase().indexOf('<html') !== -1)
  ok('the page tells the user where the management secret lives',
    landing.text.indexOf('.management-secret') !== -1)
  // The renderer paths stay human paths whatever Accept says: / is the page a
  // person opens, so it keeps the HTML challenge (JSON lives on /v1/** only).
  const headless = await req('/', { headers: { Accept: 'application/json' } })
  eq('a non-HTML client still gets 401', headless.status, 401)
  ok('and / still answers with the page, not JSON',
    headless.text.toLowerCase().indexOf('<html') !== -1 && headless.text.indexOf('/__login') !== -1)
  eq('the login page itself is reachable without a credential', (await req('/__login')).status, 200)

  const cases = [
    ['GET /', req('/')],
    ['GET /__preload.js', req('/__preload.js')],
    ['GET /__ipc/events', req('/__ipc/events')],
    ['GET /management/accounts', req('/management/accounts')],
    ['GET /v0/management/accounts', req('/v0/management/accounts')],
    ['GET /stats', req('/stats')],
    ['GET /v1/models', req('/v1/models')],
    ['POST /__ipc', req('/__ipc', { method: 'POST', headers: JSON_H, body: ipcBody('proxy:getStatus') })],
    ['POST /__login/finish', req('/__login/finish', { method: 'POST', headers: JSON_H, body: '{}' })],
    ['POST /v1/chat/completions', req('/v1/chat/completions', { method: 'POST', headers: JSON_H, body: '{}' })],
  ]
  for (const c of cases) {
    const r = await c[1]
    eq(c[0] + ' without credentials', r.status, 401)
  }

  console.log('\n[2] a wrong or misused credential is refused')
  eq('Bearer with a wrong secret',
    (await req('/__ipc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' }, body: ipcBody('proxy:getStatus') })).status, 401)
  eq('Bearer accepted on the API class',
    (await req('/management/accounts', { headers: bearer() })).status, 200)
  eq('Bearer does not open the UI (no secret in page source)',
    (await req('/', { headers: bearer() })).status, 401)
  eq('Bearer on the UI asset bundle is refused',
    (await req('/__preload.js', { headers: bearer() })).status, 401)
}

async function phaseCsrf() {
  console.log('\n[3] cross-site requests are refused (CSRF)')
  eq('POST with a foreign Origin',
    (await req('/__ipc', { method: 'POST', headers: bearer({ ...JSON_H, Origin: 'http://evil.example' }), body: ipcBody('proxy:getStatus') })).status, 403)
  eq('POST with a foreign Referer',
    (await req('/__ipc', { method: 'POST', headers: bearer({ ...JSON_H, Referer: 'http://evil.example/x' }), body: ipcBody('proxy:getStatus') })).status, 403)
  eq('same-site but different port is still cross-origin',
    (await req('/__ipc', { method: 'POST', headers: bearer({ ...JSON_H, Origin: 'http://127.0.0.1:3000' }), body: ipcBody('proxy:getStatus') })).status, 403)
  eq('Origin: null is refused',
    (await req('/__ipc', { method: 'POST', headers: bearer({ ...JSON_H, Origin: 'null' }), body: ipcBody('proxy:getStatus') })).status, 403)
  eq('GET with a foreign Origin is refused too',
    (await req('/management/accounts', { headers: bearer({ Origin: 'http://evil.example' }) })).status, 403)
  eq('same origin is accepted',
    (await req('/__ipc', { method: 'POST', headers: bearer({ ...JSON_H, Origin: BASE }), body: ipcBody('proxy:getStatus') })).status, 200)

  console.log('\n[4] only JSON bodies are accepted (no simple-request smuggling)')
  const form = await req('/__ipc', { method: 'POST', headers: bearer({ 'Content-Type': 'application/x-www-form-urlencoded' }), body: 'channel=accounts:add' })
  eq('urlencoded POST', form.status, 415)
  // /__ipc is a machine path, so even a 415 uses the upstream body an SDK can
  // parse; the response is JSON, never the HTML page.
  ok('415 explains the expected type', /^application\/json/.test(String(form.headers.get('content-type'))) && !form.text.includes('<html'), String(form.headers.get('content-type')))
  eq('text/plain POST without a body', (await req('/__ipc', { method: 'POST', headers: bearer({ 'Content-Type': 'text/plain' }) })).status, 415)
  eq('multipart POST', (await req('/__ipc', { method: 'POST', headers: bearer({ 'Content-Type': 'multipart/form-data; boundary=x' }), body: '--x--' })).status, 415)
  eq('json with charset is accepted',
    (await req('/__ipc', { method: 'POST', headers: bearer({ 'Content-Type': 'application/json; charset=utf-8' }), body: ipcBody('proxy:getStatus') })).status, 200)

  console.log('\n[5] the management API never inherits an injected secret for free')
  const mgmtNoCred = await req('/management/accounts')
  ok('no credentials -> not proxied', mgmtNoCred.status === 401 && !mgmtNoCred.text.includes('proxied'), mgmtNoCred.text.slice(0, 120))
  const mgmtBearer = await req('/management/accounts', { headers: bearer() })
  ok('Bearer caller gets the secret attached server-side', /Bearer selftest-secret/.test(mgmtBearer.text), mgmtBearer.text.slice(0, 160))
}

async function phaseBrowser() {
  console.log('\n[6] the browser flow: session cookie + CSRF token')
  const login = await req('/__login')
  const cookie = (login.setCookie || []).find((c) => c.startsWith('c2a_session=')) || ''
  ok('GET /__login sets a session cookie', !!cookie, JSON.stringify(login.setCookie))
  ok('the cookie is HttpOnly', /HttpOnly/i.test(cookie), cookie)
  ok('the cookie is SameSite=Strict', /SameSite=Strict/i.test(cookie), cookie)
  ok('the cookie is not readable by script and not Secure on plain http',
    /HttpOnly/.test(cookie) && !/Secure/i.test(cookie), cookie)
  const jsonHeader = /SameSite=Strict/.test(cookie) && !/SameSite=None/i.test(cookie)
  ok('the cookie is not SameSite=None', jsonHeader, cookie)
  const csrf = (/name="c2a-csrf-token" content="([^"]+)"/.exec(login.text) || [])[1] || ''
  ok('GET /__login publishes a CSRF token in a meta tag', /^[0-9a-f]{32}$/.test(csrf), csrf)
  const sess = cookie.split(';')[0]
  const auth = { Cookie: sess }

  eq('the session opens the UI page', (await req('/', { headers: auth })).status, 200)
  const page = await req('/', { headers: auth })
  ok('the UI page carries the preload bridge', page.text.includes('/__preload.js'), page.text.slice(0, 120))
  ok('the UI page carries a per-boot GUI token', page.text.includes('__c2a_gui_token'), page.text.slice(0, 120))
  eq('the session opens /__preload.js', (await req('/__preload.js', { headers: auth })).status, 200)
  eq('the session opens the API class', (await req('/v1/models', { headers: auth })).status, 200)

  eq('IPC without the X-C2A-Request header is refused (cross-site post)',
    (await req('/__ipc', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: BASE }, body: ipcBody('accounts:getAll') })).status, 403)
  const ipc = await req('/__ipc', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: BASE, 'X-C2A-Request': '1' }, body: ipcBody('accounts:getAll') })
  eq('IPC with the header works', ipc.status, 200)
  ok('IPC dispatches to the channel', /"ok":true/.test(ipc.text), ipc.text.slice(0, 120))

  const finishBad = await req('/__login/finish', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ providerId: 'fake', credentials: { t: 1 }, csrf: 'bogus' }) })
  eq('storing a credential without the CSRF token is refused', finishBad.status, 403)
  const finishGood = await req('/__login/finish', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ providerId: 'fake', credentials: { t: 1 }, csrf: csrf }) })
  eq('storing a credential with the CSRF token works', finishGood.status, 200)
  ok('the stored account is reported back', /"ok":true/.test(finishGood.text), finishGood.text.slice(0, 160))

  console.log('\n[7] an empty body stays a validation error, not an auth error')
  const empty = await req('/__login/finish', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ csrf: csrf }) })
  eq('missing providerId/credentials -> 400', empty.status, 400)
  ok('and reports ok:false (the machine-readable marker)', /"ok":false/.test(empty.text), empty.text.slice(0, 160))

  console.log('\n[8] a forged cookie is refused')
  eq('invented session value', (await req('/', { headers: { Cookie: 'c2a_session=sess_forged' } })).status, 401)
  eq('invented token for the API class', (await req('/v1/models', { headers: { Cookie: 'c2a_session=gui_forged' } })).status, 401)
}

async function phaseRateLimit() {
  console.log('\n[9] the IPC bridge is rate limited')
  const h = startHarness(['--env', 'CHAT2API_IPC_RATE_PER_MIN=60,CHAT2API_IPC_BURST=5'])
  try {
    if (!await waitHealthy(15000)) { ok('rate-limit harness starts', false, 'no /health'); return }
    let limited = 0
    for (let i = 0; i < 12; i++) {
      const r = await req('/__ipc', { method: 'POST', headers: bearer(JSON_H), body: ipcBody('proxy:getStatus') })
      if (r.status === 429) limited++
    }
    ok('a burst beyond CHAT2API_IPC_BURST gets 429', limited > 0, 'limited=' + limited)
    // A 429 is a machine-path refusal like any other: SDK-parseable JSON, and the
    // retry hint rides in the header. (Only asserted while still rate limited:
    // the window refills, so a later request legitimately gets a plain 200.)
    // Fire at once, not one-after-another: the bucket refills between awaited
    // requests, which is why a sequential loop sees a mix of 200 and 429. The
    // header is asserted on the first response that is actually rate limited.
    const burst = await Promise.all(Array.from({ length: 12 }, () =>
      req('/__ipc', { method: 'POST', headers: bearer(JSON_H), body: ipcBody('proxy:getStatus') })))
    const last = burst.filter((r) => r.status === 429)[0] || null
    // A throttle still answers in the shape the SDK parses, and it has to carry
    // the retry hint: openai-python backs off from Retry-After first and only
    // then falls back to its own schedule, so a missing header turns one window
    // of throttling into a client that keeps hammering on its own clock.
    ok('a 429 body is JSON, not our envelope or a page',
      !last || (/^application\/json/.test(String(last.headers.get('content-type'))) && !last.text.includes('<html')),
      last ? String(last.headers.get('content-type')) : 'no 429 in burst')
    ok('and the 429 tells the client when to come back (Retry-After is seconds)',
      !!last && /^[0-9]+$/.test(String(last.headers.get('retry-after') || '')),
      last ? 'retry-after=' + last.headers.get('retry-after') : 'no 429 in burst')
    // Throttling is not an authentication challenge: sending WWW-Authenticate
    // would tell the SDK to refresh a credential that is not the problem.
    ok('and the 429 carries no WWW-Authenticate (it is not an auth challenge)',
      !!last && last.headers.get('www-authenticate') === null,
      last ? 'www-authenticate=' + last.headers.get('www-authenticate') : 'no 429 in burst')
  } finally {
    await stopHarness(h)
  }
}

async function phaseNoSecret() {
  console.log('\n[10] a deployment without a management secret fails closed')
  const h = startHarness(['--mode', 'nosecret'])
  try {
    if (!await waitHealthy(15000)) { ok('no-secret harness starts', false, 'no /health'); return }
    eq('/health still open', (await req('/health')).status, 200)
    eq('an empty Bearer does not authenticate', (await req('/management/accounts', { headers: { Authorization: 'Bearer ' } })).status, 401)
    eq('a guessed Bearer does not authenticate', (await req('/management/accounts', { headers: { Authorization: 'Bearer anything' } })).status, 401)
    eq('the API stays closed', (await req('/v1/models')).status, 401)
    const login = await req('/__login')
    eq('the login page still opens (so the operator can see what to fix)', login.status, 200)
    let posture = {}
    try { posture = JSON.parse((await req('/health')).text).auth || {} } catch (e) { posture = {} }
    eq('the digest reports the misconfiguration instead of silence', posture.mode, 'misconfigured')
  } finally {
    await stopHarness(h)
  }
}

/* ------------------------------------------------------------------ *
 * The OpenAI-compatible namespace answers like an API, never like a page.
 *
 * A real client (openai-python, openai-node, LangChain, one-api) parses the body
 * whatever the status is. An HTML login page therefore surfaces as
 * 'Unexpected token <' / JSONDecodeError instead of 'your API key is invalid' -
 * and a wrong key is the common case, not the exotic one. Both branches are
 * pinned here: no credential at all, and a credential that is not accepted.
 * ------------------------------------------------------------------ */
const OPENAI_PATHS = [
  ['GET', '/v1/models'],
  ['POST', '/v1/chat/completions'],
  ['POST', '/v1/embeddings'],
  ['POST', '/v1/completions'],
  ['GET', '/v1/models?stream=true'],
  ['POST', '/v1/chat/completions?stream=true'],
]

function isJsonError(r) {
  const ct = String(r.headers.get('content-type') || '')
  if (ct.toLowerCase().indexOf('application/json') === -1) return 'content-type=' + ct
  if (r.text.toLowerCase().indexOf('<html') !== -1) return 'body contains <html'
  let parsed = null
  try { parsed = JSON.parse(r.text) } catch (e) { return 'body is not JSON' }
  const err = parsed && parsed.error
  if (!err || err.code !== 'invalid_api_key' || err.type !== 'invalid_request_error') {
    return 'body is not the upstream error shape: ' + r.text.slice(0, 120)
  }
  return ''
}

async function phaseOpenAiNamespace() {
  console.log('\n[12] the OpenAI namespace answers 401 as JSON, with or without a credential')
  for (const c of OPENAI_PATHS) {
    const r = await req(c[1], { method: c[0], headers: {}, body: c[0] === 'POST' ? '{}' : undefined })
    eq(c[0] + ' ' + c[1] + ' without a credential is 401', r.status, 401)
    ok(c[0] + ' ' + c[1] + ' without a credential is JSON, not a page', isJsonError(r) === '', isJsonError(r))
    ok(c[0] + ' ' + c[1] + ' without a credential sets X-Chat2API-Auth: required',
      r.headers.get('x-chat2api-auth') === 'required', String(r.headers.get('x-chat2api-auth')))
  }

  // The case that bites a real user: the key is present but wrong.
  for (const c of OPENAI_PATHS) {
    const headers = { Authorization: 'Bearer sk-mgmt-deadbeef' }
    if (c[0] === 'POST') headers['Content-Type'] = 'application/json'
    const r = await req(c[1], { method: c[0], headers: headers, body: c[0] === 'POST' ? '{}' : undefined })
    eq(c[0] + ' ' + c[1] + ' with a wrong key is 401', r.status, 401)
    ok(c[0] + ' ' + c[1] + ' with a wrong key is JSON, not a page', isJsonError(r) === '', isJsonError(r))
  }

  // A bad key on the machine interface must not lock the address out: those
  // clients retry on a schedule, and turning a 401 into a 429 storm looks like
  // an outage (one NAT means one IP for the whole site). Hammer it well past
  // CHAT2API_AUTH_FAIL_LIMIT and insist it is still a plain 401 every time.
  let wrongKeyStatuses = {}
  for (let i = 0; i < 40; i += 1) {
    const r = await req('/v1/models', { headers: { Authorization: 'Bearer sk-mgmt-deadbeef' } })
    wrongKeyStatuses[r.status] = (wrongKeyStatuses[r.status] || 0) + 1
  }
  eq('40 wrong keys on /v1/* are all plain 401s (never 429)', JSON.stringify(wrongKeyStatuses), '{"401":40}')
  const afterHammer = await req('/v1/models', { headers: { Authorization: 'Bearer ' + SECRET } })
  eq('and the real management key still works afterwards', afterHammer.status, 200)

  // The renderer paths keep the human treatment.
  const page = await req('/', { headers: { Accept: 'text/html,application/xhtml+xml' } })
  eq('a browser navigation to / still gets the 401 page', page.status, 401)
  ok('that page is still HTML with the login link',
    page.text.toLowerCase().indexOf('<html') !== -1 && page.text.indexOf('/__login') !== -1)
  const curlRoot = await req('/', { headers: { Accept: '*/*' } })
  // / is a browser path: it keeps the page even for a client that asked for
  // JSON. Only /v1/** has to be JSON, so this one is allowed to be HTML.
  eq('a client with Accept: */* on / still gets the 401 page', curlRoot.status, 401)

  // The IPC bridge keeps the JSON it had (no regression).
  const ipc = await req('/__ipc', { method: 'POST', headers: JSON_H, body: ipcBody('proxy:getStatus') })
  eq('POST /__ipc without credentials is still 401', ipc.status, 401)
  ok('POST /__ipc is still JSON (our envelope, not a page)',
    String(ipc.headers.get('content-type')).indexOf('application/json') !== -1
    && ipc.text.toLowerCase().indexOf('<html') === -1,
    ipc.text.slice(0, 80))
  const events = await req('/__ipc/events')
  eq('GET /__ipc/events without credentials is still 401', events.status, 401)
  const finish = await req('/__login/finish', { method: 'POST', headers: JSON_H, body: '{}' })
  eq('POST /__login/finish without credentials is still 401', finish.status, 401)

  // A management path is not an OpenAI path: it must not switch to the OpenAI body.
  const mgmt = await req('/management/accounts')
  eq('GET /management/accounts without credentials is 401', mgmt.status, 401)
}
async function phaseAudit() {
  console.log('\n[11] the audit entry names the caller and keeps the credential out of the log')
  const probe = 'leaked-secret-value-xyz'
  const logPath = path.join(os.tmpdir(), 'c2a-audit-' + process.pid + '-' + Date.now() + '.log')
  const fd = fs.openSync(logPath, 'w')
  const args = [HARNESS, '--port', String(PORT), '--secret', SECRET].concat(PIN_GATE)
  // stdio is inherited (a confined shell denies pipes); fd 1/2 of the child are the
  // file, while our own test output keeps going to the terminal.
  const child = spawn(process.execPath, args, { stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  const h = { child }
  try {
    if (!await waitHealthy(15000)) { ok('audit harness starts', false, 'no /health'); return }
    await req('/__ipc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + probe }, body: ipcBody('proxy:getStatus') })
    await req('/management/accounts')
    await new Promise((r) => setTimeout(r, 400))
    const log = fs.readFileSync(logPath, 'utf8')
    // One record per line, parsed as JSON so a match can never be stitched
    // together from two unrelated writes.
    const records = log.split(/\r?\n/)
      .filter((line) => line.indexOf('[audit] ') === 0)
      .map((line) => { try { return JSON.parse(line.slice(8)) } catch (e) { return null } })
      .filter(Boolean)
    ok('audit records are single-line JSON', records.length > 0, 'no [audit] records in ' + logPath)
    const deniedIpc = records.filter((r0) => r0.event === 'auth' && r0.result === 'deny' && r0.path === '/__ipc')
    ok('a denied auth is logged', deniedIpc.length > 0)
    ok('the denial names the endpoint', records.some((r0) => r0.path === '/__ipc' && r0.event === 'auth'))
    ok('the denial names the caller IP', deniedIpc.length > 0 && deniedIpc[0].ip === '127.0.0.1')
    ok('the denial carries a machine-readable reason',
      deniedIpc.length > 0 && typeof deniedIpc[0].reason === 'string' && deniedIpc[0].reason.length > 0)
    ok('the offered credential is recorded by shape only (length), never by value',
      deniedIpc.length > 0 && /redacted\(len=\d+\)/.test(String(deniedIpc[0].offeredCredential || '')))
    ok('the offered credential does NOT appear in the log', !log.includes(probe), 'secret found in ' + logPath)
    ok('the real management secret does NOT appear in the log', !log.includes(SECRET), 'secret found in ' + logPath)
    ok('an unauthenticated request is logged with its reason',
      records.some((r0) => r0.path === '/management/accounts' && r0.result === 'deny' && r0.reason === 'no_credential'))
  } finally {
    await stopHarness(h)
    try { fs.unlinkSync(logPath) } catch (e) { /* already gone */ }
  }
}

async function main() {
  if (typeof fetch !== 'function') {
    console.error('this test needs Node 18+ (built-in fetch)')
    process.exit(2)
  }
  const h = startHarness([])
  try {
    if (!await waitHealthy(20000)) {
      console.error('harness did not come up on ' + BASE + ' (see its output above)')
      process.exit(1)
    }
    await phaseGate()
    await phaseCsrf()
    await phaseBrowser()
    await phaseOpenAiNamespace()
  } finally {
    await stopHarness(h)
  }
  await phaseRateLimit()
  await phaseNoSecret()
  await phaseAudit()

  console.log('\n' + passed + ' assertions passed, ' + failures.length + ' failed')
  if (failures.length) {
    for (const f of failures) console.log('  FAILED: ' + f)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('self-test crashed: ' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
