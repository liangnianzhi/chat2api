/**
 * Entry point for the account self-heal layer.
 *
 * The gateway requires this module after the upstream bundle is loaded and
 * calls install() with the bundle's export graph. Nothing here touches the
 * network at import time: the container must boot even when the layer is
 * disabled, misconfigured, or upstream moved an internal.
 */

'use strict'

const { SelfHeal, resolveConfig, GLOBAL_KEY } = require('./selfheal/index')

let instance = null;

/**
 * Install the layer once per process.
 *
 * @param {object} deps
 * @param {any} deps.graph the upstream bundle's module.exports
 * @param {(accountId: string) => Promise<object>} [deps.validate] validator override
 * @param {object} [deps.config] resolveConfig() overrides
 * @param {(msg: string) => void} [deps.log]
 * @returns {object|null} the supervisor (null when already installed or unavailable)
 */
function install(deps) {
  if (instance) return instance;
  const d = deps || {};
  const log = typeof d.log === 'function' ? d.log : (msg) => console.log(msg);
  const config = Object.assign(resolveConfig(), d.config || {});
  const selfheal = new SelfHeal({ config, log });
  instance = selfheal;
  try {
    selfheal.install({ graph: d.graph, validate: d.validate });
  } catch (e) {
    log('[selfheal] install failed (continuing without account self-heal): ' + (e && e.message));
  } finally {
    // Publish on EVERY path, not just the catch: the /health handler in
    // shim/health.js reads this global without importing us, so a successful
    // install that forgot to publish leaves the whole self-check blind
    // ('proxy status is not readable from this build'). publish() is
    // synchronous and never throws, so it is safe in a finally block.
    selfheal.publish();
  }
  return selfheal;
}

/** Start the periodic sweep. Safe to call before or after install(). */
function start() {
  if (!instance) return false;
  try {
    return instance.start();
  } catch (e) {
    console.log('[selfheal] start failed: ' + (e && e.message));
    return false;
  }
}

/** Stop timers (tests and graceful shutdown). */
function stop() {
  if (instance) instance.stop();
}

/**
 * Forget the installed supervisor (tests only).
 *
 * The module is a deliberate process-wide singleton, which means a test that
 * wants to observe what install() itself does has to start from a clean slate.
 * Exported with a __ prefix so it is obviously not part of the public surface.
 */
function __resetForTests() {
  if (instance) {
    try { instance.stop(); } catch (e) { /* timers only */ }
  }
  instance = null;
  try { delete globalThis[GLOBAL_KEY]; } catch (e) { /* frozen global */ }
}

/** Current supervisor, or null before install(). */
function get() {
  return instance;
}

module.exports = { install, start, stop, get, resolveConfig, GLOBAL_KEY, SelfHeal, __resetForTests }
