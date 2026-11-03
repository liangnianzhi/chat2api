/**
 * Runtime hooks: the part that actually sits on the request path.
 *
 * WHAT IS WRAPPED, AND WHY THIS AND NOT MORE
 * -----------------------------------------
 * Upstream sends every chat request through RequestForwarder:
 *
 *   forwardChatCompletion(request, account, provider, ...)
 *     -> doForward() -> providerForwarders[i].forward() | generic axios branch
 *     -> on failure: handleForwardError(account, provider, error, latency)
 *
 * handleForwardError is where upstream *decides* an account is dead, using
 * isAuthError() - the table that misses the DeepSeek wording '(invalid token)'.
 * We do not replace that decision (upstream keeps its own semantics); we add a
 * second opinion on the same signal and act on it:
 *
 *   failure -> classifyFailure()
 *         auth                 -> recheck the account once (AccountManager.validate),
 *                                 then clear it or cool it down
 *         captcha              -> never cooled down: a human problem, not a token bug
 *         rate/server/network  -> left alone (transient)
 *
 * Cooling down means: our own veto list plus upstream status 'error'. The status
 * change is what stops the very next request from picking the account, since
 * AccountManager.getAvailable() filters on status === 'active'.
 *
 * A successful forward to a cooling account clears the cooldown, so a false
 * positive self-heals on the first successful request instead of waiting out
 * the timer.
 *
 * Everything here is defensive: a hook that throws would break a request path,
 * so every callback is wrapped, and a missing upstream export disables the hook
 * with a log line instead of failing the container.
 */

'use strict'

const auth = require('./auth-errors')

const BS = String.fromCharCode(92);

/**
 * Find the AccountManager class in the bundle export graph. Kept as an
 * injectable dependency so tests can pass a stub.
 *
 * @param {(name: string, depth?: number) => (Function|null)} find
 * @returns {Function|null}
 */
function findAccountManager(find) {
  return typeof find === 'function' ? find('AccountManager', 4) : null;
}

/**
 * Narrow a forwarded-response value into {ok, status, data}.
 * The forwarders return either the provider payload or an envelope with
 * success/status; ApiResponse-style objects carry status + data.
 */
function describeResult(result) {
  if (!result || typeof result !== 'object') return { ok: true, status: null, data: result, envelope: null };
  const status = typeof result.status === 'number' ? result.status : null;
  const ok = result.success === false ? false : !(status && status >= 400);
  const data = result.data !== undefined ? result.data : result;
  return { ok, status, data, envelope: result };
}

/** Pull the provider body out of a thrown error, whatever shape it has. */
function bodyOf(error) {
  if (!error || typeof error !== 'object') return undefined;
  if (error.response && error.response.data !== undefined) return error.response.data;
  if (error.data !== undefined) return error.data;
  if (error.body !== undefined) return error.body;
  return undefined;
}

/** Is this message just a bare status stem with no information in it? */
function isBodylessMessage(message) {
  if (!message) return true;
  return new RegExp('^HTTP ' + BS + 'd{3}$').test(message);
}

/**
 * Build the hook set.
 *
 * @param {object} deps
 * @param {object} deps.health AccountHealth
 * @param {object} [deps.tokens] TokenCacheInvalidator
 * @param {object} [deps.sweeper] AccountSweeper (for noteExternal)
 * @param {Function|null} [deps.AccountManager] upstream AccountManager class
 * @param {(accountId: string) => Promise<object>} deps.validate validates one account
 * @param {(msg: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {object} [deps.options] { recheckTimeoutMs }
 * @returns {object} hooks
 */
function createHooks(deps) {
  const d = deps || {};
  const health = d.health;
  const tokens = d.tokens || null;
  const sweeper = d.sweeper || null;
  const AccountManager = d.AccountManager || null;
  const log = typeof d.log === 'function' ? d.log : (msg) => console.log(msg);
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const opts = Object.assign({ recheckTimeoutMs: 20000, degradedCooldownMs: 120000, autoStatus: true }, d.options || {});
  // Optional structured state log (SelfHeal.stateChange); no-op when absent.
  const stateChange = typeof d.stateChange === 'function' ? d.stateChange : () => {};
  const validate = typeof d.validate === 'function' ? d.validate : null;
  const stats = {
    seen: 0, settled: 0, unattributed: 0, lastLatencyMs: null,
    authFailures: 0, rechecks: 0, cooled: 0, cleared: 0,
    timeouts: 0, validateErrors: 0, inconclusive: 0, suppressed: 0, degraded: 0,
  };

  /** Update upstream status without letting a store error break a request. */
  // Status writer: SelfHeal injects one that honours CHAT2API_SELFHEAL_AUTO_STATUS;
  // the fallback keeps the plain AccountManager path for standalone use.
  const writeStatus = typeof d.updateStatus === 'function'
    ? d.updateStatus
    : async (accountId, status, errorMessage) => {
      if (!AccountManager || typeof AccountManager.updateStatus !== 'function') return false;
      return AccountManager.updateStatus(accountId, status, errorMessage ? auth.summarize(errorMessage) : undefined);
    };
  const setUpstreamStatus = async (accountId, status, errorMessage) => {
    try {
      return await writeStatus(accountId, status, errorMessage ? auth.summarize(errorMessage) : undefined);
    } catch (e) {
      log('[selfheal] could not update status for account ' + accountId + ': ' + auth.summarize(e && e.message));
      return false;
    }
  };

  /**
   * Validate with a timeout: a hung provider must not pin the account as
   * 'being re-checked' forever (the in-flight mark would block new re-checks).
   */
  const validateWithTimeout = async (accountId) => {
    if (!validate) return { valid: false, error: 'validator unavailable', networkError: true };
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        stats.timeouts += 1;
        resolve({ valid: false, error: 'validation timed out after ' + opts.recheckTimeoutMs + 'ms', networkError: true });
      }, opts.recheckTimeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => validate(accountId)), timeout]);
      return result || { valid: false, error: 'empty validation result', networkError: true };
    } catch (e) {
      stats.validateErrors += 1;
      return { valid: false, error: auth.summarize(e && e.message ? e.message : e), networkError: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * Re-check one account after an auth-classified failure, then cool it down or
   * clear it. Never throws: it runs detached from the request path.
   */
  const recheck = async (account, classification) => {
    stats.rechecks += 1;
    const accountId = account.id;
    const started = now();
    try {
      const result = await validateWithTimeout(accountId);
      const at = now();
      health.noteValidation(accountId, { at, valid: result.valid, error: result.error, networkError: result.networkError });
      if (sweeper && typeof sweeper.noteExternal === 'function') {
        sweeper.noteExternal(accountId, result);
      }
      if (result.valid) {
        const was = health.health(accountId, 'active');
        health.endCooldown(accountId, { reason: 'validation succeeded' });
        stats.cleared += 1;
        stateChange({
          account: accountId, provider: account.providerId, old: was === 'cooling' ? 'cooling' : was,
          new: 'active', reason: 'validate-ok', source: 'runtime',
          validate_ms: at - started,
        });
        log('[selfheal] account ' + accountId + ' (' + account.providerId + ') passed re-validation in ' +
          (at - started) + 'ms; keeping it in rotation');
        return { valid: true };
      }
      if (result.networkError) {
        // Cannot tell a dead token from a flaky network: do not touch the account.
        stats.inconclusive += 1;
        log('[selfheal] account ' + accountId + ' re-validation was inconclusive (' +
          auth.summarize(result.error) + '); leaving it in rotation');
        return { valid: false, inconclusive: true };
      }
      const reason = auth.summarize(result.error || classification.reason || 'validation failed');
      const record = health.startCooldown(accountId, { providerId: account.providerId, reason });
      stats.cooled += 1;
      await setUpstreamStatus(accountId, 'error', reason);
      stateChange({
        account: accountId, provider: account.providerId, old: 'active', new: 'error',
        reason: 'validate-invalid', source: 'runtime', class: reason,
        cooldown_ms: record.until - at, validate_ms: at - started, strikes: record.strikes,
        detail: reason,
      });
      if (tokens) tokens.invalidate(account);
      log('[selfheal] account ' + accountId + ' (' + account.providerId + ') is invalid: ' + reason +
        ' - parked for ' + Math.round((record.until - at) / 1000) + 's');
      return { valid: false, cooldown: record };
    } catch (e) {
      log('[selfheal] re-check of account ' + accountId + ' failed: ' + auth.summarize(e && e.message));
      return { valid: false, inconclusive: true };
    } finally {
      health.endRecheck(accountId);
    }
  };

  /**
   * The single failure entry point. Called from the wrapped forwarder with the
   * thrown error (or an error-shaped envelope) for one account.
   *
   * @returns {{classification: object|null, action: string}} what was decided
   */
  const onFailure = (account, error) => {
    stats.seen += 1;
    if (!account || !account.id) return { classification: null, action: 'none' };
    const body = bodyOf(error);
    const status = auth.statusOf(error);
    let message = auth.messageOf(error);
    if (isBodylessMessage(message) && body !== undefined) {
      const enriched = auth.describeHttpFailure(status || 'error', body);
      if (error && typeof error === 'object' && !error.selfhealOriginalMessage) {
        error.selfhealOriginalMessage = message;
        try { error.message = enriched; } catch (e) { /* frozen error object */ }
      }
      message = enriched;
    }
    const classification = auth.classifyFailure({ message, status });

    // A captcha / 风控 wall is classified 'captcha', not 'auth': the token may be
    // perfectly good, the upstream is just gate-keeping the account. Park it
    // briefly so we stop paying the full timeout on every single request, but
    // never write status=error and never add a strike (degrade: true).
    if (classification.class === 'captcha') {
      stats.degraded += 1;
      const degraded = health.startCooldown(account.id, {
        providerId: account.providerId,
        reason: classification.reason,
        durationMs: opts.degradedCooldownMs,
        degrade: true,
      });
      stateChange({
        account: account.id, provider: account.providerId, old: 'active', new: 'degraded',
        reason: 'captcha', source: 'runtime', class: classification.reason,
        cooldown_ms: degraded.until - now(),
        detail: classification.reason,
      });
      log('[selfheal] account ' + account.id + ' (' + account.providerId + ') hit a captcha wall; degraded for ' +
        Math.round((degraded.until - now()) / 1000) + 's (status untouched)');
      return { classification, action: 'degraded' };
    }

    if (!classification.auth) {
      if (classification.class !== 'unknown' && classification.class !== 'server') {
        log('[selfheal] account ' + account.id + ' (' + account.providerId + ') failed with a ' +
          classification.class + ' error (' + classification.reason + '); not an account problem');
      }
      return { classification, action: 'none' };
    }
    stats.authFailures += 1;
    const decision = health.observeFailure({
      accountId: account.id, providerId: account.providerId, classification, message, status,
    });
    if (decision.action !== 'recheck') {
      stats.suppressed += 1;
      return { classification, action: decision.action };
    }
    log('[selfheal] auth failure on account ' + account.id + ' (' + account.providerId + '): ' +
      classification.reason + ' [matched: ' + classification.matched + '] - re-validating in the background');
    // Detached on purpose: the failing request answers immediately instead of
    // waiting out a second provider round-trip. The load balancer already stops
    // offering the account as soon as the cooldown is set.
    Promise.resolve()
      .then(() => recheck(account, classification))
      .catch((e) => log('[selfheal] background re-check error: ' + auth.summarize(e && e.message)));
    return { classification, action: 'recheck' };
  };

  /** A successful forward proves the account is usable again. */
  const onSuccess = (account) => {
    if (!account || !account.id) return;
    if (health && health.isCoolingDown(account.id)) {
      health.endCooldown(account.id, { reason: 'request succeeded' });
      stats.cleared += 1;
      stateChange({
        account: account.id, provider: account.providerId, old: 'cooling', new: 'active',
        reason: 'request-ok', source: 'runtime',
      });
      log('[selfheal] account ' + account.id + ' served a request successfully; cooldown cleared');
    }
  };

  /**
   * Publish the account the handler picked for this request (proxy-tap calls
   * this before next()). Upstream does not hand it to us, so the tap records
   * what it can see and settle() uses the same slot.
   */
  const tracker = createAccountTracker(500);
  /**
   * bindToRequest(ctx): called by wrapLoadBalancer the moment the router asks
   * for the candidate pool of THIS request - the only place where we can see
   * (a) who is eligible and (b) which request is asking. The pool is recorded
   * on ctx.state so the tap can attribute a failure even when the handler
   * never publishes an account (503 no_available_account / 429 account_busy).
   */
  const bindToRequest = (ctx, entries) => {
    if (!ctx || !ctx.state) return null
    const pool = Array.isArray(entries) ? poolFrom(entries) : poolFromBalancer()
    try { ctx.state.selfhealFastPool = pool } catch (e) { /* frozen state */ }
    if (pool && pool.certain && pool.accounts.length === 1) tracker.put(ctx, pool.accounts[0])
    installStateSeams(ctx, pool)
    return pool
  };

  /**
   * Give the request's ctx the three knobs the patched completions handler and
   * the tap use to talk to us:
   *
   *   selfhealBindAccount(account)        the handler picked `account`: attribute
   *                                       everything after this point to it
   *   selfhealGetAccount()                who is on the hook right now
   *   selfhealNoteOutcome(ok, ms, error)  one attempt finished with that verdict
   *
   * The completions handler (proxy-tap.attribute) calls the first one right
   * after LoadBalancer.selectAccount(), which is what makes per-account
   * attribution exact even though the router's load balancer is module-private.
   */
  const installStateSeams = (ctx, pool) => {
    try {
      const st = ctx.state
      let current = (pool && pool.certain && pool.accounts.length === 1) ? pool.accounts[0] : null
      st.selfhealBindAccount = (account) => {
        if (account && account.id) {
          current = account
          tracker.put(ctx, account)
          st.selfhealAccount = account
        }
        return current
      }
      st.selfhealGetAccount = () => current
      st.selfhealNoteOutcome = (ok, ms, error) => {
        const target = current
        if (!target || !target.id) {
          if (!ok) stats.unattributed += 1
          return null
        }
        if (ok) return settle(target, null, { ms })
        // A provider failure on the request path is exactly the case this layer
        // exists for: re-validate, then park. settle() routes it through onFailure.
        return settle(target, error || new Error('request failed'), { ms })
      }
    } catch (e) { /* a hostile ctx.state must not break anything */ }
  };

  /**
   * Kept for API compatibility; attribution is now driven by the picker
   * (wrapLoadBalancer -> bindToRequest), never by the middleware, because a
   * pool snapshot taken before the router runs cannot say who served the
   * request and mis-attributing a 503 would clear a legitimate cooldown.
   */
  const observe = (ctx) => (ctx ? ctx.state && ctx.state.selfhealFastPool : null);

  // Last candidate pool the load balancer produced, set by wrapLoadBalancer.
  let balancerPool = null
  const setBalancerPool = (entries) => { balancerPool = entries }

  /**
   * Candidate pool of the request being served right now, as {accounts, certain}.
   * Preferred source: the load balancer (the router's real picker). Fallback:
   * AccountManager.getAvailable(), which is not on the router path in the
   * shipped bundle but is the only thing available in a stubbed test graph.
   */
  const poolFrom = (entries) => {
    const accounts = (Array.isArray(entries) ? entries : [])
      .map((entry) => (entry && entry.account) ? entry.account : entry)
      .filter((a) => a && a.id)
    return { accounts, certain: accounts.length === 1, bound: true, source: 'load-balancer' }
  };

  const poolFromBalancer = () => {
    if (Array.isArray(balancerPool)) return poolFrom(balancerPool)
    return poolFor()
  };

  /** Accounts that could serve a request right now, best effort. */
  const poolFor = () => {
    try {
      const am = AccountManager
      if (!am || typeof am.getAvailable !== 'function') return null
      const list = am.getAvailable()
      if (!Array.isArray(list) || list.length === 0) return null
      // One account is a certainty; many are only a shortlist.
      return { accounts: list, certain: list.length === 1 }
    } catch (e) {
      return null
    }
  };

  /**
   * The one place a request settles: called by proxy-tap with the account that
   * served it and either the failure or null.
   *
   * @param {object|null} account
   * @param {any} error null on success
   * @param {{ms?: number}} [meta]
   */
  const settle = (account, error, meta) => {
    stats.settled += 1
    if (meta && typeof meta.ms === 'number') {
      stats.lastLatencyMs = meta.ms
    }
    const target = account && account.id ? account : null
    if (!target) {
      // A failure we cannot attribute: nothing sensible to cool down. Cannot
      // attribute also means "do not let a silent 2xx clear a cooldown".
      if (error) {
        stats.unattributed += 1
        if (meta && meta.silent) stats.silent = (stats.silent || 0) + 1
        return { ok: false, unattributed: true }
      }
      return { ok: true, unattributed: true }
    }
    if (!error) {
      onSuccess(target)
      return { ok: true }
    }
    return onFailure(target, error)
  };

  return {
    installStateSeams,
    onFailure,
    onSuccess,
    settle,
    observe,
    bindToRequest,
    setBalancerPool,
    tracker,
    recheck,
    validateWithTimeout,
    describeResult,
    stats: () => Object.assign({}, stats),
  };
}

/**
 * Track which account served which request.
 *
 * The forwarder resolves the account inside the completions handler, which is
 * module-local and not reachable. The seam we do control (proxy-tap) can watch
 * the handler, so the handler's own choice is published there: `observe()` runs
 * before the router picks anything, `settle()` runs after the answer exists.
 * `pending` maps the request context to the account picked for it.
 */
function createAccountTracker(limit) {
  const max = limit || 500
  const pending = new Map()
  return {
    put(ctx, account) {
      if (!ctx || !account) return
      try {
        if (pending.size >= max) {
          const oldest = pending.keys().next()
          if (!oldest.done) pending.delete(oldest.value)
        }
        pending.set(ctx, account)
      } catch (e) { /* never break a request */ }
    },
    take(ctx) {
      try {
        const account = pending.get(ctx)
        pending.delete(ctx)
        return account || null
      } catch (e) {
        return null
      }
    },
    size() {
      return pending.size
    },
  }
}

/**
 * Routes whose handler picks an account and returns the provider's answer.
 * The account observer runs inside these handlers, where the selection is a
 * local variable - it is the only reliable attribution point in the shipped
 * bundle (LoadBalancer is a module-private singleton and not exported).
 */
const COMPLETION_ROUTES = ['/v1/chat/completions', '/v1/completions']

/**
 * Run `ctx` through koa-router layers to reach a route's leaf handlers.
 * Mirrors koa-router's own matching closely enough for "/v1/chat/completions".
 */
function matchRouteLayers(router, path) {
  const out = []
  const stack = (router && Array.isArray(router.stack)) ? router.stack : []
  for (const layer of stack) {
    if (!layer || typeof layer.path !== 'string') continue
    const methods = Array.isArray(layer.methods) ? layer.methods : []
    const exact = layer.path === path
    if (!exact) continue
    // A layer with methods is an endpoint; one without is a nested router's
    // "allowed methods" companion (upstream registers both).
    if (methods.length === 0) continue
    if (!methods.includes('POST')) continue
    const handlers = Array.isArray(layer.stack) ? layer.stack : []
    if (handlers.length) out.push({ layer, handlers })
  }
  return out
}

/**
 * Wrap the completions handlers so each request's chosen account is known.
 * Detection lives in proxy-tap; this only supplies the seam.
 */
function wireCompletionRoutes(router, deps) {
  const d = deps || {}
  const log = typeof d.log === 'function' ? d.log : (msg) => console.log(msg)
  let wrapped = 0
  for (const path of COMPLETION_ROUTES) {
    for (const entry of matchRouteLayers(router, path)) {
      entry.handlers.forEach((fn, i) => {
        if (typeof fn !== 'function' || fn.__selfhealWrapped) return
        // Only the AsyncLocal// Only the AsyncLocalStorage scope is set up here: the verdict itself is
        // read by the tap middleware AFTER the router returns (it is the only
        // place that sees the final ctx.status/ctx.body), so the wrapper must not
        // report an outcome as well or every request would be counted twice.
        const wrappedFn = d.runInRequest
          ? function selfhealRoute(ctx, next) {
            return d.runInRequest(ctx, () => fn.call(this, ctx, next))
          }
          : function selfhealRoute(ctx, next) {
            return fn.call(this, ctx, next)
          }
        wrappedFn.__selfhealWrapped = true
        wrappedFn.__selfhealOriginal = fn
        entry.handlers[i] = wrappedFn
        wrapped += 1
      })
    }
  }
  if (wrapped === 0) log('[selfheal] no completions route found on the router; per-account attribution stays off')
  else log('[selfheal] account observer attached to ' + wrapped + ' completions handler(s)')
  return wrapped
}

/**
 * Wrap AccountManager.getAvailable so a cooling account is never offered.
 *
 * Upstream drops accounts whose status is not 'active' and we also set the
 * status, so this is belt-and-braces for the window between a failure and the
 * async status write.
 *
 * @returns {boolean}
 */
function wrapAvailable(AccountManager, health, log) {
  if (!AccountManager || typeof AccountManager.getAvailable !== 'function') return false;
  if (AccountManager.getAvailable.__selfhealWrapped) return true;
  const original = AccountManager.getAvailable;
  const logger = typeof log === 'function' ? log : (msg) => console.log(msg);
  const wrapped = function getAvailableSelfheal() {
    const result = original.apply(this, arguments);
    try {
      if (!Array.isArray(result)) return result;
      const usable = health.filterAvailable(result);
      if (usable.length !== result.length) {
        logger('[selfheal] skipped ' + (result.length - usable.length) + ' cooling account(s) when selecting an account');
      }
      return usable;
    } catch (e) {
      logger('[selfheal] availability filter error: ' + auth.summarize(e && e.message));
      return result;
    }
  };
  wrapped.__selfhealWrapped = true;
  wrapped.__selfhealOriginal = original;
  AccountManager.getAvailable = wrapped;
  return true;
}

/**
 * Wrap LoadBalancer.prototype.getAvailableAccounts: THE account-picker seam.
 *
 * This is the function the completions router really calls before every
 * request (selectAccount -> getAvailableAccounts -> storeManager.getAccounts-
 * ByProviderId(...).filter(isAccountAvailable)). Wrapping it does two things:
 *
 *   1. VETO: cooling accounts are dropped from the candidate list, so a parked
 *      account is not offered again until its cooldown expires. Wrapping
 *      AccountManager.getAvailable() instead (wrapAvailable) has no effect on
 *      this path in the shipped bundle - it is kept only for graphs that route
 *      through it (and for tests).
 *   2. ATTRIBUTE: the pool is published on the request context via
 *      hooks.setBalancerPool + hooks.bindToRequest, so a failure that happens
 *      before any account is published (503 / 429) can still be attributed to
 *      the single candidate that was in play.
 *
 * @param {Function} LoadBalancer upstream class
 * @param {object} deps { hooks, health, log, requestContext }
 * @returns {{wrapped: boolean, reason?: string}}
 */
function wrapLoadBalancer(LoadBalancer, deps) {
  if (typeof LoadBalancer !== 'function' || !LoadBalancer.prototype) {
    return { wrapped: false, reason: 'LoadBalancer not exported' };
  }
  const d = deps || {};
  const proto = LoadBalancer.prototype;
  if (typeof proto.getAvailableAccounts !== 'function') {
    return { wrapped: false, reason: 'LoadBalancer.getAvailableAccounts not found' };
  }
  if (proto.getAvailableAccounts.__selfhealWrapped) return { wrapped: true, reason: 'already wrapped' };
  const hooks = d.hooks || {};
  const health = d.health || null;
  const log = typeof d.log === 'function' ? d.log : (msg) => console.log(msg);
  const ctxOf = typeof d.requestContext === 'function' ? d.requestContext : () => null;

  const original = proto.getAvailableAccounts;
  const wrapped = function getAvailableAccountsSelfheal() {
    const result = original.apply(this, arguments);
    try {
      if (!Array.isArray(result)) return result;
      const ctx = ctxOf();
      if (typeof hooks.setBalancerPool === 'function') hooks.setBalancerPool(result);
      if (!health || typeof health.filterAvailable !== 'function') return result;
      const kept = [];
      let dropped = 0;
      for (let i = 0; i < result.length; i += 1) {
        const entry = result[i];
        const account = entry && entry.account ? entry.account : entry;
        const id = account && account.id;
        if (id && health.isCoolingDown(id)) {
          dropped += 1;
          continue;
        }
        kept.push(entry);
      }
      if (dropped > 0) {
        log('[selfheal] skipped ' + dropped + ' cooling account(s) while selecting an account');
      }
      // Bind AFTER the veto: the pool the router will actually pick from.
      if (ctx && typeof hooks.bindToRequest === 'function') hooks.bindToRequest(ctx, kept);
      return kept;
    } catch (e) {
      log('[selfheal] account picker filter error: ' + auth.summarize(e && e.message));
      return result;
    }
  };
  wrapped.__selfhealWrapped = true;
  wrapped.__selfhealOriginal = original;
  proto.getAvailableAccounts = wrapped;
  return { wrapped: true };
}

module.exports = {
  createHooks,
  wrapLoadBalancer,
  wireCompletionRoutes,
  matchRouteLayers,
  COMPLETION_ROUTES,
  wrapAvailable,
  createAccountTracker,
  findAccountManager,
  describeResult,
  bodyOf,
  isBodylessMessage,
}
