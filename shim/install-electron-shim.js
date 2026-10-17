#!/usr/bin/env node
/**
 * Replace the `electron` package with our shim.
 *
 * WHY REPLACE THE PACKAGE INSTEAD OF PATCHING BUILD OUTPUT
 * -------------------------------------------------------
 * The compiled main process AND Rollup's shared chunks each call
 * require('electron'). Which chunk holds that call is an artefact of how Rollup
 * happens to split code, so it moves around on any upstream rebuild. Rewriting
 * the compiled files therefore needs re-verification after every update.
 *
 * Swapping the package itself intercepts every call site at once, regardless of
 * how the bundler lays things out. It also guarantees the real Electron
 * package's binary downloader can never execute.
 *
 * The shim installs the same mapping a second time at require() level (see
 * shim/gateway.js), so the two mechanisms cover each other.
 */

'use strict'

const fs = require('fs')
const path = require('path')

const APP = process.env.CHAT2API_APP_DIR || '/app'
const NM = path.join(APP, 'node_modules')
const SHIM = path.join(APP, 'shim', 'electron-shim.js')
const DIR = path.join(NM, 'electron')

function main() {
  if (!fs.existsSync(SHIM)) {
    console.error(`install-electron-shim: FATAL - shim not found at ${SHIM}`)
    process.exit(1)
  }

  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })

  fs.writeFileSync(
    path.join(DIR, 'package.json'),
    JSON.stringify({ name: 'electron', version: '0.0.0-shim', main: 'index.js' }, null, 2) + '\n'
  )
  fs.writeFileSync(
    path.join(DIR, 'index.js'),
    `module.exports = require(${JSON.stringify(SHIM)});\n`
  )

  // Verify the replacement actually resolves to our shim.
  const mod = require(DIR)
  if (!mod.__isShim) {
    console.error('install-electron-shim: FATAL - electron did not resolve to the shim')
    process.exit(1)
  }
  console.log('install-electron-shim: electron -> shim OK')
}

main()
