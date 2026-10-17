/**
 * Single public entry point for the container.
 *
 * WHY THIS EXISTS
 * ---------------
 * Upstream ships account management only inside the Electron renderer, and its
 * proxy has no UI at all. This server gives the container ONE address, the way
 * the desktop app did: the console at /, everything else (the OpenAI-compatible
 * API and the management API) proxied straight through to the gateway.
 *
 *   GET /  or /index.html  -> console page
 *   everything else        -> proxied to the gateway on loopback
 *
 * The gateway itself binds 127.0.0.1 only, so this is the single published port.
 *
 * THE CONSOLE IS OPEN, THE API IS NOT
 * -----------------------------------
 * The management API requires a secret. The console is its intended client, so
 * the gateway writes that secret to /data/.chat2api/.management-secret and this
 * proxy attaches it for /v0/management/* requests. Opening the page therefore
 * needs no login, while direct callers of the management API still need it.
 */

'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')

// Single public port. The gateway lives on loopback behind it.
const PUBLIC_PORT = parseInt(process.env.CHAT2API_PORT || '8080', 10)
const PUBLIC_HOST = process.env.CHAT2API_HOST || '0.0.0.0'
const GATEWAY = {
  host: process.env.CHAT2API_UI_UPSTREAM_HOST || '127.0.0.1',
  port: parseInt(process.env.CHAT2API_INTERNAL_PORT || '18080', 10),
}
const UI_FILE = process.env.CHAT2API_UI_FILE || path.join(__dirname, 'index.html')
const SECRET_FILE = process.env.CHAT2API_SECRET_FILE
  || path.join(process.env.CHAT2API_HOME || '/data/.chat2api', '.management-secret')

// Read per request: the file is tiny, and this stays correct if the secret is
// re-generated or rotated between restarts.
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

function isConsolePage(method, urlPath) {
  return method === 'GET' && (urlPath === '/' || urlPath === '/index.html')
}

function serveConsole(res) {
  fs.readFile(UI_FILE, (err, buf) => {
    if (err) {
      console.error('[front] cannot read UI file:', err.message)
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Console file missing: ' + UI_FILE)
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(buf)
  })
}

function proxy(req, res, urlPath) {
  const headers = { ...req.headers, host: `${GATEWAY.host}:${GATEWAY.port}` }

  // Only the management API needs the injected credential; /v1 must pass
  // through untouched so client API keys still work as usual.
  if (urlPath.startsWith('/v0/management/')) {
    const secret = readSecret()
    if (secret) {
      // Attach unconditionally: the console is the trusted client, and letting
      // a stale browser header win would only cause confusing 401s.
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

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0]

  if (isConsolePage(req.method, urlPath)) {
    serveConsole(res)
    return
  }

  proxy(req, res, urlPath)
})

server.listen(PUBLIC_PORT, PUBLIC_HOST, () => {
  console.log(`[front] listening on http://${PUBLIC_HOST}:${PUBLIC_PORT}`)
  console.log(`[front] console at /, proxying everything else -> http://${GATEWAY.host}:${GATEWAY.port}`)
})

const shutdown = (sig) => {
  console.log(`[front] received ${sig}, closing`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig))
