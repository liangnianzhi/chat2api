/**
 * proxy-tap.js: the request-path seams that actually exist in the real bundle.
 *
 * WHY NOT A FORWARDER WRAP
 * ------------------------
 * The first design wrapped RequestForwarder.prototype.forwardChatCompletion.
 * Probing the shipped bundle (chunks/server-D4GzIgCk.js) showed why that can
 * never work:
 *
 *   class RequestForwarder { ... }                    // module-local, NOT exported
 *   const requestForwarder = new RequestForwarder()   // also not exported
 *
 * The only exported class on that path is ProxyServer, and its constructor
 * builds `this.app = new Koa()` then setupMiddleware() / setupRoutes() - all
 * synchronous, so by the time the shim can reach the object the middleware
 * stack is already built.
 *
 * Both seams below are driven by the shim (runtime-hooks.wrapProxyServer /
 * wrapLoadBalancer), and every call into them is guarded: a tap that throws
 * must never change the answer the client gets.
 *
 * SEAM 1 - the load balancer: WHO GETS PICKED
 * -------------------------------------------
 * The router picks accounts through
 *
 *   loadBalancer.selectAccount(model, strategy, preferredProviderId, preferredAccountId)
 *     -> this.getAvailableAccounts(model, preferredProviderId, failover)
 *          -> storeManager.getAccountsByProviderId(provider.id, true)
 *               .filter(a => this.isAccountAvailable(a))   // status === 'active'
 *
 * AccountManager.getAvailable() is NOT on that path, so wrapping it cannot veto
 * anything in the shipped build. getAvailableAccounts() is the one function the
 * router really calls before every completion, so the cooldown veto lives there
 * (runtime-hooks.wrapLoadBalancer filters its return value). The tap below only
 * remembers the last pool it saw, which is how a request that fails before the
 * handler publishes an account (503 no_available_account, 429 account_busy) can
 * still be attributed.
 *
 * SEAM 2 - a koa middleware in front of the router: WHAT HAPPENED
 * ---------------------------------------------------------------
 * wrapProxyServer gives every ProxyServer instance one extra middleware at
 * index 0 (in front of bodyParser). After next() returns it reads the router's
 * own verdict off ctx and reports it. The real shapes are:
 *
 *   success:  ctx.body = result.body                  // the provider payload
 *   failure:  ctx.body = { error: { message, type, param, code } }
 *             ctx.status = result.status || 500
 *   thrown:   ctx.status = 500, body = { error: { message, type: 'internal_error' } }
 *
 * There is no {success:false} envelope on the wire - that shape only exists
 * inside the forwarder's return value, which never reaches koa.
 */

'use strict'

const PATH_CHAT = '/v1/chat/completions'
const PATH_COMPLETIONS = '/v1/completions'

/** Is this the chat-completions route we care about? */
function isChatPath (p) {
  return normalize(p) === PATH_CHAT
}

/** Every per-request completion route (both share the same account budget). */
function isCompletionsPath (p) {
  const t = normalize(p)
  return t === PATH_CHAT || t === PATH_COMPLETIONS
}

function normalize (p) {
  if (typeof p !== 'string' || !p) return ''
  return p.length > 1 && p.charAt(p.length - 1) === '/' ? p.slice(0, -1) : p
}

/**
 * Codes that are OUR OWN routing verdicts, not the provider's. They must never
 * count as an account strike: no_available_account means the pool was empty
 * (often *because* an account is cooling) and account_busy means the slot
 * queue timed out. Cooling on those would ratchet an outage (if the veto ever
 * leaves the pool empty, the 503s would keep every account parked forever).
 */
const LOCAL_CODES = { no_available_account: true, account_busy: true }

function errorShape (body) {
  if (!body || typeof body !== 'object') return null
  const err = body.error
  if (!err) return null
  if (typeof err === 'string') return { message: err, type: '', code: '' }
  if (typeof err !== 'object') return null
  return {
    message: typeof err.message === 'string' ? err.message : '',
    type: typeof err.type === 'string' ? err.type : '',
    code: typeof err.code === 'string' ? err.code : ''
  }
}

/** Is this a local routing verdict rather than a provider failure? */
function isLocalVerdict (shape) {
  return Boolean(shape && shape.code && LOCAL_CODES[shape.code])
}

/**
 * Turn whatever the handler left on ctx into the error object the hooks expect,
 * or null when the request did not fail (or failed for a local reason).
 */
function failureOf (ctx) {
  const shape = errorShape(ctx && ctx.body)
  if (!shape) return null
  if (isLocalVerdict(shape)) return null
  const status = typeof ctx.status === 'number' && ctx.status >= 400
    ? ctx.status
    : (typeof ctx.status === 'number' ? ctx.status : null)
  const message = shape.message || shape.code || ('HTTP ' + status)
  const err = new Error(message)
  err.status = status
  err.type = shape.type
  err.code = shape.code
  err.selfhealVerdict = shape
  return err
}

/**
 * Who served this request? Decided by the LoadBalancer wrapper, which may choose
 * to switch accounts and retry after the first one failed.
 */
function who (ctx) {
  try {
    const st = ctx && ctx.state
    if (!st || typeof st.selfhealGetAccount !== 'function') return null
    const a = st.selfhealGetAccount()
    return a && a.id ? a : null
  } catch (e) {
    return null
  }
}

/**
 * The handler is about to hand `account` a task: attribute everything after.
 */
function attribute (ctx, account) {
  try {
    const st = ctx && ctx.state
    if (st && typeof st.selfhealBindAccount === 'function') st.selfhealBindAccount(account)
  } catch (e) { /* never break a request */ }
}

/** One-line, credential-free summary of a provider failure. */
function summarise (err) {
  const msg = err && err.message ? String(err.message) : 'unknown error'
  return msg.length > 160 ? msg.slice(0, 160) + '...' : msg
}

/** Record a successful provider answer for the account that produced it. */
function reportSuccess (ctx, ms) {
  try {
    const st = ctx && ctx.state
    if (st && typeof st.selfhealNoteOutcome === 'function') st.selfhealNoteOutcome(true, ms)
  } catch (e) { /* ignore */ }
}

/** Record a provider failure (auth/captcha/server) for the account that produced it. */
function reportFailure (ctx, error, ms) {
  try {
    const st = ctx && ctx.state
    if (st && typeof st.selfhealNoteOutcome === 'function') st.selfhealNoteOutcome(false, ms, error)
  } catch (e) { /* ignore */ }
}

/**
 * Build the middleware. `hooks` is expected to implement settle()/observe()
 * (see runtime-hooks.createHooks); missing methods are ignored.
 */
function createMiddleware (deps) {
  const d = deps || {}
  const hooks = d.hooks || {}
  const log = typeof d.log === 'function' ? d.log : () => {}
  const now = typeof d.now === 'function' ? d.now : () => Date.now()
  // runInRequest(ctx, next) publishes the ctx to the rest of the request, so the
  // load-balancer wrapper (called without a ctx) can still attribute its pool.
  const runInRequest = typeof d.runInRequest === 'function' ? d.runInRequest : (ctx, fn) => fn()

  /** Guard every call into the hook layer: it must never break a request. */
  const safe = (what, fn) => {
    try {
      return fn()
    } catch (e) {
      try {
        log('[selfheal] ' + what + ' hook error: ' + (e && e.message ? e.message : String(e)))
      } catch (e2) { /* ignore */ }
      return undefined
    }
  }

  return async function selfhealTap (ctx, next) {
    const path = ctx && (ctx.path || (ctx.request && ctx.request.path))
    if (!isCompletionsPath(path)) return next()
    const started = now()
    // NOTE: no pool snapshot here. A one-account pool is NOT proof that this
    // account served this request - a 503 (pool vetoed) or a 429 (busy) also
    // happens with exactly one candidate, and guessing there would let a local
    // routing verdict clear a legitimate cooldown. Attribution comes only from
    // wrapLoadBalancer.bindToRequest() (the request the picker really served)
    // or from ctx.state.selfhealAccount.
    try {
      await runInRequest(ctx, () => next())
    } catch (e) {
      const account = who(ctx) || safeAccount(ctx)
      safe('settle', () => hooks.settle(account, e, { ms: now() - started }))
      throw e
    }
    const account = who(ctx) || safeAccount(ctx)
    if (ctx && ctx.body === null && typeof hooks.settle === 'function') {
      // The router never produced an answer (neither body nor throw). Report it
      // as a local verdict - never as an account strike - so a broken/missing
      // route shows up in the stats instead of vanishing.
      const silent = new Error('empty response from the router')
      silent.status = ctx.status
      silent.selfhealSilent = true
      safe('settle', () => hooks.settle(null, silent, { ms: now() - started, silent: true }))
      return undefined
    }
    const failure = failureOf(ctx)
    const ms = now() - started
    if (failure) {
      safe('settle', () => hooks.settle(account, failure, { ms }))
      reportFailure(ctx, failure, ms)
    } else if (account && account.id) {
      // Only a real provider answer counts as a success: a local verdict was
      // filtered out above, and a 4xx still means the account is unhealthy.
      safe('settle', () => hooks.settle(account, null, { ms }))
      reportSuccess(ctx, ms)
    } else {
      // A provider failure we could not pin on an account. That is the one case
      // where guessing is worse than silence for a COOLDOWN (it could clear one),
      // but it must still be visible: an unattributed failure is a hole in the
      // attribution chain, and without this line it is simply invisible.
      try {
        if (failure) log('[selfheal] provider failure without a known account: ' + summarise(failure))
      } catch (e) { /* ignore */ }
      if (failure) safe('settle', () => hooks.settle(null, failure, { ms }))
    }
    return undefined
  }
}

/**
 * Which account served this request?
 *
 *   1. ctx.state.selfhealAccount  - published by the handler/wrapLoadBalancer
 *      when exactly one account was in play for this request.
 *   2. ctx.state.selfhealFastPool - the pool snapshot taken by observe(); only
 *      trusted when it held exactly one account (with several we would guess).
 */
function safeAccount (ctx) {
  try {
    const st = ctx && ctx.state
    if (!st) return null
    const direct = st.selfhealAccount
    if (direct && typeof direct === 'object' && direct.id) return direct
    // The picker was asked for THIS request and had exactly one candidate, so
    // that account is the one the router used. Anything else is a guess we
    // refuse to make: mis-attributing would clear a legitimate cooldown.
    const fast = st.selfhealFastPool
    if (fast && fast.bound && fast.certain && Array.isArray(fast.accounts) && fast.accounts.length === 1) {
      return fast.accounts[0]
    }
    return null
  } catch (e) {
    return null
  }
}

module.exports = {
  createMiddleware,
  who,
  attribute,
  reportSuccess,
  reportFailure,
  isChatPath,
  isCompletionsPath,
  failureOf,
  errorShape,
  isLocalVerdict,
  safeAccount,
  LOCAL_CODES,
  PATH: PATH_CHAT
}
