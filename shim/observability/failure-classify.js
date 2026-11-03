/**
 * Failure classification for observability.
 *
 * WHY THIS FILE HAS NO DEPENDENCIES
 * --------------------------------
 * This is the one place in the container that decides which bucket a failed
 * request falls into, and the statistics (/v0/management/statistics) and the
 * request log both read its answer. It must stay pure - no I/O, no clock, no
 * require() of the bundle - so that:
 *
 *   * tests drive it directly (tests/observability.test.js),
 *   * the account self-heal layer (shim/selfheal/) can consume it without
 *     creating a cycle, and
 *   * a broken upstream export can never take it down.
 *
 * THE VOCABULARY (what an operator sees)
 * --------------------------------------
 *   auth          the credential is dead or was rejected (401/403, 'invalid
 *                 token', 'please get a new Token', 'session has expired')
 *   captcha       the provider wants a human (风控 / 验证码 / risk control)
 *   rate-limit    quota, throttling, 429, 'too many requests'
 *   network       dns / tcp / tls / timeout - no HTTP status ever arrived
 *   provider-5xx  the provider answered 5xx (or its gateway did)
 *   client-error  the provider rejected THIS request (400/404/422 ...): the
 *                 request shape or model is wrong, retrying cannot help
 *   unknown       nothing above matched
 *
 * This is the vocabulary the task asks for ('auth / captcha / network /
 * rate-limit / provider-5xx / unknown'), with one addition: 'client-error'.
 * Folding a 400 ("model not supported") into 'unknown' would hide the most
 * actionable failure there is, so it gets its own bucket instead.
 *
 * RELATION TO shim/selfheal/auth-errors.js
 * ----------------------------------------
 * That module answers a different question: "may I park this account?" It
 * maps 403 to auth on purpose (the providers use 403 for 'token rejected'), it
 * never calls anything a client error, and it folds 5xx into 'server'. It is
 * also owned by the self-heal layer. We therefore keep a separate, pure table
 * here and never decide account state - see catalog.js, which reads the
 * self-heal verdict as a tie-breaker instead of re-implementing it.
 */

'use strict'

/** Canonical class names, in the order they are tried. */
const CATEGORIES = ['auth', 'captcha', 'rate-limit', 'network', 'provider-5xx', 'client-error', 'unknown']

/** Longest text this module keeps from any provider value. */
const MAX_TEXT = 400

/** Statuses that mean 'the credential was rejected'. */
const AUTH_STATUSES = new Set([401, 403])

/** Markers that mean 'a human has to act' - never classified as auth. */
const CAPTCHA_MARKERS = [
  'captcha',
  '验证码',
  '人机验证',
  '风控',
  'risk control',
  'risk-control',
  'verify you are human',
  'challenge required',
  'challenge_required',
]

/** Token / session wording. Lowercased substring match. */
const AUTH_MARKERS = [
  'unauthorized',
  // A bare 'Forbidden' with no other wording is ambiguous, but the row this
  // came from ('Forbidden: model not allowed for this key') is a dead/limited
  // credential, not a malformed request - and per selfheal the account is the
  // thing that has to be re-checked. Long, explicit phrasings still win because
  // captcha and rate-limit markers are tested first.
  'forbidden:',
  'unauthenticated',
  'authentication failed',
  'authentication required',
  'authorization failed',
  'not authorized',
  'invalid credentials',
  'credentials expired',
  'invalid token',
  'token invalid',
  'token is invalid',
  'invalid_token',
  'invalidtoken',
  'token expired',
  'expired token',
  'token has expired',
  'token revoked',
  'revoked token',
  'failed to acquire token',
  'get a new token',
  'refresh token invalid',
  'invalid refresh token',
  'invalid_grant',
  'session has expired',
  'session expired',
  'session invalid',
  'no longer valid',
  'please sign in',
  'sign in again',
  'login required',
  'login expired',
  'please login',
  'please log in',
  're-login',
  'relogin',
  'auth.token.invalid',
  'invalid api key',
  'api key is invalid',
  'key is invalid',
  'invalid access token',
  'access token expired',
  '缺少 token',
  '登录已过期',
  '登录过期',
  '凭证已失效',
  'token 无效',
  'token失效',
  'token 已过期',
  '未授权',
]

/** Rate limiting / quota wording. */
const RATE_MARKERS = [
  'rate limit',
  'rate-limit',
  'ratelimit',
  'too many requests',
  'quota',
  'insufficient balance',
  'throttl',
  '限流',
  '次数已用完',
  '额度不足',
  '频率限制',
]

/** Network wording: no usable HTTP response ever arrived. */
const NETWORK_MARKERS = [
  'econnrefused',
  'econnreset',
  'etimedout',
  'eai_again',
  'enotfound',
  'econnaborted',
  'epipe',
  'ehostunreach',
  'enetunreach',
  'socket hang up',
  'network error',
  'networkerror',
  'getaddrinfo',
  'timed out',
  'timeout of',
  'timeout after',
  'timeout exceeded',
  'request aborted',
  'aborted',
  'socket closed',
  'tls',
  'ssl',
  'certificate',
  'connect etimedout',
  'read econnreset',
  'connection refused',
  'connection reset',
]

/** Wording that means the provider was broken, not the request. */
const SERVER_MARKERS = [
  'internal server error',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'server error',
  'overloaded',
  '服务异常',
  '服务不可用',
  'internal error',
]

/** Statuses upstream itself produces; they are not the provider's fault. */
const LOCAL_GATEWAY_STATUSES = new Set([503, 504, 502])

/** Something that looks like an HTTP status embedded in free text. */
const STATUS_IN_TEXT = /(?:http(?:\s*error)?|status(?:\s*code)?)\s*[:=]?\s*(\d{3})/i

/**
 * The other way providers word it: axios builds 'Request failed with status
 * code 403' from the status alone - the number IS the whole evidence, exactly
 * like the bare 'HTTP 500' upstream produces. Without this the qwen 403 row
 * classified as 'unknown', which reads like "we have no idea" when in fact the
 * provider told us plainly. Anchored, so a 403 mentioned inside a longer
 * sentence still has to earn its category from the markers instead.
 */
const AXIOS_STATUS_IN_TEXT = /^(?:\w+\s+){0,6}?(?:status|code)\s*(?:code\s*)?[:=]?\s*(\d{3})(?:\s*\([^)]*\))?$/i

/** 'HTTP 500', the exact bare stem upstream produces when it drops the body. */
const BARE_STEM = /^(?:http(?:\s*error)?\s*)?(\d{3})$/i

/** Lowercase, collapse whitespace, bound the length. Never throws. */
function text(value, maxLen) {
  if (value === null || value === undefined) return ''
  let out
  if (typeof value === 'string') {
    out = value
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    out = String(value)
  } else {
    try {
      out = JSON.stringify(value)
    } catch {
      out = String(value)
    }
  }
  out = String(out === undefined ? '' : out).replace(/\s+/g, ' ').trim()
  const limit = maxLen || MAX_TEXT
  return out.length > limit ? out.slice(0, Math.max(1, limit - 1)) + '…' : out
}

/** First marker found in an already-lowercased string, or null. */
function includesAny(haystack, needles) {
  for (const needle of needles) {
    if (haystack.indexOf(needle) !== -1) return needle
  }
  return null
}

/**
 * The HTTP status an error or a status field carries, or null.
 * Deliberately strict: a number outside 100..599 is not a status.
 */
function statusOf(value) {
  if (value === null || value === undefined) return null
  const direct = typeof value === 'number'
    ? value
    : value && typeof value === 'object'
      ? (value.status || value.statusCode || value.httpStatus
        || (value.response && (value.response.status || value.response.statusCode)))
      : null
  const n = Number(direct)
  if (Number.isInteger(n) && n >= 100 && n < 600) return n
  return null
}

/** Pull a status out of free text ('HTTP 500', 'upstream said 429'). */
function statusInText(message) {
  const raw = String(message || '').trim()
  const m = raw.match(STATUS_IN_TEXT)
  if (m) {
    const n = Number(m[1])
    if (Number.isInteger(n) && n >= 100 && n < 600) return n
  }
  const tail = raw.match(AXIOS_STATUS_IN_TEXT)
  if (tail) {
    const n = Number(tail[1])
    if (Number.isInteger(n) && n >= 100 && n < 600) return n
  }
  return null
}

/** The markers that count as an explanation of a failure. */
const EXPLANATORY = [].concat(CAPTCHA_MARKERS, AUTH_MARKERS, RATE_MARKERS, NETWORK_MARKERS, SERVER_MARKERS)

/**
 * Does the message say anything about WHY the request failed?
 * 'HTTP 500' and '' do not; 'invalid token' and 'rate limited' do.
 */
function explainsFailure(message) {
  if (!message) return false
  return includesAny(message.toLowerCase(), EXPLANATORY) !== null
}

/** 'HTTP 500' -> 500, anything else -> null. */
function bareStatusOf(message) {
  const bare = String(message || '').trim().match(BARE_STEM)
  if (!bare) return null
  const n = Number(bare[1])
  return Number.isInteger(n) && n >= 100 && n < 600 ? n : null
}

/** Decode an axios/Node error into the facts the table needs. */
function factsOf(error) {
  if (!error) return { message: '', status: null, error }
  if (typeof error === 'string') return { message: error, status: statusInText(error), error }
  if (error instanceof Error || typeof error === 'object') {
    let own = ''
    try {
      own = typeof error.message === 'string' ? error.message : ''
    } catch {
      own = ''
    }
    const message = own || text(error, MAX_TEXT)
    return { message, status: statusOf(error) || statusInText(message), error }
  }
  return { message: text(error), status: null, error }
}

/**
 * Classify one failure.
 *
 * @param {object|string|Error} input  such as
 *        \{message, status, error\} or just an Error / message string
 * @returns {\{category: string, matched: string|null, status: number|null,
 *            reason: string, retryable: boolean\}}
 */
function classify(input) {
  const src = input && typeof input === 'object' && !(input instanceof Error) && 'message' in input
    ? input
    : { error: input }
  let rawMessage = ''
  try {
    rawMessage = src.message !== undefined && src.message !== null ? text(src.message) : ''
  } catch {
    rawMessage = ''
  }
  if (!rawMessage && src.error !== undefined) {
    try {
      rawMessage = factsOf(src.error).message
    } catch {
      rawMessage = ''
    }
  }
  const message = rawMessage
  let status = statusOf(src.status) || statusInText(message)
  if (!status) {
    // Only read the error object when the row itself said nothing: a getter
    // that throws must not be able to break classification.
    try {
      status = factsOf(src.error).status
    } catch {
      status = null
    }
  }
  const lower = message.toLowerCase()
  const result = (category, matched, retryable) => ({
    category,
    matched: matched || null,
    status: status || null,
    reason: message,
    retryable: retryable !== false,
  })

  // A human-verification demand is never an auth problem: cooling the account
  // down would not help and would hide the real cause from the operator.
  const captcha = includesAny(lower, CAPTCHA_MARKERS)
  if (captcha) return result('captcha', captcha, true)

  const auth = includesAny(lower, AUTH_MARKERS)
  if (auth) return result('auth', auth, true)

  // The status the ROW records is the proxy's own answer to the client (a 500
  // whenever the proxy gives up), so it cannot speak for the provider. The
  // status NAMED by the message can: 'Request failed with status code 403' is
  // the provider saying 'no'. That is what gets read here; a bare row status
  // keeps meaning 'we could not tell' further down.
  const namedStatus = statusInText(message)
  const authStatus = AUTH_STATUSES.has(status) ? status : (AUTH_STATUSES.has(namedStatus) ? namedStatus : null)
  if (authStatus) return result('auth', 'http ' + authStatus, true)

  const rate = includesAny(lower, RATE_MARKERS)
  if (rate) return result('rate-limit', rate, true)
  if (status === 429) return result('rate-limit', 'http 429', true)

  // WHO GETS TO DECIDE.
  // Only a message that IS the status ('HTTP 500') or wording we recognise
  // counts as evidence. A status code sitting on the row with no explanation
  // beside it ('mystery failure') is reported as unknown on purpose: inventing
  // a cause there would hide exactly the incident this work started from, and
  // it would rob the self-heal layer (which knows provider-specific shapes) of
  // its chance to explain the row.
  const bareStatus = bareStatusOf(message)
  const explained = explainsFailure(message)
  const effective = bareStatus || (explained ? status : null)

  if (effective && effective >= 500) {
    if (LOCAL_GATEWAY_STATUSES.has(effective)) {
      // 502/503/504 say the gateway in front gave up. With 'service
      // unavailable' / 'gateway timeout' wording the provider told us so; with
      // no wording at all ('HTTP 502') upstream dropped the body and we refuse
      // to blame anyone - that is the 'unknown' bucket, and it is exactly the
      // row that motivated this work.
      if (!explained) return result('unknown', 'local ' + effective, true)
      return result('provider-5xx', 'http ' + effective, true)
    }
    return result('provider-5xx', 'http ' + effective, true)
  }

  const server = includesAny(lower, SERVER_MARKERS)
  if (server) return result('provider-5xx', server, true)

  const network = includesAny(lower, NETWORK_MARKERS)
  if (network) return result('network', network, true)

  // A 4xx on the row is the provider rejecting THIS request. With no message
  // to read we still say 'client-error' rather than 'unknown': the status is
  // unambiguous and retrying cannot help, which is the whole point of the
  // bucket.
  const clientStatus = effective || (explained ? null : (status && status >= 400 && status < 500 ? status : null))
  if (clientStatus && clientStatus >= 400 && clientStatus < 500) {
    return result('client-error', 'http ' + clientStatus, false)
  }

  return result('unknown', null, true)
}

/** Is a category caused by the credential (i.e. self-heal's business)? */
function isAuth(category) {
  return category === 'auth'
}

module.exports = {
  CATEGORIES,
  MAX_TEXT,
  AUTH_STATUSES,
  AUTH_MARKERS,
  CAPTCHA_MARKERS,
  RATE_MARKERS,
  NETWORK_MARKERS,
  SERVER_MARKERS,
  classify,
  isAuth,
  statusOf,
  statusInText,
  text,
}
