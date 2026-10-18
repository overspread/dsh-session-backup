import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { PACKAGE_ID, readClientSource, renderClient } from '../scripts/build-client.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('session-backup: generated client bundle', () => {
  it('is fresh against src/client.mjs', () => {
    const committed = readFileSync(join(root, 'client.js'), 'utf8')
    assert.equal(committed, renderClient(readClientSource()), 'client.js is stale; run: node scripts/build-client.mjs')
  })

  it('registers itself as a classic-script module', () => {
    const rendered = renderClient(readClientSource())
    assert.ok(rendered.startsWith('// GENERATED from src/client.mjs'))
    assert.ok(rendered.includes(`window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(PACKAGE_ID)},`))
    assert.ok(rendered.includes('factory: (require) => {'))
    assert.ok(rendered.includes('exports.apply = apply;'))
    assert.ok(rendered.includes('exports.inject = inject;'))
  })

  it('carries no ESM syntax the browser would reject', () => {
    const rendered = renderClient(readClientSource())
    assert.equal(/^\s*import\b/m.test(rendered), false, 'an import statement survived the transform')
    assert.equal(/^\s*export\b/m.test(rendered), false, 'an export statement survived the transform')
    assert.equal(rendered.includes('export default'), false)
  })

  it('rewrites every import into a require of the same specifier', () => {
    const rendered = renderClient(readClientSource())
    assert.ok(rendered.includes('const { createElement, Fragment, useEffect, useState, useSyncExternalStore } = require("react")'))
    assert.ok(rendered.includes('= require("@deepseek-ai/dsh-client-ui-primitives")'))
    assert.equal(rendered.includes('node:'), false, 'a Node built-in reached the bundle')
  })

  it('parses as the classic script the host serves', () => {
    // node --check accepts the file because the wrapper is ordinary script syntax.
    const rendered = renderClient(readClientSource())
    assert.doesNotThrow(() => new Function('window', rendered))
  })

  it('rejects a source the classic-script wrap cannot carry', () => {
    assert.throws(() => renderClient("import { readFile } from 'node:fs/promises'\nexport const apply = () => {}"), /Node built-in/)
    assert.throws(() => renderClient("import readFile from 'node:fs'\nexport const apply = () => {}"), /Node built-in/)
    assert.throws(() => renderClient('export default function apply() {}'), /unsupported `export` form/)
    assert.throws(() => renderClient("export * from 'x'"), /unsupported `export` form/)
    assert.throws(() => renderClient('const apply = () => {}'), /exports nothing/)
  })

  it('keeps named, aliased, and side-effect imports working', () => {
    const rendered = renderClient("import { a as b, c } from 'x'\nimport def from 'y'\nimport * as ns from 'z'\nimport 'side-effect'\nexport const apply = () => [b, c, def, ns]")
    assert.ok(rendered.includes('const { a: b, c } = require("x")'))
    assert.ok(rendered.includes('const def = require("y")'))
    assert.ok(rendered.includes('const ns = require("z")'))
    assert.ok(rendered.includes('require("side-effect")'))
  })
})
