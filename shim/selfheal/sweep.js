/**
 * Background validation sweep.
 *
 * WHY A SWEEP AT ALL
 * ------------------
 * The runtime re-check (runtime-hooks.js) only fires when a request actually
 * fails. An account that is never selected - because the load balancer is
 * round-robin over many accounts, or because it is already parked - would stay
 * broken forever, and an account upstream parked long ago would stay parked
 * even after the operator pasted a fresh token.
 *
 * So: validate on start, periodically, and again quickly for anything not
 * active. Serial + rate limited on purpose - these calls hit the provider's
 * real login endpoint, and a container restart storm must not turn into a
 * provider rate limit.
 *
 * The scheduler is a pure function of (account, last check time, now), which is
 * what makes it unit-testable without timers: `due()` returns the accounts to
 * check, the test asserts on that list instead of waiting for a clock.
 */

'use strict'

const auth = require('./auth-errors')

const DEFAULTS = {
  /** active accounts are re-checked at this interval (matches autoCheckAccountsIntervalMinutes) */
  sweepIntervalMs: 30 * 60 * 1000,
  /** non-active accounts are re-checked at this interval */
  recheckIntervalMs: 60 * 1000,
  /** delay between two validations, so a sweep cannot burst the provider */
  spacingMs: 1500,
  /** hard cap for one full sweep pass */
  maxAccountsPerSweep: 200,
  /** a validation this old is considered stale even if it succeeded */
  staleAfterMs: 6 * 60 * 60 * 1000,
}

/**
 * Decide which accounts are due for validation, oldest first.
 *
 * @param {Array<{id: string, status?: string}>} accounts upstream accounts
 * @param {Map<string, {at: number, valid: boolean}>} history last validation per account id
 * @param {number} now clock (ms)
 * @param {object} [options] overrides for DEFAULTS
 * @param {(id: string) => boolean} [options.skip] predicate for accounts already being checked
 * @returns {Array<{account: object, dueAt: number, reason: string}>} ordered work list
 */
function due(accounts, history, now, options) {
  const o = options || {};
  const sweepIntervalMs = o.sweepIntervalMs || DEFAULTS.sweepIntervalMs;
  const recheckIntervalMs = o.recheckIntervalMs || DEFAULTS.recheckIntervalMs;
  const staleAfterMs = o.staleAfterMs || DEFAULTS.staleAfterMs;
  const maxPerSweep = o.maxAccountsPerSweep || DEFAULTS.maxAccountsPerSweep;
  const skipFn = typeof o.skip === 'function' ? o.skip : null;
  const rows = Array.isArray(accounts) ? accounts : [];
  const last = history && typeof history.get === 'function' ? history : null;
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const account = rows[i];
    if (!account || !account.id) continue;
    if (skipFn && skipFn(account.id)) continue;
    const isActive = account.status === 'active';
    const record = last ? last.get(account.id) : null;
    const checkedAt = record && typeof record.at === 'number' ? record.at : null;
    if (checkedAt === null) {
      // Never validated in this process: do it now, non-active accounts first
      // because they are the ones the load balancer is not exercising.
      out.push({ account: account, dueAt: 0, order: out.length, rank: isActive ? 1 : 0, reason: isActive ? 'initial' : 'never-validated' });
      continue;
    }
    const age = now - checkedAt;
    const failed = record.valid !== true;
    let wait = sweepIntervalMs;
    if (failed && !isActive) wait = recheckIntervalMs;
    if (age < wait) continue;
    let tag = 'recheck';
    if (record.valid === true) tag = 'interval';
    if (age > staleAfterMs) tag = 'stale';
    out.push({ account: account, dueAt: checkedAt + wait, order: out.length, rank: isActive ? 1 : 0, reason: tag });
  }
  out.sort(function (a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
    return a.order - b.order;
  });
  const work = [];
  const limit = out.length < maxPerSweep ? out.length : maxPerSweep;
  for (let k = 0; k < limit; k += 1) {
    work.push({ account: out[k].account, dueAt: out[k].dueAt, reason: out[k].reason });
  }
  return work;
}

class AccountSweeper {
  /**
   * @param {object} deps
   * @param {() => Promise<Array<object>>} deps.listAccounts returns upstream accounts
   * @param {(id: string) => Promise<{valid: boolean, error?: string, networkError?: boolean}>} deps.validate validates one account
   * @param {object} deps.health AccountHealth instance
   * @param {() => number} [deps.now] clock
   * @param {(msg: string) => void} [deps.log]
   * @param {(id: string) => void} [deps.onInvalid] called after an account validates invalid
   * @param {object} [deps.options] DEFAULTS overrides
   */
  constructor(deps) {
    const d = deps || {};
    this.listAccounts = d.listAccounts;
    this.validate = d.validate;
    this.health = d.health;
    this.now = typeof d.now === 'function' ? d.now : () => Date.now();
    this.log = typeof d.log === 'function' ? d.log : (msg) => console.log(msg);
    this.onInvalid = typeof d.onInvalid === 'function' ? d.onInvalid : () => {};
    this.options = Object.assign({}, DEFAULTS, d.options || {});
    this.history = new Map();
    this.inFlight = new Set();
    this.running = false;
    this.queue = null;
    this.timer = null;
    this.state = {
      lastSweepAt: null,
      lastDurationMs: null,
      sweepCount: 0,
      checked: 0,
      failed: 0,
      errors: 0,
      results: { valid: 0, invalid: 0, network: 0 },
      lastError: null,
    };
  }

  /** Accounts due right now; exposed for tests and for /health.checkNow. */
  due(accounts) {
    return due(accounts, this.history, this.now(), {
      ...this.options,
      skip: (id) => this.inFlight.has(id),
    });
  }

  /**
   * Run one sweep. Concurrent calls share the in-flight promise so a manual
   * checkNow() during a scheduled sweep does not validate twice.
   * @returns {Promise<object>} sweep summary
   */
  run(options) {
    if (this.queue) return this.queue;
    this.queue = this.execute(options).finally(() => {
      this.queue = null;
    });
    return this.queue;
  }

  async execute(options) {
    const opts = options || {};
    const started = this.now();
    this.running = true;
    const summary = {
      startedAt: started,
      durationMs: 0,
      checked: 0,
      valid: 0,
      invalid: 0,
      network: 0,
      errors: 0,
      skipped: 0,
      failures: [],
    };
    try {
      const accounts = typeof this.listAccounts === 'function' ? await this.listAccounts() : [];
      const work = opts.all
        ? accounts.map((account) => ({ account, dueAt: 0, reason: 'forced' }))
        : this.due(accounts);
      summary.total = Array.isArray(accounts) ? accounts.length : 0;
      summary.due = work.length;
      for (const item of work) {
        const account = item.account;
        if (this.inFlight.has(account.id)) {
          summary.skipped += 1;
          continue;
        }
        this.inFlight.add(account.id);
        try {
          const result = await this.validate(account.id);
          const normalized = {
            valid: Boolean(result && result.valid),
            error: result && result.error ? auth.summarize(result.error) : null,
            networkError: Boolean(result && result.networkError),
          };
          const at = this.now();
          this.history.set(account.id, { at, valid: normalized.valid });
          if (this.health) this.health.noteValidation(account.id, { at, ...normalized });
          summary.checked += 1;
          if (normalized.valid) {
            summary.valid += 1;
          } else if (normalized.networkError) {
            summary.network += 1;
          } else {
            summary.invalid += 1;
            summary.failures.push({ accountId: account.id, providerId: account.providerId, error: normalized.error });
            try {
              this.onInvalid(account.id, normalized, account);
            } catch (e) {
              /* a listener must never abort the sweep */
            }
          }
        } catch (e) {
          // A validator that throws (provider unreachable, upstream changed
          // shape) counts as an error for this account only; the sweep goes on.
          this.state.errors += 1;
          summary.errors += 1;
          this.state.lastError = auth.summarize(e && e.message ? e.message : e);
          summary.failures.push({
            accountId: account.id,
            providerId: account.providerId,
            error: this.state.lastError,
            thrown: true,
          });
        } finally {
          this.inFlight.delete(account.id);
        }
        // Rate limit: the provider login endpoint is the same one the UI uses.
        if (this.options.spacingMs > 0 && work.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, this.options.spacingMs));
        }
      }
    } finally {
      this.running = false;
      const durationMs = this.now() - started;
      this.state.lastSweepAt = started;
      this.state.lastDurationMs = durationMs;
      this.state.sweepCount += 1;
      this.state.checked = summary.checked;
      this.state.failed = summary.invalid;
      this.state.results.valid += summary.valid;
      this.state.results.invalid += summary.invalid;
      this.state.results.network += summary.network;
      summary.durationMs = durationMs;
      if (summary.checked > 0) {
        this.log('[selfheal] sweep: checked ' + summary.checked + ', valid ' + summary.valid +
          ', invalid ' + summary.invalid + ', network ' + summary.network + ' in ' + durationMs + 'ms');
      }
    }
    return summary;
  }

  /**
   * Record a validation performed outside the sweep (runtime re-check, or a
   * validate call the operator triggered from the management API).
   * `at` is preserved when the caller supplies it so a verdict learned earlier
   * is not treated as freshly checked.
   * @param {string} accountId
   * @param {{valid?: boolean, at?: number, networkError?: boolean}} result
   */
  noteExternal(accountId, result) {
    const r = result || {};
    const at = typeof r.at === 'number' ? r.at : this.now();
    this.history.set(accountId, { at: at, valid: r.valid === true });
  }

  start(intervalMs) {
    this.stop();
    const every = Number(intervalMs) || this.options.sweepIntervalMs;
    // Kick off quickly, but not before the store exists: the shim installs us
    // ahead of storeManager.initialize(), and an immediate sweep there fails with
    // "Storage not initialized, please call initialize() first". A short retry
    // (see kickOff) loses nothing - initialization takes a few hundred ms.
    this.kickOff(0);
    this.timer = setInterval(() => {
      this.run().catch((e) => this.log('[selfheal] sweep failed: ' + auth.summarize(e && e.message)));
    }, every);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  /**
   * Run the first sweep as soon as the store is usable. A readiness failure is
   * retried with a short backoff (250ms, 500ms, 1s, 2s, 4s, 8s); any other
   * failure is reported once and the interval keeps running.
   */
  kickOff(attempt) {
    const tryNo = typeof attempt === 'number' ? attempt : 0;
    const delay = Math.min(250 * Math.pow(2, tryNo), 8000);
    const timer = setTimeout(() => {
      this.run().catch((e) => {
        const msg = auth.summarize(e && e.message);
        if (tryNo < 6 && /not initialized|initialize\(\)/i.test(msg)) {
          this.kickOff(tryNo + 1);
          return;
        }
        this.log('[selfheal] initial sweep failed: ' + msg);
      });
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Snapshot for /health: no I/O, never throws. */
  snapshot() {
    return {
      lastSweepAt: this.state.lastSweepAt,
      sweep: {
        running: this.running,
        lastDurationMs: this.state.lastDurationMs,
        sweepCount: this.state.sweepCount,
        checked: this.state.checked,
        failed: this.state.failed,
        errors: this.state.errors,
        lastError: this.state.lastError,
        results: Object.assign({}, this.state.results),
        inFlight: this.inFlight.size,
        scheduled: Boolean(this.timer),
      },
    };
  }
}

module.exports = { AccountSweeper, due, DEFAULTS }
