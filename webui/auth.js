/**
 * Access control for the single public port.
 *
 * ON BY DEFAULT?
 * --------------
 * No. CHAT2API_REQUIRE_AUTH defaults to 0: this image is meant for a private
 * LAN (a NAS on the household network), where the door being open is the
 * point - no login page between the operator and the UI, no token to copy
 * into a client. The gate below still runs, and still does the two things
 * that are not about identity - same-origin provenance and a JSON content
 * type on state-changing requests - because those cost nothing and stop a
 * stray web page from rewriting the config. For anything reachable beyond the
 * LAN, set CHAT2API_REQUIRE_AUTH=1 and the whole model below applies.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Everything the container can do is reachable on port 8082: the IPC bridge
 * (add/delete accounts, rewrite config, start OAuth), the SSE event stream and
 * the whole management API. Before this module, any client that could open a
 * TCP connection to that port could drive all of it - and the management
 * secret was attached by the server itself, so "reach the port" equalled
 * "administrator". On a NAS where several containers share one Docker network,
 * that is not a boundary at all.
 *
 * THE MODEL
 * ---------
 *   Authorization: Bearer <management secret>   -> API clients (scripts, curl)
 *   Cookie  c2a_session=<...>                   -> this browser, after visiting
 *                                                  /__login once
 *   GUI token in the page (window.__c2a_gui_token)
 *                                               -> the renderer UI, fetched by
 *                                                  GET / or /__preload.js
 *
 * Requests are sorted into three classes before any handler runs:
 *
 *   exempt       /health, /__auth/status, GET /__login, its CSS
 *   api          /v1/*, /v0/*, /api/*, /management/*, /stats, /__ipc*
 *   gui          the renderer UI and its assets
 *
 * Bearer identifies only the 'api' class; everything else needs a session
 * cookie, so a leaked API token cannot silently become a UI session. The GUI
 * paths hand the renderer a per-boot token instead of the long-lived secret,
 * which keeps the secret out of the page source.
 *
 * CROSS-SITE REQUESTS
 * -------------------
 * Requests that carry a browser provenance header (Origin / Referer) must come
 * from this host. That covers same-site cross-port pages
 * (http://127.0.0.1:3000:8082), which SameSite=Strict alone does not stop.
 *
 * Separately, every state-changing request needs Content-Type: application/json
 * (or text/plain, guarded by a custom header) - the two "simple request"
 * content types a cross-origin page could otherwise use to skip the preflight.
 *
 * THROTTLING AND AUDIT
 * ---------------------
 * Wrong credentials are counted per client address; past the limit the address
 * is locked out for a while, so a LAN attacker cannot grind the secret. The IPC
 * bridge has its own token bucket, because one POST there is one desktop-IPC
 * call (add/delete an account). Every deny is written as one '[audit] {json}'
 * line on stdout with the reason, the path and the client - and never the
 * credential, not even the caller's own guess: a guess may be a real secret for
 * another service. A ring of the last 64 lines is exposed on /health.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No 'requests from 127.0.0.1 or the private network are trusted' rule. Inside
 * a container every inbound connection arrives from a bridge address, and
 * Docker's port mapping presents every LAN client the same way, so 'it came
 * from the LAN' cannot be told apart from 'it came from localhost'. A trust rule
 * keyed on the address would re-open exactly the hole this module closes. The
 * management secret is attached server-side only for a caller that already
 * proved it holds that secret (see prepareForGateway in server.js), never for
 * a caller that merely reached the port.
 */

'use strict'

const crypto = require('crypto')

/* ------------------------------------------------------------------ *
 * Tunables (env, all optional)
 * ------------------------------------------------------------------ */
function envInt(name, def) {
  const raw = parseInt(process.env[name] || '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : def
}
function envBool(name, def) {
  const raw = (process.env[name] || '').trim().toLowerCase()
  if (!raw) return def
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

// OFF by default: this deployment lives on a private LAN (CHAT2API_REQUIRE_AUTH=1
// turns the gate back on for an instance that is reachable from elsewhere).
const REQUIRE_AUTH = envBool('CHAT2API_REQUIRE_AUTH', false)
const TRUST_PROXY = envBool('CHAT2API_TRUST_PROXY', false)
const COOKIE_NAME = process.env.CHAT2API_COOKIE_NAME || 'c2a_session'
const SESSION_TTL_MS = envInt('CHAT2API_SESSION_TTL_MINUTES', 720) * 60 * 1000
const COOKIE_SECURE = envBool('CHAT2API_COOKIE_SECURE', false)
const GUI_TOKEN_TTL_MS = envInt('CHAT2API_GUI_TOKEN_TTL_MINUTES', 12 * 60) * 60 * 1000
const ALLOW_LOOPBACK_PROVENANCE = envBool('CHAT2API_ALLOW_LOOPBACK_ORIGIN', false)
const TRUSTED_ORIGINS = (process.env.CHAT2API_TRUSTED_ORIGINS || '')
  .split(',').map((s) => s.trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean)

const IPC_RATE_PER_MIN = envInt('CHAT2API_IPC_RATE_PER_MIN', 120)
const IPC_BURST = envInt('CHAT2API_IPC_BURST', 40)
const AUTH_FAIL_LIMIT = envInt('CHAT2API_AUTH_FAIL_LIMIT', 30)
// How long a throttled client is told to wait. The token bucket refills per
// minute, so one minute is the honest answer for both gates.
//
// Capped at one hour. envInt only guarantees a positive integer, so a stray
// CHAT2API_RETRY_AFTER=99999999999999999999 would otherwise go out as
// Retry-After: 1e20, which many HTTP clients overflow into Infinity or throw
// on - and a client that cannot parse Retry-After falls back to retrying with
// no backoff at all, the exact opposite of what the header is there for. The
// cap lives at this call site, not inside envInt, so the other tunables keep
// their current behaviour.
const RETRY_AFTER_MAX = 3600
const RETRY_AFTER_SECONDS = Math.min(envInt('CHAT2API_RETRY_AFTER', 60), RETRY_AFTER_MAX)
const AUTH_LOCK_MS = envInt('CHAT2API_AUTH_LOCK_SECONDS', 120) * 1000

/* ------------------------------------------------------------------ *
 * Constant-time comparison
 * ------------------------------------------------------------------ */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  try {
    return crypto.timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Sessions and GUI tokens
 * ------------------------------------------------------------------ */
const sessionStore = new Map() // sha256(token) -> expiresAt
const guiStore = new Map() // sha256(token) -> expiresAt

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex')
}

function mint(kind, ttlMs) {
  const token = kind + '_' + crypto.randomBytes(32).toString('base64url')
  const store = kind === 'sess' ? sessionStore : guiStore
  store.set(hashToken(token), Date.now() + ttlMs)
  return token
}

function prune(store) {
  const now = Date.now()
  for (const [k, exp] of store) if (exp <= now) store.delete(k)
}

const MAX_SESSIONS = envInt('CHAT2API_MAX_SESSIONS', 24)
const MAX_GUI_TOKENS = envInt('CHAT2API_MAX_GUI_TOKENS', 200)

function mintBounded(store, kind, ttlMs, cap) {
  prune(store)
  while (store.size >= cap) store.delete(store.keys().next().value)
  const token = kind + '_' + crypto.randomBytes(32).toString('base64url')
  store.set(hashToken(token), Date.now() + ttlMs)
  return token
}

function validIn(store, token, ttlMs, extend) {
  if (typeof token !== 'string' || !token) return false
  const key = hashToken(token)
  const exp = store.get(key)
  if (!exp) return false
  if (exp <= Date.now()) { store.delete(key); return false }
  if (extend && exp - Date.now() < ttlMs - 60 * 1000) store.set(key, Date.now() + ttlMs)
  return true
}

function createSession() { return mintBounded(sessionStore, 'sess', SESSION_TTL_MS, MAX_SESSIONS) }
function createGuiToken() { return mintBounded(guiStore, 'gui', GUI_TOKEN_TTL_MS, MAX_GUI_TOKENS) }
function revokeAllSessions() { sessionStore.clear() }
function isSessionValid(token) { return validIn(sessionStore, token, SESSION_TTL_MS, true) }
function isGuiTokenValid(token) { return validIn(guiStore, token, GUI_TOKEN_TTL_MS, true) }

// What an internet-facing 8082 actually gets hit with.
const WEAK_SECRETS = new Set([
  'changeme', 'change-me', 'password', 'admin', 'secret', 'chat2api', '123456',
  '12345678', '123456789', '1234567890', 'qwerty', 'test', 'root', 'letmein',
  'default', 'pass', 'admin123', 'password123', 'chat2api-secret', 'secret123',
])

function secretProblems(secret) {
  const problems = []
  if (!secret) {
    problems.push('no secret configured (set CHAT2API_MANAGEMENT_SECRET or let the entrypoint generate the secret file)')
    return problems
  }
  if (WEAK_SECRETS.has(secret.toLowerCase())) problems.push('secret is a well-known default value')
  if (secret.length < 16) problems.push('secret is shorter than 16 characters')
  if (/^(.)\1+$/.test(secret)) problems.push('secret is a single repeated character')
  if (/^(0123456789|abcdefghij|qwertyuiop)/i.test(secret)) problems.push('secret is a keyboard sequence')
  return problems
}

/* ------------------------------------------------------------------ *
 * Headers helpers
 * ------------------------------------------------------------------ */
function firstHeader(req, name) {
  const v = req.headers[name]
  if (Array.isArray(v)) return v[0] || ''
  return typeof v === 'string' ? v : ''
}

function hostCandidates(req) {
  const out = []
  const direct = firstHeader(req, 'host').trim().toLowerCase()
  if (direct) out.push(direct)
  if (TRUST_PROXY) {
    for (const raw of [firstHeader(req, 'x-forwarded-host'), firstHeader(req, 'x-original-host')]) {
      const h = raw.split(',')[0].trim().toLowerCase()
      if (h) out.push(h)
    }
  }
  return out
}

function requestScheme(req) {
  if (TRUST_PROXY) {
    const proto = firstHeader(req, 'x-forwarded-proto').split(',')[0].trim().toLowerCase()
    if (proto === 'https' || proto === 'http') return proto
  }
  if (req.socket && req.socket.encrypted) return 'https'
  return 'http'
}

function isLoopbackName(hostWithPort) {
  const name = String(hostWithPort).replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/* ------------------------------------------------------------------ *
 * Origin / Referer
 * ------------------------------------------------------------------ */
function parseOrigin(value) {
  try {
    const u = new URL(value)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return {
      origin: (u.protocol + '//' + u.host).toLowerCase(),
      host: u.host.toLowerCase(),
      hostname: u.hostname.toLowerCase(),
    }
  } catch {
    return null
  }
}

/**
 * Why a cross-origin request would be rejected, or { ok: true } when it is
 * fine. When neither Origin nor Referer is present the request is not
 * browser-initiated and this check has nothing to say - the credential check
 * still applies.
 */
function checkProvenance(req) {
  const originHeader = firstHeader(req, 'origin').trim()
  const refererHeader = firstHeader(req, 'referer').trim()
  let refererHost = null

  if (!originHeader && refererHeader) {
    const parsedRef = parseOrigin(refererHeader)
    if (!parsedRef) return { ok: false, reason: 'malformed_referer', browserInitiated: true }
    refererHost = parsedRef.host
  }
  if (!originHeader && !refererHost) return { ok: true, state: 'absent', browserInitiated: false }

  const hosts = hostCandidates(req)
  if (!hosts.length) return { ok: false, reason: 'missing_host', browserInitiated: true }

  const sameOrigin = (host) => hosts.includes(host)
  const trusted = (host) => TRUSTED_ORIGINS.some((t) => {
    const p = parseOrigin(t)
    return p && (p.host === host || p.origin === host)
  })
  const loopbackOk = (hostname) =>
    ALLOW_LOOPBACK_PROVENANCE && isLoopbackName(hostname) && hosts.every(isLoopbackName)

  if (originHeader) {
    if (originHeader === 'null') return { ok: false, reason: 'null_origin', browserInitiated: true }
    const parsed = parseOrigin(originHeader)
    if (!parsed) return { ok: false, reason: 'malformed_origin', browserInitiated: true }
    if (trusted(parsed.origin)) return { ok: true, state: 'trusted', browserInitiated: true }
    if (sameOrigin(parsed.host)) return { ok: true, state: 'same', browserInitiated: true }
    if (loopbackOk(parsed.hostname)) return { ok: true, state: 'loopback', browserInitiated: true }
    return { ok: false, reason: 'cross_origin', origin: parsed.origin, host: hosts[0], browserInitiated: true }
  }

  if (trusted(refererHost)) return { ok: true, state: 'trusted', browserInitiated: true }
  if (sameOrigin(refererHost)) return { ok: true, state: 'same', browserInitiated: true }
  if (loopbackOk(refererHost)) return { ok: true, state: 'loopback', browserInitiated: true }
  return { ok: false, reason: 'cross_referer', referer: refererHost, host: hosts[0], browserInitiated: true }
}

/* ------------------------------------------------------------------ *
 * Cookies
 * ------------------------------------------------------------------ */
function readCookie(req, name) {
  const raw = firstHeader(req, 'cookie')
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() !== name) continue
    const value = part.slice(idx + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return ''
}

function sessionCookieHeader(token) {
  const attrs = [
    COOKIE_NAME + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
  ]
  if (COOKIE_SECURE) attrs.push('Secure')
  return attrs.join('; ')
}

function clearSessionCookieHeader() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
}

/* ------------------------------------------------------------------ *
 * Request classification
 * ------------------------------------------------------------------ */
const EXEMPT_EXACT = new Set(['/health', '/__auth', '/__auth/status', '/favicon.ico'])
const API_EXACT = new Set(['/stats', '/__ipc', '/__ipc/events', '/__ipc/config'])
const API_PREFIXES = ['/v0', '/v1', '/api', '/management']
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'])

// The machine interface: an OpenAI-compatible SDK talks to these and parses the
// body unconditionally. Those paths get the JSON an SDK can read; the renderer's
// own paths get the page a person can click. /v1 and /v0 are a different
// namespace from the container's own /__ipc, and a non-API-key credential is
// still a client mistake there, never a browser to redirect.
const OPENAI_PREFIXES = ['/v0', '/v1', '/api']

function isOpenAiNamespace(pathname) {
  return OPENAI_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

function classify(method, pathname) {
  if (EXEMPT_EXACT.has(pathname)) return 'exempt'
  if (pathname === '/__login') return 'exempt'
  if (pathname.startsWith('/__login/assets/')) return 'exempt'
  if (pathname.startsWith('/__auth/')) return 'exempt'
  if (API_EXACT.has(pathname)) return 'api'
  if (isOpenAiNamespace(pathname)) return 'openai'
  if (API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) return 'api'
  return 'gui'
}

/* ------------------------------------------------------------------ *
 * Rate limiting + credential throttle
 * ------------------------------------------------------------------ */
const buckets = new Map()

function takeToken(key, perMin, burst) {
  const now = Date.now()
  const refillPerMs = perMin / 60000
  let b = buckets.get(key)
  if (!b) { b = { tokens: burst, last: now }; buckets.set(key, b) }
  b.tokens = Math.min(burst, b.tokens + (now - b.last) * refillPerMs)
  b.last = now
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

const authFailures = new Map()

function registerAuthFailure(ip) {
  const now = Date.now()
  let rec = authFailures.get(ip)
  if (!rec) { rec = { count: 0, windowStart: now, lockedUntil: 0 }; authFailures.set(ip, rec) }
  if (now - rec.windowStart > AUTH_LOCK_MS) { rec.count = 0; rec.windowStart = now }
  rec.count += 1
  if (rec.count >= AUTH_FAIL_LIMIT) {
    rec.lockedUntil = now + AUTH_LOCK_MS
    rec.count = 0
    rec.windowStart = now
    return true
  }
  return false
}

function isLockedOut(ip) {
  const rec = authFailures.get(ip)
  if (!rec) return 0
  const left = rec.lockedUntil - Date.now()
  return left > 0 ? left : 0
}

function clearAuthFailures(ip) { authFailures.delete(ip) }

setInterval(() => {
  const now = Date.now()
  for (const [k, b] of buckets) {
    if (b.tokens >= IPC_BURST || now - b.last > 10 * 60 * 1000) buckets.delete(k)
  }
  for (const [ip, rec] of authFailures) {
    if (rec.lockedUntil < now && now - rec.windowStart > AUTH_LOCK_MS) authFailures.delete(ip)
  }
  prune(sessionStore)
  prune(guiStore)
}, 5 * 60 * 1000).unref()

/* ------------------------------------------------------------------ *
 * Audit log - never the credential itself
 * ------------------------------------------------------------------ */
const AUDIT_RING = 64
const auditRecent = []
const SECRET_PATTERNS = [
  [/\b(Bearer)\s+[^\s,;"']+/gi, '$1 [redacted]'],
  [/\b((?:[A-Za-z0-9_-]*(?:secret|token|password|passwd|apikey|api_key)[A-Za-z0-9_-]*)=)[^&\s;"']+/gi, '$1[redacted]'],
  [/\b(?:sess|gui)_[A-Za-z0-9_-]{16,}/g, '[redacted-token]'],
  [/("(?:token|password|authorization|apiKey|secret)"\s*:\s*")[^"]*/gi, '$1[redacted]'],
]

function redact(text) {
  let out = String(text === null || text === undefined ? '' : text)
  for (const pair of SECRET_PATTERNS) out = out.replace(pair[0], pair[1])
  // The live management secret is known, so scrub it by value too: a caller who
  // guesses right would otherwise be the one entry that lands in plain text.
  const secret = currentSecret()
  if (secret && secret.length >= 8 && out.indexOf(secret) !== -1) out = out.split(secret).join('[redacted-secret]')
  return out.slice(0, 300)
}

function audit(entry) {
  const line = {
    t: new Date().toISOString(),
    at: 'audit',
    event: entry.event,
    result: entry.result,
    method: entry.method,
    path: entry.path,
    ip: entry.ip,
  }
  if (entry.reason) line.reason = entry.reason
  // Both fields are already credential-free by construction (reason strings,
  // lengths, origins); redact() is a second belt for anything passed through.
  if (entry.detail) line.detail = redact(entry.detail)
  if (entry.offeredCredential) line.offeredCredential = redact(entry.offeredCredential)
  // The request context (path, client, what kind of credential was used) is
  // carried in for every decision. It never holds a credential - the caller
  // spreads ctx, and ctx.auth is a label such as 'bearer' or 'session' - but it
  // still goes through redact(), so a field added later cannot leak by accident.
  if (entry.class) line.class = redact(entry.class)
  if (entry.auth && entry.auth !== 'none') line.auth = redact(entry.auth)
  const text = JSON.stringify(line)
  process.stdout.write('[audit] ' + text + '\n')
  // Also into the ring buffer that /health exposes to an operator (see
  // snapshotAuth()); counts and redacted reasons only, never a credential.
  auditRecent.push(text)
  if (auditRecent.length > AUDIT_RING) auditRecent.shift()
}

/**
 * Operator-facing view of the gate: is it on, are clients being throttled, and
 * what did the last few rejections look like. Mounted on /health so a NAS
 * operator can see brute force attempts without reading container logs.
 */
function snapshotAuth() {
  const now = Date.now()
  const locked = []
  for (const [ip, rec] of authFailures) {
    const left = rec.lockedUntil - now
    if (left > 0) locked.push({ ip: ip, seconds: Math.ceil(left / 1000), failures: rec.count })
  }
  return {
    // 'enforced' | 'disabled' (CHAT2API_REQUIRE_AUTH=false) | 'misconfigured'
    // (no usable secret, so every gated endpoint is closed - fail closed, not open)
    mode: !REQUIRE_AUTH
      ? 'disabled'
      : (secretProblems(currentSecret()).length ? 'misconfigured' : 'enforced'),
    required: REQUIRE_AUTH,
    secret: secretProblems(currentSecret()).length ? 'invalid' : 'ok',
    sessions: sessionStore.size,
    locked: locked.slice(0, 8),
    recent: auditRecent.slice(-8),
  }
}

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */
function baseHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  }
}

/**
 * The body an OpenAI-compatible client already knows how to read. Upstream
 * answers a missing/wrong key with exactly this shape; a client that reaches
 * the gate instead of upstream must not have to parse something else.
 */
const API_UNAUTHORIZED = {
  error: {
    message: 'Invalid API key',
    type: 'invalid_request_error',
    code: 'invalid_api_key',
  },
}

function apiAuthHeaders(req) {
  const nonce = crypto.randomBytes(8).toString('hex')
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Chat2API-Auth': 'required',
    // Clients that follow the OpenAI SDK do not send cookies, so this does not
    // start a browser credential prompt; it tells an operator what to send.
    'WWW-Authenticate': 'Bearer realm="chat2api", error="invalid_api_key", nonce="' + nonce + '"',
  }
}
function deny(res, status, code, extra) {
  const body = { ok: false, error: code }
  if (extra) Object.assign(body, extra)
  const headers = baseHeaders()
  headers['X-Chat2API-Auth'] = status === 401 ? 'required' : 'denied'
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

/**
 * A refusal on the OpenAI-compatible namespace. An SDK parses the body of any
 * response it gets, so this is the upstream shape whatever went wrong - a
 * missing key, a wrong key, a cross-site caller, a form content type:
 * {error:{message,type,code}}. The reason stays in the audit line and in
 * X-Chat2API-Reason, where an operator looks, not in the client's traceback.
 */
function denyOpenAi(req, res, status, code) {
  const headers = apiAuthHeaders(req)
  headers['X-Chat2API-Auth'] = status === 401 ? 'required' : 'denied'
  headers['X-Chat2API-Reason'] = code
  if (status === 429) {
    // Throttling is not an authentication challenge, and the SDK backoff reads
    // Retry-After: without it openai-python falls back to its own exponential
    // schedule and can keep the window pinned shut. A 429 also has nothing to do
    // with the key, so advertising invalid_api_key here would send a client off
    // to refresh a token that is perfectly fine.
    headers['Retry-After'] = String(RETRY_AFTER_SECONDS)
    delete headers['WWW-Authenticate']
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(API_UNAUTHORIZED))
}

/**
 * What a browser (or a client that forgot the header) gets for a 401.
 *
 * Only a browser can act on an HTML page, so only a browser-facing path gets
 * one. An OpenAI-compatible client pointed at /v1/* or /v0/* parses the body as
 * JSON: handing it a login page turns 'your API key is missing' into
 * 'Unexpected token <' in a Python/Node traceback. Those realms therefore get
 * JSON in the same shape upstream uses for an invalid key.
 */
function challenge(req, res, realm) {
  if (realm === 'api' || realm === 'openai') {
    res.writeHead(401, apiAuthHeaders(req))
    res.end(JSON.stringify(API_UNAUTHORIZED))
    return
  }
  const headers = baseHeaders()
  const nonce = crypto.randomBytes(8).toString('hex')
  headers['X-Chat2API-Auth'] = 'required'
  headers['WWW-Authenticate'] = 'Cookie realm="chat2api", nonce="' + nonce + '"'
  if (req.method === 'HEAD') {
    res.writeHead(401, headers)
    res.end()
    return
  }
  headers['Content-Type'] = 'text/html; charset=utf-8'
  // A person who typed the address into the bar renders this page and clicks
  // the button; a client that only parses headers (curl -I, fetch, an <img>)
  // still gets the same pointer in a Link header, so nobody is left guessing
  // where /__login is. /__login itself is open, so there is no loop.
  const wants = String(firstHeader(req, 'accept') || '')
  if (realm !== 'api' && wants !== '' && wants.indexOf('text/html') === -1) {
    headers['Link'] = '</__login>; rel="login"'
  }
  res.writeHead(401, headers)
  res.end(loginChallengePage(realm))
}

function loginChallengePage(realm) {
  const target = realm === 'api'
    ? '这可能是 API 客户端。请在请求头带上 <code>Authorization: Bearer &lt;管理密钥&gt;</code>。'
    : '这台浏览器还没有访问凭证。打开下面的链接登录一次即可（凭证保存在 HttpOnly cookie 里，不会出现在网址或页面里）。'
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>需要登录 - Chat2API</title>',
    '<style>body{margin:0;background:#0f1115;color:#e6e9ef;font:14px/1.7 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}',
    '.wrap{max-width:640px;margin:12vh auto;padding:0 20px}h1{font-size:18px;margin:0 0 8px}',
    '.card{background:#171a21;border:1px solid #262b36;border-radius:10px;padding:20px}',
    'a.btn{display:inline-block;margin-top:16px;background:#4c8dff;color:#fff;text-decoration:none;padding:9px 18px;border-radius:6px;font-weight:600}',
    'code{background:#0c0e12;padding:1px 6px;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;color:#9fd0ff}',
    '.muted{color:#8b93a7;font-size:13px}</style></head>',
    '<body><div class="wrap"><div class="card">',
    '<h1>需要登录 Chat2API</h1>',
    '<p>' + target + '</p>',
    '<a class="btn" href="/__login">打开登录页</a>',
    '<p class="muted" style="margin-top:18px">管理密钥（也就是登录密码）在数据卷里，首次部署时自己取一次：</p>',
    '<p class="muted"><code>docker compose exec chat2api cat /data/.chat2api/.management-secret</code></p>',
    '<p class="muted">实测 NAS 上就是把容器里的 <code>/data</code> 换成宿主机目录：</p>',
    '<p class="muted"><code>sudo cat /volume1/docker/chat2api/data/.chat2api/.management-secret</code></p>',
    '</div></div></body></html>',
  ].join('\n')
}

/* ------------------------------------------------------------------ *
 * Body guard and credential parsing
 * ------------------------------------------------------------------ */
function parseBearer(req) {
  const raw = firstHeader(req, 'authorization').trim()
  if (!raw) return { present: false, token: '' }
  const m = /^Bearer\s+(.+)$/i.exec(raw)
  if (!m) return { present: true, token: '', malformed: true }
  return { present: true, token: m[1].trim() }
}

/**
 * JSON only, or text/plain when the client names itself with a header.
 *
 * The decision is made on Content-Type alone, never on Content-Length or
 * Transfer-Encoding: a cross-site form or fetch() can send a "simple" content
 * type with a zero-length body, and a body-less checkbox for the type would
 * wave it straight through. The two simple types are exactly the ones a
 * cross-origin page can send without a preflight, so they are the only ones
 * that must be refused here.
 */
function checkBody(req, method) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return { ok: true }

  const rawCt = firstHeader(req, 'content-type').trim()
  if (!rawCt) return { ok: true, empty: true }

  const ct = rawCt.split(';')[0].trim().toLowerCase()
  if (ct === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(ct)) {
    return { ok: true, contentType: ct }
  }
  const named = firstHeader(req, 'x-c2a-request').trim() === '1'
  if (ct === 'text/plain' && named) return { ok: true, contentType: ct, nonSimple: true }

  return {
    ok: false,
    reason: ct === 'text/plain' ? 'simple_content_type' : 'unsupported_content_type',
    detail: ct || '(none)',
  }
}

/* ------------------------------------------------------------------ *
 * The management secret
 * ------------------------------------------------------------------ */
let cachedSecret = { value: '' }
let secretFile = ''

function setSecretFile(file) { secretFile = file || '' }

/** Read the secret once; a rotated secret takes effect on restart. */
function currentSecret(readFile) {
  if (cachedSecret.value) return cachedSecret.value
  const fromEnv = (process.env.CHAT2API_MANAGEMENT_SECRET || '').trim()
  if (fromEnv) { cachedSecret = { value: fromEnv }; return cachedSecret.value }
  try {
    if (secretFile && typeof readFile === 'function') {
      const v = String(readFile(secretFile) || '').trim()
      if (v) { cachedSecret = { value: v }; return v }
    }
  } catch { /* the secret file may not exist yet */ }
  return ''
}

function invalidateSecretCache() { cachedSecret = { value: '' } }

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = firstHeader(req, 'x-forwarded-for').split(',')[0].trim()
    if (xff) return xff
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown'
}

/**
 * Decide whether this request may proceed.
 *
 * Returns { allowed: true, ctx } or { allowed: false, kind, status, ctx } -
 * the caller writes the response for the failure case, so it can choose a
 * challenge page for browsers and JSON for API clients.
 */
function check(req) {
  const urlPath = (req.url || '/').split('?')[0]
  const method = (req.method || 'GET').toUpperCase()
  const ip = clientIp(req)
  const ctx = {
    ip,
    method,
    path: urlPath,
    class: classify(method, urlPath),
    auth: 'none',
    start: Date.now(),
  }

  if (!ALLOWED_METHODS.has(method)) {
    audit({ ...ctx, event: 'request', result: 'deny', reason: 'method_not_allowed', class: ctx.class })
    return { allowed: false, kind: 'method', status: 405, ctx }
  }

  if (ctx.class === 'exempt') {
    audit({ ...ctx, event: 'request', result: 'allow', reason: 'open_endpoint', class: ctx.class })
    return { allowed: true, ctx }
  }

  // 0) Provenance —— 这一条与"要不要登录"无关，所以放在门开关之前。
  // 关掉门是为了内网免登录，不是为了让别的网站能借用户浏览器发请求：
  // 跨站 POST 带着 JSON 就绕开了预检，只有 Origin/Referer 能挡住它。
  const prov = checkProvenance(req)
  if (!prov.ok) {
    audit({ ...ctx, event: 'auth', result: 'deny', reason: prov.reason, detail: prov.origin || prov.referer })
    return { allowed: false, kind: 'cross_origin', status: 403, ctx, provenance: prov }
  }

  if (!REQUIRE_AUTH) {
    audit({ ...ctx, event: 'request', result: 'allow', reason: 'auth_disabled', class: ctx.class })
    return { allowed: true, ctx }
  }

  // 2) Credential.
  const bearer = parseBearer(req)
  const cookieToken = readCookie(req, COOKIE_NAME)

  if (bearer.present) {
    if (!safeEqual(bearer.token, currentSecret())) {
      // A wrong key on an OpenAI namespace is the single most common thing a
      // real deployment sees: it happens on every key rotation, on every
      // misconfigured SDK, on every typo in a .env. Counting those as auth
      // failures would lock the address (and behind one NAT, the whole site)
      // out of the /v1 API -- turning a 401 into an outage. So a presented, 
      // well-formed but wrong key is a per-request 401: audited, never counted.
      // Only a MISSING or MALFORMED credential feeds the lockout counter.
      const counts = ctx.class !== 'openai'
      const locked = counts ? registerAuthFailure(ip) : false
      const problems = secretProblems(bearer.token)
      audit({
        ...ctx,
        event: 'auth',
        result: 'deny',
        reason: locked ? 'invalid_bearer_locked' : 'invalid_bearer',
        // Never the credential itself, not even a fragment: a caller's guess may
        // be a real secret for another service. Shape only.
        offeredCredential: bearer.malformed
          ? 'malformed'
          : 'redacted(len=' + bearer.token.length + ')',
        detail: problems.length ? problems.join('; ') : null,
      })
      return { allowed: false, kind: 'invalid_bearer', status: 401, ctx }
    }
    // A bearer is allowed on both API namespaces; only the browser paths insist
    // on a session. A wrong key on /v1/* stays a per-request 401 for that client
    // and does not lock the address out (see clearAuthFailures below).
    if (ctx.class !== 'api' && ctx.class !== 'openai') {
      audit({ ...ctx, event: 'auth', result: 'deny', reason: 'bearer_not_allowed_for_gui', class: ctx.class, auth: 'bearer' })
      return { allowed: false, kind: 'bearer_gui', status: 401, ctx }
    }
    clearAuthFailures(ip)
    ctx.auth = 'bearer'
    ctx.apiAuth = true
    audit({ ...ctx, event: 'auth', result: 'allow', reason: 'bearer', class: ctx.class, auth: 'bearer' })
  } else if (cookieToken) {
    // One cookie jar, two tokens. Browsers get a session (SameSite=Strict keeps
    // another site from attaching it); non-browser clients fetch the per-boot GUI
    // token from the page and are not exposed to a hostile web page at all.
    const valid = isSessionValid(cookieToken) || isGuiTokenValid(cookieToken)
    if (!valid) {
      const locked = registerAuthFailure(ip)
      audit({ ...ctx, event: 'auth', result: 'deny', reason: locked ? 'invalid_session_locked' : 'invalid_session', class: ctx.class, auth: 'cookie' })
      return { allowed: false, kind: 'invalid_session', status: locked ? 429 : 401, ctx }
    }
    clearAuthFailures(ip)
    ctx.auth = 'session'
    ctx.sessionEstablished = true
    audit({ ...ctx, event: 'auth', result: 'allow', reason: isSessionValid(cookieToken) ? 'session' : 'gui_token', class: ctx.class, auth: 'session' })
  } else {
    const left = isLockedOut(ip)
    if (left) {
      audit({ ...ctx, event: 'auth', result: 'deny', reason: 'locked_out', detail: Math.ceil(left / 1000) + 's', class: ctx.class })
      return { allowed: false, kind: 'locked', status: 429, ctx }
    }
    if (registerAuthFailure(ip)) {
      audit({ ...ctx, event: 'auth', result: 'deny', reason: 'no_credential_locked', class: ctx.class })
      return { allowed: false, kind: 'locked', status: 429, ctx }
    }
    audit({ ...ctx, event: 'auth', result: 'deny', reason: 'no_credential', class: ctx.class })
    return { allowed: false, kind: 'no_credential', status: 401, ctx }
  }

  // 3) Content type on state-changing requests.
  const bodyCheck = checkBody(req, method)
  if (!bodyCheck.ok) {
    audit({ ...ctx, event: 'request', result: 'deny', reason: bodyCheck.reason, detail: bodyCheck.detail, class: ctx.class, auth: ctx.auth })
    return { allowed: false, kind: 'content_type', status: 415, ctx, bodyCheck }
  }

  // 4) Rate limit on the IPC bridge and its event stream.
  if (urlPath === '/__ipc' || urlPath === '/__ipc/events') {
    if (!takeToken('ipc:' + ip, IPC_RATE_PER_MIN, IPC_BURST)) {
      audit({ ...ctx, event: 'rate_limit', result: 'deny', reason: 'ipc_rate_exceeded', class: ctx.class, auth: ctx.auth })
      return { allowed: false, kind: 'rate_limited', status: 429, ctx }
    }
  }

  return { allowed: true, ctx }
}

/* ------------------------------------------------------------------ *
 * The login page (GET /__login)
 * ------------------------------------------------------------------ */
function ensureSession(req, res) {
  const existing = readCookie(req, COOKIE_NAME)
  const renewed = !existing || !isSessionValid(existing)
  const token = renewed ? createSession() : existing
  if (renewed) res.setHeader('Set-Cookie', sessionCookieHeader(token))
  return { token, csrf: csrfFor(token), renewed }
}

/**
 * Double-submit check: the page echoes the token that GET /__login put into
 * <meta name="c2a-csrf-token">, and the cookie proves which session it belongs
 * to. A cross-site page can neither read the meta tag nor forge the cookie
 * value, so it cannot produce a matching pair. Always derived from the cookie's
 * session - never from the candidate itself.
 */
function csrfMatches(req, candidate) {
  const cookieToken = readCookie(req, COOKIE_NAME)
  const supplied = String(candidate || '').trim()
  if (!cookieToken || !supplied) return false
  if (!isSessionValid(cookieToken)) return false
  return safeEqual(csrfFor(cookieToken), supplied)
}

function csrfFor(sessionToken) {
  return crypto.createHash('sha256').update('csrf:' + hashToken(sessionToken)).digest('hex').slice(0, 32)
}

function authStatus(req, res) {
  const prov = checkProvenance(req)
  const bearer = parseBearer(req)
  const cookieToken = readCookie(req, COOKIE_NAME)
  let kind = 'anonymous'
  if (!REQUIRE_AUTH) kind = 'disabled'
  else if (bearer.present && safeEqual(bearer.token, currentSecret())) kind = 'bearer'
  else if (cookieToken && isSessionValid(cookieToken)) kind = 'session'
  const payload = {
    authRequired: REQUIRE_AUTH,
    originOk: prov.ok,
    access: kind,
    session: kind === 'session' ? 'valid' : 'absent',
    loginUrl: '/__login',
  }
  res.writeHead(200, baseHeaders())
  res.end(JSON.stringify(payload))
}

module.exports = {
  COOKIE_NAME,
  REQUIRE_AUTH,
  TRUST_PROXY,
  check,
  classify,
  checkProvenance,
  checkBody,
  parseBearer,
  safeEqual,
  secretProblems,
  currentSecret,
  setSecretFile,
  invalidateSecretCache,
  createSession,
  createGuiToken,
  isSessionValid,
  isGuiTokenValid,
  revokeAllSessions,
  sessionCookieHeader,
  clearSessionCookieHeader,
  readCookie,
  ensureSession,
  csrfFor,
  csrfMatches,
  authStatus,
  challenge,
  deny,
  denyOpenAi,
  API_UNAUTHORIZED,
  audit,
  snapshotAuth,
  redact,
  clientIp,
  hostCandidates,
  requestScheme,
  loginChallengePage,
  baseHeaders,
}
