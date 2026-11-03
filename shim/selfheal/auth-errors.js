/**
 * Failure classification for upstream's provider errors.
 *
 * WHY THIS EXISTS
 * ---------------
 * Upstream decides whether an account is dead in `RequestForwarder.handleForwardError()`,
 * using its own `isAuthError()` keyword table (shipped bundle, not importable from
 * here). That table matches "token is invalid", "token invalid", "token expired",
 * ... but NOT the wording the DeepSeek adapter actually produces for a revoked
 * token:
 *
 *   Failed to acquire token: "..." Failed (invalid token)
 *
 * so a dead account stayed `active`, the load balancer kept handing it requests,
 * and every request waited out the provider timeout before failing with a 500.
 * Measured on the live deployment: 39 of 51 failed requests were this one account.
 *
 * This module is the container's own table. It is a superset of upstream's, so
 * the shim classifies at least as many failures as upstream does.
 *
 * IMPORTANT: this file must stay dependency-free and pure (no I/O, no clock) -
 * it is the part tests drive directly.
 */

'use strict'

/** Longest slice of a provider message kept in logs / account.errorMessage. */
const MAX_REASON_LENGTH = 200

/**
 * Auth-failure keywords, lowercased substring match - mirroring upstream's
 * style so the two tables are easy to compare.
 *
 * Grouped by what the provider says:
 *   - generic HTTP auth: unauthorized / forbidden / 401 / 403
 *   - token wording: invalid token, token invalid, invalid_token, token expired
 *   - session wording: session expired, login required, please sign in
 *   - refresh wording: refresh token invalid, re-login
 */
const AUTH_KEYWORDS = [
  // generic
  'unauthorized',
  'unauthenticated',
  'authentication failed',
  'authentication required',
  'authorization failed',
  'authorization required',
  // 'authorization:' also catches headers echoed back in a message
  'authorization:',
  'auth failed',
  'not authorized',
  'forbidden',
  'invalid credentials',
  'credentials expired',
  'invalid api key',
  'invalid apikey',
  'api key invalid',
  'api key is invalid',
  'key is invalid',

  // token wording - NOTE "invalid token" (this order) is the one upstream misses
  'invalid token',
  'token invalid',
  'token is invalid',
  'token is invalid',
  'invalid_token',
  'invalidtoken',
  'token expired',
  'token has expired',
  'expired token',
  'token has been expired',
  'token revoked',
  'revoked token',
  'token is revoked',
  'token was revoked',
  'token not found',
  'token is required',
  'token not configured',
  'please get a new token',
  'get a new token',
  'invalid access token',
  'access token expired',
  'access_token invalid',

  // refresh / oauth wording
  'refresh token invalid',
  'refresh token expired',
  'refresh_token invalid',
  'invalid refresh token',
  'oauth failed',
  'invalid_grant',

  // session / login wording (upstream has these too)
  'session has expired',
  'session expired',
  'session is invalid',
  'session invalid',
  'no longer valid',
  'sign in',
  'sign-in',
  'login required',
  'login expired',
  'please login',
  'please log in',
  're-login',
  'relogin',
  'auth.token.invalid',
  'auth token invalid',

  // provider-specific ready-made messages from the shipped bundle
  'token expired or invalid',
  'session token appears to be invalid',
  '缺少 token',
  '登录已过期',
  '登录过期',
  '凭证已失效',
  'token 无效',
  'token失效',
  'token 已过期',
  '未授权',
]

/**
 * Statuses that mean "these credentials will never work again".
 * 402 is deliberately absent: it is a billing/quota problem, not an auth one,
 * and re-running the validator cannot fix it. Upstream treats 403 as auth; we
 * follow, because these providers use 403 for "token rejected by WAF policy".
 */
const AUTH_STATUSES = new Set([401, 403])

/**
 * Failure classes. Kept as plain strings so they survive JSON round-trips into
 * logs and the /health payload.
 *   auth     - credentials dead; validate + cool down
 *   captcha  - provider wants a human; do NOT cool down (it is not a token bug)
 *   rate     - quota / rate limit; transient, back off but keep the account
 *   server   - provider 5xx / gateway error; transient
 *   network  - dns / tcp / timeout; transient
 *   unknown  - anything else
 */
const CLASSES = ['auth', 'captcha', 'rate', 'server', 'network', 'unknown']

/** Markers that mean "a human has to act" - never treated as auth. */
const CAPTCHA_MARKERS = [
  'captcha',
  '验证码',
  '风控',
  'risk control',
  'verify you are human',
  'challenge required',
]

/** Network-level failure wording. */
const NETWORK_MARKERS = [
  'econnrefused',
  'econnreset',
  'etimedout',
  'enotfound',
  'eai_again',
  'socket hang up',
  'network error',
  'timeout of',
  'timed out',
  'getaddrinfo',
  'connect etimedout',
  'read econnreset',
]

/**
 * Something that looks like an HTTP status embedded in free text.
 * "HTTP 500", "HTTP error 401", "status 403", "statusCode: 429".
 */
const STATUS_IN_TEXT = /(?:http(?:\s*error)?|status(?:\s*code)?)\s*[:=]?\s*(\d{3})/i

/** Truncate any value into a single-line, bounded log string. */
function summarize(value, maxLen) {
  const limit = maxLen || MAX_REASON_LENGTH
  if (value === null || value === undefined) return ''
  let text
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  text = String(text).replace(/\s+/g, ' ').trim()
  // Bounded output: the ellipsis lives inside the limit, so callers may rely on
  // summarize(x).length <= MAX_REASON_LENGTH.
  return text.length > limit ? text.slice(0, Math.max(1, limit - 1)) + '…' : text
}

/**
 * Pull a response-body summary out of a provider payload, in the same order
 * upstream's own error extractors use, so the text matches what operators see
 * in the UI. Falls back to the raw JSON so nothing is lost silently.
 */
function summarizePayload(data, maxLen) {
  if (data === null || data === undefined) return ''
  if (typeof data === 'string') return summarize(data, maxLen)
  if (typeof data !== 'object') return summarize(String(data), maxLen)
  const candidates = [
    data.error && data.error.message,
    data.error && data.error.code,
    data.message,
    data.msg,
    data.error_message,
    data.errorMsg,
    data.detail,
    data.data && data.data.biz_msg,
    data.data && data.data.details,
    data.data && data.data.code,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      const extra = summarize(data, maxLen)
      // A real headline is enough; the raw payload is only appended when the
      // headline says nothing ("error", "failed", a bare code), because that is
      // exactly when the operator needs the rest of the body.
      const weak = c.trim().length < 24
      return weak && extra && !extra.includes(c) ? summarize(c + ' | ' + extra, maxLen) : summarize(c, maxLen)
    }
  }
  return summarize(data, maxLen)
}

/**
 * Build the account-facing message for an HTTP failure.
 *
 * Upstream's forwarders throw away the body whenever the provider does not use
 * one of the keys it knows about, so a z.ai 500 that says
 * {"code":500,"msg":"internal error"} reached the operator as the literal
 * string "HTTP 500" - 7 of the 51 production failures had no usable cause.
 */
function describeHttpFailure(status, data, context) {
  const body = summarizePayload(data)
  const head = context ? context + ': ' : ''
  if (body) return summarize(head + 'HTTP ' + status + ' - ' + body)
  return summarize(head + 'HTTP ' + status)
}

/**
 * Extract an HTTP status from an error object regardless of its shape:
 * a real Error with an axios response, a plain {status} object, or a message
 * with the number embedded.
 */
function statusOf(error) {
  if (!error || typeof error !== 'object') return null
  const direct = [
    error.status,
    error.statusCode,
    error.httpStatus,
    error.response && error.response.status,
    error.response && error.response.statusCode,
    error.cause && error.cause.status,
  ]
  for (const s of direct) {
    const n = Number(s)
    if (Number.isInteger(n) && n >= 100 && n < 600) return n
  }
  const message = typeof error.message === 'string' ? error.message : ''
  const m = message.match(STATUS_IN_TEXT)
  if (m) return Number(m[1])
  return null
}

/**
 * The message carried by a thrown value. Non-Error throws are summarised
 * rather than dropped (the bundle throws plain objects in a few places).
 */
function messageOf(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message) return error.message
  return summarize(error)
}

function includesAny(haystack, needles) {
  for (const n of needles) {
    if (haystack.indexOf(n) !== -1) return n
  }
  return null
}

/**
 * Upstream-compatible auth test (superset of the bundle's `isAuthError`).
 *
 * @param {string} message free text (may be empty)
 * @param {number|null} status HTTP status when known
 * @returns {boolean}
 */
function isAuthError(message, status) {
  const httpStatus = Number(status)
  if (Number.isInteger(httpStatus) && AUTH_STATUSES.has(httpStatus)) return true
  const text = String(message || '').toLowerCase()
  if (!text) return false
  // Never classify a human-verification demand as an auth problem: cooling the
  // account down would not help and hides the real cause from the operator.
  if (includesAny(text, CAPTCHA_MARKERS)) return false
  if (includesAny(text, AUTH_KEYWORDS)) return true
  // Upstream's last clause: "login" together with "expired"/"required".
  if (text.indexOf('login') !== -1 && (text.indexOf('expired') !== -1 || text.indexOf('required') !== -1)) {
    return true
  }
  // Fall back to a status embedded in the text.
  const m = text.match(STATUS_IN_TEXT)
  if (m && AUTH_STATUSES.has(Number(m[1]))) return true
  return false
}

/**
 * Classify one failure. Ordering matters: captcha before auth (a 403 captcha
 * page must not cool the account down), auth before rate/server.
 *
 * @param {{message?: string, status?: number|null, error?: any}} input
 * @returns {{class: string, retryable: boolean, auth: boolean, status: number|null,
 *            reason: string, matched: string|null}}
 */
function classifyFailure(input) {
  const src = input || {}
  const message = src.message !== undefined && src.message !== null
    ? String(src.message)
    : messageOf(src.error)
  const status = src.status !== undefined && src.status !== null
    ? Number(src.status)
    : statusOf(src.error)
  const text = message.toLowerCase()
  const reason = summarize(message)

  const captcha = includesAny(text, CAPTCHA_MARKERS)
  if (captcha) {
    return { class: 'captcha', retryable: true, auth: false, status: status || null, reason, matched: captcha }
  }

  const authKeyword = includesAny(text, AUTH_KEYWORDS)
  if ((status && AUTH_STATUSES.has(status)) || authKeyword) {
    return {
      class: 'auth',
      retryable: false,
      auth: true,
      status: status || null,
      reason,
      matched: authKeyword || ('http ' + status),
    }
  }

  if (status === 429 || includesAny(text, ['rate limit', 'too many requests', 'quota', '限流', '次数已用完'])) {
    return { class: 'rate', retryable: true, auth: false, status: status || null, reason, matched: 'rate' }
  }

  if ((status && status >= 500) || includesAny(text, ['bad gateway', 'service unavailable', 'gateway timeout', 'internal server error'])) {
    return { class: 'server', retryable: true, auth: false, status: status || null, reason, matched: 'server' }
  }

  if (includesAny(text, NETWORK_MARKERS)) {
    return { class: 'network', retryable: true, auth: false, status: status || null, reason, matched: 'network' }
  }

  return { class: 'unknown', retryable: false, auth: false, status: status || null, reason, matched: null }
}

module.exports = {
  MAX_REASON_LENGTH,
  AUTH_KEYWORDS,
  AUTH_STATUSES,
  CLASSES,
  CAPTCHA_MARKERS,
  NETWORK_MARKERS,
  isAuthError,
  classifyFailure,
  describeHttpFailure,
  summarizePayload,
  summarize,
  statusOf,
  messageOf,
}
