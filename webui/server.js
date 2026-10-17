/**
 * Web management console for the headless Chat2API gateway.
 *
 * WHY THIS EXISTS
 * ---------------
 * Upstream ships account management only inside the Electron renderer. The
 * headless build drops the renderer, which leaves the management API
 * (/v0/management/*) as the only way to add providers and accounts - usable
 * from curl, but there is no page to open in a browser.
 *
 * THIS CONSOLE IS OPEN, ITS CREDENTAL IS NOT
 * ------------------------------------------
 * The management API requires a secret. The console is its only intended client,
 * so the gateway writes that secret to /data/.chat2api/.management-secret and
 * this proxy attaches it server-side. Opening the page therefore "just works",
 * with no login step.
 *
 * Callers hitting the gateway directly on :8080 still need the secret - only the
 * loopback console auto-authenticates. Keeping the API protected while the UI is
 * open is deliberate: bind :8081 to your LAN, bind :8080 where the clients are.
 */

'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')

const UI_PORT = parseInt(process.env.CHAT2API_UI_PORT || '8081', 10)
const UI_HOST = process.env.CHAT2API_UI_HOST || '0.0.0.0'
const GATEWAY = {
  host: process.env.CHAT2API_UI_UPSTREAM_HOST || '127.0.0.1',
  port: parseInt(process.env.CHAT2API_PORT || '8080', 10),
}
const UI_FILE = process.env.CHAT2API_UI_FILE || path.join(__dirname, 'index.html')
const SECRET_FILE = process.env.CHAT2API_SECRET_FILE
  || path.join(process.env.CHAT2API_HOME || '/data/.chat2api', '.management-secret')

// Paths this console is allowed to proxy. Anything else is refused, so the
// console cannot become an open relay to the rest of the gateway.
const ALLOWED_PREFIXES = [
  '/v0/management/',
  '/health',
]

function isAllowed(p) {
  return ALLOWED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix))
}

function isManagementPath(p) {
  return p.startsWith('/v0/management/')
}

// Read per request: the file is tiny, and this stays correct if the secret is
// re-generated or rotated in the compose file between restarts.
function readSecret() {
  if (process.env.CHAT2API_MANAGEMENT_SECRET) {
    return process.env.CHAT2API_MANAGEMENT_SECRET
  }
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

function proxy(req, res) {
  const urlPath = (req.url || '/').split('?')[0]

  const headers = { ...req.headers, host: `${GATEWAY.host}:${GATEWAY.port}` }

  if (isManagementPath(urlPath)) {
    const secret = readSecret()
    if (secret) {
      // Attach unconditionally: the console is the trusted client, and letting a
      // stale header from the browser win would only cause confusing 401s.
      headers.authorization = `Bearer ${secret}`
    } else {
      console.warn('[webui] management secret unavailable at', SECRET_FILE)
    }
  }

  const options = {
    host: GATEWAY.host,
    port: GATEWAY.port,
    method: req.method,
    path: req.url,
    headers,
  }

  const upstream = http.request(options, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers)
    upRes.pipe(res)
  })

  upstream.on('error', (err) => {
    console.error('[webui] upstream error:', err.message)
    if (res.headersSent) { res.end(); return }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      success: false,
      error: {
        code: 'gateway_unreachable',
        message: `Cannot reach the gateway at ${GATEWAY.host}:${GATEWAY.port}: ${err.message}`,
      },
    }))
  })

  req.pipe(upstream)
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0]

  // Health probe for the container healthcheck / operators.
  if (urlPath === '/_ui/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  // Serve the console.
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    fs.readFile(UI_FILE, (err, buf) => {
      if (err) {
        console.error('[webui] cannot read UI file:', err.message)
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Web console file missing: ' + UI_FILE)
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(buf)
    })
    return
  }

  // Reverse-proxy the management API.
  if (isAllowed(urlPath)) {
    proxy(req, res)
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({
    success: false,
    error: { code: 'not_found', message: `Console does not serve ${urlPath}` },
  }))
})

server.listen(UI_PORT, UI_HOST, () => {
  console.log(`[webui] management console listening on http://${UI_HOST}:${UI_PORT}`)
  console.log(`[webui] proxying /v0/management/* -> http://${GATEWAY.host}:${GATEWAY.port}`)
})

const shutdown = (sig) => {
  console.log(`[webui] received ${sig}, closing`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig))
