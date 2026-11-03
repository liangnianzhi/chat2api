#!/usr/bin/env node
/**
 * A stand-in for the container, so the access rules can be exercised without
 * building an image. It mounts exactly the files under test (webui/auth.js and
 * webui/server.js) next to a fake shim with a few IPC channels and a fake proxy
 * handler, then lets the real server.js serve them.
 *
 *   node tests/local_harness.js --port 18082 --secret 'test-secret-0123456789'
 *   node tests/local_harness.js --mode nosecret          # no secret file at all
 *   node tests/local_harness.js --env CHAT2API_REQUIRE_AUTH=off
 *
 * It is a test double, not the product: the shim exists so /__ipc has something
 * to dispatch to, and the fake proxy echoes the request so tests can tell
 * 'reached the proxy' from 'blocked at the gate'.
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0 || i + 1 >= process.argv.length) return def
  return process.argv[i + 1]
}

const PORT = parseInt(arg('port', '18082'), 10)
const SECRET = arg('secret', 'harness-secret-0123456789abcdef')
const MODE = arg('mode', 'full')
const WEBUI = path.resolve(__dirname, '..', 'webui')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'c2a-harness-'))
const DATA = path.join(ROOT, 'data', '.chat2api')

const DIRS = ['app', 'app/shim', 'app/upstream/renderer', 'app/upstream/preload', 'copied/webui']
for (const d of DIRS) fs.mkdirSync(path.join(ROOT, d), { recursive: true })
fs.mkdirSync(DATA, { recursive: true })

const SECRET_FILE = path.join(DATA, '.management-secret')
if (MODE !== 'nosecret') fs.writeFileSync(SECRET_FILE, SECRET + '\n')

// The files under test, copied verbatim.
const UNDER_TEST = ['auth.js', 'server.js', 'preload-bridge.js']
for (const f of UNDER_TEST) {
  fs.copyFileSync(path.join(WEBUI, f), path.join(ROOT, 'copied/webui', f))
}

const LOGIN_HTML = [
  '<!doctype html>',
  '<html><head>',
  '<meta charset="utf-8">',
  '<title>Login</title>',
  '</head><body>',
  '<form id="add"><input name="userToken"><button type="submit">save</button></form>',
  '<script>fetch("/__login/finish", {method:"POST", headers:{"Content-Type":"application/json"}, body: "{}"})</script>',
  '</body></html>'
].join('\n')
fs.writeFileSync(path.join(ROOT, 'copied/webui/login.html'), LOGIN_HTML)

const INDEX_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>fake ui</title></head>'
  + '<body><div id="app"></div></body></html>'
fs.writeFileSync(path.join(ROOT, 'app/upstream/renderer/index.html'), INDEX_HTML)
fs.writeFileSync(path.join(ROOT, 'app/upstream/renderer/app.js'), 'window.fakeUi = 1')
fs.writeFileSync(path.join(ROOT, 'app/upstream/preload/index.js'), 'window.__fakePreload = 1')

const SHIM_JS = [
  "'use strict'",
  "const { EventEmitter } = require('events')",
  "const handlers = new Map()",
  "handlers.set('accounts:getAll', async () => ([{ providerId: 'fake', name: 'a1' }]))",
  "handlers.set('proxy:getStatus', async () => ({ running: true, port: 8082 }))",
  "handlers.set('oauth:validateToken', async (e, a) => ({ valid: !!(a && a.credentials && a.credentials.t),",
  "  accountInfo: { name: 'from-token', email: 'x@example.com' } }))",
  "handlers.set('accounts:add', async (e, a) => ({ id: 'acc-1', providerId: a.providerId }))",
  "const proxy = (req, res) => {",
  "  res.writeHead(200, { 'Content-Type': 'application/json' })",
  "  res.end(JSON.stringify({ proxied: true, path: req.url, method: req.method,",
  "    auth: req.headers.authorization || null }))",
  "}",
  "module.exports = {",
  "  __isShim: true,",
  "  __ipcHandlers: handlers,",
  "  __eventBus: new EventEmitter(),",
  "  __httpHandler: () => proxy,",
  "  __replayPendingOpens: () => {},",
  "}"
].join('\n')
fs.writeFileSync(path.join(ROOT, 'app/shim/electron-shim.js'), SHIM_JS)

process.env.CHAT2API_APP_DIR = path.join(ROOT, 'app')
process.env.CHAT2API_PORT = String(PORT)
process.env.CHAT2API_HOST = '127.0.0.1'
process.env.CHAT2API_HOME = DATA
process.env.CHAT2API_SECRET_FILE = SECRET_FILE
process.env.CHAT2API_ENABLE_WEBUI = 'true'

// --env may be repeated: `--env A=1 --env B=2` and `--env A=1,B=2` both work.
// It used to take a single value, so a second flag was silently dropped -- which
// is indistinguishable from "that setting had no effect" when a test fails.
const extras = process.argv.reduce((acc, cur, i) => {
  if (cur === '--env' && typeof process.argv[i + 1] === 'string') {
    acc.push(...process.argv[i + 1].split(','))
  }
  return acc
}, []).filter(Boolean)
for (const extra of extras) {
  const eq = extra.indexOf('=')
  if (eq > 0) process.env[extra.slice(0, eq)] = extra.slice(eq + 1)
}

const server = require(path.join(ROOT, 'copied/webui/server.js'))
server.start()

console.log('[harness] root ' + ROOT)
console.log('[harness] secret file ' + SECRET_FILE
  + (fs.existsSync(SECRET_FILE) ? ' (present)' : ' (absent)'))

function shutdown() {
  try { server.close() } catch (e) { /* already down */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch (e) { /* best effort */ }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
