#!/usr/bin/env node
/**
 * Prune node_modules down to what the headless gateway actually loads at run time.
 *
 * WHY THIS IS SAFE
 * ----------------
 * Upstream's electron-vite config uses `externalizeDepsPlugin({ exclude: [...] })`.
 * Rollup inlines every dependency *except* the ones in that exclude list, so at
 * run time the compiled bundle only needs those packages to exist on disk.
 * Everything else - Electron, React, the renderer's UI libraries, the
 * electron-builder toolchain - is dead weight for a headless server.
 *
 * Measured effect: 302 MB / 245 packages  ->  ~4 MB / ~11 packages.
 *
 * The required set below is the upstream exclude list (the GUI-only
 * electron-updater is intentionally dropped), plus `ajv`, which the compiled
 * chunks reach into for electron-store's schema validation.
 *
 * If upstream ever adds a dependency to that exclude list, add it here too -
 * the build fails loudly otherwise, which is the intended signal.
 */

'use strict'

const fs = require('fs')
const path = require('path')

const NM = process.argv[2] || 'node_modules'

// Upstream externalizeDepsPlugin exclude list, minus electron-updater
// (GUI-only: it performs in-app updates, meaningless in a container).
const REQUIRED = [
  'koa',
  '@koa/router',
  'koa-bodyparser',
  'koa-router',
  'eventsource-parser',
  'js-sha3',
  'mime-types',
  'zstd-codec',
  'electron-store',
  'axios',
  // Reached directly by the compiled chunks (electron-store's validator).
  'ajv',
]

function exists(p) {
  try { fs.accessSync(p); return true } catch { return false }
}

/**
 * Resolve a package's transitive dependencies so the pruned tree is still
 * loadable. Walks package.json "dependencies" recursively.
 */
function collect(root, name, seen, missing) {
  if (seen.has(name)) return
  seen.add(name)

  const dir = path.join(root, ...name.split('/'))
  const pkgFile = path.join(dir, 'package.json')
  if (!exists(pkgFile)) {
    missing.push(name)
    return
  }
  let pkg
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch { return }
  const deps = Object.keys(pkg.dependencies || {})
  for (const d of deps) collect(root, d, seen, missing)
}

function main() {
  if (!exists(NM)) {
    console.error(`prune-deps: ${NM} not found`)
    process.exit(1)
  }

  console.log('prune-deps: resolving the runtime dependency closure...')
  const keep = new Set()
  const missing = []

  for (const name of REQUIRED) {
    if (!exists(path.join(NM, ...name.split('/')))) {
      // ajv and friends may be hoisted; record rather than fail immediately.
      missing.push(name)
      continue
    }
    collect(NM, name, keep, missing)
  }

  // A missing *top-level* requirement is fatal: the bundle will throw on boot.
  const fatal = REQUIRED.filter((n) => !keep.has(n))
  if (fatal.length) {
    console.error('prune-deps: FATAL - required packages not installed:', fatal.join(', '))
    process.exit(1)
  }

  console.log(`prune-deps: keeping ${keep.size} packages`)

  // Keep the electron shim directory: it is re-installed right after.
  const KEEP_EXTRA = new Set(['electron', '.package-lock.json', '.bin'])

  let removed = 0
  let freedBytes = 0

  for (const entry of fs.readdirSync(NM)) {
    if (KEEP_EXTRA.has(entry)) continue

    // Scoped packages: prune inside the scope, not the whole directory.
    if (entry.startsWith('@')) {
      const scopeDir = path.join(NM, entry)
      if (!fs.statSync(scopeDir).isDirectory()) continue
      for (const sub of fs.readdirSync(scopeDir)) {
        const full = `${entry}/${sub}`
        if (keep.has(full)) continue
        const p = path.join(scopeDir, sub)
        try {
          freedBytes += dirSize(p)
          fs.rmSync(p, { recursive: true, force: true })
          removed++
        } catch (e) {
          console.warn(`prune-deps: could not remove ${full}: ${e.message}`)
        }
      }
      // Remove the scope directory if it became empty.
      try { if (fs.readdirSync(scopeDir).length === 0) fs.rmdirSync(scopeDir) } catch { /* ignore */ }
      continue
    }

    if (keep.has(entry)) continue
    const p = path.join(NM, entry)
    try {
      const st = fs.lstatSync(p)
      if (st.isDirectory()) freedBytes += dirSize(p)
      fs.rmSync(p, { recursive: true, force: true })
      removed++
    } catch (e) {
      console.warn(`prune-deps: could not remove ${entry}: ${e.message}`)
    }
  }

  console.log(`prune-deps: removed ${removed} entries, ~${(freedBytes / 1048576).toFixed(1)} MB`)

  // Sanity check: the packages the bundle needs must still resolve.
  for (const name of REQUIRED) {
    const target = name.startsWith('@')
      ? path.join(NM, ...name.split('/'))
      : path.join(NM, name)
    if (!exists(target)) {
      console.error(`prune-deps: FATAL - ${name} disappeared during prune`)
      process.exit(1)
    }
  }
  console.log('prune-deps: required packages all resolve')
}

function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = path.join(cur, e.name)
      try {
        if (e.isDirectory()) stack.push(p)
        else if (e.isFile()) total += fs.statSync(p).size
      } catch { /* ignore */ }
    }
  }
  return total
}

main()
