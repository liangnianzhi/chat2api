/**
 * Electron API shim for headless (container) operation.
 *
 * The upstream Chat2API proxy is a plain Koa/Node application whose only
 * Electron touchpoints are:
 *   - store/store.ts               : app, safeStorage, BrowserWindow
 *   - proxy/adapters/perplexity.ts : net
 *   - proxy/captchaWindow.ts       : BrowserWindow, session  (Qwen captcha, unused here)
 *
 * This module provides just enough of those APIs for the proxy + store to run
 * in a plain Node.js process. Anything genuinely requiring a Chromium window
 * throws a clear, explicit error instead of failing silently.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DATA_DIR = process.env.CHAT2API_HOME || path.join(process.env.HOME || '/data', '.chat2api')
const SECRET_FILE = path.join(DATA_DIR, '.safe-storage-key')

/* ------------------------------------------------------------------ *
 * safeStorage
 * Electron's safeStorage encrypts via the OS keyring. In a container there
 * is no keyring, so we persist a random key on the data volume and use
 * AES-256-GCM. Format is versioned so it stays self-describing.
 *
 * The key MUST stay stable across restarts. Upstream's store.ts warns that if
 * it changes, the encrypted data.json is read as corrupt and the recovery path
 * silently wipes every account.
 * ------------------------------------------------------------------ */
function loadOrCreateKey() {
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const raw = fs.readFileSync(SECRET_FILE, 'utf8').trim()
      if (raw.length === 64) return Buffer.from(raw, 'hex')
    }
  } catch { /* fall through and regenerate */ }

  const key = crypto.randomBytes(32)
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true })
    fs.writeFileSync(SECRET_FILE, key.toString('hex'), { mode: 0o600 })
  } catch (err) {
    console.warn('[shim] could not persist safeStorage key:', err.message)
  }
  return key
}

let cachedKey = null
function getKey() {
  if (!cachedKey) cachedKey = loadOrCreateKey()
  return cachedKey
}

const safeStorage = {
  isEncryptionAvailable() {
    // Always true: we supply our own crypto rather than relying on a keyring.
    return true
  },
  encryptString(plainText) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
    const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    // v1:<iv>:<tag>:<payload>  (base64 fields)
    const packed = `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
    return Buffer.from(packed, 'utf8')
  },
  decryptString(buffer) {
    const packed = Buffer.from(buffer).toString('utf8')
    if (!packed.startsWith('v1:')) {
      // Not produced by us (plaintext, or an OS-keyring blob). Return as-is so
      // upstream's own fallback logic keeps behaving predictably.
      return packed
    }
    const [, ivB64, tagB64, dataB64] = packed.split(':')
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  },
}

/* ------------------------------------------------------------------ *
 * app
 * ------------------------------------------------------------------ */
const appPaths = {
  home: DATA_DIR,
  userData: DATA_DIR,
  appData: DATA_DIR,
  logs: path.join(DATA_DIR, 'logs'),
  downloads: path.join(DATA_DIR, 'downloads'),
  temp: process.env.TMPDIR || '/tmp',
}

const app = {
  isReady: () => true,
  getVersion: () => process.env.CHAT2API_VERSION || '0.0.0-container',
  getName: () => 'Chat2API',
  getPath: (name) => appPaths[name] || DATA_DIR,
  getAppPath: () => process.cwd(),
  setPath: () => {},
  quit: () => { process.exit(0) },
  exit: (code) => { process.exit(code || 0) },
  relaunch: () => { throw new Error('[shim] app.relaunch() is not supported in the container build') },
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock: () => {},
  whenReady: () => Promise.resolve(),
  on: () => app,
  once: () => app,
  off: () => app,
  removeListener: () => app,
  emit: () => false,
  commandLine: { appendSwitch: () => {}, appendArgument: () => {} },
  disableHardwareAcceleration: () => {},
  isPackaged: true,
}

/* ------------------------------------------------------------------ *
 * BrowserWindow / session
 * Upstream uses these only for optional GUI features (the Qwen
 * auto-registration captcha window). Guard them loudly rather than
 * pretending to work, so failures are diagnosable.
 * ------------------------------------------------------------------ */
function unsupported(feature) {
  const err = new Error(
    `[shim] ${feature} requires an Electron GUI, which is not available in this ` +
    `headless container build. Add the account by supplying its token/cookie ` +
    `directly instead of using the in-app browser login.`
  )
  err.code = 'ENOTSUP_HEADLESS'
  return err
}

class BrowserWindow {
  constructor() {
    throw unsupported('BrowserWindow')
  }
  static getAllWindows() { return [] }
  static getFocusedWindow() { return null }
  static fromWebContents() { return null }
}

const session = {
  defaultSession: {
    cookies: {
      get: async () => [],
      set: async () => {},
      remove: async () => {},
    },
    clearStorageData: async () => {},
    setProxy: async () => {},
  },
  fromPartition: () => { throw unsupported('session.fromPartition') },
  fromPath: () => { throw unsupported('session.fromPath') },
}

/* ------------------------------------------------------------------ *
 * net
 * Chromium's net module backs the Perplexity adapter. Node's built-in
 * http/https provides the equivalent; it honours a configured upstream
 * proxy so container deployments can still route outbound traffic.
 * ------------------------------------------------------------------ */
function buildNetRequest(options, callback) {
  const http = require('http')
  const https = require('https')
  const { URL } = require('url')

  const url = new URL(options.url)
  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http

  const headers = {}
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      headers[k] = Array.isArray(v) ? v.join(', ') : v
    }
  }

  let body = null
  if (options.uploadData && options.uploadData.length) {
    body = Buffer.concat(options.uploadData.map((d) => Buffer.from(d.bytes || '')))
    if (!headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = body.length
    }
  }

  // Optional upstream proxy support (HTTP CONNECT tunnelling via agent).
  let agent
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
  if (proxyUrl && isHttps) {
    try {
      const { HttpsProxyAgent } = require('https-proxy-agent')
      agent = new HttpsProxyAgent(proxyUrl)
    } catch { /* dependency absent - connect directly */ }
  }

  const req = transport.request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers,
      agent,
    },
    (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const payload = Buffer.concat(chunks)
        if (callback) callback(res.statusCode, res.statusMessage, res.headers, payload)
      })
    }
  )

  req.on('error', (err) => {
    if (callback) callback(-1, err.message, {}, Buffer.alloc(0))
  })

  if (body) req.write(body)

  return {
    setHeader: (name, value) => { headers[name] = value },
    getHeader: (name) => headers[name],
    on: (evt, fn) => { req.on(evt, fn); return this },
    write: (chunk) => req.write(chunk),
    end: (chunk) => { if (chunk) req.write(chunk); req.end() },
    abort: () => req.destroy(),
    followRedirect: () => {},
    setRedirectPolicy: () => {},
    chunkedEncoding: false,
    _nodeRequest: req,
  }
}

const net = {
  request: buildNetRequest,
  isOnline: () => true,
  fetch: (...args) => globalThis.fetch(...args),
}

/* ------------------------------------------------------------------ *
 * Remaining stubs
 * ------------------------------------------------------------------ */
const shell = {
  openExternal: async (url) => { console.log('[shim] shell.openExternal ignored:', url) },
  showItemInFolder: () => {},
  openPath: async () => '',
}

const ipcMain = { handle: () => {}, on: () => {}, removeHandler: () => {} }

const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
  showMessageBox: async () => ({ response: 0 }),
}

function Tray() { throw unsupported('Tray') }
function Menu() { throw unsupported('Menu') }

const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true, resize: () => nativeImage.createEmpty() }),
  createEmpty: () => ({ isEmpty: () => true }),
}

const screen = {
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, scaleFactor: 1 }),
  getAllDisplays: () => [{ workAreaSize: { width: 1920, height: 1080 }, scaleFactor: 1 }],
}

const clipboard = { writeText: () => {}, readText: () => '' }
const powerMonitor = { on: () => {}, once: () => {}, off: () => {} }

module.exports = {
  app,
  safeStorage,
  BrowserWindow,
  session,
  net,
  shell,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
  screen,
  clipboard,
  powerMonitor,
  // Not a real Electron export: lets the entrypoint detect the shim.
  __isShim: true,
}
