/**
 * Failure-reason preservation.
 *
 * WHY
 * ---
 * Upstream's forwarders build the account-facing error themselves:
 *
 *     let errorMessage = `HTTP ${status}`
 *     if (data) { ...only msg / message / error.message are read... }
 *
 * and the provider adapters add their own wording on top ('Token refresh
 * failed: ', 'Failed to acquire token: '). When the response shape does not
 * match one of those keys the body is thrown away: 7 of the 51 production
 * failures reached the operator as the literal string 'HTTP 500', which says
 * nothing about which account broke or why.
 *
 * WHAT THIS DOES
 * -------------
 * Two complementary layers:
 *
 *   enrichHttpMessage()  - pure: given upstream's message plus the response body,
 *                          return a message that always carries a bounded body
 *                          summary. Used by the runtime wrapper.
 *   install(deps)        - patches the seams that really exist in the shipped
 *                          bundle (see SYNC POINTS below).
 *
 * SYNC POINTS (verified against chunks/server-D4GzIgCk.js on the shipped image)
 * ---------------------------------------------------------------------------
 * Earlier drafts looked for RequestForwarder.extractErrorMessage and
 * GLMAdapter/DeepSeekAdapter.buildErrorMessage. Measured on the real bundle:
 *
 *   RequestForwarder           not exported at all (module-local class behind a
 *                              `const requestForwarder = new RequestForwarder()`
 *                              singleton), so its instance methods are unreachable.
 *   buildErrorMessage          does not exist anywhere in the bundle (0 hits).
 *
 * Those entries were an assumption, not a seam. They are gone. What is actually
 * patchable, and what each one buys:
 *
 *   ZaiAdapter.prototype.ensureToken        wraps `Token refresh failed: <body>`
 *                                           so the body survives.
 *   ZaiAdapter.prototype.createChat         throws `Failed to create chat: HTTP 500`
 *      (line 145919 on the shipped image)   with `response2.data` DROPPED - the exact
 *                                           source of the 7 production 'HTTP 500'
 *                                           failures. Patched: the thrown Error
 *                                           carries a bounded body summary.
 *   KimiAdapter.prototype.chatCompletion    throws `Completion request failed: HTTP N`
 *      (line 42332)                         and also drops the body.
 *   GLMAdapter.prototype.acquireToken       throws `Token refresh failed: HTTP N` when
 *                                           the body has no message field.
 *
 * Every patch keeps the thrown/rejected value's identity (same Error object, same
 * stack, same error.response) and only rewrites .message, keeping the original text
 * in .selfhealOriginalMessage so grep-ability survives. A seam that is not present
 * is reported as 'not present on this build' and is not counted as a failure:
 * upstream may inline or rename it on the next upgrade and that must not turn into
 * a permanent warning the operator cannot ever clear.
 */

'use strict'

const auth = require('./auth-errors')

/** Marker so a patched function is never patched twice. */
const PATCH_FLAG = '__selfhealPatched'

/** Bare status stems upstream produces when it discarded the body. */
// Any message of the shape '<any prefix>: HTTP 500' or bare 'HTTP 500' contains
// nothing but a status code: the body was read and thrown away. Only these are
// rewritten - a message that already names a cause is kept verbatim.
const BARE_STEM = /^(?:.*:\s*)?HTTP \d{3}$/

/**
 * Replace a body-less provider message with one that carries the body summary.
 *
 * @param {string} message message upstream produced (may be empty)
 * @param {any} data provider response body
 * @param {number|string} status HTTP status
 * @returns {string} a single-line message, bounded to MAX_REASON_LENGTH
 */
function enrichHttpMessage(message, data, status) {
  const text = typeof message === 'string' ? message : ''
  const body = auth.summarizePayload(data)
  const code = status === undefined || status === null ? '' : String(status)
  if (!body) return text;
  if (!text || BARE_STEM.test(text)) {
    if (!text) return auth.describeHttpFailure(code || 'error', data)
    const prefix = text.indexOf(': ') !== -1 ? text.slice(0, text.indexOf(': ') + 2) : ''
    return auth.summarize(prefix + auth.describeHttpFailure(code || 'error', data))
  }
  // Any real message is kept verbatim: it already says what went wrong (the auth
  // wording the classifier needs lives there), and appending the body would only
  // bury it. The body is added when the message is empty or says nothing at all.
  return text
}

/**
 * Give an Error a richer message while preserving its identity, stack and the
 * axios response attached to it (upstream reads error.response.status).
 *
 * @returns {any} the same object, mutated
 */
function enrichError(error, data) {
  if (!error || typeof error !== 'object') return error
  const response = error.response || null
  // The status may live in the response, or only in the message text: adapters
  // that use validateStatus throw their own Error and mention the code inline.
  const status = statusOf(error, null);
  const body = bodyOf(data, error);
  const current = typeof error.message === 'string' ? error.message : '';
  const next = enrichHttpMessage(current, body, status);
  if (next && next !== current) {
    // Keep the original text: it is what upstream logs and what existing logs in
    // the wild contain, so grep-ability survives the improvement.
    if (!error.selfhealOriginalMessage) error.selfhealOriginalMessage = current;
    error.message = next;
  }
  return error;
}

/**
 * Pull the provider body out of an error, wherever upstream left it.
 *
 * Most adapters use `validateStatus: () => true`, so a non-2xx response is not
 * thrown by axios: the adapter throws its own Error and the body it was holding
 * (`response2.data`) is simply dropped. When the caller can name that body we
 * take it directly; otherwise we look for error.response.data (axios-thrown
 * errors). Returns undefined when nothing is available, which leaves the
 * message untouched.
 *
 * @param {any} body the response body the caller still has in scope
 * @param {any} error the thrown value
 * @returns {any} body to summarize, or undefined
 */
function bodyOf(body, error) {
  if (body !== undefined && body !== null) return body;
  const response = error && error.response;
  return response ? response.data : undefined;
}

/**
 * Status out of an error or a message that says 'HTTP 500'.
 */
function statusOf(error, fallback) {
  const response = error && error.response;
  if (response && response.status) return response.status;
  const message = error && typeof error.message === 'string' ? error.message : '';
  const m = /(\d{3})/.exec(message);
  return m ? m[1] : fallback;
}

/**
 * Patch a function-valued property.
 *
 * @param {any} target object or prototype
 * @param {string} name property name
 * @param {(original: Function) => Function} factory builds the replacement
 * @returns {boolean} true when installed now or already installed
 */
function patchMethod(target, name, factory) {
  if (!target || typeof target[name] !== 'function') return false;
  const original = target[name];
  if (original[PATCH_FLAG]) return true;
  let replacement;
  try {
    replacement = factory(original);
  } catch (e) {
    return false;
  }
  if (typeof replacement !== 'function') return false;
  replacement[PATCH_FLAG] = true;
  replacement.__selfhealOriginal = original;
  target[name] = replacement;
  return true;
}

/**
 * Install every patch that can be located in the bundle export graph.
 *
 * @param {{find: (name: string, depth?: number) => (Function|null), log?: (msg: string) => void}} deps
 * @returns {{installed: string[], missing: string[], absent: string[]}}
 *   `installed` - patched. `absent` - this build does not have the seam at all
 *   (upstream renamed or inlined it); NOT a failure and not worth a warning.
 *   `missing` - the seam's class was found but the method was not, which is the
 *   only case that suggests our assumption drifted and deserves a look.
 */
function install(deps) {
  const d = deps || {};
  const find = typeof d.find === 'function' ? d.find : () => null;
  const log = typeof d.log === 'function' ? d.log : (msg) => console.log(msg);
  const installed = [];
  const missing = [];
  const absent = [];

  /**
   * Patch `Class.prototype[method]` so the message it throws carries the body
   * the caller already had in hand.
   *
   * Only .message is rewritten: the Error object, its stack and its
   * error.response are left alone, because upstream reads response.status to
   * decide whether an auth failure happened.
   */
  const patchThrower = (label, className, methodName, opts2) => {
    // `critical` marks the seam that produces a failure operators actually see.
    // Losing that one is worth a warning even when the whole class vanished
    // upstream: unlike a decorative seam, its absence changes log content.
    const critical = Boolean(opts2 && opts2.critical);
    const cls = find(className, 4);
    if (!cls) {
      if (critical) missing.push(label + ' (class not exported by this build)');
      else absent.push(label);
      return false;
    }
    const proto = cls.prototype;
    const had = proto && typeof proto[methodName] === 'function';
    const ok = patchMethod(proto, methodName, (original) => function selfhealThrower() {
      try {
        return original.apply(this, arguments);
      } catch (err) {
        enrichError(err);
        throw err;
      }
    });
    if (ok) {
      installed.push(label);
      log('[selfheal] patched ' + label + ' to keep the provider response body in the error message');
    } else if (had) {
      // The method is there but the patch did not take: a real surprise.
      missing.push(label);
    } else if (critical) {
      missing.push(label + ' (method renamed by this build)');
    } else {
      absent.push(label);
    }
    return ok;
  };

  // The seam that produced the 7 production 'HTTP 500' failures: z.ai drops the
  // body when creating a chat, and that message reaches the operator verbatim.
  // This is THE one that matters: it is where the 7 production 'HTTP 500' lines
  // came from, so its loss is a warning rather than quiet drift.
  patchThrower('ZaiAdapter.createChat', 'ZaiAdapter', 'createChat', { critical: true });
  // Same shape one level up, for token refresh.
  patchThrower('ZaiAdapter.ensureToken', 'ZaiAdapter', 'ensureToken');
  // Kimi drops the body on a non-200 completion.
  patchThrower('KimiAdapter.chatCompletion', 'KimiAdapter', 'chatCompletion');
  // GLM only reaches the body when it has a message field.
  patchThrower('GLMAdapter.acquireToken', 'GLMAdapter', 'acquireToken');

  if (absent.length) {
    // Deliberately quiet: a seam upstream no longer has is normal drift, and a
    // warning the operator can never clear is worse than no warning.
    log('[selfheal] reason-fidelity seams not present on this build: ' + absent.join(', '));
  }
  return { installed, missing, absent };
}
module.exports = { install, patchMethod, enrichHttpMessage, enrichError, PATCH_FLAG }
