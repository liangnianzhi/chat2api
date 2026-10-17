#!/usr/bin/env node
/**
 * Add the headless entry as an extra Rollup input in electron.vite.config.ts.
 *
 * The upstream config looks like:
 *
 *   main: {
 *     plugins: [...],
 *     build: {
 *       rollupOptions: {
 *         input: {
 *           index: resolve(__dirname, 'src/main/index.ts')
 *         },
 *         output: { format: 'cjs' }
 *       }
 *     }
 *   },
 *
 * A regex over this structure is fragile: an earlier attempt inserted the entry
 * into `output` because `input`'s last property had no trailing comma. Instead,
 * locate the `input: {` that follows `main:` and splice the property in at the
 * object level, normalising comma placement so the emitted code is clean.
 */

const fs = require('fs')

const FILE = process.argv[2] || 'electron.vite.config.ts'
const MARKER = 'headless-entry'

let src = fs.readFileSync(FILE, 'utf8')

if (src.includes(MARKER)) {
  console.log('already patched')
  process.exit(0)
}

// Locate "main: {" then the first "input" after it.
const mainIdx = src.search(/main\s*:\s*\{/)
if (mainIdx === -1) {
  console.error('ERROR: could not find the "main: {" section')
  process.exit(1)
}

const inputIdx = src.indexOf('input', mainIdx)
if (inputIdx === -1) {
  console.error('ERROR: could not find "input" after "main: {"')
  process.exit(1)
}

const braceIdx = src.indexOf('{', inputIdx)
if (braceIdx === -1) {
  console.error('ERROR: could not find the opening brace of the input object')
  process.exit(1)
}

// Match the input object's matching close brace by brace counting, so nested
// braces inside the object cannot confuse us.
let depth = 0
let closeIdx = -1
for (let i = braceIdx; i < src.length; i++) {
  const ch = src[i]
  if (ch === '{') depth++
  else if (ch === '}') {
    depth--
    if (depth === 0) { closeIdx = i; break }
  }
}
if (closeIdx === -1) {
  console.error('ERROR: could not find the closing brace of the input object')
  process.exit(1)
}

const body = src.slice(braceIdx + 1, closeIdx)

// Follow the indentation of the first existing entry.
const firstEntry = body.match(/\n(\s*)(\w+)\s*:/)
const indent = firstEntry ? firstEntry[1] : '          '

// Normalise the body: strip whitespace, ensure exactly one trailing comma.
const trimmed = body.replace(/^\s+|\s+$/g, '').replace(/,\s*$/, '')

const newBody =
  '\n' + indent + trimmed.split('\n').map((l) => l.replace(/^\s+/, '')).join('\n' + indent) +
  ',\n' + indent + `headless: resolve(__dirname, 'src/main/headless-entry.ts')` +
  '\n' + indent.slice(0, Math.max(0, indent.length - 2))

src = src.slice(0, braceIdx + 1) + newBody + src.slice(closeIdx)

fs.writeFileSync(FILE, src)
console.log('patched OK (indent: ' + JSON.stringify(indent) + ')')
