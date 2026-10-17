/**
 * Single public entry point for the container.
 *
 * WHAT IT SERVES
 * --------------
 * One address, the way the desktop app worked:
 *
 *   GET /                -> the upstream renderer (the real Chat2API UI)
 *   /assets/*, static    -> files from out/renderer
 *   POST /__ipc          -> dispatch into upstream's ipcMain.handle registry
 *   GET  /__ipc/events   -> webContents.send events, streamed over SSE
 *   GET  /__preload.js   -> upstream's preload bundle, wrapped for the browser
 *   /v1/*, /v0/*, /health-> proxied to the gateway on loopback
 *
 * WHY THE REAL RENDERER
 * ---------------------
 * Upstream's UI and all of its logic already exist. Rather than reimplement the
 * pages, the built renderer is served as-is and its IPC calls are bridged to the
 * very same handlers Electron would have called. Nothing about the UI is
 * duplicated, and it follows upstream automatically.
 *
 * WHY IN-PROCESS
 * --------------
 * The handler registry lives in the gateway process (the shim records it as
 * upstream registers). A separate process could not reach it, so gateway.js
 * requires this module instead of spawning it.
 *
 * THE BRIDGE IS NOT AUTHENTICATION
 * ---------------------------------
 * The management API requires a secret. This server attaches it server-side for
 * /v0/management/*, so the browser needs no credential and direct callers still
 * do - but, since the console and the API share a port, anyone who can reach the
 * port can administer. That is the accepted tradeoff of a single open address.
 */

'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')

const APP_DIR = process.env.CHAT2API_APP_DIR || path.join(__dirname, '..')
const SHIM_PATH = process.env.CHAT2API_SHIM || path.join(APP_DIR, 'shim', 'electron-shim.js')
const RENDERER_DIR = process.env.CHAT2API_RENDERER_DIR || path.join(APP_DIR, 'upstream', 'renderer')
const PRELOAD_FILE = process.env.CHAT2API_PRELOAD_FILE || path.join(APP_DIR, 'upstream', 'preload', 'index.js')
const FALLBACK_UI = process.env.CHAT2API_UI_FILE || path.join(__dirname, 'index.html')

const PUBLIC_PORT = parseInt(process.env.CHAT2API_PORT || '8080', 10)
const PUBLIC_HOST = process.env.CHAT2API_HOST || '0.0.0.0'
const GATEWAY = {
  host: process.env.CHAT2API_UI_UPSTREAM_HOST || '127.0.0.1',
  port: parseInt(process.env.CHAT2API_INTERNAL_PORT || '18080', 10),
}
const SECRET_FILE = process.env.CHAT2API_SECRET_FILE
  || path.join(process.env.CHAT2API_HOME || '/data/.chat2api', '.management-secret')

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

// The shim emits one array argument per event, e.g. emit(channel, [a, b]).
// EventEmitter has no wildcard, so wrap emit to fan out to a single stream.
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

const API_PREFIXES = ['/v0/', '/v1/', '/api/']

/* ------------------------------------------------------------------ *
 * Console page
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
 * The preload script must run before the app bundle, hence the position.
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

function sendHtml(res, file, inject) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      console.error('[front] cannot read UI file:', file, err.message)
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('UI file missing: ' + file)
      return
    }
    const html = inject ? injectConsoleHtml(buf.toString('utf8')) : buf
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
  })
}

function serveIndex(res) {
  const upstreamIndex = path.join(RENDERER_DIR, 'index.html')
  if (bridgeReady() && fs.existsSync(upstreamIndex)) {
    sendHtml(res, upstreamIndex, true)
  } else {
    // No bridge (or no renderer build): the built-in console still works.
    sendHtml(res, FALLBACK_UI, false)
  }
}

/* ------------------------------------------------------------------ *
 * The preload bundle, wrapped for a browser
 * ------------------------------------------------------------------ */
const STUB = `(function () {
  var listeners = Object.create(null);
  var stream = null;
  function rpc(channel, args) {
    return fetch('/__ipc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channel, args: args || [] })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r && r.ok) return r.result;
      throw new Error((r && r.error) || ('ipc failed: ' + channel));
    });
  }
  function connect() {
    if (stream || typeof EventSource === 'undefined') return;
    stream = new EventSource('/__ipc/events');
    stream.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.channel === '__c2a:openExternal') {
        try { window.open(msg.args[0], '_blank', 'noopener'); } catch (_) {}
        return;
      }
      var set = listeners[msg.channel];
      if (!set) return;
      set.forEach(function (fn) {
        try { fn.apply(null, [{}].concat(msg.args || [])); }
        catch (err) { console.error('[ipc]', msg.channel, err); }
      });
    };
  }
  var ipcRenderer = {
    invoke: function (channel) {
      return rpc(channel, Array.prototype.slice.call(arguments, 1));
    },
    send: function (channel) {
      rpc(channel, Array.prototype.slice.call(arguments, 1)).catch(function () {});
    },
    sendSync: function () { throw new Error('sendSync is not available over the HTTP bridge'); },
    on: function (channel, fn) {
      connect();
      (listeners[channel] = listeners[channel] || new Set()).add(fn);
      return ipcRenderer;
    },
    once: function (channel, fn) {
      var self = this;
      function wrapped() { self.removeListener(channel, wrapped); fn.apply(null, arguments); }
      return self.on(channel, wrapped);
    },
    removeListener: function (channel, fn) {
      if (listeners[channel]) listeners[channel].delete(fn);
      return ipcRenderer;
    },
    removeAllListeners: function (channel) {
      if (channel === undefined) listeners = Object.create(null);
      else delete listeners[channel];
      return ipcRenderer;
    },
    listenerCount: function (channel) {
      return listeners[channel] ? listeners[channel].size : 0;
    }
  };
  var electronStub = {
    ipcRenderer: ipcRenderer,
    contextBridge: { exposeInMainWorld: function (key, value) { window[key] = value; } },
    webFrame: { setZoomFactor: function () {}, getZoomFactor: function () { return 1; } },
    shell: { openExternal: function (u) { try { window.open(u, '_blank', 'noopener'); } catch (_) {} } }
  };
  window.__c2a_electron = electronStub;
  window.__c2a_require = function (name) {
    if (name === 'electron') return electronStub;
    throw new Error('unexpected require in preload bundle: ' + name);
  };
  window.__c2a_module = { exports: {} };
  window.__c2a_process = {
    env: { NODE_ENV: 'production' },
    platform: 'linux',
    versions: {},
    type: 'renderer',
    nextTick: function (f) { setTimeout(f, 0); }
  };
}());`

function servePreload(res) {
  let bundle
  try {
    bundle = fs.readFileSync(PRELOAD_FILE, 'utf8')
  } catch (err) {
    console.error('[front] cannot read preload bundle:', PRELOAD_FILE, err.message)
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('preload bundle not found')
    return
  }

  // electron-vite emits the preload as CommonJS. If that ever changes this will
  // fail loudly in the browser console rather than silently doing nothing.
  if (/^\s*(import|export)\s/m.test(bundle)) {
    console.error('[front] preload bundle looks like ESM; the CJS wrapper will not work')
  }

  const js = STUB
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
    // Upstream handlers take (event, ...args). The event is only used for
    // reply plumbing, which the HTTP round-trip replaces.
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
  // Never serve outside the renderer directory.
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
 * Gateway proxy
 * ------------------------------------------------------------------ */
function proxy(req, res, urlPath) {
  const headers = { ...req.headers, host: `${GATEWAY.host}:${GATEWAY.port}` }

  // Only the management API needs the injected secret; /v1 passes through
  // untouched so client API keys keep working as usual.
  if (urlPath.startsWith('/v0/management/')) {
    const secret = readSecret()
    if (secret) {
      headers.authorization = `Bearer ${secret}`
    } else {
      console.warn('[front] management secret unavailable at', SECRET_FILE)
    }
  }

  const upstream = http.request(
    {
      host: GATEWAY.host,
      port: GATEWAY.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers)
      upRes.pipe(res)
    }
  )

  upstream.on('error', (err) => {
    console.error('[front] upstream error:', err.message)
    if (res.headersSent) { res.end(); return }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      error: {
        message: `Cannot reach the gateway at ${GATEWAY.host}:${GATEWAY.port}: ${err.message}`,
        type: 'upstream_unreachable',
      },
    }))
  })

  req.pipe(upstream)
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

    if (urlPath === '/_ui/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        status: 'ok',
        ui: bridgeReady() && fs.existsSync(path.join(RENDERER_DIR, 'index.html')) ? 'upstream' : 'fallback',
        channels: handlerCount(),
      }))
      return
    }

    // API surface always proxies, so it never falls through to the SPA fallback.
    if (urlPath === '/health' || API_PREFIXES.some((p) => urlPath.startsWith(p))) {
      proxy(req, res, urlPath)
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (urlPath === '/' || urlPath === '/index.html') { serveIndex(res); return }
      if (serveStatic(res, urlPath)) return
      // A path without a file extension is a client-side route.
      if (!path.extname(urlPath)) { serveIndex(res); return }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found: ' + urlPath)
      return
    }

    proxy(req, res, urlPath)
  })
}

function start() {
  const server = createServer()
  server.listen(PUBLIC_PORT, PUBLIC_HOST, () => {
    console.log(`[front] listening on http://${PUBLIC_HOST}:${PUBLIC_PORT}`)
    console.log(`[front] UI: ${bridgeReady() ? 'upstream renderer (IPC bridge active, '
      + handlerCount() + ' channels)' : 'built-in fallback console'}`)
    console.log(`[front] proxying /v1, /v0 and /health -> http://${GATEWAY.host}:${GATEWAY.port}`)
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
