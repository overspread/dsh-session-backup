#!/usr/bin/env node
/**
 * Emit `client.js`, the browser face of this plugin, from `src/client.mjs`.
 *
 * The Harness web host composes every `dsh.client.platform: "web"` package's
 * `exports["./client"]` file into a **classic script** batch served from
 * `/plugins/...`; each file must register itself through
 * `window.__ModuleLoader__.load({ id, factory })`, and its module specifiers
 * must be plain `require()` calls resolved from the boot graph.
 *
 * The transform is deliberately small and checked rather than clever:
 *
 *   import { a as b } from "pkg"   ->  const { a: b } = require("pkg")
 *   import * as ns from "pkg"      ->  const ns = require("pkg")
 *   import def from "pkg"          ->  const def = require("pkg")
 *   import "pkg"                   ->  require("pkg")
 *   export const name = ...        ->  const name = ...   (+ exports.name)
 *
 * Anything outside that list (Node built-ins, `export default`, re-exports)
 * fails the build instead of shipping a script the browser cannot parse.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package id the boot graph addresses this plugin by (its package name). */
export const PACKAGE_ID = 'dsh-session-backup'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read the browser source this bundle is generated from. */
export function readClientSource() {
  return readFileSync(join(root, 'src', 'client.mjs'), 'utf8')
}

/** Rewrite one ESM import statement into the equivalent `require()` call. */
function rewriteImport(match, names, quote, specifier) {
  if (specifier.startsWith('node:')) {
    throw new Error(`build-client: "${specifier}" is a Node built-in; a browser bundle cannot use it`)
  }
  const bindings = names
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [original, alias] = entry.split(/\s+as\s+/).map((part) => part.trim())
      if (original === undefined || original === '') {
        throw new Error(`build-client: cannot parse import binding "${entry}"`)
      }
      return alias === undefined ? original : `${original}: ${alias}`
    })
    .join(', ')
  return `const { ${bindings} } = require(${JSON.stringify(specifier)})`
}

/**
 * Wrap one browser ESM source in the registration factory.
 * @param {string} source - contents of `src/client.mjs`
 * @returns {string} contents of `client.js`
 * @throws {Error} when the source uses a form the classic-script wrap cannot carry
 */
export function renderClient(source) {
  let body = source
  // import { a, b as c } from 'pkg'
  body = body.replace(/import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2[ \t]*;?/g, rewriteImport)
  // import * as ns from 'pkg'
  body = body.replace(
    /import\s*\*\s*as\s+(\w+)\s+from\s*(['"])([^'"]+)\2[ \t]*;?/g,
    (match, ns, _quote, specifier) => {
      if (specifier.startsWith('node:')) {
        throw new Error(`build-client: "${specifier}" is a Node built-in; a browser bundle cannot use it`)
      }
      return `const ${ns} = require(${JSON.stringify(specifier)})`
    },
  )
  // import def from 'pkg'
  body = body.replace(
    /import\s+(\w+)\s+from\s*(['"])([^'"]+)\2[ \t]*;?/g,
    (match, name, _quote, specifier) => {
      if (specifier.startsWith('node:')) {
        throw new Error(`build-client: "${specifier}" is a Node built-in; a browser bundle cannot use it`)
      }
      return `const ${name} = require(${JSON.stringify(specifier)})`
    },
  )
  // import 'pkg'
  body = body.replace(/import\s*(['"])([^'"]+)\1[ \t]*;?/g, (match, _quote, specifier) => {
    if (specifier.startsWith('node:')) {
      throw new Error(`build-client: "${specifier}" is a Node built-in; a browser bundle cannot use it`)
    }
    return `require(${JSON.stringify(specifier)})`
  })

  // export const/function/class ... -> remember the binding, drop the keyword
  const exported = []
  body = body.replace(
    /\bexport\s+(const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/g,
    (match, kind, identifier) => {
      if (!exported.includes(identifier)) exported.push(identifier)
      return `${kind} ${identifier}`
    },
  )

  const leftoverImport = /^\s*import\b/m
  if (leftoverImport.test(body)) {
    throw new Error('build-client: unhandled `import` statement left in the bundle body')
  }
  const leftoverExport = /^\s*export\b/m
  if (leftoverExport.test(body)) {
    const line = body.match(leftoverExport)[0].trim()
    throw new Error(`build-client: unsupported \`export\` form left in the bundle body: ${line}`)
  }
  if (exported.length === 0) {
    throw new Error('build-client: src/client.mjs exports nothing; the loader would reject the bundle')
  }

  const exportAssignments = exported.map((identifier) => `\t\texports.${identifier} = ${identifier};`)

  return `${[
    '// GENERATED from src/client.mjs by scripts/build-client.mjs',
    '// Edit src/client.mjs, then run: node scripts/build-client.mjs',
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(PACKAGE_ID)},`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    '',
    body.replace(/\s*$/, ''),
    '',
    ...exportAssignments,
    '\t\treturn module.exports;',
    '\t},',
    '});',
    '',
  ].join('\n')}`
}

/** Write `client.js` from the current `src/client.mjs`. */
export function build() {
  const rendered = renderClient(readClientSource())
  writeFileSync(join(root, 'client.js'), rendered)
  return rendered
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build()
  console.log('wrote client.js')
}
