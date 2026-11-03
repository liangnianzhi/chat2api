/**
 * Single public entry point for the container.
 *
 * WHAT IT SERVES
 * --------------
 *   GET /                -> the upstream renderer (the real Chat2API UI)
 *   /assets/*, static    -> files from out/renderer
 *   POST /__ipc          -> dispatch into upstream's ipcMain.handle registry
 *   GET  /__ipc/events   -> webContents.send events, streamed over SSE
 *   GET  /__preload.js   -> the browser bridge + upstream's preload bundle
 *   GET  /__login        -> guided add-account page (also the login page)
 *   POST /__login/finish -> validate + store the credential it collected
 *   /management/*        -> rewritten to /v0/management/*, then to the proxy
 *   everything else      -> upstream's HTTP handler (the API)
 *
 * WHO MAY CALL WHAT
 * -----------------
 * Every one of those paths is administrative except /health and GET /__login,
 * so each request passes through webui/auth.js before a handler runs:
 * Bearer <management secret> for API clients, an HttpOnly SameSite=Strict
 * cookie for this browser, and Origin/Referer + Content-Type checks against
 * cross-site requests. See webui/auth.js for the threat model.
 *
 * ADDING ACCOUNTS
 * ---------------
 * Upstream's web login opens an Electron window and reads tokens out of it; a
 * container cannot. The /__login page therefore walks the user through copying
 * the credential themselves, then this server validates and stores it. It also
 * hands out the browser session, which is why the first stop for a new user or
 * a discarded cookie jar is /__login - the 401 response links there.
 *
 * Storage itself is upstream's: every account keeps its own credentials, so N
 * accounts for one provider coexist and are scheduled by the proxy. Whether the
 * browser is still signed in afterwards is irrelevant.
 */

'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')

const APP_DIR = process.env.CHAT2API_APP_DIR || path.join(__dirname, '..')
const SHIM_PATH = process.env.CHAT2API_SHIM || path.join(APP_DIR, 'shim', 'electron-shim.js')
const RENDERER_DIR = process.env.CHAT2API_RENDERER_DIR || path.join(APP_DIR, 'upstream', 'renderer')
const PRELOAD_FILE = process.env.CHAT2API_PRELOAD_FILE || path.join(APP_DIR, 'upstream', 'preload', 'index.js')
const BRIDGE_FILE = process.env.CHAT2API_BRIDGE_FILE || path.join(__dirname, 'preload-bridge.js')
const LOGIN_PAGE = process.env.CHAT2API_LOGIN_PAGE || path.join(__dirname, 'login.html')

const PUBLIC_PORT = parseInt(process.env.CHAT2API_PORT || '8082', 10)
const PUBLIC_HOST = process.env.CHAT2API_HOST || '0.0.0.0'
const SECRET_FILE = process.env.CHAT2API_SECRET_FILE
  || path.join(process.env.CHAT2API_HOME || '/data/.chat2api', '.management-secret')

const UPSTREAM_MGMT = '/v0/management'
const ALIAS_MGMT = '/management'

const auth = require('./auth')
auth.setSecretFile(SECRET_FILE)

/* ------------------------------------------------------------------ *
 * Bridge access
 * ------------------------------------------------------------------ */
let shim = null
try {
  shim = require(SHIM_PATH)
} catch (err) {
  console.error('[front] could not load the electron shim, UI bridge disabled:', err.message)
}

function handlerCount() {
  return shim && shim.__ipcHandlers ? shim.__ipcHandlers.size : 0
}
function bridgeReady() {
  return handlerCount() > 0
}

function proxyHandler() {
  if (!shim || typeof shim.__httpHandler !== 'function') return null
  try {
    return shim.__httpHandler() || null
  } catch (err) {
    console.warn('[front] could not read the captured handler:', err.message)
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Health probe (shim/health.js) - optional, falls back to a minimal body
 * ------------------------------------------------------------------ */
let health = null
try {
  health = require(path.join(APP_DIR, 'shim', 'health.js'))
} catch (err) {
  console.warn('[front] structured /health unavailable (' + err.message + '); serving the minimal body')
}

/**
 * The account list shim/gateway.js snapshots in the background.
 *
 * Synchronous by contract: /health runs on the probe's critical path and must
 * never wait on the store. gateway.js refreshes this once a minute.
 */
function cachedAccounts() {
  const list = globalThis.__chat2apiAccounts
  return Array.isArray(list) ? list : null
}

/**
 * Upstream's proxy status through its own IPC channel.
 *
 * callIpc() is async, but a health probe needs an answer now; the channel is a
 * plain handler that resolves synchronously for this one message, so the race is
 * only there to bound a pathological case. Returns null on any failure - health
 * reports "unknown" rather than inventing a state.
 */
function proxyStatusFromIpc() {
  let settled = null
  try {
    const entry = shim && shim.__ipcHandlers ? shim.__ipcHandlers.get('proxy:getStatus') : null
    if (!entry) return null
    const handler = typeof entry === 'function' ? entry : entry.handler
    if (typeof handler !== 'function') return null
    // Same receiver signature callIpc() uses, so the handler cannot tell the two
    // apart. It may still be async; then this returns null and /health reports
    // unknown rather than a state it made up.
    const out = handler({ sender: null, senderFrame: null })
    // A promise is not an answer. upstream registers most channels async, which is
    // exactly why a synchronous probe must not pretend it resolved: the report then
    // says unknown, and /health stays degraded instead of inventing a state.
    if (out && typeof out.then === 'function') return null
    settled = out || null
  } catch (err) {
    return null
  }
  return settled
}

function minimalHealthSafe() {
  try {
    return minimalHealth()
  } catch (err) {
    return { status: 'failing', ok: false, warnings: ['self-check failed: ' + (err && err.message)] }
  }
}

function minimalHealth() {
  return {
    status: proxyHandler() ? 'running' : 'degraded',
    ok: true,
    uptime: Math.round(process.uptime()),
    memoryMB: health && typeof health.memoryMB === 'function' ? health.memoryMB() : null,
    port: PUBLIC_PORT,
    warnings: health ? [] : ['shim/health.js is missing: this is the minimal body'],
  }
}

const streamClients = new Set()
if (shim && shim.__eventBus) {
  const bus = shim.__eventBus
  const originalEmit = bus.emit.bind(bus)
  bus.emit = (channel, ...rest) => {
    const args = Array.isArray(rest[0]) ? rest[0] : rest
    for (const client of streamClients) client(channel, args)
    return originalEmit(channel, ...rest)
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

const API_PREFIXES = ['/v0/', '/v1/', '/api/', ALIAS_MGMT]

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */
function readSecret() {
  // Cached after the first successful read; a rotated secret applies on the
  // next start (documented in README - the entrypoint generates it once).
  return auth.currentSecret((f) => fs.readFileSync(f, 'utf8'))
}

/**
 * The token the renderer uses for its own /__ipc calls. It is per boot and
 * short-lived, so the long-lived management secret never appears in a page
 * that anyone can read out of the browser cache.
 */
function guiBootstrap() {
  return auth.createGuiToken()
}

function injectConsoleHtml(html, bootstrap) {
  let out = html
  const head = '<script>window.__c2a_gui_token=' + JSON.stringify(bootstrap) + '</script>'
  if (!/<base\s/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, '<head$1><base href="/">')
  }
  // Bootstrap first: the preload bridge reads it as it loads.
  if (!out.includes('__c2a_gui_token')) {
    out = out.replace(/<head([^>]*)>/i, (m, attrs) => '<head' + attrs + '>' + head)
  }
  if (!out.includes('/__preload.js')) {
    out = out.replace(/<head([^>]*)>/i, '<head$1><script src="/__preload.js"></script>')
  }
  return out
}

function sendFile(res, file, type, injectHtml) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      console.error('[front] cannot read', file, '-', err.message)
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Missing file in this image: ' + file + '\n')
      return
    }
    const body = injectHtml ? injectConsoleHtml(buf.toString('utf8'), guiBootstrap()) : buf
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(body)
  })
}

function serveIndex(res) {
  sendFile(res, path.join(RENDERER_DIR, 'index.html'), 'text/html; charset=utf-8', true)
}

/* ------------------------------------------------------------------ *
 * Login page
 * ------------------------------------------------------------------ */
function serveLoginPage(req, res) {
  fs.readFile(LOGIN_PAGE, 'utf8', (err, html) => {
    if (err) {
      console.error('[front] cannot read', LOGIN_PAGE, '-', err.message)
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Missing file in this image: ' + LOGIN_PAGE + '\n')
      return
    }
    // Opening this page is how a browser obtains its session; the token only
    // goes into the HttpOnly cookie, never into the markup.
    const csrf = auth.ensureSession(req, res).csrf
    const injected = html.replace(
      '<meta charset="utf-8">',
      '<meta charset="utf-8">\n<meta name="c2a-csrf-token" content="' + csrf + '">'
    )
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(injected)
  })
}

/* ------------------------------------------------------------------ *
 * Preload bundle, wrapped for a browser
 * ------------------------------------------------------------------ */
function servePreload(req, res) {
  let bundle
  let bridge
  try {
    bundle = fs.readFileSync(PRELOAD_FILE, 'utf8')
    bridge = fs.readFileSync(BRIDGE_FILE, 'utf8')
  } catch (err) {
    console.error('[front] cannot read preload files:', err.message)
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('preload bundle not found')
    return
  }

  if (/^\s*(import|export)\s/m.test(bundle)) {
    console.error('[front] preload bundle looks like ESM; the CJS wrapper will not work')
  }

  // The same bootstrap the page got: a client fetching this file directly
  // (which also needs a session) can run the bridge on its own.
  const bootstrapScript = 'window.__c2a_gui_token=window.__c2a_gui_token||'
    + JSON.stringify(guiBootstrap()) + ';\n'

  const js = bootstrapScript
    + bridge
    + '\n;(function (require, module, exports, process) {\n'
    + bundle
    + '\n}).call(window, window.__c2a_require, window.__c2a_module, window.__c2a_module.exports, window.__c2a_process);\n'

  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(js)
}

/* ------------------------------------------------------------------ *
 * IPC endpoints
 * ------------------------------------------------------------------ */
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function callIpc(channel, args) {
  if (!shim || !shim.__ipcHandlers) throw new Error('IPC bridge is not available')
  const handler = shim.__ipcHandlers.get(channel)
  if (!handler) throw new Error('no handler registered for channel: ' + channel)
  return await handler({ sender: null, senderFrame: null }, ...(args || []))
}

async function handleIpc(req, res, ctx) {
  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  if (!shim || !shim.__ipcHandlers) {
    send(503, { ok: false, error: 'IPC bridge is not available in this container' })
    return
  }

  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (err) {
    send(400, { ok: false, error: 'invalid request: ' + err.message })
    return
  }

  // A session-driven request is a browser request: it must also prove it came
  // from a page we served, not from another site's form post (CSRF). The
  // header makes it a non-simple request, so a cross-site page cannot send it
  // without a CORS preflight that we never answer.
  if (ctx && ctx.auth === 'session') {
    const named = String((req.headers && req.headers['x-c2a-request']) || '') === '1'
    if (!named) {
      auth.audit({ ip: ctx.ip, method: ctx.method, path: ctx.path }, {
        event: 'ipc', result: 'deny', reason: 'missing_c2a_request_header', detail: body && body.channel,
      })
      send(403, { ok: false, error: 'cross_site_request_blocked' })
      return
    }
  }

  const channel = body && body.channel
  const args = Array.isArray(body && body.args) ? body.args : []
  const handler = shim.__ipcHandlers.get(channel)
  if (!handler) {
    send(404, { ok: false, error: 'no handler registered for channel: ' + channel })
    return
  }

  try {
    const result = await handler({ sender: null, senderFrame: null }, ...args)
    send(200, { ok: true, result: result === undefined ? null : result })
  } catch (err) {
    console.error('[front] ipc error on', channel, err && err.message)
    send(200, { ok: false, error: (err && err.message) || String(err) })
  }
}

/* ------------------------------------------------------------------ *
 * Add-account page: validation and storage
 *
 * Storing is upstream's job, so this forwards to upstream's own channels rather
 * than writing to the store. That keeps credential encryption and any
 * de-duplication in one place.
 * ------------------------------------------------------------------ */
async function handleLoginFinish(req, res, ctx) {
  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  let body
  try {
    body = JSON.parse(await readBody(req, 256 * 1024))
  } catch (err) {
    send(400, { ok: false, error: 'invalid request: ' + err.message })
    return
  }

  // Only our own page may store a credential through this endpoint: the
  // session cookie (checked earlier) plus the CSRF value that page was given.
  if (ctx && ctx.auth === 'session') {
    const csrf = String((body && body.csrf) || req.headers['x-c2a-csrf'] || '')
    if (!auth.csrfMatches(req, csrf)) {
      auth.audit({ ip: ctx.ip, method: ctx.method, path: ctx.path }, {
        event: 'login', result: 'deny', reason: 'csrf_token_mismatch',
      })
      send(403, { ok: false, error: 'cross_site_request_blocked' })
      return
    }
  }

  const providerId = body && body.providerId
  const providerType = (body && body.providerType) || providerId
  const credentials = (body && body.credentials) || null
  const providedName = ((body && body.name) || '').toString().trim()

  if (!providerId || !credentials || !Object.keys(credentials).length) {
    send(400, { ok: false, error: '缺少 providerId 或 credentials' })
    return
  }

  // 1) Validate exactly as the UI's own "login with token" path does, so a
  //    mistyped or expired token fails here instead of becoming a dead account.
  let validation
  try {
    validation = await callIpc('oauth:validateToken', [{ providerId, providerType, credentials }])
  } catch (err) {
    send(200, { ok: false, error: '无法验证凭证：' + err.message })
    return
  }

  if (!validation || validation.valid !== true) {
    send(200, { ok: false, error: (validation && validation.error) || '凭证无效或已过期' })
    return
  }

  // 2) Store through upstream's account channel. The user-supplied name wins,
  //    because with several accounts per provider the display name is the only
  //    way to tell them apart.
  const info = validation.accountInfo || {}
  const name = providedName
    || info.name
    || info.email
    || providerId + '-' + new Date().toISOString().slice(5, 19).replace(/[-:T]/g, '')

  let saved
  try {
    saved = await callIpc('accounts:add', [{
      providerId,
      name,
      email: info.email || undefined,
      credentials,
    }])
  } catch (err) {
    send(200, { ok: false, error: '验证通过但保存失败：' + err.message })
    return
  }

  // Report how many this provider now has, so the page can show progress.
  let count = null
  try {
    const all = await callIpc('accounts:getAll', [false])
    if (Array.isArray(all)) {
      count = all.filter((a) => a && a.providerId === providerId).length
    }
  } catch {
    /* the count is a nicety; storing already succeeded */
  }

  // The account name is user-supplied: quote it, and never log the credential.
  console.log('[front] stored account ' + JSON.stringify(name) + ' for ' + providerId
    + ' (now ' + (count === null ? '?' : count) + ')')
  auth.audit({ ip: ctx && ctx.ip, method: ctx && ctx.method, path: ctx && ctx.path }, {
    event: 'login', result: 'allow', reason: 'account_stored', detail: providerId + '/' + name,
  })
  send(200, {
    ok: true,
    account: { name, email: info.email || null, id: saved && saved.id },
    providerAccountCount: count,
  })
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')

  const client = (channel, args) => {
    try { res.write('data: ' + JSON.stringify({ channel, args }) + '\n\n') } catch { /* closing */ }
  }
  streamClients.add(client)

  if (shim && typeof shim.__replayPendingOpens === 'function') {
    shim.__replayPendingOpens()
  }

  const heartbeat = setInterval(() => {
    try { res.write(': hb\n\n') } catch { /* closing */ }
  }, 25000)

  const cleanup = () => {
    clearInterval(heartbeat)
    streamClients.delete(client)
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}

/* ------------------------------------------------------------------ *
 * Static renderer files
 * ------------------------------------------------------------------ */
function serveStatic(res, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '')
  const target = path.resolve(RENDERER_DIR, rel)
  if (!target.startsWith(path.resolve(RENDERER_DIR) + path.sep)) return false

  let stat
  try {
    stat = fs.statSync(target)
  } catch {
    return false
  }
  if (!stat.isFile()) return false

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=3600',
  })
  fs.createReadStream(target).pipe(res)
  return true
}

/* ------------------------------------------------------------------ *
 * Request forwarding to upstream
 * ------------------------------------------------------------------ */
function isManagementPath(urlPath) {
  return urlPath === ALIAS_MGMT || urlPath.startsWith(ALIAS_MGMT + '/')
    || urlPath.startsWith(UPSTREAM_MGMT)
}

function prepareForGateway(req, urlPath, ctx) {
  if (!isManagementPath(urlPath)) return

  // The secret is attached server-side, and only for a caller that already
  // authenticated with it. A client that brought its own Authorization header
  // keeps it: otherwise every authorized caller would silently inherit full
  // administrator rights on the management API.
  if (req.headers.authorization) return
  if (!ctx || ctx.auth !== 'bearer' || !ctx.apiAuth) return

  const secret = readSecret()
  if (secret) {
    req.headers.authorization = 'Bearer ' + secret
  } else {
    console.warn('[front] management secret unavailable at', SECRET_FILE)
  }

  if (!urlPath.startsWith(UPSTREAM_MGMT)) {
    req.url = UPSTREAM_MGMT + req.url.slice(ALIAS_MGMT.length)
  }
}

/**
 * /health - the liveness probe, and only that.
 *
 * It stays open (a NAS operator and the container supervisor ask "are you alive"
 * without holding a credential), it answers before the auth gate, and it never
 * carries account data or credentials: the body is the build identity, whether
 * the proxy runs, whether the data volume can be written, and how the accounts
 * look in aggregate. The gate's own view - whether auth is on, sessions, locked
 * addresses, recent audit lines - moved to /__auth/status, which is gated like
 * every other privileged endpoint.
 *
 * Shape: {status, ok, upstream, store, accounts, lastSweepAt, sweep, uptime,
 * memoryMB, port, statistics, checks, warnings, at}, plus "auth" when auth.js is
 * present. status is 'running' only when the proxy answers and the store is
 * healthy; a broken store or a missing proxy answers 503 so HEALTHCHECK and
 * docker compose report the container unhealthy instead of pretending.
 */
async function serveHealth(req, res) {
  let report
  try {
    report = health
      ? await health.buildReport({
        // Upstream's own view, read through its IPC channel - the same source the
        // UI reads, so the probe and the page cannot disagree about the port.
        proxyStatus: proxyStatusFromIpc,
        listAccounts: cachedAccounts,
      })
      : minimalHealthSafe()
  } catch (err) {
    // A health endpoint that can throw is worse than one with a thin body.
    console.error('[front] self-check failed:', err && err.message)
    report = minimalHealthSafe()
  }

  let payload = report
  try {
    payload = Object.assign({}, report, { auth: auth.snapshotAuth() })
  } catch (err) {
    payload = Object.assign({}, report, { auth: { error: 'snapshot_failed' } })
  }

  let body
  try {
    body = JSON.stringify(payload)
  } catch (err) {
    body = JSON.stringify({ status: 'failing', ok: false, error: 'health_serialise_failed' })
  }

  res.writeHead(payload.ok ? 200 : 503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  })
  if (req.method === 'HEAD') { res.end(); return }
  res.end(body)
}

// The self-check module belongs to the ops track (shim/health.js). When it is
// absent - an older image, a patched tree, the local test harness - /health
// must still answer the question that matters: am I up, is the proxy there,
// and what is the gate doing.
function minimalHealthSafe() {
  if (typeof minimalHealth === 'function') {
    try { return minimalHealth() } catch (err) { /* fall through */ }
  }
  return {
    status: 'unknown',
    ok: false,
    upstream: typeof proxyHandler === 'function' && proxyHandler()
      ? 'ready'
      : 'missing',
    note: 'self-check module unavailable; reporting the minimum',
    at: new Date().toISOString(),
  }
}

function dispatch(req, res, urlPath, ctx) {
  prepareForGateway(req, urlPath, ctx)

  const handler = proxyHandler()
  if (!handler) {
    console.error('[front] no proxy handler captured; cannot serve', urlPath)
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      error: {
        message: 'The proxy handler is not available yet. Check the container log for '
          + '"captured the HTTP request handler".',
        type: 'proxy_unavailable',
      },
    }))
    return
  }

  try {
    handler(req, res)
  } catch (err) {
    console.error('[front] in-process dispatch failed:', err && err.message)
    if (res.headersSent) { res.end(); return }
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      error: { message: (err && err.message) || 'internal error', type: 'dispatch_failed' },
    }))
  }
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */
function sendGateFailure(req, res, gate) {
  // The reply has to match what the caller can parse: machine clients get JSON
  // (an OpenAI SDK turns an HTML body into 'Unexpected token <'), a person
  // browsing the renderer gets the page with the login button.
  const cls = gate.ctx && gate.ctx.class
  const realm = cls === 'api' ? 'api' : (cls === 'openai' ? 'openai' : 'ui')
  // Every machine-facing class - the OpenAI namespace /v1 and /v0, plus the
  // /api and IPC/stats class - gets the upstream error shape instead of our own
  // envelope: a client on any of them parses the body, and an HTML page only
  // moves the confusion to its side.
  if (cls === 'openai' || cls === 'api') {
    auth.denyOpenAi(req, res, gate.status || 401,
      gate.status === 403 ? 'cross_site_request_blocked'
        : (gate.status === 415 ? 'unsupported_content_type'
          : (gate.status === 429 ? 'rate_limited' : 'invalid_api_key')))
    return
  }
  switch (gate.kind) {
    case 'cross_origin':
      auth.deny(res, 403, 'cross_site_request_blocked', {
        reason: gate.provenance ? gate.provenance.reason : 'cross_origin',
      })
      return
    case 'content_type':
      auth.deny(res, 415, 'unsupported_content_type', {
        reason: gate.bodyCheck ? gate.bodyCheck.reason : 'unsupported_content_type',
        accepted: 'application/json',
      })
      return
    case 'rate_limited':
      res.setHeader('Retry-After', '60')
      auth.deny(res, 429, 'rate_limited', { retryAfter: 60 })
      return
    case 'locked':
      auth.deny(res, 429, 'too_many_auth_failures')
      return
    case 'method':
      auth.deny(res, 405, 'method_not_allowed')
      return
    case 'bearer_gui':
      auth.deny(res, 401, 'session_required', {
        hint: 'API tokens cannot open the UI: log in once in a browser at /__login.',
      })
      return
    default:
      auth.challenge(req, res, realm)
  }
}

function createServer() {
  return http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0]

    // /health answers BEFORE the gate (see serveHealth): it is the liveness
    // probe, so it must not depend on a credential the probe does not have, nor
    // on a session store that a broken data volume cannot provide. It carries no
    // credential and no account data - see the module for what it does carry.
    if (urlPath === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      void serveHealth(req, res)
      return
    }

    // One gate for everything else; an unauthenticated request never reaches a
    // handler, a stream or the proxy.
    const gate = auth.check(req)
    if (!gate.allowed) {
      sendGateFailure(req, res, gate)
      return
    }
    const ctx = gate.ctx

    if (urlPath === '/__ipc' && req.method === 'POST') { void handleIpc(req, res, ctx); return }
    if (urlPath === '/__ipc/events') { handleEvents(req, res); return }
    if (urlPath === '/__preload.js') { servePreload(req, res); return }

    if (urlPath === '/__login') {
      serveLoginPage(req, res)
      return
    }
    if (urlPath === '/__login/finish' && req.method === 'POST') {
      void handleLoginFinish(req, res, ctx)
      return
    }
    if (urlPath === '/__auth/status') { auth.authStatus(req, res); return }

    if (urlPath === '/stats' || API_PREFIXES.some((p) => urlPath.startsWith(p))) {
      dispatch(req, res, urlPath, ctx)
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (urlPath === '/' || urlPath === '/index.html') { serveIndex(res); return }
      if (serveStatic(res, urlPath)) return
      if (!path.extname(urlPath)) { serveIndex(res); return }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found: ' + urlPath)
      return
    }

    dispatch(req, res, urlPath, ctx)
  })
}

function start() {
  const server = createServer()
  server.listen(PUBLIC_PORT, PUBLIC_HOST, () => {
    console.log('[front] Chat2API ready on http://' + PUBLIC_HOST + ':' + PUBLIC_PORT + ' (the only port)')
    if (bridgeReady()) {
      console.log('[front] UI: upstream renderer, IPC bridge active (' + handlerCount() + ' channels)')
    } else {
      console.warn('[front] UI: IPC bridge has NO registered channels - the page will not function.')
    }
    if (proxyHandler()) {
      console.log('[front] API: served in-process, no second port')
    } else {
      console.warn('[front] API: no proxy handler yet; API calls get 503 until it is captured')
    }
    reportAuthPosture()
  })

  const shutdown = (sig) => {
    console.log('[front] received ' + sig + ', closing')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig))

  return server
}

/**
 * Say out loud what the gate is doing, and complain loudly when it is off or
 * when the secret does not look like one - a silent weak secret on an
 * internet-facing port is exactly the case worth failing loudly.
 */
function reportAuthPosture() {
  if (!auth.REQUIRE_AUTH) {
    console.warn('[front] WARNING: CHAT2API_REQUIRE_AUTH is off - anyone who can reach this port '
      + 'controls the accounts and the whole management API.')
    return
  }
  const secret = readSecret()
  const problems = auth.secretProblems(secret)
  const where = process.env.CHAT2API_MANAGEMENT_SECRET ? 'CHAT2API_MANAGEMENT_SECRET' : SECRET_FILE
  if (problems.length) {
    console.warn('[front] WARNING: weak or missing management secret (' + where + '): ' + problems.join('; '))
    console.warn('[front] Every endpoint stays closed until a usable secret is set: the process '
      + 'cannot authenticate anyone. See README, section "安全".')
  } else {
    console.log('[front] auth: on - Bearer <management secret> for API clients, '
      + 'session cookie for browsers (login at /__login)')
  }
  if (auth.TRUST_PROXY) {
    console.log('[front] auth: trusting X-Forwarded-* headers (only correct behind a reverse proxy)')
  } else if (PUBLIC_HOST === '0.0.0.0') {
    console.warn('[front] listening on all interfaces: bind 127.0.0.1, or put a reverse proxy '
      + 'in front, if this network is not trusted')
  }
}

module.exports = { start }

if (require.main === module) start()
