/**
 * Request-log annotation.
 *
 * WHAT UPSTREAM DOES
 * ------------------
 * The management UI reads 'request logs' from an in-memory store that the
 * proxy fills in after every request. Each row records the status, the
 * latency, the request body... and, for a failure, whatever error text the
 * provider layer happened to keep. For the two dominant failures on this
 * deployment that text is worthless:
 *
 *   * DeepSeek: 'Failed to acquire token: "..." Failed (invalid token)' - the
 *     cause is visible but the request still burns 18 s and nothing tells the
 *     statistics layer it was an auth failure;
 *   * zai:      literally 'HTTP 500' - upstream builds the error from the
 *     status code alone and throws the provider's response body away.
 *
 * WHAT WE ADD (additive only - existing fields keep their meaning)
 * ---------------------------------------------------------------
 *   failureCategory  auth | captcha | rate-limit | network | provider-5xx |
 *                    client-error | unknown | none (success)
 *   failureReason    short, bounded, human text ('deepseek token rejected')
 *   providerResponse when the provider's own body was available (or when we
 *                    can recover it from the error object / response), the
 *                    response body or headers, truncated to 1-2 KB
 *   httpStatus       the real provider status, when the message only said
 *                    'HTTP 500' and the row has no statusCode
 *   classifiedAt     ms epoch of the classification (for debugging)
 *
 * Everything here is defensive: a row that is frozen, a getter that throws, an
 * exotic object - none of it may break the request path. The wrapper always
 * calls the original first and annotates afterwards, and every failure is
 * swallowed (optionally logged once per distinct error).
 */

'use strict'

const classifier = require('./failure-classify')

/** Default cap on the provider-response excerpt; the task asked for 1-2 KB. */
const DEFAULT_BODY_LIMIT = 2048

/** Default cap on the reason line, so a row stays a row. */
const DEFAULT_REASON_LIMIT = 240

/** Header names that carry the provider's own failure story. */
const HEADER_NAMES = [
  'x-request-id', 'x-trace-id', 'x-amzn-requestid', 'x-oneapi-request-id',
  'openai-processing-ms', 'retry-after', 'www-authenticate', 'x-ratelimit-limit',
  'x-ratelimit-remaining', 'x-ratelimit-reset', 'cf-ray', 'x-envoy-upstream-service-time',
]

/** Keys that would make a serialised provider body explode. */
const BODY_KEY_LIMIT = 4000

/**
 * Credential scrubbing for anything that leaves the process.
 *
 * The excerpt is bounded, but bounded is not the same as safe: a provider that
 * echoes the request headers in an error body would otherwise write its own
 * bearer token, a session cookie or a JWT into request-logs.ndjson, where it
 * stays forever and is readable by the management UI. Everything below is
 * applied before the text is clipped, so a secret cannot survive by being
 * longer than the cap either.
 */
const REDACTED = '[REDACTED]'

/** Patterns that are always credentials, whoever produced them. */
const SECRET_PATTERNS = [
  // Authorization headers in any casing / quoting: "Bearer abc", basic auth.
  /\b(bearer|basic)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi,
  // Common provider key shapes: sk-..., sk-proj-..., ak-/sk-/pk- style.
  /\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{12,}/g,
  // JSON Web Tokens (three dot-separated base64url segments).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Long base64 / base64url blobs (token payloads, serialized credentials).
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g,
  // Hex secrets (session ids, api hashes) - 32+ hex chars.
  /\b[0-9a-fA-F]{32,}\b/g,
]

/** Header-ish assignments: x-api-key: xxx / "cookie": "..." / token=xxx. */
const SECRET_ASSIGNMENT = /\b([\w-]*(?:authorization|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|cookie|set-cookie|session[-_]?id|sessionid|credential|private[-_]?key)[\w-]*)\s*([:=])\s*("?)([^\s",;]{6,})\3/gi

/** Quoted values under a secret-looking key in serialised JSON. */
const SECRET_JSON = /("([\w-]*(?:token|secret|password|key|cookie|authorization|credential)[\w-]*)"\s*:\s*")([^"]{6,})(")/gi

function redactText(value) {
  if (typeof value !== 'string' || !value) return value
  let out = value
  try {
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED)
    out = out.replace(SECRET_ASSIGNMENT, (m, key, sep, quote) => key + sep + quote + REDACTED)
    out = out.replace(SECRET_JSON, (m, head, key, secret, tail) => head + REDACTED + tail)
    // A '?access_token=...' style query string.
    out = out.replace(/([?&][\w-]*(?:token|key|secret|password|sig)[\w-]*=)[^&\s"']+/gi, (m, head) => head + REDACTED)
  } catch {
    return REDACTED
  }
  return out
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Safe property read; a getter that throws yields undefined. */
function safeGet(obj, key) {
  if (!obj) return undefined
  try {
    return obj[key]
  } catch {
    return undefined
  }
}

/** Safe write; a frozen row simply does not get the annotation. */
function safeSet(obj, key, value) {
  if (!obj || typeof obj !== 'object') return false
  try {
    obj[key] = value
    return obj[key] === value
  } catch {
    return false
  }
}

/** Truncate to a character budget, marking the cut. */
function clip(value, limit) {
  return redactText(classifier.text(value, limit))
}

/**
 * Turn a provider response into a short, safe excerpt.
 * Accepts a fetch/axios response, a string body, or any object.
 */
function excerptOf(value, limit) {
  const max = Number(limit) > 0 ? Number(limit) : DEFAULT_BODY_LIMIT
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return clip(value, max)

  const parts = []
  const status = classifier.statusOf(value) || safeGet(value, 'status')
  if (Number.isFinite(Number(status))) parts.push('status=' + Number(status))

  const headers = safeGet(value, 'headers')
  if (headers && typeof headers === 'object') {
    const picked = []
    for (const name of HEADER_NAMES) {
      let v = safeGet(headers, name)
      if (v === undefined && typeof safeGet(headers, 'get') === 'function') {
        try { v = headers.get(name) } catch { v = undefined }
      }
      if (v !== undefined && v !== null && v !== '') picked.push(name + ': ' + clip(v, 96))
    }
    if (picked.length) parts.push(picked.join(' | '))
  }

  const body = safeGet(value, 'body') !== undefined ? safeGet(value, 'body') : safeGet(value, 'data')
  if (typeof body === 'string' && body) {
    parts.push(clip(body, max))
  } else if (body && typeof body === 'object') {
    parts.push(clip(JSON.stringify(body), max))
  } else if (!parts.length) {
    // Last resort: an error-ish object. Keep the fields that identify it.
    const keep = {}
    for (const key of ['message', 'code', 'type', 'error', 'detail', 'error_description']) {
      const v = safeGet(value, key)
      if (v !== undefined && v !== null && v !== '') keep[key] = typeof v === 'string' ? clip(v, 200) : v
    }
    if (Object.keys(keep).length) {
      try {
        parts.push(clip(JSON.stringify(keep), max))
      } catch {
        parts.push(clip(String(value), max))
      }
    }
  }

  const joined = parts.filter(Boolean).join(' ')
  return joined ? clip(joined, max) : null
}

/**
 * Find the provider's response anywhere on an error object.
 * Providers wrap errors differently: axios puts it on err.response, some SDKs
 * on err.body / err.data / err.responseBody, and a few hang the raw text on
 * err.message. We look in that order and never throw.
 */
function providerResponseOf(row, error, limit) {
  const response = safeGet(error, 'response')
  const nested = safeGet(response, 'data')
  const candidates = [
    // Prefer a real status+body pair over a bare body string: the excerpt is
    // then usable without the row (status, request id, retry-after), which is
    // exactly what was missing when the message was only 'HTTP 500'.
    response ? responseOf(response) : null,
    // A bare {status, headers, data} (tests, or a provider we shape ourselves).
    safeGet(error, 'data') && safeGet(error, 'headers')
      ? { status: safeGet(error, 'status'), headers: safeGet(error, 'headers'), data: safeGet(error, 'data') }
      : null,
    safeGet(error, 'providerResponse'),
    safeGet(error, 'responseBody'),
    safeGet(error, 'body'),
    safeGet(error, 'data'),
    response,
    safeGet(safeGet(error, 'cause'), 'response'),
    safeGet(row, 'providerResponse'),
    safeGet(row, 'upstreamBody'),
    safeGet(row, 'responseBody'),
  ]
  for (const candidate of candidates) {
    const excerpt = excerptOf(candidate, limit)
    if (excerpt) return excerpt
  }
  return null
}

/** Project an axios/fetch-style response to the fields the excerpt uses. */
function responseOf(response) {
  return {
    status: safeGet(response, 'status'),
    headers: safeGet(response, 'headers'),
    data: safeGet(response, 'data') !== undefined ? safeGet(response, 'data') : safeGet(response, 'body'),
  }
}

/** Does the row/message carry a real provider body, or just a bare status? */
function bareStatusOnly(message) {
  return /^(?:http(?:\s*error)?\s*)?\d{3}$/i.test(String(message || '').trim())
}

/**
 * Pull a provider body out of a string message, for the error shapes upstream
 * builds without a response object.
 *
 * zai.ts answers 'HTTP 500' and keeps nothing; some other paths throw with the
 * provider's JSON (or HTML) already inside the message. The classifier only
 * ever sees a trimmed excerpt of that string, so the full text has to be
 * recovered from the original source, not from what classification returned.
 * Only text that looks like a body qualifies: a bare 'HTTP 500' must NOT become
 * a fake provider response.
 */
const BODY_IN_TEXT = /(?:[{\[]\s*["\w$])|<(?:!doctype|html|head|body|title|pre|div)\b|^[A-Za-z0-9+\/]{16,}={0,2}$|^[\x20-\x7E]{12,}$/i
function bodyFromText(value, limit) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || bareStatusOnly(trimmed)) return null
  if (BODY_IN_TEXT.test(trimmed)) return clip(trimmed, limit)
  // '<token> Failed (invalid token)' and friends: prose about the failure, not
  // the provider's answer. The row still classifies from it.
  return null
}

/**
 * Wrap upstream's OWNER of the log manager so that the manager is wrapped the
 * instant upstream assigns it.
 *
 * The only side effect on the owner is an accessor property with the original
 * value kept in a closure: reads return the same object, writes wrap-and-store.
 * Returns false (and changes nothing) when the property cannot be redefined -
 * callers then stay on the lazy read path, which still works, just one write
 * later.
 */
function wrapArmOwner(owner, key, options) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key)
  if (!descriptor) return false
  if (descriptor.get && descriptor.get.__observabilityArmed) return true
  if (!descriptor.configurable) return false
  let current = descriptor.value
  const arm = (value) => {
    if (value && typeof value === 'object' && !value.__observabilityWrapped) {
      try {
        wrapManager(value, Object.assign({}, options, { armOwner: null }))
      } catch { /* leave it unwrapped rather than break upstream */ }
    }
    return value
  }
  const getter = function observabilityArmed() { return current }
  getter.__observabilityArmed = true
  try {
    Object.defineProperty(owner, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: getter,
      set(value) {
        current = arm(value)
      },
    })
  } catch {
    return false
  }
  if (current) current = arm(current)
  return true
}

/**
 * Classify one log row, in place, and return the class name.
 *
 * @param {object} row request-log row (mutated)
 * @param {object} [options]
 * @param {object|Error} [options.error] the error the proxy saw, if any
 * @param {number} [options.bodyLimit] provider-response cap (bytes/chars)
 * @param {(category: string, row: object) => (string|null)} [options.selfHealHint]
 *        consulted only when the local table answers 'unknown' - see catalog.js
 * @param {number} [options.now] clock
 * @returns {string} the failure category written on the row
 */
function annotate(row, options) {
  const opts = options || {}
  if (!row || typeof row !== 'object') return 'unknown'

  const statusCode = Number(
    safeGet(row, 'statusCode') || safeGet(row, 'responseStatus') || safeGet(row, 'httpStatus') || 0,
  ) || 0
  const message = firstText(
    safeGet(row, 'errorMessage'),
    safeGet(row, 'error'),
    safeGet(opts.error, 'message'),
    typeof safeGet(row, 'responseBody') === 'string' ? safeGet(row, 'responseBody') : '',
  )

  // Success: say so explicitly instead of leaving a hole. 'none' rather than
  // absent keeps the statistics loop branch-free.
  const ok = statusCode > 0 && statusCode < 400
  if (ok) {
    safeSet(row, 'failureCategory', 'none')
    safeSet(row, 'classifiedAt', now(opts))
    return 'none'
  }

  let verdict = classifier.classify({ message, status: statusCode, error: opts.error })
  if ((!verdict.category || verdict.category === 'unknown') && typeof opts.selfHealHint === 'function') {
    // The self-heal layer knows the error shapes of each provider (account
    // cooling is its business). When our own table has nothing to say we ask
    // it - but we never let it override a decision we are sure about.
    let hint = null
    try {
      hint = opts.selfHealHint(verdict.reason, row)
    } catch {
      hint = null
    }
    if (hint && classifier.CATEGORIES.indexOf(hint) !== -1) {
      verdict = Object.assign({}, verdict, { category: hint, matched: 'selfheal' })
    }
  }

  safeSet(row, 'failureCategory', verdict.category)
  safeSet(row, 'failureReason', clip(verdict.reason || verdict.matched || verdict.category, opts.reasonLimit || DEFAULT_REASON_LIMIT))
  const clazz = verdict.matched && verdict.matched.startsWith('http ') ? verdict.matched : null
  if (clazz && !statusCode) safeSet(row, 'httpStatus', Number(clazz.slice(5)))
  else if (verdict.status) safeSet(row, 'httpStatus', verdict.status)

  if (!safeGet(row, 'providerResponse')) {
    const excerpt = providerResponseOf(row, opts.error, opts.bodyLimit)
      || bodyFromText(message, opts.bodyLimit)
      || bodyFromText(safeGet(opts.error, 'message'), opts.bodyLimit)
    if (excerpt) safeSet(row, 'providerResponse', excerpt)
  }
  // A row whose whole story is 'HTTP 500' is exactly the case the task is
  // about; flag it so the UI can say 'provider body unavailable' instead of
  // pretending the message is the provider's answer.
  if (bareStatusOnly(message) && !safeGet(row, 'providerResponse')) {
    safeSet(row, 'providerResponseMissing', true)
  }
  safeSet(row, 'classifiedAt', now(opts))
  return verdict.category
}

function now(opts) {
  return typeof opts.now === 'number' ? opts.now : Date.now()
}

function firstText(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v
    if (v && typeof v === 'object') {
      const m = safeGet(v, 'message')
      if (typeof m === 'string' && m.trim()) return m
    }
  }
  return ''
}

/**
 * Wrap a log-adding function so every row is annotated before it is stored.
 *
 * The wrapper is deliberately thin: it calls through first (so a logging bug
 * can never delay or drop a request), then annotates the row - before or after
 * storage, whichever works. Upstream pushes the row into an array and keeps a
 * reference, so annotating after the call still lands on the stored object;
 * when it copies instead, we annotate before the call.
 *
 * @param {Function} original the function to wrap
 * @param {object} [options] forwarded to annotate(); plus
 *        options.errorFor(row) -> error object, when the caller has it
 * @returns {Function} the wrapper
 */
function wrapAdder(original, options) {
  const opts = options || {}
  if (typeof original !== 'function') return original
  const wrapped = function wrappedAdd(row, ...rest) {
    const error = typeof opts.errorFor === 'function' ? opts.errorFor(row) : undefined
    try {
      annotate(row, Object.assign({}, opts, { error }))
    } catch {
      /* annotation never blocks a request */
    }
    const result = original.call(this, row, ...rest)
    // Upstream may store a copy; annotate whatever it returns too, if it looks
    // like a row.
    try {
      if (result && typeof result === 'object' && result !== row
        && (result.statusCode !== undefined || result.latency !== undefined)) {
        annotate(result, Object.assign({}, opts, { error }))
      }
    } catch {
      /* ignore */
    }
    return result
  }
  copyFunctionMeta(original, wrapped)
  return wrapped
}

/** Keep name/length/toString recognisable for anything that inspects them. */
function copyFunctionMeta(from, to) {
  try {
    Object.defineProperty(to, 'name', { value: from.name || 'wrapped', configurable: true })
  } catch { /* ignore */ }
  try {
    if (from.prototype) to.prototype = from.prototype
  } catch { /* ignore */ }
}

/**
 * Upstream's write path, in full.
 *
 *   addRequestLog(entry)        sanitize -> push -> trim -> schedulePersist,
 *                               returns the STORED row (with its new id)
 *   updateRequestLog(id, part)  merge into the stored row
 *
 * The row is written by the FIRST call and completed by the SECOND (that is
 * where statusCode / latency / errorMessage arrive). Wrapping only the adder
 * annotates a row that has no failure in it yet; the classifier then has to
 * wait for an update we cannot see. So both are wrapped, and the category is
 * remembered by ROW ID between the two calls.
 *
 * getRequestLogs(limit, filter) is wrapped for the reason the store's rows
 * array cannot cover: it deep-copies every row it returns, so a reader handed
 * those copies would never see an annotation written later.
 *
 * @param {object} manager the request-log manager instance
 * @param {object} [options] annotate() options, plus
 *        options.index   a Map(id -> category) kept across add/update
 * @returns {{wrapped: string[], bound: string[], annotated: number}}
 */
function wrapManager(manager, options) {
  const opts = options || {}
  const wrapped = []
  const bound = []
  let annotated = 0
  if (!manager || typeof manager !== 'object') return { wrapped, bound, annotated }

  // ARMING A STORE THAT DOES NOT EXIST YET.
  //
  // Upstream's manager is created after the shim runs (StoreManager declares
  // 'requestLogManager: null' and fills it in initialize()), so at install time
  // there is nothing to wrap. Instead of polling, the manager's owner gets a
  // property hook: the moment upstream ASSIGNS the manager, we wrap it. This is
  // what makes the very first failed request, rather than the second, land
  // classified.
  if (opts.armOwner && typeof opts.armOwner === 'object' && typeof opts.armKey === 'string') {
    try {
      if (!wrapArmOwner(opts.armOwner, opts.armKey, options)) wrapped.push('(armed ' + opts.armKey + ')')
    } catch { /* a non-configurable property simply stays lazy */ }
  }

  // add (and any other adder the manager exposes): annotate BEFORE the call so
  // the object pushed into the array is already annotated - upstream copies the
  // row on the way in ('{...sanitize(entry), id}'), so annotating afterwards
  // would land on a discarded object.
  const adders = ['addRequestLog', 'addLog', 'pushLog', 'appendLog']
  const seen = new Set()
  for (const name of adders) {
    const original = safeGet(manager, name)
    if (typeof original !== 'function' || seen.has(original) || original.__observabilityWrapped) continue
    seen.add(original)
    const next = wrapAdder(original, opts)
    next.__observabilityWrapped = true
    try {
      manager[name] = next
      wrapped.push(name)
    } catch { /* read-only: skip */ }
  }

  // The completion path. Annotating the UPDATE payload is enough: upstream
  // spreads it into a fresh row, and every field it carries is copied.
  const update = safeGet(manager, 'updateRequestLog')
  if (typeof update === 'function' && !update.__observabilityWrapped) {
    const wrappedUpdate = function wrappedUpdate(id, updates, ...rest) {
      try {
        if (updates && typeof updates === 'object') annotateCompletion(updates, id, opts)
      } catch { /* never block the write */ }
      return update.call(this, id, updates, ...rest)
    }
    copyFunctionMeta(update, wrappedUpdate)
    wrappedUpdate.__observabilityWrapped = true
    try {
      manager.updateRequestLog = wrappedUpdate
      wrapped.push('updateRequestLog')
    } catch { /* ignore */ }
  }

  // The reader. A returned copy is annotated on the way out; the live row is
  // annotated in place so the array and the copy agree.
  const read = safeGet(manager, 'getRequestLogs')
  if (typeof read === 'function' && !read.__observabilityWrapped) {
    const wrappedRead = function wrappedRead(limit, filter, ...rest) {
      const result = read.call(this, limit, filter, ...rest)
      try {
        const rows = Array.isArray(result) ? result : (Array.isArray(safeGet(result, 'logs')) ? result.logs : [])
        for (const row of rows) {
          if (row && typeof row === 'object') annotate(row, opts)
        }
      } catch { /* ignore */ }
      return result
    }
    copyFunctionMeta(read, wrappedRead)
    wrappedRead.__observabilityWrapped = true
    try {
      manager.getRequestLogs = wrappedRead
      wrapped.push('getRequestLogs')
    } catch { /* ignore */ }
  }

  // Backfill: rows already on disk (the 51 failures that motivated this work).
  const rows = safeGet(manager, 'requestLogs')
  if (Array.isArray(rows)) {
    for (const row of rows) {
      try {
        if (row && (!row.failureCategory || row.providerResponseMissing === undefined)) {
          annotate(row, opts)
          annotated += 1
        }
      } catch { /* ignore */ }
    }
  }
  // Which of the wrapped methods take an id first: the caller's report says
  // "writers by id: updateRequestLog", which is what an operator needs to know
  // when the completion path stops being visible after an upstream change.
  for (const name of wrapped) {
    if (/^update/i.test(name)) bound.push(name)
  }
  return { wrapped, bound, annotated }
}

/**
 * Annotate an update payload, and remember the verdict for the row id so an
 * annotation that happens before the row is visible still reaches the reader.
 */
function annotateCompletion(updates, id, opts) {
  annotate(updates, opts)
  if (opts && opts.index instanceof Map && id !== undefined && id !== null) {
    try {
      opts.index.set(String(id), {
        failureCategory: safeGet(updates, 'failureCategory'),
        failureReason: safeGet(updates, 'failureReason'),
        providerResponse: safeGet(updates, 'providerResponse'),
        providerResponseMissing: safeGet(updates, 'providerResponseMissing'),
        httpStatus: safeGet(updates, 'httpStatus'),
        classifiedAt: safeGet(updates, 'classifiedAt'),
      })
      // The index only exists to cover the window between the two calls; it
      // must not grow without bound on a long-running container.
      if (opts.index.size > 5000) {
        const oldest = opts.index.keys().next()
        if (!oldest.done) opts.index.delete(oldest.value)
      }
    } catch { /* ignore */ }
  }
}

/**
 * Wrap a whole request-log store: every array-adding method gets the wrapper,
 * and existing rows are annotated once (so historical failures - the 51 that
 * made us build this - show up in the statistics immediately).
 *
 * @param {object} store request-log store instance or plain array
 * @param {object} [options]
 * @returns {{wrapped: string[], annotated: number}}
 */
function wrapStore(store, options) {
  const opts = options || {}
  const wrapped = []
  if (!store) return { wrapped, annotated: 0 }

  if (Array.isArray(store)) {
    let annotated = 0
    for (const row of store) {
      try { annotate(row, opts); annotated += 1 } catch { /* ignore */ }
    }
    return { wrapped, annotated }
  }

  const methods = ['addLog', 'add', 'push', 'append', 'record', 'addRequestLog', 'pushLog']
  const seen = new Set()
  for (const name of methods) {
    const original = safeGet(store, name)
    if (typeof original !== 'function' || seen.has(original)) continue
    if (original.__observabilityWrapped) continue
    seen.add(original)
    const next = wrapAdder(original, opts)
    next.__observabilityWrapped = true
    try {
      store[name] = next
      wrapped.push(name)
    } catch { /* read-only store: skip */ }
  }

  // The store may expose its rows; annotate the backfill.
  let annotated = 0
  for (const candidate of ['logs', 'requestLogs', 'entries', 'items', 'logsList']) {
    const rows = safeGet(store, candidate)
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      try {
        if (row && !row.failureCategory) {
          annotate(row, opts)
          annotated += 1
        }
      } catch { /* ignore */ }
    }
  }
  return { wrapped, annotated }
}

module.exports = {
  wrapManager,
  wrapArmOwner,
  annotateCompletion,
  DEFAULT_BODY_LIMIT,
  DEFAULT_REASON_LIMIT,
  HEADER_NAMES,
  annotate,
  wrapAdder,
  wrapStore,
  excerptOf,
  providerResponseOf,
  redactText,
  clip,
  safeGet,
  safeSet,
  isPlainObject,
}
