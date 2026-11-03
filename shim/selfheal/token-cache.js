/**
 * Token cache invalidation for the providers that keep a module-level cache
 * inside upstream's shipped bundle.
 *
 * WHY THIS IS NEEDED
 * -------------------
 * Two adapters memoise acquired tokens in a module-private Map that nothing
 * outside the bundle can reach:
 *
 *   DeepSeekAdapter  tokenCache$1 : Map<token,        {accessToken, refreshToken, expiresAt}>  1h
 *   GLMAdapter       tokenCache   : Map<refreshToken, {accessToken, refreshToken, expiresAt}>  1h
 *
 * After an operator replaces a dead credential through the management API the
 * stale entry keeps winning for up to an hour, so the account still looks
 * broken even though the stored credential is good. The Maps are unreachable,
 * but the adapters are, and every request goes through acquireToken(). Two
 * things follow from that:
 *
 *   1. Cache keys are derived here exactly like the adapters derive them, so a
 *      rotated credential naturally maps to a different key (a cache miss).
 *   2. acquireToken() is wrapped so a served token for an account whose entry
 *      was invalidated is noticed and counted, instead of silently reused.
 *
 * Dependency-free, pure key logic, clock injectable: unit-testable without a
 * provider or a bundle.
 */

'use strict'

/** DeepSeek keys the cache by the credential itself (token || apiKey || refreshToken). */
function deepseekKey(credentials) {
  const c = credentials || {}
  return c.token || c.apiKey || c.refreshToken || ''
}

/** GLM keys the cache by the refresh token, falling back to token. */
function glmKey(credentials) {
  const c = credentials || {}
  return c.refresh_token || c.token || ''
}

/** Providers with a module-level token cache, and how to key it. */
const PROVIDERS = {
  deepseek: { adapter: 'DeepSeekAdapter', key: deepseekKey },
  glm: { adapter: 'GLMAdapter', key: glmKey },
}

/** How long an invalidation mark is kept (one full cache lifetime). */
const INVALIDATION_TTL_MS = 60 * 60 * 1000

/**
 * Depth-bounded search for a class by name in a module export graph.
 * The bundle is a single large CommonJS graph with circular references, so a
 * visited set and a depth limit are mandatory.
 *
 * @param {any} root
 * @param {string} className
 * @param {number} [maxDepth]
 * @returns {Function|null}
 */
function findByExportName(root, className, maxDepth) {
  const seen = new Set()
  const limit = typeof maxDepth === 'number' ? maxDepth : 4
  const stack = [{ value: root, depth: 0 }]
  while (stack.length) {
    const item = stack.pop()
    const value = item.value
    if (!value) continue
    const t = typeof value
    if (t !== 'object' && t !== 'function') continue
    if (seen.has(value)) continue
    seen.add(value)
    if (t === 'function') {
      if (value.name === className && value.prototype) return value
      continue
    }
    if (item.depth >= limit) continue
    let keys = []
    try {
      keys = Object.keys(value)
    } catch (e) {
      continue
    }
    for (let i = 0; i < keys.length; i += 1) {
      let child
      try {
        child = value[keys[i]]
      } catch (e) {
        continue
      }
      const ct = typeof child
      if (child && (ct === 'object' || ct === 'function')) {
        stack.push({ value: child, depth: item.depth + 1 })
      }
    }
  }
  return null
}

class TokenCacheInvalidator {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]
   * @param {(msg: string) => void} [options.log]
   */
  constructor(options) {
    const opts = options || {}
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.log = typeof opts.log === 'function' ? opts.log : (msg) => console.log(msg)
    /** accountId -> {providerId, key, at, expiresAt} */
    this.invalidated = new Map()
    /** providerId -> true once the adapter prototype is wrapped */
    this.installed = new Map()
    this.served = { deepseek: 0, glm: 0 }
    // Called as (providerId, account, error) whenever an adapter's acquireToken()
    // throws. This is the ONE place where the failing account is known exactly:
    // the adapters are exported, forwardChatCompletion is not.
    this.onAcquireFailure = typeof opts.onAcquireFailure === 'function' ? opts.onAcquireFailure : null
    this.refreshed = { deepseek: 0, glm: 0 }
    this.missing = []
  }

  /**
   * Cache key for a provider, or null when the provider keeps no such cache.
   * Used by tests and by the wrapper.
   */
  keyFor(providerId, credentials) {
    const spec = PROVIDERS[providerId]
    if (!spec) return null
    const key = spec.key(credentials)
    return key || null
  }

  /**
   * Mark an account's cached token stale. Called after the credential is
   * replaced through the management API and after a validation proved it dead.
   * @returns {boolean} whether the provider actually keeps a cache
   */
  invalidate(account) {
    if (!account || !account.id) return false
    const providerId = account.providerId
    const key = this.keyFor(providerId, account.credentials)
    if (!key) return false
    const now = this.now()
    this.invalidated.set(account.id, { providerId, key, at: now, expiresAt: now + INVALIDATION_TTL_MS })
    this.log('[selfheal] token cache invalidated for account ' + account.id + ' (' + providerId + ')')
    return true
  }

  /** Has this account's cache entry been invalidated for this credential? */
  isInvalidated(accountId, key) {
    const entry = this.invalidated.get(accountId)
    if (!entry) return false
    if (entry.expiresAt <= this.now()) {
      this.invalidated.delete(accountId)
      return false
    }
    return key ? entry.key === key : true
  }

  /** Number of invalidations still inside their retention window. */
  pending() {
    let n = 0
    const now = this.now()
    for (const entry of this.invalidated.values()) {
      if (entry.expiresAt > now) n += 1
    }
    return n
  }

  /**
   * Wrap one adapter class's acquireToken().
   *
   * A cached token is returned without any provider round-trip, so a dead entry
   * is invisible from the outside. The wrapper notices a served token for an
   * account whose entry was invalidated, drops the mark (the operator's refresh
   * has now happened) and counts both events, so /health can show the wrapper is
   * actually live.
   *
   * @returns {{wrapped: boolean, reason?: string}}
   */
  wrapAdapter(adapterClass, providerId) {
    const spec = PROVIDERS[providerId]
    if (!spec) return { wrapped: false, reason: 'unknown provider ' + providerId }
    if (typeof adapterClass !== 'function' || !adapterClass.prototype) {
      return { wrapped: false, reason: 'adapter class not found' }
    }
    const proto = adapterClass.prototype
    if (proto.__selfhealWrapped) return { wrapped: true, reason: 'already wrapped' }
    const original = proto.acquireToken
    if (typeof original !== 'function') return { wrapped: false, reason: 'acquireToken not found' }
    const self = this
    const wrapped = async function acquireTokenSelfheal() {
      self.served[providerId] = (self.served[providerId] || 0) + 1
      const account = this.account || {}
      const key = spec.key(account.credentials || {})
      const stale = account.id ? self.isInvalidated(account.id, key) : false
      try {
        const token = await original.apply(this, arguments)
        if (stale) {
          self.invalidated.delete(account.id)
          self.refreshed[providerId] = (self.refreshed[providerId] || 0) + 1
        }
        return token
      } catch (err) {
        if (self.onAcquireFailure) {
          try { self.onAcquireFailure(providerId, account, err) } catch (e) {}
        }
        if (stale) {
          // Refresh failed: drop the mark as well, otherwise the next successful
          // request would keep reporting a refresh that never happened.
          self.invalidated.delete(account.id)
        }
        throw err
      }
    }
    wrapped.__selfhealOriginal = original
    proto.acquireToken = wrapped
    proto.__selfhealWrapped = true
    return { wrapped: true }
  }

  /**
   * Install against a loaded bundle's export graph. Idempotent and safe to call
   * repeatedly (the bundle may still be warming up when the supervisor boots).
   *
   * @param {any} exportsGraph bundle module.exports (or anything reachable from it)
   * @returns {{installed: string[], missing: string[]}}
   */
  install(exportsGraph) {
    const installed = []
    const missing = []
    for (const providerId of Object.keys(PROVIDERS)) {
      const spec = PROVIDERS[providerId]
      if (this.installed.get(providerId)) {
        installed.push(providerId)
        continue
      }
      const adapterClass = findByExportName(exportsGraph, spec.adapter)
      const outcome = adapterClass ? this.wrapAdapter(adapterClass, providerId) : { wrapped: false, reason: 'not in export graph' }
      if (outcome.wrapped) {
        this.installed.set(providerId, true)
        installed.push(providerId)
        this.log('[selfheal] wrapping ' + spec.adapter + '.acquireToken() for token cache invalidation')
      } else {
        missing.push(providerId)
        this.log('[selfheal] token cache for ' + providerId + ' not installed (' + outcome.reason + ')')
      }
    }
    this.missing = missing
    return { installed, missing }
  }

  /** Counters for /health. */
  stats() {
    return {
      installed: Array.from(this.installed.keys()),
      missing: this.missing.slice(),
      pending: this.pending(),
      served: Object.assign({}, this.served),
      refreshed: Object.assign({}, this.refreshed),
    }
  }
}

module.exports = { TokenCacheInvalidator, PROVIDERS, deepseekKey, glmKey, findByExportName, INVALIDATION_TTL_MS }
