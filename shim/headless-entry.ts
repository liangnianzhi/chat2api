/**
 * Headless entry point, compiled by the upstream electron-vite build.
 *
 * WHY THIS FILE LIVES IN THE UPSTREAM SOURCE TREE
 * ----------------------------------------------
 * The upstream build (electron-vite + Rollup) emits the whole main process as
 * ONE tree-shaken bundle (out/main/index.js). Because nothing outside imported
 * `storeManager` or `ProxyServer`, Rollup dropped those exports - so an external
 * script cannot require() them.
 *
 * Adding this file as an extra Rollup input makes the bundler see real imports
 * of both and keep them. The result is out/main/headless.js: a self-contained
 * bundle that starts the proxy with no Electron GUI.
 *
 * It is copied into src/main/ at image build time and never touches upstream
 * behaviour: the normal GUI entry (index.ts) is unchanged.
 */

import { randomBytes } from 'crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import { storeManager } from './store/store'
import { ProxyServer } from './proxy/server'

/* ------------------------------------------------------------------ *
 * Environment-driven configuration
 * ------------------------------------------------------------------ */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase())
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

const WEBUI_ENABLED = envBool('CHAT2API_ENABLE_WEBUI', true)
const ENV_SECRET = process.env.CHAT2API_MANAGEMENT_SECRET || ''

/**
 * The web console drives the management API, so that API must be on whenever the
 * console is. Requiring a second flag (and a secret) just to get a working UI is
 * friction with no benefit: the secret is generated automatically below.
 */
const MANAGEMENT_API_ENABLED =
  envBool('CHAT2API_ENABLE_MANAGEMENT_API', false) || WEBUI_ENABLED

const DATA_DIR = process.env.CHAT2API_HOME || join(process.env.HOME || '/data', '.chat2api')
const SECRET_FILE = join(DATA_DIR, '.management-secret')

const CONFIG = {
  port: envInt('CHAT2API_PORT', 8080),
  // 0.0.0.0 is required for the port to be reachable outside the container.
  host: process.env.CHAT2API_HOST || '0.0.0.0',
  apiKey: process.env.CHAT2API_API_KEY || '',
  enableApiKey: envBool('CHAT2API_ENABLE_API_KEY', Boolean(process.env.CHAT2API_API_KEY)),
  logLevel: process.env.CHAT2API_LOG_LEVEL || 'info',
  enableCors: envBool('CHAT2API_ENABLE_CORS', true),
  corsOrigin: process.env.CHAT2API_CORS_ORIGIN || '*',
  loadBalanceStrategy: process.env.CHAT2API_LB_STRATEGY || 'round-robin',
  enableManagementApi: MANAGEMENT_API_ENABLED,
  managementSecret: ENV_SECRET,
}

console.log('[headless] Chat2API gateway starting')
console.log('[headless] listening target:', `${CONFIG.host}:${CONFIG.port}`)

/**
 * Publish the effective management secret where the console can read it.
 *
 * The console is a separate process and cannot decrypt data.json, so the secret
 * is mirrored to a 0600 file on the same volume. This is the same trust
 * boundary as the credential-encryption key stored alongside it.
 */
function writeSecretFile(secret: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
    chmodSync(SECRET_FILE, 0o600)
  } catch (err) {
    console.warn('[headless] could not write management secret file:',
      err instanceof Error ? err.message : err)
  }
}

/* ------------------------------------------------------------------ *
 * Seed configuration the container needs.
 *
 * Precedence: values already stored in data.json win for anything the operator
 * may have tuned through the console (load balancing, log level, ...), so their
 * choices survive a restart. The management secret is the exception: the
 * environment is authoritative when it provides one, so rotating it in the
 * compose file takes effect on restart.
 * ------------------------------------------------------------------ */
async function reconcileConfig(): Promise<void> {
  const current = storeManager.getConfig() as Record<string, any>
  const updates: Record<string, any> = {}

  if (current.proxyPort !== CONFIG.port) updates.proxyPort = CONFIG.port
  if (current.proxyHost !== CONFIG.host) updates.proxyHost = CONFIG.host
  if (current.enableCors !== CONFIG.enableCors) updates.enableCors = CONFIG.enableCors
  if (current.corsOrigin !== CONFIG.corsOrigin) updates.corsOrigin = CONFIG.corsOrigin
  if (current.logLevel !== CONFIG.logLevel) updates.logLevel = CONFIG.logLevel
  if (current.loadBalanceStrategy !== CONFIG.loadBalanceStrategy) {
    updates.loadBalanceStrategy = CONFIG.loadBalanceStrategy
  }

  if (CONFIG.enableApiKey) {
    updates.enableApiKey = true
    if (CONFIG.apiKey) {
      const keys = Array.isArray(current.apiKeys) ? current.apiKeys : []
      if (!keys.some((k: any) => k && k.key === CONFIG.apiKey)) {
        updates.apiKeys = [
          ...keys,
          {
            id: `env-${Date.now()}`,
            name: 'env-injected',
            key: CONFIG.apiKey,
            enabled: true,
            createdAt: Date.now(),
            usageCount: 0,
            description: 'Injected from CHAT2API_API_KEY',
          },
        ]
        console.log('[headless] API key from environment registered')
      }
    }
  }

  if (CONFIG.enableManagementApi) {
    const currentMgmt = current.managementApi || {}
    // env > stored > freshly generated. Generated once, then persisted in
    // data.json so restarts keep the same value and open consoles keep working.
    let effectiveSecret: string = ENV_SECRET || currentMgmt.managementApiSecret || ''
    if (!effectiveSecret) {
      effectiveSecret = randomBytes(32).toString('hex')
      console.log('[headless] generated a management secret for the console')
    }

    if (
      currentMgmt.enableManagementApi !== true ||
      currentMgmt.managementApiSecret !== effectiveSecret
    ) {
      updates.managementApi = {
        ...currentMgmt,
        enableManagementApi: true,
        managementApiSecret: effectiveSecret,
      }
      if (ENV_SECRET && currentMgmt.managementApiSecret &&
          currentMgmt.managementApiSecret !== ENV_SECRET) {
        console.log('[headless] management secret updated from environment')
      }
    }

    writeSecretFile(effectiveSecret)
  }

  // A headless process must never try to minimise into a tray that cannot exist.
  updates.minimizeToTray = false

  if (Object.keys(updates).length > 0) {
    storeManager.updateConfig(updates)
    console.log('[headless] config reconciled:', Object.keys(updates).join(', '))
  } else {
    console.log('[headless] config already matches environment')
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
async function main(): Promise<void> {
  try {
    await storeManager.initialize()
  } catch (err) {
    console.error('[headless] FATAL: store initialization failed')
    console.error(err instanceof Error ? err.stack : err)
    process.exit(1)
  }

  await reconcileConfig()

  const server = new ProxyServer()
  const ok = await server.start(CONFIG.port, CONFIG.host)
  if (!ok) {
    console.error(`[headless] FATAL: proxy failed to listen on ${CONFIG.host}:${CONFIG.port}`)
    process.exit(1)
  }

  const providers = storeManager.getProviders()
  const accounts = storeManager.getAccounts()
  console.log(`[headless] ready - providers: ${providers.length}, accounts: ${accounts.length}`)
  if (accounts.length === 0) {
    console.log('[headless] no accounts configured yet.')
    console.log('[headless] open the web console to add them')
  }

  /* Graceful shutdown: flush upstream's buffered log writers so the data
   * volume never keeps a partial write. */
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[headless] received ${signal}, shutting down`)
    try {
      await server.stop()
    } catch (err) {
      console.warn('[headless] error stopping server:', err instanceof Error ? err.message : err)
    }
    try {
      storeManager.flushPendingWrites()
    } catch (err) {
      console.warn('[headless] error flushing writes:', err instanceof Error ? err.message : err)
    }
    process.exit(0)
  }

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => { void shutdown(sig) })
  }

  process.on('uncaughtException', (err) => {
    console.error('[headless] uncaught exception:', err instanceof Error ? err.stack : err)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[headless] unhandled rejection:', reason)
  })
}

void main().catch((err) => {
  console.error('[headless] FATAL:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
