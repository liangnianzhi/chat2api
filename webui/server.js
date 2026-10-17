/**
 * Single public entry point for the container.
 *
 * WHAT IT SERVES
 * --------------
 * One address, one HTTP server, the way the desktop app worked:
 *
 *   GET /                -> the upstream renderer (the real Chat2API UI)
 *   /assets/*, static    -> files from out/renderer
 *   POST /__ipc          -> dispatch into upstream's ipcMain.handle registry
 *   GET  /__ipc/events   -> webContents.send events, streamed over SSE
 *   GET  /__preload.js   -> the browser bridge + upstream's preload bundle
 *   /management/*        -> rewritten to /v0/management/*, then to the proxy
 *   everything else      -> upstream's HTTP handler (the OpenAI-compatible API)
 *
 * NO SECOND PORT
 * --------------
 * Upstream's ProxyServer expects to bind a port. The shim intercepts that bind
 * and publishes the replayed request handler as __httpHandler; this module feeds
 * requests straight into it. The proxy is configured for this same public port,
 * so one number appears everywhere - config, the header badge, the management
 * base URL and this server all agree on it.
 *
 * MANAGEMENT AUTH
 * ---------------
 * Upstream's management middleware expects a secret. Requests are handed to the
 * proxy directly here, so this server sets the Authorization header for
 * management paths before the hand-off. Direct API clients are unaffected:
 * /v1 passes through untouched.
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

// The only published port.
const PUBLIC_PORT = parseInt(process.env.CHAT2API_PORT || '8082', 10)
const PUBLIC_HOST = process.env.CHAT2API_HOST || '0.0.0.0'
const SECRET_FILE = process.env.CHAT2API_SECRET_FILE
  || path.join(process.env.CHAT2API_HOME || '/data/.chat2api', '.management-secret')

// Upstream's own prefix, and the friendlier alias this server exposes.
const UPSTREAM_MGMT = '/v0/management'
const ALIAS_MGMT = '/management'

/* ------------------------------------------------------------------ *
 * Bridge access (same process as the gateway)
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

/**
 * The captured upstream request handler, or null before the proxy binds.
 *
 * Resolved per request rather than cached: the shim owns the captured handler and
 * may publish it after this server has begun listening.
 */
function proxyHandler() {
  if (!shim || typeof shim.__httpHandler !== 'function') return null
  try {
    return shim.__httpHandler() || null
  } catch (err) {
    console.warn('[front] could not read the captured handler:', err.message)
    return null
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
  if (process.env.CHAT2API_MANAGEMENT_SECRET) return process.env.CHAT2API_MANAGEMENT_SECRET
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Inject <base> and the preload script into the renderer's index.html.
 *
 * <base href="/"> matters because vite emits relative asset URLs (./assets/...);
 * on a nested SPA route those would resolve against the route and 404.
 */
function injectConsoleHtml(html) {
  let out = html
  if (!/<base\s/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, '<head$1><base href="/">')
  }
  if (!out.includes('/__preload.js')) {
    out = out.replace(/<head([^>]*)>/i, '<head$1><script src="/__preload.js"></script>')
  }
  return out
}

function serveIndex(res) {
  const upstreamIndex = path.join(RENDERER_DIR, 'index.html')
  fs.readFile(upstreamIndex, (err, buf) => {
    if (err) {
      console.error('[front] cannot read the upstream UI at', upstreamIndex, '-', err.message)
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(
        'The upstream UI is missing from this image.\n\n'
        + `Expected: ${upstreamIndex}\n`
        + 'The API on /v1 is unaffected. Rebuild the image, or report a bug.\n'
      )
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(injectConsoleHtml(buf.toString('utf8')))
  })
}

/* ------------------------------------------------------------------ *
 * The preload bundle, wrapped for a browser
 * ------------------------------------------------------------------ */
function servePreload(res) {
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

  const js = bridge
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

async function handleIpc(req, res) {
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

  const channel = body && body.channel
  const args = Array.isArray(body && body.args) ? body.args : []
  const handler = shim.__ipcHandlers.get(channel)
  if (!handler) {
    send(404, { ok: false, error: `no handler registered for channel: ${channel}` })
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

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')

  const client = (channel, args) => {
    try { res.write(`data: ${JSON.stringify({ channel, args })}\n\n`) } catch { /* closing */ }
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
 * Handing a request to upstream
 * ------------------------------------------------------------------ */
function isManagementPath(urlPath) {
  return urlPath === ALIAS_MGMT || urlPath.startsWith(ALIAS_MGMT + '/')
    || urlPath.startsWith(UPSTREAM_MGMT)
}

/** Attach the management credential and rewrite the alias, in place. */
function prepareForGateway(req, urlPath) {
  if (!isManagementPath(urlPath)) return

  const secret = readSecret()
  if (secret) {
    req.headers.authorization = `Bearer ${secret}`
  } else {
    console.warn('[front] management secret unavailable at', SECRET_FILE)
  }

  // /management/x -> /v0/management/x.
  if (!urlPath.startsWith(UPSTREAM_MGMT)) {
    req.url = UPSTREAM_MGMT + req.url.slice(ALIAS_MGMT.length)
  }
}

/**
 * Hand the request to upstream's app in-process.
 *
 * There is deliberately NO loopback fallback any more. The proxy is configured
 * for this same port, so "retry over HTTP" would send the request back to this
 * very server - an infinite loop. When the handler is missing the honest answer
 * is an error.
 */
function dispatch(req, res, urlPath) {
  prepareForGateway(req, urlPath)

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
function createServer() {
  return http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0]

    if (urlPath === '/__ipc' && req.method === 'POST') { void handleIpc(req, res); return }
    if (urlPath === '/__ipc/events') { handleEvents(req, res); return }
    if (urlPath === '/__preload.js') { servePreload(res); return }

    if (urlPath === '/health' || urlPath === '/stats'
        || API_PREFIXES.some((p) => urlPath.startsWith(p))) {
      dispatch(req, res, urlPath)
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

    dispatch(req, res, urlPath)
  })
}

function start() {
  const server = createServer()
  server.listen(PUBLIC_PORT, PUBLIC_HOST, () => {
    console.log(`[front] Chat2API ready on http://${PUBLIC_HOST}:${PUBLIC_PORT} (the only port)`)
    if (bridgeReady()) {
      console.log(`[front] UI: upstream renderer, IPC bridge active (${handlerCount()} channels)`)
    } else {
      console.warn('[front] UI: IPC bridge has NO registered channels - the page will not function.')
    }
    if (proxyHandler()) {
      console.log('[front] API: served in-process, no second port')
    } else {
      console.warn('[front] API: no proxy handler yet; API calls get 503 until it is captured')
    }
  })

  const shutdown = (sig) => {
    console.log(`[front] received ${sig}, closing`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig))

  return server
}

module.exports = { start }

if (require.main === module) start()
