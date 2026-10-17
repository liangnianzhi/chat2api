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
 * This server fills that gap. It is deliberately tiny and dependency-free:
 *   * GET /            -> serves webui/index.html
 *   * /v0/management/* -> reverse-proxied to the gateway on localhost
 *
 * Proxying rather than calling the gateway directly from the browser keeps
 * everything same-origin, so no CORS configuration is needed and the
 * management secret never has to be exposed to a cross-origin request.
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

// Paths this console is allowed to proxy. Anything else is refused, so the
// console cannot become an open relay to the rest of the gateway.
const ALLOWED_PREFIXES = [
  '/v0/management/',
  '/health',
]

function isAllowed(p) {
  return ALLOWED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix))
}

function proxy(req, res) {
  const options = {
    host: GATEWAY.host,
    port: GATEWAY.port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `${GATEWAY.host}:${GATEWAY.port}` },
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
