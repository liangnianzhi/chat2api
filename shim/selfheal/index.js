/**
 * Self-heal wiring: turns the five building blocks into one supervisor.
 *
 * THE FIVE BUILDING BLOCKS
 * ------------------------
 *   auth-errors.js     pure: what does this failure mean?
 *   account-health.js  the cooldown / validation table (the veto list)
 *   runtime-hooks.js   wraps the request path, decides per failure
 *   sweep.js           periodic validation so idle accounts are not neglected
 *   reason-fidelity.js keeps the provider response body in error messages
 *   token-cache.js     invalidates the adapters' 1h token caches
 *
 * THE ENTRY POINT
 * ---------------
 *   install({ load: () => bundleExports })  - called by the gateway once the
 *   upstream bundle has been required. Everything found there is patched;
 *   whatever is missing is reported, never fatal, because the shim must keep
 *   the container serving even if upstream renames an internal.
 *
 *   snapshot()                              - synchronous, no I/O, never throws;
 *   published as globalThis.__chat2apiSelfHeal for /health.
 *
 * CONFIGURATION (environment, all optional)
 * ----------------------------------------
 *   CHAT2API_SELFHEAL=0                  disable the whole layer
 *   CHAT2API_SELFHEAL_COOLDOWN_MS=60000  base cooldown after a confirmed bad account
 *   CHAT2API_SELFHEAL_COOLDOWN_MAX_MS    ceiling of the exponential backoff
 *   CHAT2API_ACCOUNT_RECHECK_SEC=60      how often non-active accounts are re-validated
 *   CHAT2API_SELFHEAL_REVALIDATE_FRESH_MS treat a validation this recent as final
 *   CHAT2API_SELFHEAL_TIMEOUT_MS=20000   cap on one validation round-trip
 *   autoCheckAccountsIntervalMinutes     sweep interval (env var of the same name
 *                                        is also honoured, as minutes)
 */

'use strict'

const { AccountHealth } = require('./account-health')
const auth = require('./auth-errors')
const hooks = require('./runtime-hooks')
const reason = require('./reason-fidelity')
const { AccountSweeper } = require('./sweep')
const { TokenCacheInvalidator, findByExportName } = require('./token-cache')
const path = require('path')
const fs = require('fs')

const GLOBAL_KEY = '__chat2apiSelfHeal'

/**
 * The Koa ctx of the request currently being served, so the account-picker
 * wrapper (which upstream calls without any request argument) can attribute the
 * pool it just produced to the right request. AsyncLocalStorage keeps it right
 * under concurrency; when the module is unavailable we degrade to null and the
 * tap falls back to "the pool holds exactly one account" attribution.
 */
let requestStore = null
try {
  const { AsyncLocalStorage } = require('async_hooks')
  requestStore = new AsyncLocalStorage()
} catch (e) { /* older runtime: no attribution, still safe */ }

/** The ctx of the in-flight request (null outside a request). */
function currentRequest() {
  if (!requestStore) return null
  try {
    return requestStore.getStore() || null
  } catch (e) {
    return null
  }
}

/**
 * Wrap next() so everything the router does inherits the request context.
 * @param {any} ctx
 * @param {() => Promise<any>} next
 */
function runInRequest(ctx, next) {
  if (!requestStore) return next()
  return requestStore.run(ctx, next)
}

/** Read a positive integer from the environment, with a default. */
function envInt(name, fallback, min) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  const v = Math.floor(n)
  return v < (min === undefined ? 1 : min) ? fallback : v
}

/** Read a boolean flag (1/true/yes/on). */
function envBool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].indexOf(String(raw).toLowerCase()) !== -1;
}

/** Configuration resolved from the environment (pure, testable). */
function resolveConfig(env) {
  const e = env || process.env;
  const readInt = (name, fallback, min) => {
    const raw = e[name]
    if (raw === undefined || raw === null || raw === '') return fallback
    const n = Number(raw)
    if (!Number.isFinite(n)) return fallback
    const v = Math.floor(n)
    return v < (min === undefined ? 1 : min) ? fallback : v;
  };
  const sweepMinutes = readInt('autoCheckAccountsIntervalMinutes', 0) || readInt('CHAT2API_SELFHEAL_SWEEP_MINUTES', 30);
  return {
    enabled: ['0', 'false', 'no', 'off'].indexOf(String(e.CHAT2API_SELFHEAL || '').toLowerCase()) === -1,
    cooldownMs: readInt('CHAT2API_SELFHEAL_COOLDOWN_MS', 60000, 1000),
    cooldownMaxMs: readInt('CHAT2API_SELFHEAL_COOLDOWN_MAX_MS', 30 * 60 * 1000, 1000),
    recheckIntervalSec: readInt('CHAT2API_ACCOUNT_RECHECK_SEC', 60, 5),
    sweepIntervalMinutes: sweepMinutes,
    validatedFreshMs: readInt('CHAT2API_SELFHEAL_REVALIDATE_FRESH_MS', 10 * 60 * 1000, 1000),
    recheckTimeoutMs: readInt('CHAT2API_SELFHEAL_TIMEOUT_MS', 20000, 1000),
    spacingMs: readInt('CHAT2API_SELFHEAL_SWEEP_SPACING_MS', 1500, 0),
    // Safety rails (see README: conservative defaults, never punish a good account).
    sweepMaxAccounts: readInt('CHAT2API_SELFHEAL_SWEEP_MAX_ACCOUNTS', 200, 1),
    autoStatus: envBoolLocal(e.CHAT2API_SELFHEAL_AUTO_STATUS, true),
    degradedCooldownMs: readInt('CHAT2API_SELFHEAL_DEGRADED_COOLDOWN_MS', 120000, 1000),
    dataDir: e.CHAT2API_HOME || (e.HOME ? e.HOME + '/.chat2api' : '/data/.chat2api'),
  };
}

/** Local boolean reader (keep resolveConfig self-contained). */
function envBoolLocal(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['0', 'false', 'no', 'off'].indexOf(String(raw).toLowerCase()) === -1;
}

/**
 * The supervisor. One per process; `install` is idempotent.
 */
class SelfHeal {
  /**
   * @param {object} [options]
   * @param {object} [options.config] resolveConfig() overrides
   * @param {() => number} [options.now]
   * @param {(msg: string) => void} [options.log]
   */
  constructor(options) {
    const opts = options || {};
    this.config = Object.assign(resolveConfig(), opts.config || {});
    /** Machine-readable state-change log (docker logs verification). */
    this.stateLog = typeof opts.stateLog === 'function' ? opts.stateLog : (line) => console.log(line);
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.log = typeof opts.log === 'function' ? opts.log : (msg) => console.log(msg);
    this.health = new AccountHealth({
      now: this.now,
      cooldownMs: this.config.cooldownMs,
      cooldownMaxMs: this.config.cooldownMaxMs,
      validatedFreshMs: this.config.validatedFreshMs,
    });
    // The adapter's acquireToken() is the only seam that knows WHICH account
    // failed: the forwarder that throws 'Failed to acquire token' is a
    // module-local singleton the bundle never exports. So the failure signal
    // enters self-heal from here (see install(): the hook is attached later,
    // once hooks exist).
    this.onAcquireFailure = null;
    this.tokens = new TokenCacheInvalidator({
      now: this.now,
      log: this.log,
      onAcquireFailure: (providerId, account, err) => {
        if (typeof this.onAcquireFailure === 'function') this.onAcquireFailure(providerId, account, err);
      },
    });
    this.upstream = null;
    this.hooks = null;
    this.sweeper = null;
    this.installed = { hooks: false, balancer: false, available: false, reason: [], tokens: [], missing: [] };
    this.startedAt = null;
    /** Last account list seen by the sweeper; /health reads the snapshot. */
    this.accountCache = null;
  }

  /**
   * Resolve the upstream classes we build on.
   * @param {any} graph bundle export graph
   */
  resolve(graph) {
    const find = (name, depth) => {
      // Prefer a direct export: once ProxyServer has been replaced by the
      // patched subclass, its .name is ProxyServerSelfHeal and a name-based
      // deep search would walk past it (and miss the ORIGINAL class, so the
      // patch would be re-applied to a stale reference on a reload).
      const own = graph && typeof graph === 'object' ? graph[name] : undefined;
      if (own && (typeof own === 'function' || typeof own === 'object')) return own;
      return findByExportName(graph, name, depth);
    };
    const AccountManager = find('AccountManager', 4);
    // Upstream's bundle is Rollup CJS: the chunk exports AccountManager and
    // friends, but RequestForwarder is a module-local class that is only
    // reachable through a singleton instance (`const requestForwarder = new
    // RequestForwarder()`). Accept either shape, and behave correctly when
    // the graph is only the headless entry (which exports nothing at all).
    // ProxyServer is the only exported class on the request path: its
    // constructor builds the Koa app, and our middleware goes to the front of
    // that stack - see README section 1 for why that route was measured dead.
    const ProxyServer = find('ProxyServer', 4) || null;
    // The account picker the completions router really calls.
    const LoadBalancer = find('LoadBalancer', 4) || null;
    // Plain data object (proven live on the shipped image): the only
    // synchronous source of 'is the proxy up', which shim/health.js needs.
    const proxyStatusManager = graph && graph.proxyStatusManager && typeof graph.proxyStatusManager === 'object'
      ? graph.proxyStatusManager
      : null;
    return { find, AccountManager, ProxyServer, LoadBalancer, proxyStatusManager, headless: isHeadlessEntry(graph) };
  }

  /**
   * Re-load the upstream chunk when the graph we were handed is only the
   * headless bootstrap (electron-shim requires headless.js, which exports
   * nothing - the classes live in chunks/server-*.js).
   */
  resolveChunk(graph) {
    if (!isHeadlessEntry(graph)) return graph;
    // Remember what the entry handed us: if that object carries ProxyServer,
    // the patched class has to be written back there (see install) because the
    // entry constructs the server through its own namespace reference.
    this.entryGraph = graph;
    const dir = path.join(__dirname, '..', '..', 'upstream', 'main', 'chunks');
    let candidates = [];
    try {
      candidates = fs.readdirSync(dir).filter((f) => /^server-.*[.]js$/.test(f)).sort();
    } catch (e) {
      this.log('[selfheal] cannot read upstream chunks (' + auth.summarize(e && e.message) + '); using the entry exports');
      return graph;
    }
    for (const name of candidates) {
      try {
        const chunk = require(path.join(dir, name));
        if (chunk && typeof chunk === 'object' && findAccountManager(chunk)) {
          this.log('[selfheal] upstream graph resolved from chunks/' + name);
          return chunk;
        }
      } catch (e) {
        this.log('[selfheal] could not require chunks/' + name + ': ' + auth.summarize(e && e.message));
      }
    }
    return graph;
  }

  /**
   * Wire everything against the loaded bundle.
   *
   * @param {object} deps
   * @param {any} deps.graph upstream bundle exports
   * @param {(accountId: string) => Promise<object>} [deps.validate] validator override
   * @returns {{enabled: boolean, installed: object}}
   */
  install(deps) {
    const d = deps || {};
    if (!this.config.enabled) {
      this.log('[selfheal] disabled by CHAT2API_SELFHEAL=0');
      this.publish();
      return { enabled: false, installed: this.installed };
    }
    let graph = d.graph;
    if (!graph) {
      this.log('[selfheal] no upstream bundle exports - self-heal stays idle');
      this.publish();
      return { enabled: false, installed: this.installed };
    }
    graph = this.resolveChunk(graph);
    this.graph = graph;
    const resolved = this.resolve(graph);
    if (resolved.headless) {
      this.log('[selfheal] upstream exports carry no AccountManager - running on the store-level fallback');
    }
    const AccountManager = resolved.AccountManager;
    this.upstream = resolved;

    // Validation: upstream's own AccountManager.validate() is the source of
    // truth - it writes the status back, so we only need its verdict.
    const validate = typeof d.validate === 'function'
      ? d.validate
      : (AccountManager && typeof AccountManager.validate === 'function'
        ? (accountId) => AccountManager.validate(accountId)
        : null);

    if (!AccountManager) {
      this.log('[selfheal] AccountManager not found in the upstream bundle - account self-heal unavailable');
    } else if (!validate) {
      this.log('[selfheal] AccountManager.validate() not found - account self-heal unavailable');
    }

    this.sweeper = new AccountSweeper({
      listAccounts: async () => {
        if (!AccountManager || typeof AccountManager.getAll !== 'function') return [];
        const all = await AccountManager.getAll();
        const list = Array.isArray(all) ? all : [];
        this.accountCache = list;
        return list;
      },
      validate,
      health: this.health,
      now: this.now,
      log: this.log,
      options: {
        sweepIntervalMs: this.config.sweepIntervalMinutes * 60 * 1000,
        recheckIntervalMs: this.config.recheckIntervalSec * 1000,
        spacingMs: this.config.spacingMs,
      },
      onInvalid: (accountId, result, account) => {
        // The sweep found a dead account the request path never touched.
        const record = this.health.startCooldown(accountId, {
          providerId: account && account.providerId,
          reason: (result && result.error) || 'validation failed',
        });
        if (account) this.tokens.invalidate(account);
        const detail = auth.summarize(result && result.error);
        this.log('[selfheal] sweep found account ' + accountId + ' invalid (' + detail +
          '); parked for ' + Math.round((record.until - this.now()) / 1000) + 's');
        this.stateChange({
          account: accountId, provider: account && account.providerId, old: 'active', new: 'error',
          reason: 'sweep-invalid', source: 'sweep', class: detail,
          cooldown_ms: record.until - this.now(), strikes: record.strikes, detail,
        });
        if (this.config.autoStatus && AccountManager && typeof AccountManager.updateStatus === 'function') {
          this.setStatus(accountId, 'error', detail).catch(() => {});
        }
      },
    });

    this.hooks = hooks.createHooks({
      health: this.health,
      tokens: this.tokens,
      sweeper: this.sweeper,
      AccountManager,
      validate,
      now: this.now,
      log: this.log,
      stateChange: (fields) => this.stateChange(fields),
      // Single gate for every status write: CHAT2API_SELFHEAL_AUTO_STATUS=0 keeps
      // the upstream record untouched (cooldown-only mode).
      updateStatus: (id, status, msg) => this.setStatus(id, status, msg),
      options: {
        recheckTimeoutMs: this.config.recheckTimeoutMs,
        degradedCooldownMs: this.config.degradedCooldownMs,
        autoStatus: this.config.autoStatus,
      },
    });

    // The failure signal from the adapters: exact account, exact error.
    this.onAcquireFailure = (providerId, account, err) => {
      try {
        const id = account && (account.id || account.accountId);
        if (!id) {
          this.log('[selfheal] ' + providerId + ' token acquisition failed without an account id: ' +
            auth.summarize(err && err.message));
          return;
        }
        this.hooks.onFailure(Object.assign({}, account, { id: id, providerId: account.providerId || providerId }), err);
      } catch (e) {
        this.log('[selfheal] acquire-failure handler failed: ' + auth.summarize(e && e.message));
      }
    };

    // 0. The request seam that exists in the shipped build.
    //
    // The chunk creates its koa server at module-evaluation time
    // (`const proxyServer = new ProxyServer()`), so that instance predates any
    // patch, and it is the one the shim captures. The shim therefore asks us for
    // an outer observer instead: it runs first, wraps res.write/res.end to keep a
    // bounded tail, and reports the verdict through this.hooks.settle(). It never
    // answers a request.
    this.installed.httpObserver = false;
    try {
      const observer = require('./http-observer');
      const handler = observer.createHandler({
        log: this.log,
        now: this.now,
        report: (account, outcome) => {
          try {
            if (outcome && outcome.ok) this.hooks.settle(null, null, { ms: outcome.ms, ok: true });
            else this.hooks.settle(null, { message: outcome && outcome.message, status: outcome && outcome.status }, { ms: outcome && outcome.ms });
          } catch (e) {
            this.log('[selfheal] settle from http observer failed: ' + auth.summarize(e && e.message));
          }
        },
      });
      const shim = safeRequireShim();
      if (shim && typeof shim.__setSelfhealTap === 'function') {
        shim.__setSelfhealTap(handler);
        this.installed.httpObserver = true;
        this.log('[selfheal] request seam attached to the captured http handler (http observer)');
      } else {
        this.log('[selfheal] shim does not expose the request seam (__setSelfhealTap)');
      }
    } catch (e) {
      this.log('[selfheal] http observer unavailable: ' + auth.summarize(e && e.message));
    }

    // 1. The request path.
    //
    // NOT wrapped here on purpose. The chunk builds its koa server at module
    // evaluation time (`const proxyServer = new ProxyServer()` sits right next
    // to `exports.ProxyServer = ProxyServer`), so that instance exists before
    // anything outside the bundle can patch the class, and it is the instance
    // the shim captures. Subclassing ProxyServer therefore only ever affects
    // instances nobody uses - measured on the shipped image: zero middleware
    // invocations across several hundred requests. A subclass route lived here
    // until it was removed for exactly that reason.
    //
    // What does carry the request path is step 0 above (the http observer on the
    // captured handler) plus the adapter seam in token-cache.js.
    this.installed.hooks = this.installed.httpObserver === true;
    this.installed.routeObserver = false;
    // 2. The account picker. Three seams, in order of precision:
    //    - LoadBalancer.getAvailableAccounts is what selectAccount() calls for
    //      every completion - used when the bundle exports the class (newer
    //      bumps may);
    //    - the completions route handler itself, which is the only place the
    //      chosen account is visible when LoadBalancer is module-private
    //      (that is the case for the shipped bundle);
    //    - AccountManager.getAvailable, kept for graphs that route through it
    //      (and for the stubs in the tests).
    const wrappedBalancer = hooks.wrapLoadBalancer(resolved.LoadBalancer, {
      hooks: this.hooks,
      health: this.health,
      log: this.log,
      requestContext: currentRequest,
    });
    this.installed.balancer = wrappedBalancer.wrapped;
    if (wrappedBalancer.wrapped) {
      this.log('[selfheal] account picker hooked via LoadBalancer.getAvailableAccounts: cooling accounts are not offered');
    } else {
      this.log('[selfheal] LoadBalancer not exported (' + (wrappedBalancer.reason || 'unknown reason') +
        '); the completions handler carries the veto instead');
    }
    this.installed.available = hooks.wrapAvailable(AccountManager, this.health, this.log);

    // 3. Failure reasons.
    //
    // `absent` is not a failure: it means this upstream build has no such seam
    // (renamed or inlined), and it is reported once at debug level rather than
    // carried in `missing`, which would turn into a warning our operators could
    // never clear. Only `missing` - class found, method not patched - is drift
    // that deserves a look and belongs in the /health warnings.
    try {
      const patched = reason.install({ find: resolved.find, log: this.log });
      this.installed.reason = patched.installed;
      this.installed.reasonAbsent = patched.absent || [];
      this.installed.missing = (this.installed.missing || []).concat(patched.missing || []);
    } catch (e) {
      this.log('[selfheal] reason-fidelity patches failed: ' + auth.summarize(e && e.message));
    }

    // 4. Token caches.
    try {
      const tc = this.tokens.install(graph);
      this.installed.tokens = tc.installed;
    } catch (e) {
      this.log('[selfheal] token cache wrapping failed: ' + auth.summarize(e && e.message));
    }

    this.publish();
    return { enabled: true, installed: this.installed };
  }

  /** Start the periodic sweep (after the store is ready). */
  start() {
    if (!this.config.enabled || !this.sweeper) return false;
    this.startedAt = this.now();
    this.sweeper.start(this.config.sweepIntervalMinutes * 60 * 1000);
    this.log('[selfheal] background sweep armed: every ' + this.config.sweepIntervalMinutes +
      ' min, non-active accounts every ' + this.config.recheckIntervalSec + 's');
    return true;
  }

  /**
   * We are installed from the shim, which runs BEFORE upstream reaches
   * storeManager.initialize(), so the first sweep always landed on an
   * uninitialized store ("Storage not initialized"). Upstream initializes in a
   * few hundred milliseconds, so retry quickly (1s, 2s, 4s, 8s, capped at 15s
   * for about a minute) instead of either failing once or waiting a full
   * sweep interval. A readiness failure is retried; a real sweep failure is not.
   *
   * @returns {Promise<object|null>} the first successful sweep summary
   */
  startWhenReady(attempt) {
    const self = this;
    const tryNo = typeof attempt === 'number' ? attempt : 0;
    const delay = Math.min(1000 * Math.pow(2, tryNo), 15000);
    return new Promise((resolve) => setTimeout(resolve, delay)).then(() => {
      if (!self.sweeper) return null;
      return Promise.resolve()
        .then(() => self.sweeper.run({}))
        .then((summary) => {
          self.log('[selfheal] initial sweep done: checked ' + ((summary && summary.checked) || 0) +
            ' account(s) after ' + delay + 'ms wait');
          return summary;
        })
        .catch((e) => {
          const msg = auth.summarize(e && e.message);
          if (tryNo >= 5 || !/not initialized|initialize\(\)/i.test(msg)) {
            self.log('[selfheal] initial sweep failed: ' + msg);
            return null;
          }
          return self.startWhenReady(tryNo + 1);
        });
    });
  }

  stop() {
    if (this.sweeper) this.sweeper.stop();
  }

  /** Manual trigger, used by tests and by an operator via /health.checkNow. */
  checkNow() {
    if (!this.sweeper) return Promise.resolve(null);
    return this.sweeper.run({ all: true });
  }

  /**
   * Write a status back upstream, honouring CHAT2API_SELFHEAL_AUTO_STATUS.
   * Visible in the management page, so a parked account stops looking healthy.
   */
  async setStatus(accountId, status, errorMessage) {
    const am = this.upstream && this.upstream.AccountManager;
    if (!am || typeof am.updateStatus !== 'function') return false;
    if (!this.config.autoStatus) return false;
    try {
      await am.updateStatus(accountId, status, errorMessage ? auth.summarize(errorMessage) : undefined);
      return true;
    } catch (e) {
      this.log('[selfheal] could not update status for account ' + accountId + ': ' + auth.summarize(e && e.message));
      return false;
    }
  }

  /**
   * One machine-readable line per account state change, so an operator can
   * verify the whole chain straight from `docker logs`:
   *
   *   [selfheal] state-change account=<id> provider=<pid> old=<a> new=<b>
   *                reason=<class> source=runtime|sweep class=<detail> ...
   *
   * Never contains credentials: only the (truncated) provider error text.
   */
  stateChange(fields) {
    try {
      const f = fields || {};
      const parts = ['[selfheal] state-change'];
      const keys = ['account', 'provider', 'old', 'new', 'reason', 'source', 'class', 'cooldown_ms', 'validate_ms', 'strikes'];
      for (const k of keys) {
        if (f[k] === undefined || f[k] === null || f[k] === '') continue;
        parts.push(k + '=' + String(f[k]).replace(/\s+/g, '_'));
      }
      if (f.detail) parts.push('detail="' + String(auth.summarize(f.detail)).replace(/"/g, "'") + '"');
      this.stateLog(parts.join(' '));
    } catch (e) {
      /* logging must never break the request path */
    }
  }

  /**
   * Stable, tiny read surface for /health (shim/health.js).
   * Synchronous, no I/O, never throws.
   */
  info() {
    try {
      const snap = this.snapshot();
      return {
        installed: true,
        enabled: !!this.config.enabled,
        lastSweepAt: snap.lastSweepAt,
        coolingAccounts: Array.isArray(snap.cooling) ? snap.cooling.length : 0,
        badAccountCount: snap.badAccountCount,
        lastSweepError: (snap.sweep && snap.sweep.lastError) || null,
        config: snap.config || null,
        proxyStatus: this.proxyStatus(),
        version: 1,
      };
    } catch (e) {
      return { installed: true, enabled: false, lastSweepAt: null, coolingAccounts: 0, badAccountCount: null, lastSweepError: 'snapshot failed', config: null, proxyStatus: null, version: 1 };
    }
  }

  /**
   * Refresh the cached account list without running a validation sweep, so
   * /health can report account totals between sweeps. Never throws.
   * @returns {Promise<Array<object>|null>}
   */
  refreshAccounts() {
    if (!this.sweeper) return Promise.resolve(null);
    return Promise.resolve()
      .then(() => this.sweeper.listAccounts())
      .then((list) => {
        this.accountCache = Array.isArray(list) ? list : [];
        return this.accountCache;
      })
      .catch((e) => {
        this.log('[selfheal] could not refresh the account list: ' + auth.summarize(e && e.message));
        return null;
      });
  }

  /**
   * Whether the proxy is running, for the /health self-check.
   *
   * SYNCHRONOUS BY CONTRACT: shim/health.js has a 1500ms budget for the whole
   * document, so this must not await, must not touch the network and must not
   * schedule work. It only reads fields upstream already keeps in memory.
   *
   * Note on the shape: upstream's ProxyStatusManager has no getStatus() - it
   * exposes getRunningStatus() / getStatistics() / getPort(). getStatistics()
   * calls cleanupOldTimestamps(), which is cheap but is not a pure read, so it
   * is only consulted for a small derived shape and never allowed to throw.
   *
   * @returns {object|null} null when the status source is not in the graph
   */
  proxyStatus() {
    try {
      const mgr = this.upstream && this.upstream.proxyStatusManager;
      if (!mgr || typeof mgr.getRunningStatus !== 'function') return null;
      const run = mgr.getRunningStatus() || {};
      let inflight = null;
      let totalRequests = null;
      try {
        const stats = typeof mgr.getStatistics === 'function' ? mgr.getStatistics() : null;
        if (stats) {
          if (typeof stats.activeConnections === 'number') inflight = stats.activeConnections;
          if (typeof stats.totalRequests === 'number') totalRequests = stats.totalRequests;
        }
      } catch (e) { /* statistics are optional; running state is not */ }
      return {
        running: run.isRunning === true,
        port: typeof mgr.getPort === 'function' ? mgr.getPort() : null,
        uptimeMs: typeof run.uptime === 'number' ? run.uptime : null,
        startedAt: typeof run.startTime === 'number' ? run.startTime : null,
        inflight: inflight,
        totalRequests: totalRequests,
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Publish the synchronous read surface under the well-known global, so the
   * /health handler in shim/health.js can read it without importing this module.
   * See README section 4 for the full contract of every method below.
   */
  publish() {
    const self = this;
    globalThis[GLOBAL_KEY] = {
      snapshot: () => self.snapshot(),
      info: () => self.info(),
      checkNow: () => self.checkNow(),
      // Optional for the /health handler: refreshes the cached account list.
      refreshAccounts: () => self.refreshAccounts(),
      // Synchronous proxy liveness for the /health self-check. Never throws;
      // null means 'not readable from this seam', not 'down'.
      proxyStatus: () => self.proxyStatus(),
    };
    return globalThis[GLOBAL_KEY];
  }

  /**
   * Synchronous health snapshot. No I/O, never throws.
   *
   * @param {Array<object>} [accounts] upstream account list, when the caller has it
   */
  snapshot(accounts) {
    const base = {
      enabled: this.config.enabled,
      startedAt: this.startedAt,
      lastSweepAt: null,
      sweep: { running: false, lastDurationMs: null, checked: 0, failed: 0, errors: 0 },
      accounts: null,
      badAccountCount: null,
      cooling: [],
      hooks: this.hooks ? this.hooks.stats() : null,
      token: this.tokens.stats(),
      installed: {
        requestPath: this.installed.hooks,
        accountPicker: Boolean(this.installed.balancer || this.installed.available),
        // The seams the shipped bundle's completions router actually uses; the
        // /health handler reports both so a partial hook is visible.
        balancer: Boolean(this.installed.balancer),
        routeObserver: Boolean(this.installed.routeObserver),
        tokenCaches: this.installed.tokens,
        reasonPatches: this.installed.reason,
        // Seams this upstream build does not have at all: informational only, never a warning.
        reasonAbsent: this.installed.reasonAbsent || [],
        missing: this.installed.missing,
      },
      config: {
        cooldownMs: this.config.cooldownMs,
        cooldownMaxMs: this.config.cooldownMaxMs,
        sweepIntervalMinutes: this.config.sweepIntervalMinutes,
        recheckIntervalSec: this.config.recheckIntervalSec,
        sweepMaxAccounts: this.config.sweepMaxAccounts,
        autoStatus: this.config.autoStatus,
        degradedCooldownMs: this.config.degradedCooldownMs,
        recheckTimeoutMs: this.config.recheckTimeoutMs,
        spacingMs: this.config.spacingMs,
      },
    };
    if (!this.config.enabled) return base;
    try {
      if (this.sweeper) {
        const s = this.sweeper.snapshot();
        base.lastSweepAt = s.lastSweepAt;
        base.sweep = s.sweep;
      }
      const list = Array.isArray(accounts) ? accounts : (Array.isArray(this.accountCache) ? this.accountCache : null);
      base.cooling = this.health.coolingList();
      if (list) {
        base.accounts = this.health.summarize(list);
        base.badAccountCount = base.accounts.unreachable;
      } else {
        base.badAccountCount = base.cooling.length;
      }
    } catch (e) {
      base.snapshotError = auth.summarize(e && e.message ? e.message : e);
    }
    return base;
  }
}

/** A graph with no AccountManager but a storeManager is the headless entry. */
function isHeadlessEntry(graph) {
  return !!(graph && typeof graph === 'object' && !findAccountManager(graph) && graph.storeManager);
}

/** Depth-limited AccountManager search (kept here to avoid a cycle with token-cache). */
function findAccountManager(graph) {
  return findByExportName(graph, 'AccountManager', 4) || null;
}
/**
 * The shim that hosts us, or null. Resolved on demand so the module also
 * loads standalone (tests, probes).
 */
function safeRequireShim() {
  try {
    // Never require it: electron-shim installs self-heal itself at load time,
    // so a require() from here would re-enter install() with a null graph and
    // clobber the singleton (this bit the tests, where the shim is not under
    // test at all). Use it only when it is already part of this process.
    const loaded = require.cache[require.resolve('../electron-shim.js')];
    return loaded ? loaded.exports : null;
  } catch (e) {
    return null;
  }
}

module.exports = { SelfHeal, resolveConfig, envInt, envBool, GLOBAL_KEY, safeRequireShim }
