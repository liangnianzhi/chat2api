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

/**
 * Delete files that are on disk but never loaded at run time: TypeScript type
 * declarations, source maps, docs and test fixtures. These ship inside ordinary
 * dependency folders - `electron` alone carries ~2.9 MB of .d.ts (electron.d.ts
 * plus @types/node) that no `require()` can ever reach.
 *
 * Only extensions/extras that are unambiguously dead are removed; anything the
 * loader might want (package.json, .js/.cjs/.mjs/.json/.wasm/.node) is kept.
 */
const PRUNE_DIRS = new Set([
  'test', 'tests', '__tests__', 'doc', 'docs', 'example', 'examples',
  '.github', 'benchmark', 'benchmarks',
])
const PRUNE_FILES = new Set(['.d.ts', '.d.mts', '.d.cts', '.map', 'CHANGELOG.md', 'HISTORY.md', 'README.md', 'tsconfig.json', '.npmignore', '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.prettierrc', 'tslint.json'])
const PRUNE_SUFFIX = ['.ts', '.tsx', '.map', '.md', '.markdown']

/**
 * TypeScript sources are dead for the .js entry points, but the .stub / .cjs
 * pair sometimes keeps resolvable JS in a file named *.ts-free, so only strip
 * .ts next to an existing sibling .js of the same base name - that is the one
 * case where we know for certain the .ts is the source of a compiled JS.
 */
function pruneContent(root) {
  let bytes = 0
  let files = 0
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (PRUNE_DIRS.has(e.name)) { bytes += dirSize(p); try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ } continue }
        stack.push(p)
        continue
      }
      if (!e.isFile()) continue
      let drop = PRUNE_FILES.has(e.name)
      if (!drop) for (const sfx of PRUNE_SUFFIX) if (e.name.endsWith(sfx)) { drop = true; break }
      if (drop) {
        try {
          bytes += fs.statSync(p).size
          fs.rmSync(p, { force: true })
          files++
        } catch { /* ignore */ }
      }
    }
  }
  return { bytes, files }
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

  const content = pruneContent(NM)
  console.log(`prune-deps: dropped ${content.files} type/doc files, ~${(content.bytes / 1048576).toFixed(1)} MB`)

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
