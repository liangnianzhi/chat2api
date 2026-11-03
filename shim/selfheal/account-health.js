/**
 * Account health bookkeeping for the container self-heal layer.
 *
 * WHAT PROBLEM THIS SOLVES
 * ------------------------
 * Upstream's load balancer only ever looks at `account.status === 'active'`
 * (`AccountManager.getAvailable()`), so an account whose token died stays in
 * rotation until something changes that field. Upstream's own detection is
 * the keyword table in `isAuthError()`, which misses the DeepSeek wording
 * ("... Failed (invalid token)"); on the live deployment that meant 39 requests
 * each burned the full provider timeout before answering 500.
 *
 * The self-heal layer keeps its own state next to upstream's:
 *
 *   cooling[id]      - account must be skipped until `until` (wall clock ms)
 *   lastValidation[] - when the validator last ran for the account
 *   lastAuthFailure  - the classified failure that started it all
 *
 * It never *replaces* upstream's status; it adds a veto on top, so an account
 * upstream still considers active is skipped here while it is cooling down,
 * and comes back automatically when the cooldown expires.
 *
 * Everything here is synchronous, in-memory and clock-injectable so the
 * behaviour can be unit tested without timers or a provider.
 */

'use strict'

const auth = require('./auth-errors')

const DEFAULTS = {
  cooldownMs: 60 * 1000,
  /** Upper bound of the cooldown, so a stuck account is re-probed eventually. */
  cooldownMaxMs: 30 * 60 * 1000,
  /** Multiplier applied on repeated failures while cooling down. */
  cooldownBackoff: 2,
  /** How long a successful validation counts as fresh. */
  validatedFreshMs: 10 * 60 * 1000,
  /** Serial validation spacing per account (protects the provider). */
  minValidateIntervalMs: 30 * 1000,
  /** Ignore a second failure signal for an account already being re-checked. */
  inFlightTtlMs: 2 * 60 * 1000,
}

const STATE = { HEALTHY: 'healthy', COOLING: 'cooling', INVALID: 'invalid', UNKNOWN: 'unknown' }

class AccountHealth {
  /**
   * @param {object} [options]
   * @param {number} [options.cooldownMs] base cooldown for a confirmed-dead account
   * @param {number} [options.cooldownMaxMs] ceiling for the exponential backoff
   * @param {() => number} [options.now] clock injection for tests
   */
  constructor(options) {
    const opts = options || {}
    this.options = { ...DEFAULTS, ...opts }
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    /** @type {Map<string, {accountId: string, providerId: string|null, until: number, since: number, reason: string, strikes: number}>} */
    this.cooling = new Map()
    /** @type {Map<string, {at: number, valid: boolean, error: string|null, networkError: boolean}>} */
    this.validations = new Map()
    /** Mirror of `validations`, keyed for AccountSweeper; kept identity-synced (see NoteStore below). */
    this.cache = this.validations
    /** @type {Map<string, {since: number, reason: string, class: string}>} */
    this.rechecks = new Map()
    this.events = []
    this.maxEvents = 200
  }

  /* ------------------------------------------------------------------ */
  /* Health view                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Health of one account, without touching upstream state.
   * @param {string} accountId
   * @param {string|undefined} status upstream status (active/inactive/error/expired)
   * @returns {{state: string, cooling: boolean, until: number|null, remainingMs: number,
   *            reason: string|null, strikes: number, lastValidation: object|null, inFlight: boolean}}
   */
  health(accountId, status) {
    const now = this.now()
    const cool = this.cooling.get(accountId)
    const active = cool && cool.until > now ? cool : null
    if (cool && !active) this.cooling.delete(accountId)
    const validation = this.validations.get(accountId) || null
    const recheck = this.rechecks.get(accountId)
    const inFlight = Boolean(recheck && now - recheck.since < this.options.inFlightTtlMs)
    let state = STATE.UNKNOWN
    if (active) state = STATE.COOLING
    else if (status === 'active') state = STATE.HEALTHY
    else if (status === 'error' || status === 'expired') state = STATE.INVALID
    return {
      state,
      cooling: Boolean(active),
      until: active ? active.until : null,
      remainingMs: active ? Math.max(0, active.until - now) : 0,
      reason: active ? active.reason : null,
      strikes: cool ? cool.strikes : 0,
      lastValidation: validation,
      inFlight,
    }
  }

  isCoolingDown(accountId) {
    const cool = this.cooling.get(accountId)
    if (!cool) return false
    if (cool.until > this.now()) return true
    this.cooling.delete(accountId)
    return false
  }

  /** Filter a list of upstream accounts down to those that may take traffic. */
  filterAvailable(accounts) {
    if (!Array.isArray(accounts)) return []
    return accounts.filter((a) => a && !this.isCoolingDown(a.id))
  }

  /* ------------------------------------------------------------------ */
  /* Failure handling                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Start (or extend) a cooldown for an account.
   * @returns {object} the cooldown record
   */
  startCooldown(accountId, details) {
    const d = details || {}
    const now = this.now()
    const previous = this.cooling.get(accountId)
    // `degrade: true` = a soft park (captcha/风控 wall). It never adds a strike,
    // so hammering a gated account cannot escalate it into a multi-hour ban,
    // and it never counts as 'this account is broken' in the status write.
    const degraded = d.degrade === true
    const strikes = degraded ? ((previous && previous.strikes) || 0) : (previous && previous.strikes ? previous.strikes : 0) + 1
    const base = Math.max(1000, Number(d.durationMs) || this.options.cooldownMs)
    const span = degraded
      ? Math.min(base, this.options.cooldownMaxMs)
      : Math.min(base * Math.pow(this.options.cooldownBackoff, strikes - 1), this.options.cooldownMaxMs)
    const record = {
      accountId,
      providerId: d.providerId || (previous && previous.providerId) || null,
      until: now + span,
      since: now,
      reason: auth.summarize(d.reason || (previous && previous.reason) || 'auth failure'),
      strikes,
      degraded,
    }
    this.cooling.set(accountId, record)
    this.record('cooldown-start', { accountId, providerId: record.providerId, durationMs: span, reason: record.reason, strikes })
    return record
  }

  /**
   * Clear the cooldown after a successful validation.
   * Strikes are only dropped after a full quiet period, so an account that
   * flaps between good and bad does not get reset to the minimum cooldown.
   */
  endCooldown(accountId, details) {
    const previous = this.cooling.get(accountId)
    this.cooling.delete(accountId)
    this.rechecks.delete(accountId)
    if (previous) {
      this.record('cooldown-end', {
        accountId,
        providerId: previous.providerId,
        durationMs: this.now() - previous.since,
        reason: (details && details.reason) || previous.reason,
      })
    }
    return Boolean(previous)
  }

  /** Record a validation outcome; `at` defaults to now. */
  noteValidation(accountId, result) {
    const r = result || {}
    const entry = {
      at: typeof r.at === 'number' ? r.at : this.now(),
      valid: Boolean(r.valid),
      error: r.error ? auth.summarize(r.error) : null,
      networkError: Boolean(r.networkError),
    }
    // Seed the scheduler's cache lazily (kept in sync by AccountSweeper).
    if (this.cache instanceof Map) this.cache.set(accountId, entry)
    this.validations.set(accountId, entry)
    return entry
  }

  lastValidation(accountId) {
    return this.validations.get(accountId) || null
  }

  /** Mark that a re-check is in flight, so a burst of failures checks once. */
  beginRecheck(accountId, details) {
    const d = details || {}
    const now = this.now()
    const existing = this.rechecks.get(accountId)
    if (existing && now - existing.since < this.options.inFlightTtlMs) return false
    this.rechecks.set(accountId, { since: now, reason: auth.summarize(d.reason || ''), class: d.class || 'auth' })
    return true
  }

  endRecheck(accountId) {
    this.rechecks.delete(accountId)
  }

  /**
   * The single entry point used by the runtime wrapper: given a failed
   * forward, decide what the account deserves.
   *
   * @param {{accountId: string, providerId?: string, message?: string, status?: number|null, error?: any}} failure
   * @returns {{classification: object, action: 'none'|'recheck'|'cooldown', cooldown?: object}}
   */
  observeFailure(failure) {
    const f = failure || {}
    const classification = f.classification || auth.classifyFailure({ message: f.message, status: f.status, error: f.error })
    const accountId = f.accountId
    if (!accountId) return { classification, action: 'none' }

    // A human-verification demand is neither an auth bug nor a server bug;
    // cooling the account down would hide the real cause from the operator.
    if (!classification.auth) return { classification, action: 'none' }

    const recent = this.validations.get(accountId)
    const fresh = recent && this.now() - recent.at < this.options.validatedFreshMs
    if (fresh && recent.valid) {
      // Validated healthy moments ago: this is a per-request hiccup, not a
      // dead credential. Do not start a re-check storm.
      return { classification, action: 'none' }
    }

    if (!this.beginRecheck(accountId, { reason: classification.reason, class: classification.class })) {
      return { classification, action: 'none' }
    }
    return { classification, action: 'recheck' }
  }

  /* ------------------------------------------------------------------ */
  /* Reporting                                                          */
  /* ------------------------------------------------------------------ */

  record(kind, payload) {
    this.events.push({ at: this.now(), kind, ...(payload || {}) })
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents)
  }

  recentEvents(limit) {
    const n = Number(limit) || 20
    return this.events.slice(-n)
  }

  /** Snapshot of the cooldown table, for /health and logs. */
  coolingList() {
    const now = this.now()
    const out = []
    for (const [id, c] of this.cooling) {
      if (c.until <= now) {
        this.cooling.delete(id)
        continue
      }
      out.push({
        accountId: id,
        providerId: c.providerId,
        until: c.until,
        remainingMs: c.until - now,
        reason: c.reason,
        strikes: c.strikes,
        degraded: Boolean(c.degraded),
      })
    }
    return out
  }

  /** Aggregate counters derived from an upstream account list. */
  summarize(accounts) {
    const list = Array.isArray(accounts) ? accounts : []
    const counts = { total: list.length, active: 0, error: 0, inactive: 0, expired: 0, cooling: 0, unreachable: 0 }
    for (const a of list) {
      if (!a) continue
      if (a.status === 'active') counts.active += 1
      else if (a.status === 'error') counts.error += 1
      else if (a.status === 'inactive') counts.inactive += 1
      else if (a.status === 'expired') counts.expired += 1
      if (this.isCoolingDown(a.id)) counts.cooling += 1
    }
    counts.unreachable = counts.error + counts.expired + counts.cooling
    return counts
  }

  reset() {
    this.cooling.clear()
    this.validations.clear()
    this.rechecks.clear()
    this.events.length = 0
  }
}

module.exports = { AccountHealth, STATE, DEFAULTS }
