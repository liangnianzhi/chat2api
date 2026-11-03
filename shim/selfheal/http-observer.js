/**
 * http-observer.js: the request seam for the build that is actually shipped.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bundle builds its koa app in a module-level initializer:
 *
 *   class ProxyServer { ... }
 *   const proxyServer = new ProxyServer()   // runs while the chunk loads
 *   exports.ProxyServer = ProxyServer
 *
 * That instance is created before any patch can be applied to the class, and it
 * is the one the shim captures (http.Server.prototype.listen -> 'request'), so
 * neither a subclass nor a namespace swap can reach it. The captured callback
 * lives in the shim, which we own, so the request seam is there:
 *
 *   httpHandler = function (req, res) {
 *     if (selfhealTapHandler && selfhealTapHandler(req, res)) return
 *     for (const listener of listeners) listener.call(server, req, res)
 *   }
 *
 * This module produces that handler. It is a pure observer: it never answers a
 * request, never buffers more than TAIL_LIMIT bytes of the response, and hands
 * the verdict to the same classifyFailure/settle path the koa tap uses.
 *
 * COST
 * ----
 * One path compare per request; on completion routes only, two write/end
 * wrappers and a bounded tail buffer (8 KiB). No parsing of streamed bodies.
 */

'use strict'

const auth = require('./auth-errors')

const PATH_CHAT = '/v1/chat/completions'
const PATH_COMPLETIONS = '/v1/completions'
const TAIL_LIMIT = 8192
const SUMMARY_LIMIT = 160

/**
 * Splits the request line off a raw request. Returns null when the request did
 * not arrive with a usable path (upgraded sockets, malformed).
 */
function requestPath (req) {
  try {
    const url = req && (req.url || (req.socket && req.socket._httpMessage && req.socket._httpMessage.path))
    if (!url || typeof url !== 'string') return null
    const q = url.indexOf('?')
    return q === -1 ? url : url.slice(0, q)
  } catch (e) {
    return null
  }
}

function isCompletions (path) {
  return path === PATH_CHAT || path === PATH_COMPLETIONS
}

/** The last complete JSON object in the buffer, or null. */
function tailJson (text) {
  if (!text) return null
  const end = text.lastIndexOf('}')
  if (end < 0) return null
  // Walk back to the matching opening brace: bounded, no full parse.
  let depth = 0
  for (let i = end; i >= 0; i -= 1) {
    const ch = text[i]
    if (ch === '}') depth += 1
    else if (ch === '{') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, end + 1))
        } catch (e) {
          return null
        }
      }
    }
  }
  return null
}

/** A message from an error envelope; null for a healthy body. */
function errorMessageOf (body, status) {
  if (!body || typeof body !== 'object') return status >= 400 ? 'HTTP ' + status : null
  const err = body.error || (body.success === false ? body : null)
  if (!err) return status >= 400 ? 'HTTP ' + status : null
  const message = typeof err === 'string'
    ? err
    : (err.message || err.msg || err.error_description || err.detail)
  const text = message ? String(message) : ''
  if (text) {
    return (err.code || err.type) && !text.includes('.') ? text : text
  }
  return status >= 400 ? 'HTTP ' + status : null
}

function summarise (value) {
  const text = value === null || value === undefined ? '' : String(value)
  return text.length > SUMMARY_LIMIT ? text.slice(0, SUMMARY_LIMIT) + '...' : text
}

/**
 * @param {{log?:Function, hooks?:object, now?:Function, settle?:Function}} deps
 * @returns {(req:object, res:object)=>boolean} true when the request was taken over
 */
function createHandler (deps) {
  const d = deps || {}
  const log = typeof d.log === 'function' ? d.log : () => {}
  const now = typeof d.now === 'function' ? d.now : () => Date.now()
  const report = typeof d.report === 'function' ? d.report : () => {}

  return function selfhealHttpTap (req, res) {
    const path = requestPath(req)
    if (!isCompletions(path)) return false
    const started = now()
    let tail = ''
    try {
      const originalWrite = res.write
      const originalEnd = res.end
      const collect = (chunk, encoding) => {
        try {
          if (!chunk) return
          const text = typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
              ? chunk.toString(encoding && typeof encoding === 'string' ? encoding : 'utf8')
              : ''
          if (!text) return
          tail += text
          if (tail.length > TAIL_LIMIT) tail = tail.slice(tail.length - TAIL_LIMIT)
        } catch (e) { /* observation only */ }
      }
      res.write = function patchedWrite (chunk, encoding) {
        collect(chunk, encoding)
        return originalWrite.apply(this, arguments)
      }
      res.end = function patchedEnd (chunk, encoding) {
        try {
          collect(chunk, encoding)
          const status = res.statusCode
          const ms = now() - started
          const body = tailJson(tail)
          const message = errorMessageOf(body, status)
          if (message) {
            const verdict = auth.classifyFailure({ message, status })
            report(null, { ok: false, status, ms, message, verdict })
          } else {
            report(null, { ok: true, status, ms })
          }
        } catch (e) {
          try { log('[selfheal] http observer error: ' + summarise(e && e.message)) } catch (e2) { /* ignore */ }
        }
        return originalEnd.apply(this, arguments)
      }
    } catch (e) {
      try { log('[selfheal] http observer could not attach: ' + summarise(e && e.message)) } catch (e2) { /* ignore */ }
    }
    // Never take the request over: koa still answers it.
    return false
  }
}

module.exports = { createHandler, requestPath, isCompletions, tailJson, errorMessageOf, TAIL_LIMIT }
