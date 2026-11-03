/**
 * Unit tests for the account self-heal layer.
 *
 * Run with `node tests/selfheal.test.js` (also wired into tests/smoke.sh as a
 * pure-node stage). No framework: a tiny assert/case harness keeps CI clean and
 * the file runnable inside the runtime image, which has no devDependencies.
 *
 * Covered:
 *   - the auth-message matrix (the 39 x 500 incident in one table)
 *   - the captcha / rate-limit / network courtesies (never parked)
 *   - cooldown lifecycle, exponential backoff, and the picker veto
 *   - the sweep scheduler: which accounts are due, and when
 *   - reason fidelity: a body-less 'HTTP 500' gains the response body
 *   - token cache invalidation keys
 *   - real-bundle shapes: {error:{message}} bodies, 503/429 local verdicts,
 *     the LoadBalancer picker seam, captcha degraded parks
 *
 * Test discipline (read before adding a case):
 *   - Time comes from a MUTABLE CLOCK INJECTED AT CONSTRUCTION
 *     (`new SelfHeal({ now: () => clock })`, then `clock += 61000`).
 *     Never simulate time by assigning to an instance field after the fact
 *     (`self.now = ...`): AccountHealth copies `opts.now` into its own field at
 *     construction and cooldown records hold an ABSOLUTE `until`, so the
 *     reassignment does nothing and the case only goes red on some paths.
 *   - No case may depend on ordering: reset the health registry and seed the
 *     cooldown/state a case needs instead of inheriting an earlier case's.
 *   - Assert the CAUSE, not just the effect: for "a cooling account is not
 *     served", also check that the UNWRAPPED picker
 *     (`getAvailableAccounts.__selfhealOriginal`) still offers it.
 */

'use strict'

const path = require('path')
const assert = require('assert')

const HERE = path.join(__dirname, '..', 'shim', 'selfheal')
const auth = require(path.join(HERE, 'auth-errors'))
const { AccountHealth } = require(path.join(HERE, 'account-health'))
const sweepMod = require(path.join(HERE, 'sweep'))
const reason = require(path.join(HERE, 'reason-fidelity'))
const { TokenCacheInvalidator } = require(path.join(HERE, 'token-cache'))
const hooksMod = require(path.join(HERE, 'runtime-hooks'))
const { resolveConfig, SelfHeal } = require(path.join(__dirname, '..', 'shim', 'selfheal'))

let passed = 0
const failures = []

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log('  ok   ' + name) })
.catch((e) => { failures.push([name, e]); console.log('  FAIL ' + name + ': ' + (e && e.message)); });
    }
    passed++;
    console.log('  ok   ' + name);
    return Promise.resolve();
  } catch (e) {
    failures.push([name, e]);
    console.log('  FAIL ' + name + ': ' + (e && e.message));
    return Promise.resolve();
  }
}

function section(title) { console.log('\n' + title); }

async function main() {
  section('--- auth failure classification ---');

  // The exact message from the production incident. It contains 'invalid token'
  // in that order, which upstream isAuthError() does not know, so the account
  // stayed active and every request paid the full timeout.
  const incident = 'Failed to acquire token: \"{\"code\":40003,\"msg\":\"Failed (invalid token)\"}\"';

  await test('the production message is recognized as auth', () => {
    const c = auth.classifyFailure({ message: incident });
    assert.strictEqual(c.class, 'auth');
    assert.strictEqual(c.auth, true);
  });

  const AUTH_MATRIX = [
    ['Failed (invalid token)', 'invalid token'],
    ['invalid_token', 'lowercase underscore form'],
    ['Token invalid', 'upstream already knows this one'],
    ['token is invalid', 'upstream already knows this one'],
    ['Token invalid or expired, please get a new Token', 'deepseek acquireToken 401'],
    ['Token expired or invalid', 'deepseek token check'],
    ['authorization failed', 'generic auth failure'],
    ['Authorization: Bearer rejected', 'contains authorization'],
    ['Unauthorized', '401 body'],
    ['session has expired', 'upstream keyword'],
    ['credentials are no longer valid', 'upstream keyword'],
    ['please sign in again', 'upstream keyword'],
    ['auth.token.invalid', 'upstream keyword'],
    ['login expired', 'upstream keyword'],
    ['API key is invalid', 'generic key failure'],
    ['access token has expired', 'expiry wording'],
    ['refresh token is revoked', 'revoked wording'],
    ['缺少 token', 'chinese wording'],
  ];
  for (const entry of AUTH_MATRIX) {
    await test('auth matrix: ' + entry[0] + ' (' + entry[1] + ')', () => {
      assert.strictEqual(auth.isAuthError(entry[0]), true);
    });
  }

  await test('auth matrix: HTTP 401 and 403 are auth even without a message', () => {
    assert.strictEqual(auth.isAuthError('', 401), true);
    assert.strictEqual(auth.isAuthError('', 403), true);
  });

  const NON_AUTH = [
    ['HTTP 500', 'empty body'],
    ['Rate limit exceeded', 'quota'],
    ['insufficient balance', 'billing'],
    ['Request timed out after 120000ms', 'timeout'],
    ['HTTP 429: too many requests', 'throttle'],
    ['socket hang up', 'network'],
  ];
  for (const entry of NON_AUTH) {
    await test('auth matrix: ' + entry[0] + ' is not auth (' + entry[1] + ')', () => {
      assert.notStrictEqual(auth.classifyFailure({ message: entry[0] }).class, 'auth');
    });
  }

  await test('captcha wins over auth wording (qwen-ai risk control)', () => {
    const c = auth.classifyFailure({ message: 'Qwen AI 风控拦截（需要验证码校验）' });
    assert.strictEqual(c.class, 'captcha');
    assert.strictEqual(c.auth, false);
  });

  await test('a 401 packed into a captcha message still does not park the account', () => {
    const c = auth.classifyFailure({ message: '需要验证码校验 (HTTP 401)' });
    assert.strictEqual(c.class, 'captcha');
  });

  await test('network failures are not auth (validation is inconclusive)', () => {
    const c = auth.classifyFailure({ message: 'getaddrinfo ENOTFOUND chat.deepseek.com' });
    assert.strictEqual(c.class, 'network');
  });

  await test('classifyFailure reads the axios status when the message is empty', () => {
    const c = auth.classifyFailure({ status: 401, error: { response: { status: 401 } } });
    assert.strictEqual(c.class, 'auth');
  });

  await test('summarize collapses whitespace and truncates', () => {
    const s = auth.summarize('a'.repeat(5) + '   \n ' + 'b'.repeat(400));
    assert.ok(s.length <= auth.MAX_REASON_LENGTH);
    assert.ok(s.indexOf('   ') === -1);
  });

  section('--- cooldown lifecycle ---');

  let clock = 1000000;
  const health = new AccountHealth({ now: () => clock, cooldownMs: 60000, cooldownMaxMs: 600000, cooldownBackoff: 2 });

  await test('a parked account is hidden from the picker and returns after the cooldown', () => {
    const rec = health.startCooldown('acc-1', { providerId: 'deepseek', reason: 'invalid token' });
    assert.strictEqual(rec.until, clock + 60000);
    assert.deepStrictEqual(health.filterAvailable([{ id: 'acc-1' }, { id: 'acc-2' }]).map((a) => a.id), ['acc-2']);
    clock += 59999;
    assert.deepStrictEqual(health.filterAvailable([{ id: 'acc-1' }]), []);
    clock += 2;
    assert.deepStrictEqual(health.filterAvailable([{ id: 'acc-1' }]).map((a) => a.id), ['acc-1']);
    health.endCooldown('acc-1');
  });

  await test('repeated failures back off exponentially up to the ceiling', () => {
    health.reset();
    const a = health.startCooldown('acc-1', {});
    const b = health.startCooldown('acc-1', {});
    const c = health.startCooldown('acc-1', {});
    assert.strictEqual(a.until - clock, 60000);
    assert.strictEqual(b.until - clock, 120000);
    assert.strictEqual(c.until - clock, 240000);
    let last = c;
    for (let i = 0; i < 10; i++) last = health.startCooldown('acc-1', {});
    assert.strictEqual(last.until - clock, 600000);
    health.endCooldown('acc-1');
  });

  await test('a successful validation clears the strike count', () => {
    health.reset();
    health.startCooldown('acc-1', {});
    health.startCooldown('acc-1', {});
    health.endCooldown('acc-1');
    health.noteValidation('acc-1', { valid: true });
    const rec = health.startCooldown('acc-1', {});
    assert.strictEqual(rec.until - clock, 60000);
  });

  await test('filterAvailable keeps accounts that are not cooling', () => {
    health.reset();
    const list = [{ id: 'a', status: 'active' }, { id: 'b', status: 'active' }];
    assert.deepStrictEqual(health.filterAvailable(list).map((a) => a.id), ['a', 'b']);
  });

  await test('summarize reports totals and cooling count', () => {
    health.reset();
    health.startCooldown('a', {});
    const s = health.summarize([{ id: 'a', status: 'error' }, { id: 'b', status: 'active' }]);
    assert.strictEqual(s.total, 2);
    assert.strictEqual(s.active, 1);
    assert.strictEqual(s.cooling, 1);
  });

  section('--- sweep scheduling ---');

  const now0 = 5000000;
  const accounts = [
    { id: 'active-old', status: 'active' },
    { id: 'active-fresh', status: 'active' },
    { id: 'error-1', status: 'error' },
    { id: 'inactive-1', status: 'inactive' },
    { id: 'fresh-1', status: 'active' },
  ];
  // History entries carry the verdict (`valid`), not just the time - that is
  // what lets one sweep interval serve healthy accounts and another serve
  // accounts that failed their last validation.
  const history = new Map();
  // A failed validation is what the short recheck interval is for, so this one
  // failed 40 minutes ago and is due again right now.
  history.set('active-old', { at: now0 - 40 * 60000, valid: false });
  history.set('active-fresh', { at: now0 - 1000, valid: true });
  history.set('fresh-1', { at: now0 - 5000, valid: true });

  await test('due() picks stale active accounts and unvalidated non-active ones', () => {
    const list = sweepMod.due(accounts, history, now0, {
      sweepIntervalMs: 30 * 60000, recheckIntervalMs: 60000,
    }).map((d) => d.account.id);
    assert.deepStrictEqual(list, ['error-1', 'inactive-1', 'active-old']);
  });

  await test('due() honours the recheck interval for non-active accounts', () => {
    const h = new Map(history);
    h.set('error-1', { at: now0 - 10000, valid: false }); // 10s ago, recheck is 60s
    const list = sweepMod.due(accounts, h, now0, {
      sweepIntervalMs: 30 * 60000, recheckIntervalMs: 60000,
    }).map((d) => d.account.id);
    assert.deepStrictEqual(list, ['inactive-1', 'active-old']);
  });

  await test('a sweeper validates due accounts serially and records results', async () => {
    const validated = [];
    const sweeper = new sweepMod.AccountSweeper({
      listAccounts: async () => accounts,
      validate: async (id) => { validated.push(id); return { valid: id !== 'error-1', error: id === 'error-1' ? 'invalid token' : undefined }; },
      health: new AccountHealth({ now: () => now0 }),
      now: () => now0,
      log: () => {},
      options: { sweepIntervalMs: 30 * 60000, recheckIntervalMs: 60000, spacingMs: 0 },
    });
    // Seed the scheduler's own history with the fixture verdicts. noteExternal
    // records a fresh check time, so the timestamp is restored afterwards.
    history.forEach((v, k) => sweeper.noteExternal(k, { at: v.at, valid: v.valid }));
    const summary = await sweeper.run();
    assert.deepStrictEqual(validated, ['error-1', 'inactive-1', 'active-old']);
    assert.strictEqual(summary.checked, 3);
    assert.strictEqual(summary.invalid, 1);
    assert.strictEqual(summary.valid, 2);
    const snap = sweeper.snapshot();
    assert.strictEqual(snap.lastSweepAt, now0);
    assert.strictEqual(snap.sweep.checked, 3);
  });

  await test('run({all:true}) validates every account regardless of schedule', async () => {
    const validated = [];
    const sweeper = new sweepMod.AccountSweeper({
      listAccounts: async () => accounts.slice(0, 2),
      validate: async (id) => { validated.push(id); return { valid: true }; },
      health: new AccountHealth({ now: () => now0 }),
      now: () => now0,
      log: () => {},
      options: { spacingMs: 0 },
    });
    await sweeper.run({ all: true });
    assert.deepStrictEqual(validated.sort(), ['active-fresh', 'active-old']);
  });

  await test('a validator that throws does not abort the sweep', async () => {
    const sweeper = new sweepMod.AccountSweeper({
      listAccounts: async () => [{ id: 'x', status: 'error' }, { id: 'y', status: 'error' }],
      validate: async (id) => { if (id === 'x') throw new Error('boom'); return { valid: true }; },
      health: new AccountHealth({ now: () => now0 }),
      now: () => now0,
      log: () => {},
      options: { spacingMs: 0 },
    });
    const summary = await sweeper.run({ all: true });
    // Two accounts attempted, one threw: the throw is counted separately and the
    // other account still got its verdict.
    assert.strictEqual(summary.checked + summary.errors, 2);
    assert.strictEqual(summary.errors, 1);
    assert.strictEqual(summary.valid, 1);
  });

  section('--- request-path integration (fake upstream bundle) ---');

  /**
   * A miniature stand-in for upstream's shipped bundle.
   *
   * It mirrors the shape the real bundle actually has, because that shape is
   * the whole reason the request-path seam is ProxyServer:
   *   - AccountManager / DeepSeekAdapter ARE exported classes;
   *   - ProxyServer is exported and builds `new App()` in its constructor,
   *     then pushes middleware synchronously (setupMiddleware/setupRoutes);
   *   - RequestForwarder is NOT exported at all (module-local singleton).
   */
  function makeFakeBundle(opts) {
    const o = opts || {};
    const state = { available: o.available || 1, tokens: 0, statuses: [], errorMessages: [], tokenFail: !!o.tokenFail };
    class AccountManager {
      constructor(accounts) { this.accounts = accounts || []; state.instance = this; }
      async getAll() { return this.accounts; }
      async validate(id) {
        const account = this.accounts.find((a) => a.id === id);
        return { valid: Boolean(account && account.valid), error: account && account.valid ? undefined : 'Failed (invalid token)' };
      }
      async updateStatus(id, status, errorMessage) {
        state.statuses.push([id, status]);
        state.errorMessages.push(errorMessage);
        const account = this.accounts.find((a) => a.id === id);
        // Upstream really stores the reason on the account record; mirror it so
        // tests can assert what the operator will actually see.
        if (account) { account.status = status; if (errorMessage) account.errorMessage = errorMessage; }
        return true;
      }
      // Raw picker: upstream's own view, WITHOUT the self-heal veto. The
      // wrapping happens on AccountManager.getAvailable (the static entry the
      // router really calls), so this must stay unwrapped or the veto would be
      // applied twice and the router would never see the cooling account.
      getAvailable() { return this.activeAccounts(); }
      activeAccounts() { return state.available === 0 ? [] : this.accounts.filter((a) => a.status === 'active'); }
    }
    AccountManager.getAll = () => state.instance.getAll();
    AccountManager.updateStatus = (id, status, errorMessage) => state.instance.updateStatus(id, status, errorMessage);
    AccountManager.getAvailable = function getAvailable() { return state.instance.activeAccounts(); };

    /** Koa-shaped app: `use()` pushes, `middleware` is the composed stack. */
    class App {
      constructor() { this.middleware = []; this.calls = []; }
      use(fn) { this.middleware.push(fn); return this; }
      /** Compose exactly like koa-compose does (index 0 runs first). */
      compose() {
        const stack = this.middleware.slice();
        const dispatch = (i, ctx) => {
          if (i >= stack.length) return Promise.resolve();
          try { return Promise.resolve(stack[i](ctx, () => dispatch(i + 1, ctx))); } catch (e) { return Promise.reject(e); }
        };
        return (ctx) => dispatch(0, ctx);
      }
    }

    /**
     * The account picker the router really calls: selectAccount() delegates to
     * getAvailableAccounts(). This is the seam the self-heal veto is applied to
     * (AccountManager.getAvailable is NOT on the shipped bundle's request path).
     */
    class LoadBalancer {
      getAvailableAccounts() {
        return state.instance.activeAccounts()
          .filter((a) => a.status === 'active')
          .map((account) => ({ account, provider: { id: account.providerId }, actualModel: 'x' }));
      }
      selectAccount() {
        const candidates = this.getAvailableAccounts();
        return candidates.length ? candidates[0] : null;
      }
    }

    class ProxyServer {
      constructor() {
        this.app = new App();
        this.setupMiddleware();
        this.setupRoutes();
        state.servers = (state.servers || 0) + 1;
      }
      setupMiddleware() { this.app.use(async (ctx, next) => { await next(); }); }
      setupRoutes() {
        this.app.use(async (ctx, next) => {
          // Mirrors the real /v1/chat/completions handler: picker -> forward ->
          // ctx.body = result.body, or {error:{message,type}} + ctx.status.
          if (ctx.path !== '/v1/chat/completions') return next();
          const selection = new LoadBalancer().selectAccount();
          if (!selection) {
            ctx.status = 503;
            ctx.body = { error: { message: 'No available account for model: x', type: 'service_unavailable_error', param: null, code: 'no_available_account' } };
            return;
          }
          const account = selection.account;
          ctx.state.selfhealAccount = account;
          try {
            if (state.tokenFail) throw new Error('Failed to acquire token: "Failed (invalid token)"');
            ctx.status = 200;
            ctx.body = { id: 'cmpl-1', choices: [{ message: { content: 'hi' } }] };
          } catch (e) {
            ctx.status = 500;
            ctx.body = { error: { message: e.message, type: 'api_error', param: null, code: null } };
          }
        });
      }
    }

    class DeepSeekAdapter {
      constructor(credentials) { this.credentials = credentials; }
      async acquireToken() {
        state.tokens += 1;
        // Same shape as the shipped adapter: the provider answers 200 with
        // {code:40003,msg:'Authorization Failed (invalid token)'} and the
        // adapter rejects with the wrapped message.
        if (o.acquireFails) throw new Error('Failed to acquire token: Authorization Failed (invalid token)');
        return { accessToken: 'access', refreshToken: 'refresh' };
      }
    }
    // Mirrors upstream's ProxyStatusManager: no getStatus(), only
    // getRunningStatus()/getStatistics()/getPort() - the shape proxyStatus() reads.
    const proxyStatusManager = {
      isRunning: true,
      startTime: 1000,
      getRunningStatus() { return { isRunning: this.isRunning, startTime: this.startTime, uptime: 5000 }; },
      getStatistics() { return { totalRequests: 7, activeConnections: 1 }; },
      getPort() { return 8082; },
    };
    return { AccountManager, ProxyServer, LoadBalancer, DeepSeekAdapter, proxyStatusManager, state, App };
  }

  // --- attribution through the adapter -------------------------------------
  //
  // The shipped bundle never exports RequestForwarder, so a failure on the wire
  // reaches us as a bare HTTP status with no account attached. The adapter's
  // acquireToken() is the only reachable seam that knows the account, which is
  // why the failure signal is fed from there. These two cases pin that.

  await test('the adapter seam attributes an invalid token to the exact account', async () => {
    const SelfHeal = require(path.join(__dirname, '..', 'shim', 'selfheal', 'index')).SelfHeal;
    const bundle = makeFakeBundle({ acquireFails: true });
    const manager = new bundle.AccountManager([
      { id: 'acc-good', providerId: 'deepseek', status: 'active', valid: true },
      { id: 'acc-dead', providerId: 'deepseek', status: 'active', valid: false },
    ]);
    let clock = 1000000;
    const traced = [];
    const self = new SelfHeal({
      now: () => clock,
      log: (m) => traced.push(m),
      stateLog: () => {},
      config: { enabled: true, cooldownMs: 60000, cooldownMaxMs: 1800000, sweepIntervalMinutes: 30, recheckIntervalSec: 60, spacingMs: 0, recheckTimeoutMs: 5000 },
    });
    self.install({ graph: bundle, validate: (id) => manager.validate(id) });
    self.hooks.log = (m) => traced.push(m);
    self.health.reset();

    const adapter = new bundle.DeepSeekAdapter({ token: 'dead-token' });
    adapter.account = manager.accounts[1];
    let threw = null;
    try { await adapter.acquireToken(); } catch (e) { threw = e; }
    assert.ok(threw, 'the adapter must still reject - self-heal never swallows a failure');
    assert.ok(/invalid token/i.test(threw.message), 'the original error must survive, got ' + String(threw && threw.message));

    await new Promise((r) => setTimeout(r, 40));
    const snap = self.snapshot(manager.accounts);
    assert.strictEqual(snap.hooks.rechecks, 1, 'expected one re-check for the failing adapter, logs: ' + JSON.stringify(traced));
    assert.strictEqual(snap.cooling.length, 1, 'exactly one account must be parked');
    assert.strictEqual(snap.cooling[0].accountId, 'acc-dead', 'the parked account must be the one the adapter used, got ' + snap.cooling[0].accountId);
    const coolingIds = self.health.filterAvailable(manager.activeAccounts()).map((a) => a.id);
    assert.ok(coolingIds.indexOf('acc-good') !== -1, 'the healthy account must stay available: ' + JSON.stringify(coolingIds));
    assert.ok(coolingIds.indexOf('acc-dead') === -1, 'the dead account must be filtered out: ' + JSON.stringify(coolingIds));
  });

  await test('a failure with no account id is reported, not misattributed', async () => {
    const SelfHeal = require(path.join(__dirname, '..', 'shim', 'selfheal', 'index')).SelfHeal;
    const bundle = makeFakeBundle({ acquireFails: true });
    const manager = new bundle.AccountManager([{ id: 'acc-1', providerId: 'deepseek', status: 'active', valid: false }]);
    const traced = [];
    const self = new SelfHeal({
      now: () => 1000000,
      log: (m) => traced.push(m),
      stateLog: () => {},
      config: { enabled: true, cooldownMs: 60000, cooldownMaxMs: 1800000, sweepIntervalMinutes: 30, recheckIntervalSec: 60, spacingMs: 0, recheckTimeoutMs: 5000 },
    });
    self.install({ graph: bundle, validate: (id) => manager.validate(id) });
    self.hooks.log = (m) => traced.push(m);
    self.health.reset();

    const adapter = new bundle.DeepSeekAdapter({ token: 'x' });
    adapter.account = undefined;
    let threw = null;
    try { await adapter.acquireToken(); } catch (e) { threw = e; }
    assert.ok(threw, 'the adapter must still reject');
    await new Promise((r) => setTimeout(r, 20));
    const snap = self.snapshot(manager.accounts);
    assert.strictEqual(snap.cooling.length, 0, 'nothing may be parked when the account is unknown');
    assert.strictEqual(snap.hooks.rechecks, 0, 'no re-check without an account to re-check');
    assert.ok(traced.some((m) => /without an account id/.test(m)),
      'the unattributed failure must be logged, got ' + JSON.stringify(traced));
  });

  await test('a DeepSeek invalid-token failure parks the account without waiting for a second round-trip', async () => {
    const SelfHeal = require(path.join(__dirname, '..', 'shim', 'selfheal', 'index')).SelfHeal;
    const bundle = makeFakeBundle({ acquireFails: true });
    const manager = new bundle.AccountManager([{ id: 'acc-1', providerId: 'deepseek', status: 'active', valid: false }]);
    let clock = 1000000;
    const traced = [];
    const self = new SelfHeal({
      now: () => clock,
      log: (m) => traced.push(m),
      stateLog: () => {},
      config: { enabled: true, cooldownMs: 60000, cooldownMaxMs: 1800000, sweepIntervalMinutes: 30, recheckIntervalSec: 60, spacingMs: 0, recheckTimeoutMs: 5000 },
    });
    self.install({ graph: bundle, validate: (id) => manager.validate(id) });
    self.hooks.log = (m) => traced.push(m);
    const snap0 = self.snapshot(manager.accounts);
    // requestPath is owned by the http observer on the captured handler, which
    // only exists under the real shim; in a unit test the adapter seam below is
    // what carries the failure. Assert the adapter seam is really wrapped.
    assert.strictEqual(bundle.DeepSeekAdapter.prototype.__selfhealWrapped, true,
      'the adapter seam must be wrapped: ' + JSON.stringify(snap0.installed));

    // The failing request goes through the adapter (the seam the shipped
    // bundle actually exposes). The rejection must reach the caller unchanged
    // and must NOT wait for the re-check.
    const adapter = new bundle.DeepSeekAdapter({ token: 'dead' });
    adapter.account = manager.accounts[0];
    const started = Date.now();
    let surfaced = null;
    try { await adapter.acquireToken(); } catch (e) { surfaced = e; }
    const elapsed = Date.now() - started;
    assert.ok(surfaced, 'the failure must reach the caller');
    assert.ok(/invalid token/i.test(surfaced.message),
      'the failure message must survive intact, got ' + String(surfaced && surfaced.message));
    assert.ok(elapsed < 1000, 'the request path must not block on the re-check, took ' + elapsed + 'ms');

    await new Promise((r) => setTimeout(r, 40));
    const snap = self.snapshot(manager.accounts);
    assert.strictEqual(snap.hooks.rechecks, 1, 'expected exactly one re-check, logs: ' + JSON.stringify(traced));
    assert.strictEqual(snap.cooling.length, 1, 'the invalid account must be parked');
    assert.strictEqual(bundle.state.statuses[0][0], 'acc-1');
    assert.strictEqual(bundle.state.statuses[0][1], 'error');
    assert.ok(/invalid token/i.test(bundle.state.errorMessages[0]), 'the reason must be preserved, got ' + bundle.state.errorMessages[0]);

    assert.strictEqual(manager.accounts[0].status, 'error', 'upstream status must have been written to error');
    assert.deepStrictEqual(manager.activeAccounts(), []);
    clock += 61000;
    assert.strictEqual(self.snapshot(manager.accounts).cooling.length, 0, 'the cooldown must expire on its own');
    manager.accounts[0].status = 'active';
    self.health.startCooldown('acc-1', { providerId: 'deepseek', reason: 'seeded' });
    assert.deepStrictEqual(self.health.filterAvailable(manager.activeAccounts()), [],
      'the veto must skip a cooling account even while upstream still says active');
    self.stop();
  });

  await test('a captcha failure degrades the account instead of condemning it', async () => {
    const SelfHeal = require(path.join(__dirname, '..', 'shim', 'selfheal', 'index')).SelfHeal;
    const bundle = makeFakeBundle({ tokenFail: false });
    const manager = new bundle.AccountManager([{ id: 'qwen-1', providerId: 'qwen-ai', status: 'active', valid: true }]);
    const self = new SelfHeal({ now: () => 1000000, log: () => {}, stateLog: () => {}, config: { spacingMs: 0 } });
    self.install({ graph: bundle, validate: (id) => manager.validate(id) });
    const outcome = self.hooks.onFailure(manager.accounts[0], { message: 'Qwen AI 风控拦截（需要验证码校验）' });
    assert.strictEqual(outcome.classification.class, 'captcha');
    assert.strictEqual(outcome.action, 'degraded');
    await new Promise((r) => setTimeout(r, 20));
    const snap = self.snapshot(manager.accounts);
    assert.strictEqual(snap.cooling.length, 1);
    assert.strictEqual(snap.cooling[0].degraded, true);
    assert.strictEqual(snap.cooling[0].strikes, 0);
    assert.deepStrictEqual(self.health.filterAvailable(manager.getAvailable()).map((a) => a.id), []);
    assert.strictEqual(manager.accounts[0].status, 'active');
    self.stop();
  });

  await test('a successful request to a cooling account clears the cooldown', async () => {
    const SelfHeal = require(path.join(__dirname, '..', 'shim', 'selfheal', 'index')).SelfHeal;
    const bundle = makeFakeBundle({});
    const manager = new bundle.AccountManager([{ id: 'acc-2', providerId: 'deepseek', status: 'active', valid: true }]);
    // One mutable clock for the whole case: the cooldown record is an absolute
    // instant, so a fixed now() would keep the account parked forever and the
    // "expires on its own" half of the test could never pass.
    let clock = 1000000;
    const self = new SelfHeal({ now: () => clock, log: () => {}, stateLog: () => {}, config: { spacingMs: 0 } });
    self.install({ graph: bundle, validate: (id) => manager.validate(id) });
    // Every precondition is (re)built here, never inherited from a previous
    // case: the cooldown is seeded explicitly and the pools are re-derived
    // from the live registry. A test that leaned on state left behind by an
    // earlier case would go red only in some orders (that is exactly how this
    // one first showed up as 'FAILED 1 of 66').
    self.health.reset();
    self.health.startCooldown('acc-2', { providerId: 'deepseek', reason: 'seeded' });
    assert.strictEqual(self.snapshot(manager.accounts).cooling.length, 1, 'the case starts from exactly one parked account');
    self.hooks.log = () => {};
    // While it is parked the real picker (LoadBalancer.getAvailableAccounts)
    // must not offer it: the seeded cooldown is the veto, upstream status is
    // still 'active', so only our wrapper can be the reason it is gone.
    // The veto must be OURS, not the fake bundle's: the unwrapped picker still
    // offers the account (upstream status is 'active'), the wrapped one does not.
    const unwrapped = bundle.LoadBalancer.prototype.getAvailableAccounts.__selfhealOriginal;
    assert.strictEqual(typeof unwrapped, 'function', 'the picker seam is wrapped by this case');
    const before = unwrapped.call(new bundle.LoadBalancer(), null, null, false);
    assert.strictEqual(before.length, 1, 'upstream alone would hand out the parked account');
    const after = bundle.LoadBalancer.prototype.getAvailableAccounts.call(new bundle.LoadBalancer(), null, null, false);
    assert.strictEqual(after.length, 0, 'the self-heal picker refuses to hand it out');
    const server = new bundle.ProxyServer();
    const ctx = { path: '/v1/chat/completions', state: {}, status: 404, body: null };
    await server.app.compose()(ctx);
    assert.strictEqual(ctx.status, 503, 'a cooling account must not be handed to the router');
    assert.strictEqual(ctx.body.error.code, 'no_available_account');
    // A local routing verdict is not an account strike: the cooldown stands.
    assert.strictEqual(self.snapshot(manager.accounts).cooling.length, 1);
    assert.strictEqual(self.snapshot(manager.accounts).cooling[0].strikes, 1);
    assert.strictEqual(manager.accounts[0].status, 'active', 'a 503 must never be written back as an account error');
    // Once the cooldown expires the account is offered again and the very next
    // successful request clears every trace of the parking.
    clock += 61000;
    const ctx2 = { path: '/v1/chat/completions', state: {}, status: 404, body: null };
    await server.app.compose()(ctx2);
    assert.strictEqual(ctx2.status, 200, 'after the cooldown the account must serve again');
    assert.strictEqual(self.snapshot(manager.accounts).cooling.length, 0);
    self.stop();
  });
  await section('--- real bundle shapes: {error:{message}} + local routing verdicts ---');
  await test('the shipped failure shape ({error:{message,type}}) is classified, not ignored', async () => {
    const tap = require(path.join(__dirname, '..', 'shim', 'selfheal', 'proxy-tap'));
    const { classifyFailure } = require(path.join(__dirname, '..', 'shim', 'selfheal', 'auth-errors'));
    const ctx = {
      status: 500,
      body: { error: { message: 'Failed to acquire token: "x" Failed (invalid token)', type: 'api_error', param: null, code: null } },
    };
    const failure = tap.failureOf(ctx);
    assert.ok(failure, 'the real failure body must be recognised');
    assert.strictEqual(failure.status, 500);
    const cls = classifyFailure({ message: failure.message, status: failure.status });
    assert.strictEqual(cls.class, 'auth');
    assert.strictEqual(cls.matched, 'invalid token');
  });

  await test('local routing verdicts (503/429) are never account strikes', async () => {
    const tap = require(path.join(__dirname, '..', 'shim', 'selfheal', 'proxy-tap'));
    const noAccount = tap.failureOf({ status: 503, body: { error: { message: 'No available account for model: x', type: 'service_unavailable_error', code: 'no_available_account' } } });
    assert.strictEqual(noAccount, null, 'a 503 no_available_account must not count as a failure');
    const busy = tap.failureOf({ status: 429, body: { error: { message: 'All accounts busy', type: 'rate_limit_error', code: 'account_busy' } } });
    assert.strictEqual(busy, null, 'a 429 account_busy must not count as a failure');
    const provider = tap.failureOf({ status: 502, body: { error: { message: 'upstream boom', type: 'api_error', code: null } } });
    assert.ok(provider && provider.status === 502, 'a provider failure must still be reported');
  });

  await test('a successful completion body ({id, choices}) is not mistaken for a failure', async () => {
    const tap = require(path.join(__dirname, '..', 'shim', 'selfheal', 'proxy-tap'));
    assert.strictEqual(tap.failureOf({ status: 200, body: { id: 'cmpl-1', choices: [{ message: { content: 'hi' } }] } }), null);
    assert.strictEqual(tap.failureOf({ status: 200, body: { object: 'chat.completion', data: { error: 'nested but harmless' } } }), null);
  });

  await test('the picker wrapper is what vetoes a cooling account (LoadBalancer seam)', async () => {
    const SelfHeal = require(path.join(__dirname, '..', 'shim', 'selfheal', 'index')).SelfHeal;
    const bundle = makeFakeBundle({});
    const manager = new bundle.AccountManager([
      { id: 'ok-1', providerId: 'deepseek', status: 'active', valid: true },
      { id: 'cool-1', providerId: 'deepseek', status: 'active', valid: true },
    ]);
    const self = new SelfHeal({ now: () => 1000000, log: () => {}, stateLog: () => {}, config: { spacingMs: 0 } });
    self.install({ graph: bundle, validate: (id) => manager.validate(id) });
    self.hooks.log = () => {};
    assert.strictEqual(self.snapshot(manager.accounts).installed.balancer, true, 'LoadBalancer must be hooked');
    const picker = new bundle.LoadBalancer();
    assert.strictEqual(picker.getAvailableAccounts().length, 2, 'both accounts start out eligible');
    self.health.startCooldown('cool-1', { providerId: 'deepseek', reason: 'invalid token' });
    const after = picker.getAvailableAccounts().map((c) => c.account.id);
    assert.deepStrictEqual(after, ['ok-1'], 'the cooling account must not be offered, got ' + JSON.stringify(after));
    // Upstream's own record still says active: the veto is ours, not a status write.
    assert.strictEqual(manager.accounts[1].status, 'active');
    self.stop();
  });

  await test('a captcha failure on the real path degrades without ever writing status', async () => {
    const SelfHeal = require(path.join(__dirname, '..', 'shim', 'selfheal', 'index')).SelfHeal;
    const bundle = makeFakeBundle({});
    const manager = new bundle.AccountManager([{ id: 'qwen-2', providerId: 'qwen-ai', status: 'active', valid: true }]);
    const self = new SelfHeal({ now: () => 1000000, log: () => {}, stateLog: () => {}, config: { spacingMs: 0, degradedCooldownMs: 2000 } });
    self.install({ graph: bundle, validate: () => ({ valid: true }) });
    self.hooks.log = () => {};
    const account = manager.accounts[0];
    const outcome = self.hooks.settle(account, Object.assign(new Error('Qwen AI 风控拦截（需要验证码校验）'), { status: 500 }), { ms: 19000 });
    assert.strictEqual(outcome.action, 'degraded');
    assert.strictEqual(bundle.state.statuses.length, 0, 'a captcha wall must never be written back as status=error');
    assert.strictEqual(self.snapshot(manager.accounts).cooling[0].degraded, true);
    // Reverse check: once the short degraded cooldown expires the account is back.
    const later = 1000000 + 2100;
    self.now = () => later;
    self.health.now = () => later;
    assert.strictEqual(self.snapshot(manager.accounts).cooling.length, 0, 'the degraded park must expire on its own');
    assert.strictEqual(manager.accounts[0].status, 'active', 'upstream status must still be active after the park');
    self.stop();
  });

  await test('the exported global snapshot is synchronous, throw-free and null-safe', async () => {
    const entry = require(path.join(__dirname, '..', 'shim', 'selfheal'));
    entry.stop();
    // Not installed: the hook object must still exist for /health, with a null
    // account section rather than a 0, so degradation is visible.
    const before = entry.get();
    assert.ok(before === null || typeof before === 'object');
    const bundle = makeFakeBundle({});
    const manager = new bundle.AccountManager([{ id: 'a', status: 'active' }, { id: 'b', status: 'error' }]);
    const managerClass = bundle.AccountManager;
    managerClass.getAll = () => manager.getAll();
    managerClass.validate = (id) => manager.validate(id);
    entry.install({ graph: bundle, validate: (id) => manager.validate(id), log: () => {} });
    const hook = globalThis.__chat2apiSelfHeal;
    assert.strictEqual(typeof hook.snapshot, 'function');
    assert.strictEqual(typeof hook.checkNow, 'function');
    await entry.get().refreshAccounts();
    const snap = hook.snapshot();
    assert.strictEqual(snap.accounts.total, 2);
    assert.strictEqual(snap.accounts.error, 1);
    assert.strictEqual(snap.badAccountCount >= 1, true);
    entry.stop();
  });

  await test('a bundle without our seams degrades instead of throwing', async () => {
    const SelfHeal = require(path.join(__dirname, '..', 'shim', 'selfheal', 'index')).SelfHeal;
    const logs = [];
    const self = new SelfHeal({ now: () => 1, log: (m) => logs.push(m), config: {} });
    self.install({ graph: {}, validate: null });
    const snap = self.snapshot([]);
    assert.strictEqual(snap.enabled, true);
    assert.strictEqual(snap.installed.requestPath, false);
    // An empty graph has no reason-fidelity seams at all. The decorative ones go to
    // `absent` (reported once, never a permanent /health warning, because operators
    // cannot clear upstream drift) - but the zai seam is `critical`, so its loss is
    // surfaced in `missing` even though the whole class is gone.
    assert.deepStrictEqual(snap.installed.missing, ['ZaiAdapter.createChat (class not exported by this build)']);
    assert.ok(snap.installed.reasonAbsent.length > 0, 'absent seams should still be recorded');
    assert.ok(logs.some((l) => /AccountManager not found/.test(l)), 'a missing seam must be logged, got ' + JSON.stringify(logs));
    assert.strictEqual(await self.checkNow().then((r) => r.checked), 0);
    self.stop();
  });
  await test('install() publishes the global on the healthy path, not only on failure', async () => {
    // Regression: install() used to call publish() only from its catch branch, so a
    // successful install left globalThis.__chat2apiSelfHeal undefined and /health
    // could never read proxy status. Publish must happen on EVERY path.
    const entryPath = require.resolve(path.join(__dirname, '..', 'shim', 'selfheal.js'));
    delete require.cache[entryPath];
    const entry2 = require(entryPath);
    const key = entry2.GLOBAL_KEY;
    delete globalThis[key];
    // Simulate a process that has just started: with a fresh module the install()
    // below is the ONLY thing that can publish, so the assertion really observes
    // install()'s own behaviour instead of a global left behind by an earlier test.
    entry2.stop();
    entry2.__resetForTests();
    // A bundle whose AccountManager is reachable: this is the healthy path.
    const bundle = makeFakeBundle({});
    entry2.install({ graph: bundle, log: () => {} });
    const hook = globalThis[key];
    assert.ok(hook, 'install() must publish the global on the healthy path');
    assert.strictEqual(typeof hook.snapshot, 'function');
    const snap = hook.snapshot();
    assert.strictEqual(snap.enabled, true);
    assert.strictEqual(typeof hook.proxyStatus, 'function', 'proxyStatus must be on the published surface');
    entry2.stop();
    delete require.cache[entryPath];
  });

  await test('install() still publishes when the upstream graph is unusable', async () => {
    const entryPath = require.resolve(path.join(__dirname, '..', 'shim', 'selfheal.js'));
    delete require.cache[entryPath];
    const entry3 = require(entryPath);
    const key = entry3.GLOBAL_KEY;
    delete globalThis[key];
    entry3.__resetForTests();
    entry3.install({ graph: null, config: { enabled: true }, log: () => {} });
    const hook = globalThis[key];
    assert.ok(hook, 'a degraded install must still publish, so /health reports degraded rather than unknown');
    assert.strictEqual(hook.snapshot().installed.requestPath, false);
    entry3.stop();
    delete require.cache[entryPath];
  });

  section('--- failure reason fidelity ---');

  await test('a body-less HTTP 500 gains the provider body', () => {
    const msg = reason.enrichHttpMessage('HTTP 500', { error: { message: 'internal model error: context overflow' } }, 500);
    assert.ok(msg.indexOf('HTTP 500') === 0, msg);
    assert.ok(msg.indexOf('context overflow') !== -1, msg);
  });

  await test('a string body is kept verbatim (truncated)', () => {
    const msg = reason.enrichHttpMessage('HTTP 502', 'upstream gateway timeout', 502);
    assert.ok(msg.indexOf('upstream gateway timeout') !== -1, msg);
  });

  await test('a message that already carries a body is left alone', () => {
    const original = 'Failed to acquire token: invalid token';
    assert.strictEqual(reason.enrichHttpMessage(original, { msg: 'x' }, 500), original);
  });

  await test('an empty body does not produce a dangling colon', () => {
    const msg = reason.enrichHttpMessage('HTTP 500', {}, 500);
    assert.ok(msg.indexOf(': ') === -1 || msg.indexOf('HTTP 500') !== 0, msg);
  });

  await test('losing the zai seam is a warning, not silent drift', () => {
    // z.ai is where the 7 production 'HTTP 500' lines came from. If the seam
    // disappears we want it in installed.missing (surfaced by /health), while a
    // decorative seam stays in absent so operators are not chased by upstream
    // renames they can do nothing about.
    const mk = (methods) => { const C = function X() {}; methods.forEach((m) => { C.prototype[m] = function () { throw new Error('HTTP 500') }; }); return C; };
    const graph = { KimiAdapter: mk(['chatCompletion']), GLMAdapter: mk(['acquireToken']) };
    const out = reason.install({ find: (n) => graph[n] || null, log: () => {} });
    assert.ok(out.missing.some((m) => /^ZaiAdapter\.createChat/.test(m)), 'zai must be reported, got ' + JSON.stringify(out.missing));
    assert.ok(out.absent.indexOf('ZaiAdapter.ensureToken') !== -1, 'the secondary zai seam stays quiet');
    assert.ok(out.missing.every((m) => !/KimiAdapter|GLMAdapter/.test(m)), 'present seams must not be reported as missing');
  });

  section('--- token cache invalidation ---');

  await test('deepseek keys are derived from the credential that seeds the cache', () => {
    const inv = new TokenCacheInvalidator({ now: () => 1 });
    assert.strictEqual(inv.keyFor('deepseek', { token: 'abc', apiKey: 'zzz' }), 'abc');
    assert.strictEqual(inv.keyFor('deepseek', { apiKey: 'zzz' }), 'zzz');
    assert.strictEqual(inv.keyFor('glm', { refresh_token: 'r1', token: 't1' }), 'r1');
    assert.strictEqual(inv.keyFor('glm', { token: 't1' }), 't1');
  });

  await test('invalidate() marks the key for the next acquireToken', () => {
    let t = 0;
    const inv = new TokenCacheInvalidator({ now: () => t });
    const ok = inv.invalidate({ id: 'a1', providerId: 'deepseek', credentials: { token: 'abc' } });
    assert.strictEqual(ok, true);
    assert.strictEqual(inv.isInvalidated('a1', 'abc'), true);
    t += 3600000 + 1;
    assert.strictEqual(inv.isInvalidated('a1', 'abc'), false);
  });

  await test('wrapping an adapter clears the cache entry once', async () => {
    const store = new Map();
    class FakeAdapter {
      async acquireToken() { return store.get('tok') || 'cached'; }
    }
    class GlmAdapter {
      async acquireToken() { return 'glm-cached'; }
    }
    let t = 0;
    const inv = new TokenCacheInvalidator({ now: () => t });
    const r = inv.wrapAdapter(FakeAdapter, 'deepseek');
    assert.strictEqual(r.wrapped, true);
    const fresh = new TokenCacheInvalidator({ now: () => t });
    const g = fresh.wrapAdapter(GlmAdapter, 'glm');
    assert.strictEqual(g.wrapped, true);
    inv.invalidate({ id: 'a1', providerId: 'deepseek', credentials: { token: 'abc' } });
    const adapter = new FakeAdapter();
    adapter.account = { id: 'a1', credentials: { token: 'abc' } };
    const token = await adapter.acquireToken();
    assert.strictEqual(token, 'cached');
    assert.strictEqual(inv.stats().refreshed.deepseek, 1);
    assert.strictEqual(inv.isInvalidated('a1', 'abc'), false);
  });

  section('--- request hooks (parking decisions) ---');

  await test('a captcha failure is parked briefly (degraded) but never marked error', async () => {
    const h = new AccountHealth({ now: () => now0 });
    const parked = [];
    const hooks = hooksMod.createHooks({
      health: h,
      tokens: new TokenCacheInvalidator({ now: () => now0 }),
      sweeper: { noteExternal: () => {} },
      AccountManager: { updateStatus: (id, status, msg) => parked.push([id, status, msg]) },
      validate: async () => ({ valid: false, error: 'captcha' }),
      now: () => now0,
      log: () => {},
    });
    const changes = [];
    const r = hooks.onFailure({ id: 'q1', providerId: 'qwen-ai' }, new Error('Qwen AI 风控拦截（需要验证码校验）'));
    assert.strictEqual(r.classification.class, 'captcha');
    assert.strictEqual(r.action, 'degraded');
    // Degraded, not condemned: no status write, no strike, short cooldown so the
    // next requests skip this account instead of waiting out the 19s wall again.
    assert.deepStrictEqual(parked, []);
    assert.strictEqual(h.isCoolingDown('q1'), true);
    const rec = h.coolingList()[0];
    assert.strictEqual(rec.strikes, 0);
    assert.ok(rec.until - now0 <= 120000, 'degraded cooldown stays short');
  });

  await test('an auth failure whose re-validation says valid keeps the account', async () => {
    const h = new AccountHealth({ now: () => now0 });
    const parked = [];
    const hooks = hooksMod.createHooks({
      health: h,
      tokens: new TokenCacheInvalidator({ now: () => now0 }),
      sweeper: { noteExternal: () => {} },
      AccountManager: { updateStatus: (id, status, msg) => parked.push([id, status, msg]) },
      validate: async () => ({ valid: true }),
      now: () => now0,
      log: () => {},
    });
    hooks.onFailure({ id: 'd1', providerId: 'deepseek' }, new Error(incident));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(parked, []);
    assert.strictEqual(h.isCoolingDown('d1'), false);
  });

  await test('an auth failure confirmed invalid parks the account and writes the reason', async () => {
    const h = new AccountHealth({ now: () => now0 });
    const parked = [];
    let invalidated = 0;
    const tokens = new TokenCacheInvalidator({ now: () => now0 });
    tokens.invalidate = () => { invalidated++; return true; };
    const hooks = hooksMod.createHooks({
      health: h,
      tokens,
      sweeper: { noteExternal: () => {} },
      AccountManager: { updateStatus: (id, status, msg) => parked.push([id, status, msg]) },
      validate: async () => ({ valid: false, error: 'Token expired or invalid' }),
      now: () => now0,
      log: () => {},
    });
    hooks.onFailure({ id: 'd2', providerId: 'deepseek', credentials: { token: 'abc' } }, new Error(incident));
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(parked.length, 1);
    assert.strictEqual(parked[0][0], 'd2');
    assert.strictEqual(parked[0][1], 'error');
    assert.ok(parked[0][2].length > 0);
    assert.strictEqual(h.isCoolingDown('d2'), true);
    assert.strictEqual(invalidated, 1);
  });

  await test('an inconclusive (network) re-validation changes nothing', async () => {
    const h = new AccountHealth({ now: () => now0 });
    const parked = [];
    const tokens = new TokenCacheInvalidator({ now: () => now0 });
    tokens.invalidate = () => { throw new Error('must not be called'); };
    const hooks = hooksMod.createHooks({
      health: h,
      tokens,
      sweeper: { noteExternal: () => {} },
      AccountManager: { updateStatus: (id, status, msg) => parked.push([id, status, msg]) },
      validate: async () => ({ valid: false, networkError: true, error: 'ECONNRESET' }),
      now: () => now0,
      log: () => {},
    });
    hooks.onFailure({ id: 'd3', providerId: 'deepseek' }, new Error(incident));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(parked, []);
    assert.strictEqual(h.isCoolingDown('d3'), false);
  });

  section('--- degraded cooldown + state-change log ---');

  await test('degraded cooldowns never escalate into an error strike', async () => {
    const h = new AccountHealth({ now: () => now0 });
    for (let i = 0; i < 4; i++) {
      h.startCooldown('q9', { providerId: 'qwen-ai', reason: 'captcha', durationMs: 120000, degrade: true });
    }
    const rec = h.coolingList()[0];
    assert.strictEqual(rec.strikes, 0);
    assert.strictEqual(h.summarize([{ id: 'q9', status: 'active' }]).cooling, 1);
  });

  await test('a captcha failure emits a state-change line and no status write', async () => {
    const h = new AccountHealth({ now: () => now0 });
    const lines = [];
    const parked = [];
    const hooks = hooksMod.createHooks({
      health: h,
      tokens: new TokenCacheInvalidator({ now: () => now0 }),
      sweeper: { noteExternal: () => {} },
      AccountManager: { updateStatus: (id, s2, m) => parked.push([id, s2, m]) },
      validate: async () => ({ valid: false, error: 'captcha' }),
      now: () => now0,
      log: () => {},
      stateChange: (f) => lines.push(f),
      options: { degradedCooldownMs: 90000 },
    });
    hooks.onFailure({ id: 'q2', providerId: 'qwen-ai' }, new Error('Qwen AI 风控拦截（需要验证码校验）'));
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].reason, 'captcha');
    assert.strictEqual(lines[0].cooldown_ms, 90000);
    assert.deepStrictEqual(parked, []);
  });

  await test('state-change lines are single-line, quoted and secret-free', () => {
    const lines = [];
    const sh = new SelfHeal({ config: { enabled: true }, stateLog: (l) => lines.push(l), log: () => {} });
    sh.stateChange({
      account: 'acc-1', provider: 'deepseek', old: 'active', new: 'error',
      reason: 'validate-invalid', source: 'runtime', class: 'Failed (invalid token)',
      cooldown_ms: 60000, validate_ms: 3812, strikes: 1,
      detail: 'Failed to acquire token: "abc" Failed (invalid token)',
      credentials: { token: 'super-secret' },
    });
    assert.strictEqual(lines.length, 1);
    const line = lines[0];
    assert.ok(line.startsWith('[selfheal] state-change '));
    assert.ok(line.indexOf('account=acc-1') !== -1);
    assert.ok(line.indexOf('reason=validate-invalid') !== -1);
    assert.ok(line.indexOf('cooldown_ms=60000') !== -1);
    assert.strictEqual(line.indexOf('\n'), -1);
    assert.strictEqual(line.indexOf('super-secret'), -1);
    assert.strictEqual((line.match(/"/g) || []).length, 2);
  });

  await test('state-change never throws on a hostile logger', () => {
    const sh = new SelfHeal({ config: { enabled: true }, stateLog: () => { throw new Error('boom'); }, log: () => {} });
    sh.stateChange({ account: 'a', old: 'active', new: 'error' });
  });

  await test('info() exposes the machine-readable read surface', () => {
    const sh = new SelfHeal({ config: { enabled: true, cooldownMs: 1234, autoStatus: true }, log: () => {}, stateLog: () => {} });
    sh.publish();
    const api = globalThis.__chat2apiSelfHeal;
    assert.strictEqual(typeof api.snapshot, 'function');
    assert.strictEqual(typeof api.info, 'function');
    assert.strictEqual(typeof api.checkNow, 'function');
    assert.strictEqual(typeof api.refreshAccounts, 'function');
    const info = api.info();
    assert.strictEqual(info.installed, true);
    assert.strictEqual(info.enabled, true);
    assert.strictEqual(info.badAccountCount, 0);
    assert.strictEqual(info.coolingAccounts, 0);
    assert.strictEqual(info.config.cooldownMs, 1234);
    assert.strictEqual(info.config.autoStatus, true);
    assert.strictEqual(info.lastSweepAt, null);
    assert.strictEqual(info.version, 1);
  });

  section('--- public read surface ---');

  await test('proxyStatus is synchronous, bounded and never throws', async () => {
    const SelfHeal = require(path.join(__dirname, '..', 'shim', 'selfheal', 'index')).SelfHeal;
    const bundle = makeFakeBundle({});
    const manager = new bundle.AccountManager([{ id: 'acc-1', providerId: 'deepseek', status: 'active', valid: true }]);
    const self = new SelfHeal({ now: () => 1000, log: () => {}, config: {} });
    self.install({ graph: bundle, validate: (id) => manager.validate(id) });

    const started = Date.now();
    const st = self.proxyStatus();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5, 'proxyStatus must be a plain synchronous read, took ' + elapsed + 'ms');
    assert.strictEqual(typeof st, 'object');
    assert.strictEqual(st.running, true, 'running must reflect getRunningStatus().isRunning');
    assert.strictEqual(st.port, 8082);
    assert.strictEqual(st.uptimeMs, 5000);
    assert.strictEqual(st.inflight, 1);
    assert.strictEqual(st.totalRequests, 7);

    // A throwing status source must yield null, never an exception: /health
    // turns an exception here into a 500.
    bundle.proxyStatusManager.getRunningStatus = () => { throw new Error('boom'); };
    assert.strictEqual(self.proxyStatus(), null, 'a throwing status source must degrade to null');
    // An absent source must also yield null (not 'down').
    self.upstream = { proxyStatusManager: null };
    assert.strictEqual(self.proxyStatus(), null);

    // It is part of info(), so the self-check can report it.
    self.upstream = bundle;
    bundle.proxyStatusManager.getRunningStatus = () => ({ isRunning: true, startTime: 1, uptime: 2 });
    assert.ok(self.info().proxyStatus, 'info() must carry proxyStatus');
  });

  await test('the published global exposes exactly the documented methods', async () => {
    const SelfHeal = require(path.join(__dirname, '..', 'shim', 'selfheal', 'index')).SelfHeal;
    const self = new SelfHeal({ now: () => 1, log: () => {}, config: {} });
    self.install({ graph: {}, validate: null });
    const g = globalThis.__chat2apiSelfHeal;
    assert.ok(g, 'the global must be published even when every seam is missing');
    for (const name of ['snapshot', 'info', 'checkNow', 'refreshAccounts', 'proxyStatus']) {
      assert.strictEqual(typeof g[name], 'function', 'missing public method: ' + name);
    }
    // Each synchronous one must be safe to call right now.
    assert.doesNotThrow(() => g.snapshot());
    assert.doesNotThrow(() => g.info());
    assert.strictEqual(g.proxyStatus(), null, 'no graph means no proxy status');
    self.stop();
  });

  section('--- boundary with the observability module ---');

  // feature-obs owns the request-log row (failureCategory / failureReason /
  // providerResponse). We own the ACCOUNT object's errorMessage. The two must
  // not bleed: a request-log row that suddenly carries account-state fields
  // would silently break their 'account-state fields = 0' assertion.
  await test('self-heal never writes classification fields onto a request-log row', async () => {
    const SelfHeal = require(path.join(__dirname, '..', 'shim', 'selfheal', 'index')).SelfHeal;
    const bundle = makeFakeBundle({ acquireFails: true });
    const manager = new bundle.AccountManager([{ id: 'acc-1', providerId: 'deepseek', status: 'active', valid: false }]);
    const rows = [];
    // A stand-in for feature-obs' wrapped log adder: it records whatever row
    // object the bundle passes in, before any of their annotation runs.
    const fakeLogger = {
      addRequestLog(row) { rows.push(JSON.parse(JSON.stringify(row))); return row; },
    };
    const self = new SelfHeal({
      now: () => 1000000,
      log: () => {},
      stateLog: () => {},
      config: { enabled: true, cooldownMs: 60000, cooldownMaxMs: 1800000, sweepIntervalMinutes: 30, recheckIntervalSec: 60, spacingMs: 0, recheckTimeoutMs: 5000 },
    });
    self.install({ graph: bundle, validate: (id) => manager.validate(id) });
    self.health.reset();

    const adapter = new bundle.DeepSeekAdapter({ token: 'dead' });
    adapter.account = manager.accounts[0];
    try { await adapter.acquireToken(); } catch (e) { /* expected */ }
    await new Promise((r) => setTimeout(r, 40));

    // The account object DID receive the reason (that is our job)...
    assert.ok(/invalid token|Token expired or invalid/i.test(String(manager.accounts[0].errorMessage)),
      'the account errorMessage must carry the real reason, got ' + String(manager.accounts[0].errorMessage));
    // ...but no request-log row was produced by us, and nothing we touch names
    // a classification field.
    assert.strictEqual(rows.length, 0, 'self-heal must not write request-log rows: ' + JSON.stringify(rows));
    const ACCOUNT_STATE_FIELDS = ['accountStatus', 'accountState', 'status', 'cooldown', 'strikes', 'degraded', 'errorMessage'];
    const leaks = ACCOUNT_STATE_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(fakeLogger, k));
    assert.deepStrictEqual(leaks, [], 'self-heal must not decorate the log sink: ' + JSON.stringify(leaks));
  });

  section('--- configuration ---');

  await test('defaults match the documented behaviour', () => {
    const c = resolveConfig({});
    assert.strictEqual(c.enabled, true);
    assert.strictEqual(c.cooldownMs, 60000);
    assert.strictEqual(c.recheckIntervalSec, 60000 / 1000);
    assert.strictEqual(c.sweepIntervalMinutes, 30);
  });

  await test('autoCheckAccountsIntervalMinutes drives the sweep interval', () => {
    assert.strictEqual(resolveConfig({ autoCheckAccountsIntervalMinutes: '10' }).sweepIntervalMinutes, 10);
  });

  await test('auto-status and degraded knobs are configurable', () => {
    const c = resolveConfig({});
    assert.strictEqual(c.autoStatus, true, 'AUTO_STATUS defaults to on');
    assert.strictEqual(c.degradedCooldownMs, 120000);
    assert.strictEqual(c.sweepMaxAccounts, 200);
    assert.strictEqual(resolveConfig({ CHAT2API_SELFHEAL_AUTO_STATUS: '0' }).autoStatus, false);
    assert.strictEqual(resolveConfig({ CHAT2API_SELFHEAL_AUTO_STATUS: 'off' }).autoStatus, false);
    assert.strictEqual(resolveConfig({ CHAT2API_SELFHEAL_DEGRADED_COOLDOWN_MS: '30000' }).degradedCooldownMs, 30000);
  });

  await test('CHAT2API_SELFHEAL=0 disables the layer', () => {
    assert.strictEqual(resolveConfig({ CHAT2API_SELFHEAL: '0' }).enabled, false);
    assert.strictEqual(resolveConfig({ CHAT2API_SELFHEAL: 'off' }).enabled, false);
    assert.strictEqual(resolveConfig({ CHAT2API_SELFHEAL: '1' }).enabled, true);
  });

  console.log('');
  if (failures.length) {
    console.log('FAILED ' + failures.length + ' of ' + (passed + failures.length) + ' checks');
    for (const f of failures) {
      console.log('\n--- ' + f[0] + ' ---');
      console.log(f[1] && f[1].stack ? f[1].stack : String(f[1]));
    }
    process.exitCode = 1;
    return;
  }
  console.log('PASSED ' + passed + ' checks');
}

main().catch((e) => {
  console.error('harness crashed:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
