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
 * that lets the real renderer drive the real main-process logic from a browser
 * (see "IPC bridge" below).
 */

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')

const DATA_DIR = process.env.CHAT2API_HOME || path.join(process.env.HOME || '/data', '.chat2api')
const SECRET_FILE = path.join(DATA_DIR, '.safe-storage-key')

/* ------------------------------------------------------------------ *
 * process.resourcesPath
 *
 * Electron defines this; plain Node does not. The compiled bundle uses it to
 * locate the sha3 wasm it needs for DeepSeek/GLM request signing:
 *
 *   const wasmPath = app.isPackaged
 *     ? path.join(process.resourcesPath, "sha3_wasm_bg.7b9ca65ddd.wasm")
 *     : path.join(app.getAppPath(), "sha3_wasm_bg.7b9ca65ddd.wasm")
 *
 * With app.isPackaged = true and resourcesPath undefined that path.join throws
 * a TypeError - so signing would fail on the first real request. Point it at
 * the directory that actually holds the wasm (beside the bundle).
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
 * Electron's safeStorage encrypts via the OS keyring. A container has none, so
 * a random key is persisted on the data volume and AES-256-GCM is used instead.
 * The format is versioned so it stays self-describing.
 *
 * The key MUST stay stable across restarts: upstream's store.ts warns that if it
 * changes, the encrypted data.json is read as corrupt and the recovery path
 * silently wipes every account.
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
    // v1:<iv>:<tag>:<ciphertext>  (all base64)
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
  // Used by lib/autoStart. There is no login session to register into, and the
  // container's own restart policy is what keeps it running.
  setLoginItemSettings: () => {},
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setAppUserModelId: () => {},
  setAboutPanelOptions: () => {},
  isPackaged: true,
  // Upstream sets this before closing to distinguish quit from hide-to-tray.
  isQuitting: false,
}

/* ------------------------------------------------------------------ *
 * IPC bridge
 *
 * Upstream registers every renderer-facing capability as
 * `ipcMain.handle(channel, fn)`. Recording those handlers is what lets the real
 * renderer run in a browser: the front server dispatches HTTP calls into this
 * map, so every UI action lands on upstream's own implementation.
 *
 * The window stub stands in for the BrowserWindow that would normally exist.
 * Its webContents.send feeds the event bus (so status/config/OAuth events reach
 * the page), and it carries the window methods upstream calls on mainWindow.
 * ------------------------------------------------------------------ */
const eventBus = new EventEmitter()
// SSE listeners can be several; the UI may open more than one tab.
eventBus.setMaxListeners(0)

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
    send: (channel, ...args) => { eventBus.emit(channel, args) },
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
windowStub.webContents.session = null

/* ------------------------------------------------------------------ *
 * BrowserWindow / session
 *
 * Only optional GUI features use these (the Qwen captcha window). Constructing
 * a real window in a browser-hosted UI makes no sense, so it throws a message
 * that points at the manual path. getAllWindows() still returns the stub so
 * upstream's broadcast loops reach the event bus.
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
 *
 * Chromium's net module backs the Perplexity adapter. Node's http/https is the
 * equivalent and honours a configured upstream proxy.
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
    // No desktop to open onto. Hand it to the UI, which opens a real tab.
    console.log('[shim] shell.openExternal -> browser tab:', url)
    eventBus.emit('__c2a:openExternal', [String(url)])
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

  // Not real Electron exports: these are the bridge plumbing, consumed by
  // shim/gateway.js and webui/server.js, which run in this same process.
  __isShim: true,
  __ipcHandlers: ipcHandlers,
  __ipcListeners: ipcListeners,
  __eventBus: eventBus,
  __windowStub: windowStub,
}
