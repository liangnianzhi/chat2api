/**
 * Electron API shim for headless (container) operation.
 *
 * The upstream Chat2API application is an Electron app whose proxy is plain
 * Koa/Node. Only three proxy files touch Electron:
 *
 *   store/store.ts            app, safeStorage, BrowserWindow
 *   proxy/adapters/perplexity net
 *   proxy/captchaWindow.ts    BrowserWindow, session (Qwen captcha)
 *
 * This module provides those APIs for a plain Node process, plus the plumbing
 * that lets the real renderer drive the real main-process logic from a browser.
 *
 * It also captures upstream's HTTP request handler so the front server can serve
 * the API without a second listening port. See "single port capture" below.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const http = require('http')
const { EventEmitter } = require('events')

const DATA_DIR = process.env.CHAT2API_HOME || path.join(process.env.HOME || '/data', '.chat2api')
const SECRET_FILE = path.join(DATA_DIR, '.safe-storage-key')

/* ------------------------------------------------------------------ *
 * process.resourcesPath
 *
 * Electron defines this; plain Node does not. The compiled bundle uses it to
 * locate the sha3 wasm it needs for DeepSeek/GLM request signing:
 *
 *   app.isPackaged ? path.join(process.resourcesPath, "sha3_wasm_bg...wasm") : ...
 *
 * With app.isPackaged = true and resourcesPath undefined that path.join throws,
 * so signing would fail on the first real request.
 * ------------------------------------------------------------------ */
const RESOURCES_DIR = process.env.CHAT2API_RESOURCES_DIR || path.join(__dirname, '..', 'upstream')
if (typeof process.resourcesPath !== 'string') {
  try {
    Object.defineProperty(process, 'resourcesPath', {
      value: RESOURCES_DIR,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  } catch {
    process.resourcesPath = RESOURCES_DIR
  }
}

/* ------------------------------------------------------------------ *
 * safeStorage
 *
 * No OS keyring in a container, so a random key is persisted on the data volume
 * and AES-256-GCM is used. The key MUST stay stable across restarts: upstream's
 * store.ts warns that if it changes, the encrypted data.json is read as corrupt
 * and the recovery path silently wipes every account.
 * ------------------------------------------------------------------ */
function loadOrCreateKey() {
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const raw = fs.readFileSync(SECRET_FILE, 'utf8').trim()
      if (raw.length === 64) return Buffer.from(raw, 'hex')
    }
  } catch {
    /* fall through and regenerate */
  }
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
    return true
  },
  encryptString(plainText) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
    const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const packed = `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
    return Buffer.from(packed, 'utf8')
  },
  decryptString(buffer) {
    const packed = Buffer.from(buffer).toString('utf8')
    if (!packed.startsWith('v1:')) {
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
 * Single port capture
 *
 * Upstream's ProxyServer owns a Koa app and calls app.listen(port, host, cb),
 * which ends at http.Server.prototype.listen. Left alone that opens a second
 * port for the container.
 *
 * CAPTURE POINT: http.Server.prototype.listen
 *
 * Patching Koa's prototype does not work here. electron-vite inlines the app's
 * dependencies into one bundle, so the Koa class inside upstream's bundle is a
 * private copy - patching the Koa required from node_modules affects a different
 * object, and the interception silently never fires. Node's own http module is
 * shared, so patching its listen() is reliable.
 *
 * The first listen() on the default port is intercepted: a handler is built by
 * replaying the server's own request listeners, __httpHandler is published, and a
 * stand-in handle is returned that is already "listening". Upstream's callback is
 * invoked (it does proxyStatusManager bookkeeping there) and its request
 * listeners are suppressed on the real server so only one path serves requests.
 *
 * Returns to normal for any later listen(), so nothing else is affected.
 * ------------------------------------------------------------------ */
const INTERCEPT_PORTS = new Set(
  (process.env.CHAT2API_INTERCEPT_PORTS || '18090,18080,8080')
    .split(',')
    .map((p) => parseInt(p.trim(), 10))
    .filter((p) => Number.isFinite(p))
)

let httpHandler = null
let httpListening = false

function portFromArgs(args) {
  const first = args[0]
  if (first && typeof first === 'object') return first.port
  return first
}

function installHttpCapture() {
  if (http.Server.prototype.__c2aCaptured) return
  const originalListen = http.Server.prototype.listen

  http.Server.prototype.listen = function capturedListen(...args) {
    const port = portFromArgs(args)
    // Only the first bound port that the app itself asks for is captured.
    if (httpHandler || !INTERCEPT_PORTS.has(port)) {
      return originalListen.apply(this, args)
    }

    const server = this
    // Node takes the callback last, in any position.
    const callback = args.find((a) => typeof a === 'function')
    // Keep the server's request listeners so the handler can replay them; then
    // detach them so the real server never sees traffic (it never binds anyway).
    const requestListeners = server.listeners('request').slice()
    for (const listener of requestListeners) server.removeListener('request', listener)

    httpHandler = function capturedHandler(req, res) {
      for (const listener of requestListeners) listener.call(server, req, res)
    }
    httpListening = true
    console.log(`[shim] captured the HTTP request handler on :${port} (single port)`)

    const stand_in = new EventEmitter()
    stand_in.listening = true
    stand_in.close = (cb) => {
      httpListening = false
      if (typeof cb === 'function') setTimeout(cb, 0)
      return stand_in
    }
    stand_in.address = () => ({ address: '127.0.0.1', family: 'IPv4', port })
    stand_in.ref = () => stand_in
    stand_in.unref = () => stand_in

    // Upstream's own bookkeeping lives in this callback: proxyStatusManager
    // .start() / setPort() / setHost() and a log entry. Skip it and the UI would
    // report the proxy as stopped while it is in fact serving.
    if (callback) setTimeout(() => callback(), 0)

    return stand_in
  }

  http.Server.prototype.__c2aCaptured = true
}

installHttpCapture()

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
  getAppPath: () => RESOURCES_DIR,
  getLocale: () => 'zh-CN',
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
  setLoginItemSettings: () => {},
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setAppUserModelId: () => {},
  setAboutPanelOptions: () => {},
  isPackaged: true,
  isQuitting: false,
}

/* ------------------------------------------------------------------ *
 * IPC bridge
 *
 * Upstream registers every renderer-facing capability as
 * `ipcMain.handle(channel, fn)`. Recording those handlers is what lets the real
 * renderer run in a browser.
 * ------------------------------------------------------------------ */
const eventBus = new EventEmitter()
eventBus.setMaxListeners(0)

/**
 * Opens requested before any client is listening.
 *
 * shell.openExternal is how upstream opens a login page, and OAuth adapters call
 * it directly without anyone having registered a listener first - so a plain
 * broadcast reached nobody and the browser never opened.
 */
const pendingOpens = []
let hasSubscribers = false

function emitEvent(channel, args) {
  if (channel === '__c2a:openExternal') {
    if (hasSubscribers) {
      eventBus.emit(channel, args)
    } else {
      pendingOpens.push(args)
      console.log('[shim] queued browser open until the UI connects:', args[0])
    }
    return
  }
  eventBus.emit(channel, args)
}

function replayPendingOpens() {
  if (hasSubscribers) return
  hasSubscribers = true
  if (pendingOpens.length === 0) return
  console.log(`[shim] replaying ${pendingOpens.length} queued browser open(s)`)
  for (const args of pendingOpens.splice(0)) eventBus.emit('__c2a:openExternal', args)
}

const ipcHandlers = new Map()
const ipcListeners = new Map()

const ipcMain = {
  handle: (channel, fn) => { ipcHandlers.set(channel, fn) },
  handleOnce: (channel, fn) => { ipcHandlers.set(channel, fn) },
  removeHandler: (channel) => { ipcHandlers.delete(channel) },
  on: (channel, fn) => {
    if (!ipcListeners.has(channel)) ipcListeners.set(channel, [])
    ipcListeners.get(channel).push(fn)
    return ipcMain
  },
  once: (channel, fn) => {
    const wrapped = (...args) => { ipcMain.removeListener(channel, wrapped); fn(...args) }
    return ipcMain.on(channel, wrapped)
  },
  removeListener: (channel, fn) => {
    const list = ipcListeners.get(channel)
    if (list) ipcListeners.set(channel, list.filter((f) => f !== fn))
    return ipcMain
  },
  removeAllListeners: (channel) => {
    if (channel === undefined) ipcListeners.clear()
    else ipcListeners.delete(channel)
    return ipcMain
  },
}

const windowStub = {
  webContents: {
    send: (channel, ...args) => { emitEvent(channel, args) },
    on: () => {}, once: () => {}, removeListener: () => {},
    executeJavaScript: async () => undefined,
    openDevTools: () => {}, closeDevTools: () => {},
    setWindowOpenHandler: () => {},
    session: null,
  },
  isDestroyed: () => false,
  isMinimized: () => false,
  isMaximized: () => false,
  isVisible: () => true,
  isFullScreen: () => false,
  minimize: () => {},
  maximize: () => {},
  unmaximize: () => {},
  restore: () => {},
  hide: () => {},
  show: () => {},
  focus: () => {},
  blur: () => {},
  close: () => {},
  destroy: () => {},
  setTitle: () => {},
  loadURL: async () => {},
  loadFile: async () => {},
  setMenu: () => {},
  on: () => {}, once: () => {}, removeListener: () => {},
}

/* ------------------------------------------------------------------ *
 * BrowserWindow / session
 * ------------------------------------------------------------------ */
function unsupported(feature) {
  const err = new Error(
    `[shim] ${feature} requires an Electron GUI, which this headless container `
    + `does not have. Supply the account's token/cookie directly, or complete `
    + `the verification in your own browser and paste the resulting cookie.`
  )
  err.code = 'ENOTSUP_HEADLESS'
  return err
}

class BrowserWindow {
  constructor() { throw unsupported('BrowserWindow') }
  static getAllWindows() { return [windowStub] }
  static getFocusedWindow() { return windowStub }
  static fromWebContents() { return null }
}

const session = {
  defaultSession: {
    cookies: { get: async () => [], set: async () => {}, remove: async () => {} },
    clearStorageData: async () => {},
    setProxy: async () => {},
  },
  fromPartition: () => { throw unsupported('session.fromPartition') },
  fromPath: () => { throw unsupported('session.fromPath') },
}

/* ------------------------------------------------------------------ *
 * net
 * ------------------------------------------------------------------ */
function buildNetRequest(options, callback) {
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

  let agent
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
  if (proxyUrl && isHttps) {
    try {
      const { HttpsProxyAgent } = require('https-proxy-agent')
      agent = new HttpsProxyAgent(proxyUrl)
    } catch {
      /* dependency absent - connect directly */
    }
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
 * shell / dialog
 * ------------------------------------------------------------------ */
const shell = {
  openExternal: async (url) => {
    console.log('[shim] shell.openExternal -> browser tab:', url)
    emitEvent('__c2a:openExternal', [String(url)])
    return undefined
  },
  showItemInFolder: () => {},
  openPath: async () => '',
}

const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
  showMessageBox: async () => ({ response: 0 }),
}

/* ------------------------------------------------------------------ *
 * Tray / Menu / nativeImage
 *
 * Inert rather than throwing: registerIpcHandlers calls
 * TrayManager.getInstance().updateProxyStatus() from the proxy start/stop
 * handlers, and a throw there would break the UI's own controls.
 * ------------------------------------------------------------------ */
const nativeImage = {
  createFromPath: () => ({
    isEmpty: () => true,
    resize: () => nativeImage.createEmpty(),
    setTemplateImage: () => {},
  }),
  createEmpty: () => ({
    isEmpty: () => true,
    resize: () => nativeImage.createEmpty(),
    setTemplateImage: () => {},
  }),
}

class Tray {
  constructor() { console.log('[shim] Tray is inert in the container build') }
  setToolTip() {} setImage() {} setContextMenu() {} setTitle() {}
  on() {} once() {} removeAllListeners() {} destroy() {} popUpContextMenu() {}
}

class Menu {
  static buildFromTemplate() { return new Menu() }
  static setApplicationMenu() {}
  static getApplicationMenu() { return null }
  popup() {}
  closePopup() {}
  append() { return this }
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

  // Not real Electron exports: bridge plumbing consumed by shim/gateway.js and
  // webui/server.js, which run in this same process.
  __isShim: true,
  __ipcHandlers: ipcHandlers,
  __ipcListeners: ipcListeners,
  __eventBus: eventBus,
  __windowStub: windowStub,
  __replayPendingOpens: replayPendingOpens,
  // The captured upstream HTTP handler, or null until the proxy binds. The front
  // server polls this; when null it falls back to a loopback port.
  __httpHandler: () => httpHandler,
  __httpListening: () => httpListening,
}
