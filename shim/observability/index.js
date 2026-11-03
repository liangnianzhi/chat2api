/**
 * Observability entry point (shim layer).
 *
 * See install.js for what happens; this file is just the public surface so
 * shim/gateway.js can require('.../observability') and nothing else.
 */

'use strict'

module.exports = require('./install.js')
