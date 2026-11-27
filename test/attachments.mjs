/** Actual attachment collector regressions; every filesystem mutation uses a private temporary fixture. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import * as zlib from 'node:zlib'
import { AttachmentCleanupStore, attachmentRefs, observeAttachmentUse } from '../attachments.js'

const PREFIX = 'dsh-attachment-tests-'
const cases = []
const test = (name, run) => cases.push({ name, run })
const ALLOW = { blocked: () => false }
const exists = async path => {
  try { await lstat(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
const receipt = (data, kind = 'image', name = 'upload.txt') => ({
  attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`,
  bytes: Buffer.byteLength(data),
  ...(kind === 'image' ? { mediaType: 'image/png', width: 1, height: 1 } : { mediaType: 'text/plain', name }),
})
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

async function fixture(run) {
  const parent = await realpath(tmpdir())
  const root = await realpath(await mkdtemp(join(parent, PREFIX)))
  assert.ok(isAbsolute(root))
  assert.equal(dirname(root), parent)
  assert.ok(basename(root).startsWith(PREFIX))
  const home = join(root, 'home')
  await mkdir(home, { mode: 0o700 })
  const sessions = join(home, 'sessions')
  const backups = join(home, 'backups', 'sessions')
  await mkdir(sessions, { recursive: true })
  await mkdir(backups, { recursive: true })
  const owned = async path => {
    assert.equal(await realpath(root), root)
    const target = resolve(path)
    const rel = relative(root, target)
    assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `fixture-only target: ${target}`)
    assert.equal(await realpath(dirname(target)), dirname(target), 'mutations do not follow a redirected parent')
    return target
  }
  const remove = async (path, options = {}) => rm(await owned(path), options)
  const log = async (dir, rows, name = 'session.v4.jsonl', raw = false) => {
    await mkdir(dir, { recursive: true })
    const path = join(dir, name)
    const text = raw ? rows : jsonl(rows)
    await writeFile(path, name.endsWith('.zstd') && !raw ? zlib.zstdCompressSync(Buffer.from(text)) : text, { mode: 0o600 })
    return path
  }
  const upload = async (data = 'fixture image', kind = 'image', names = ['upload.txt']) => {
    const ref = receipt(data, kind, names[0])
    const digest = ref.attachmentId.slice(7)
    const storeRoot = join(home, 'attachments', 'v1')
    const path = join(storeRoot, kind === 'image' ? 'objects' : 'file-objects', digest.slice(0, 2), digest)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data, { mode: 0o600 })
    const aliases = []
    if (kind === 'file') {
      const directory = join(storeRoot, 'files', digest.slice(0, 2), digest)
      await mkdir(directory, { recursive: true })
      for (const name of names) {
        const alias = join(directory, name)
        await link(path, alias)
        aliases.push(alias)
      }
    }
    return { ref, digest, path, aliases, data, bytes: Buffer.byteLength(data) }
  }
  const candidate = async (item, id = `session-${randomUUID()}`) => {
    const source = join(sessions, 'workspace-a', id)
    await log(source, [{ historical: { request: { tool: { content: [item.ref] } } } }])
    const store = new AttachmentCleanupStore(home)
    await store.capture(id, source)
    await remove(source, { recursive: true })
    return { id, source, store }
  }
  try { await run({ root, home, sessions, backups, owned, remove, log, upload, candidate }) }
  finally {
    const target = await realpath(root)
    assert.ok(isAbsolute(target))
    assert.equal(target, root, 'canonical test root is revalidated before recursive cleanup')
    assert.equal(dirname(target), parent)
    assert.ok(basename(target).startsWith(PREFIX))
    await rm(target, { recursive: true, force: true })
  }
}

function backend(home, overrides = {}) {
  const root = join(home, 'attachments', 'v1')
  return {
    root,
    imageHostPath: ref => join(root, 'objects', ref.attachmentId.slice(7, 9), ref.attachmentId.slice(7)),
    fileHostPath: ref => join(root, 'files', ref.attachmentId.slice(7, 9), ref.attachmentId.slice(7), ref.name),
    async saveImage(value) { return value },
    async saveFile(value) { return value },
    ...overrides,
  }
}
const context = (store, port = undefined) => ({ get: name => name === 'attachments' ? store : name === 'webServer' ? { port } : undefined })
const assertRetained = (result, count = 1) => {
  assert.equal(result.removed, 0)
  assert.equal(result.retained, count)
  assert.ok(result.failed.length > 0, JSON.stringify(result))
}

// Reference recognition deliberately walks complete historical/request/tool objects.
test('attachmentRefs finds nested/cyclic plain refs, deduplicates names and rejects invalid receipts', () => {
  const image = receipt('same digest')
  const file = { ...receipt('same digest', 'file'), name: 'one.txt' }
  const refs = { history: [{ request: { tool: { data: [image, file, { ...file, name: 'two.txt' }] } } }] }
  refs.loop = refs
  refs.invalid = [
    { ...image, attachmentId: image.attachmentId.toUpperCase() }, { ...image, bytes: -1 },
    { ...image, width: 0 }, { ...file, name: undefined }, { ...file, bytes: 1.5 },
    Object.assign(new Date(), file), Object.assign(Buffer.from('x'), file),
  ]
  const result = [...attachmentRefs(refs).values()]
  assert.equal(result.length, 2)
  assert.deepEqual(new Set(result.map(row => row.kind)), new Set(['image', 'file']))
  assert.ok(result.every(row => row.sha256 === image.attachmentId.slice(7) && row.bytes === image.bytes))
})

test('capture parses every canonical log version recursively and both plain/zstd logs', () => fixture(async f => {
  const source = join(f.sessions, 'workspace', 'capture-all')
  const wanted = []
  for (const [index, name] of ['session.jsonl', 'session.v0.jsonl', 'session.v4.jsonl', 'session.v123.jsonl.zstd', 'session.jsonl.zstd'].entries()) {
    const item = await f.upload(`canonical ${index}`)
    wanted.push(item)
    await f.log(index % 2 ? join(source, 'history', String(index)) : source, [{ request: { histories: [{ toolResult: [item.ref] }] } }], name)
  }
  for (const name of ['other.jsonl', 'not-session.jsonl', 'session.txt', 'session.v4.json']) await f.log(source, 'not JSON', name, true)
  const store = new AttachmentCleanupStore(f.home)
  assert.equal(await store.capture('capture-all', source), wanted.length)
  assert.deepEqual(await store.pending(), [{ sessionId: 'capture-all', count: wanted.length }])
  await f.remove(source, { recursive: true })
  assert.equal((await store.cleanup('capture-all', ALLOW)).removed, wanted.length)
  for (const item of wanted) assert.equal(await exists(item.path), false)
}))

for (const [label, name, content] of [
  ['malformed JSON', 'session.v4.jsonl', '{broken}\n'],
  ['unterminated JSON record', 'session.v4.jsonl', '{"complete":true}'],
  ['invalid compressed log', 'session.v4.jsonl.zstd', 'not a zstd stream'],
  ['unsupported future generation', 'session.vNext.jsonl', '{}\n'],
  ['unsupported compression extension', 'session.v4.jsonl.zst', '{}\n'],
]) {
  test(`capture fails closed on ${label} without registering a partial candidate set`, () => fixture(async f => {
    const item = await f.upload()
    const source = join(f.sessions, 'workspace', 'bad-capture')
    await f.log(source, [item.ref], 'session.jsonl')
    await f.log(source, content, name, true)
    const store = new AttachmentCleanupStore(f.home)
    await assert.rejects(store.capture('bad-capture', source))
    assert.deepEqual(await store.pending(), [])
    assert.equal(await exists(item.path), true)
  }))
}

test('capture merges candidate identities durably across independent collector instances', () => fixture(async f => {
  const one = await f.upload('first')
  const two = await f.upload('second', 'file', ['a.txt', 'b.txt'])
  const source = join(f.sessions, 'workspace', 'persistent')
  await f.log(source, [one.ref])
  assert.equal(await new AttachmentCleanupStore(f.home).capture('persistent', source), 1)
  await f.log(source, [{ deep: [two.ref, { ...two.ref, name: 'b.txt' }] }])
  assert.equal(await new AttachmentCleanupStore(f.home).capture('persistent', source), 2)
  await f.remove(source, { recursive: true })
  const restarted = new AttachmentCleanupStore(f.home)
  assert.deepEqual(await restarted.pending(), [{ sessionId: 'persistent', count: 2 }])
  assert.deepEqual(await restarted.cleanup('persistent', ALLOW), { removed: 2, bytes: one.bytes + two.bytes, retained: 0, deferred: 0, failed: [] })
  assert.deepEqual(await restarted.pending(), [])
  assert.equal(await exists(one.path), false)
  for (const path of [two.path, ...two.aliases]) assert.equal(await exists(path), false)
}))

test('cleanup only removes journal candidates and preserves unregistered originals plus cache', () => fixture(async f => {
  const tracked = await f.upload('tracked')
  const orphan = await f.upload('unregistered original')
  const unregisteredFile = await f.upload('unregistered file', 'file', ['keep.bin'])
  const cache = join(f.home, 'attachments', 'v1', 'cache', 'preview.png')
  await mkdir(dirname(cache), { recursive: true })
  await writeFile(cache, 'cached image')
  const { id, store } = await f.candidate(tracked)
  assert.equal((await store.cleanup(id, ALLOW)).removed, 1)
  assert.equal(await exists(tracked.path), false)
  assert.equal(await readFile(orphan.path, 'utf8'), orphan.data)
  assert.equal(await readFile(unregisteredFile.path, 'utf8'), unregisteredFile.data)
  assert.equal(await readFile(unregisteredFile.aliases[0], 'utf8'), unregisteredFile.data)
  assert.equal(await readFile(cache, 'utf8'), 'cached image')
  assert.deepEqual(await store.cleanup(id, ALLOW), { removed: 0, bytes: 0, retained: 0, deferred: 0, failed: [] })
}))

for (const location of ['other workspace session', 'fork history', 'other session backup', 'backup staging']) {
  test(`cleanup scans the entire reference corpus and protects ${location}`, () => fixture(async f => {
    const item = await f.upload(`shared ${location}`)
    const { id, store } = await f.candidate(item)
    const reference = {
      'other workspace session': join(f.sessions, 'unrelated-workspace', 'session-other'),
      'fork history': join(f.sessions, 'another-workspace', 'session-fork', 'forks', 'history'),
      'other session backup': join(f.backups, 'session-other', 'old-snapshot', 'history'),
      'backup staging': join(f.backups, '.pending', 'staged-snapshot'),
    }[location]
    await f.log(reference, [{ replay: { prompt: { content: [item.ref] } } }], 'session.v2.jsonl.zstd')
    assert.deepEqual(await store.cleanup(id, ALLOW), { removed: 0, bytes: 0, retained: 1, deferred: 0, failed: [] })
    assert.equal(await exists(item.path), true)
    await f.remove(reference, { recursive: true })
    assert.equal((await store.cleanup(id, ALLOW)).removed, 1)
  }))
}

test('file aliases with the same digest and multiple names are reclaimed as one object family', () => fixture(async f => {
  const item = await f.upload('one file payload', 'file', ['first.txt', 'second name.txt', '第三份.txt'])
  const info = await lstat(item.path)
  assert.equal(info.nlink, 4)
  for (const path of item.aliases) assert.equal((await lstat(path)).ino, info.ino)
  const { id, store } = await f.candidate(item)
  assert.deepEqual(await store.cleanup(id, ALLOW), { removed: 1, bytes: item.bytes, retained: 0, deferred: 0, failed: [] })
  for (const path of [item.path, ...item.aliases]) assert.equal(await exists(path), false)
}))

test('a missing file canonical permits reclaiming its complete validated alias-only family', () => fixture(async f => {
  const item = await f.upload('canonical already gone', 'file', ['first.txt', 'second.txt'])
  const { id, store } = await f.candidate(item)
  await f.remove(item.path)
  for (const alias of item.aliases) assert.equal((await lstat(alias)).nlink, 2)
  assert.deepEqual(await store.cleanup(id, ALLOW), { removed: 1, bytes: item.bytes, retained: 0, deferred: 0, failed: [] })
  for (const path of item.aliases) assert.equal(await exists(path), false)
}))

for (const [label, name, content] of [
  ['malformed JSON', 'session.v4.jsonl', '{broken}\n'],
  ['incomplete record', 'session.jsonl', '{"valid":true}'],
  ['corrupt zstd', 'session.v3.jsonl.zstd', 'compressed garbage'],
]) {
  test(`cleanup fails closed across an unrelated ${label} log`, () => fixture(async f => {
    const item = await f.upload()
    const { id, store } = await f.candidate(item)
    await f.log(join(f.backups, 'session-other', 'snapshot'), content, name, true)
    assertRetained(await store.cleanup(id, ALLOW))
    assert.equal(await exists(item.path), true)
    assert.deepEqual(await store.pending(), [{ sessionId: id, count: 1 }])
  }))
}

for (const kind of ['reference directory', 'reference log']) {
  test(`a symlinked ${kind} makes the reference scan fail closed`, () => fixture(async f => {
    const item = await f.upload()
    const { id, store } = await f.candidate(item)
    const real = join(f.root, 'real-reference')
    await f.log(real, [])
    await symlink(kind === 'reference directory' ? real : join(real, 'session.v4.jsonl'), join(f.sessions, kind === 'reference directory' ? 'linked-session' : 'session.v4.jsonl'))
    assertRetained(await store.cleanup(id, ALLOW))
    assert.equal(await exists(item.path), true)
  }))
}

for (const anomaly of ['image canonical symlink', 'file canonical symlink', 'file alias symlink', 'image extra hardlink', 'file outside-family hardlink', 'file replaced alias inode']) {
  test(`object validation retains ${anomaly}`, () => fixture(async f => {
    const kind = anomaly.startsWith('image') ? 'image' : 'file'
    const item = await f.upload(`unsafe ${anomaly}`, kind, ['original.txt', 'second.txt'])
    const { id, store } = await f.candidate(item)
    const outsider = join(f.root, 'unrelated-original')
    if (anomaly.includes('symlink')) {
      await writeFile(outsider, item.data)
      const target = anomaly === 'file alias symlink' ? item.aliases[0] : item.path
      await f.remove(target)
      await symlink(outsider, target)
    } else if (anomaly.includes('hardlink')) await link(item.path, outsider)
    else {
      await f.remove(item.aliases[0])
      await writeFile(item.aliases[0], item.data)
    }
    assertRetained(await store.cleanup(id, ALLOW))
    assert.equal(await exists(item.path), true)
    for (const alias of item.aliases) assert.equal(await exists(alias), true)
    if (await exists(outsider)) assert.equal(await readFile(outsider, 'utf8'), item.data)
  }))
}

for (const anomaly of ['outside-family hardlink', 'replaced alias inode']) {
  test(`an alias-only family retains every remaining name with an ${anomaly}`, () => fixture(async f => {
    const item = await f.upload(`alias-only ${anomaly}`, 'file', ['one.txt', 'two.txt'])
    const { id, store } = await f.candidate(item)
    await f.remove(item.path)
    if (anomaly === 'outside-family hardlink') await link(item.aliases[0], join(f.root, 'outside-family'))
    else {
      await f.remove(item.aliases[0])
      await writeFile(item.aliases[0], item.data)
    }
    assertRetained(await store.cleanup(id, ALLOW))
    for (const alias of item.aliases) assert.equal(await readFile(alias, 'utf8'), item.data)
    assert.deepEqual(await store.pending(), [{ sessionId: id, count: 1 }])
  }))
}

test('a changed digest or byte count is retained and remains journaled', () => fixture(async f => {
  const item = await f.upload('aaaa')
  const { id, store } = await f.candidate(item)
  await writeFile(item.path, 'bbbb')
  assertRetained(await store.cleanup(id, ALLOW))
  await writeFile(item.path, 'a different size')
  assertRetained(await store.cleanup(id, ALLOW))
  assert.deepEqual(await store.pending(), [{ sessionId: id, count: 1 }])
}))

test('already missing journal candidates clear without sweeping any unrelated objects', () => fixture(async f => {
  const item = await f.upload('already missing')
  const orphan = await f.upload('orphan')
  const { id, store } = await f.candidate(item)
  await f.remove(item.path)
  assert.deepEqual(await store.cleanup(id, ALLOW), { removed: 0, bytes: 0, retained: 0, deferred: 0, failed: [] })
  assert.deepEqual(await store.pending(), [])
  assert.equal(await exists(orphan.path), true)
}))

test('pending isolates a corrupt ledger from a healthy candidate and never rewrites corruption', () => fixture(async f => {
  const healthy = await f.upload('healthy')
  const corrupt = await f.upload('corrupt ledger payload')
  const good = await f.candidate(healthy, 'session-healthy')
  const bad = await f.candidate(corrupt, 'session-corrupt')
  const path = join(f.home, 'attachment-cleanup', 'registry', `${bad.id}.json`)
  await writeFile(path, '{broken-json')
  const errors = []
  assert.deepEqual(await new AttachmentCleanupStore(f.home).pending({ onError: error => errors.push(error) }), [{ sessionId: good.id, count: 1 }])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].sessionId, bad.id)
  await assert.rejects(bad.store.cleanup(bad.id, ALLOW))
  assert.equal((await good.store.cleanup(good.id, ALLOW)).removed, 1)
  assert.equal(await readFile(corrupt.path, 'utf8'), corrupt.data)
  assert.equal(await readFile(path, 'utf8'), '{broken-json')
}))

test('no observer guard defers candidates without unlinking them', () => fixture(async f => {
  const item = await f.upload()
  const { id, store } = await f.candidate(item)
  assert.deepEqual(await store.cleanup(id), { removed: 0, bytes: 0, retained: 1, deferred: 1, failed: [] })
  assert.equal(await exists(item.path), true)
}))

test('a hot observer retains three unused candidates without failures until a backend restart', () => fixture(async f => {
  const items = [await f.upload('hot first'), await f.upload('hot second'), await f.upload('hot third', 'file')]
  const { id, store } = await f.candidate(items[0])
  for (const item of items.slice(1)) await f.candidate(item, id)
  const hotStore = backend(f.home)
  const hot = observeAttachmentUse(context(hotStore, 3080), f.home)
  assert.equal(observeAttachmentUse(context(hotStore), f.home), hot)
  assert.equal(hot.pins.size, 0, 'hot activation does not prove these copies were used')
  assert.deepEqual(await store.cleanup(id, hot), {
    removed: 0, bytes: 0, retained: 3, deferred: 3, restartRequired: 3, failed: [],
  })
  assert.deepEqual(await store.pending(), [{ sessionId: id, count: 3 }])
  for (const item of items) assert.equal(await exists(item.path), true)
  const restarted = observeAttachmentUse(context(backend(f.home)), f.home)
  assert.equal((await new AttachmentCleanupStore(f.home).cleanup(id, restarted)).removed, 3)
  assert.deepEqual(await store.pending(), [])
  for (const item of items) assert.equal(await exists(item.path), false)
}))

test('new upload receipts pin candidates for the backend lifetime across plugin remounts', () => fixture(async f => {
  const item = await f.upload('new staged upload')
  const { id, store } = await f.candidate(item)
  const service = backend(f.home)
  const guard = observeAttachmentUse(context(service), f.home)
  const wrapped = service.saveImage
  assert.equal(await service.saveImage(item.ref), item.ref)
  assert.equal(observeAttachmentUse(context(service, 3080), f.home), guard)
  assert.equal(service.saveImage, wrapped, 'remount does not add a second wrapper')
  const result = await store.cleanup(id, guard)
  assert.equal(result.deferred, 1)
  assert.equal(result.removed, 0)
  assert.equal(await exists(item.path), true)
}))

test('an active async admission defers collection until it settles', () => fixture(async f => {
  const item = await f.upload('existing unpinned candidate')
  const { id, store } = await f.candidate(item)
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const service = backend(f.home, { saveFile: async () => pending })
  const guard = observeAttachmentUse(context(service), f.home)
  const admission = service.saveFile('raw upload bytes')
  assert.equal(guard.active, 1)
  assert.equal((await store.cleanup(id, guard)).deferred, 1)
  finish({ completed: true })
  await admission
  assert.equal(guard.active, 0)
  assert.equal((await store.cleanup(id, guard)).removed, 1)
}))

for (const method of ['imageHostPath', 'fileHostPath', 'readFileStream']) {
  test(`${method} pins synchronously while preserving the backend return value`, () => fixture(async f => {
    const isFile = method !== 'imageHostPath'
    const item = await f.upload(`synchronous ${method}`, isFile ? 'file' : 'image')
    const { id, store } = await f.candidate(item)
    const sentinel = { stream: true }
    const service = backend(f.home, { readFileStream: () => sentinel })
    const guard = observeAttachmentUse(context(service), f.home)
    const value = service[method](item.ref)
    if (method === 'readFileStream') assert.equal(value, sentinel)
    else assert.equal(typeof value, 'string')
    assert.equal((await store.cleanup(id, guard)).deferred, 1)
    assert.equal(await exists(item.path), true)
  }))
}

for (const missing of ['backend', 'matching root', 'listener', 'local layout']) {
  test(`observer fails closed without a supported ${missing}`, () => fixture(async f => {
    const service = backend(f.home)
    let ctx = context(service)
    if (missing === 'backend') ctx = context(undefined)
    if (missing === 'matching root') service.root = join(f.root, 'elsewhere')
    if (missing === 'listener') ctx = { get: name => name === 'attachments' ? service : undefined }
    if (missing === 'local layout') service.fileHostPath = () => '/unsupported-layout'
    const guard = observeAttachmentUse(ctx, f.home)
    assert.equal(guard.blocked({ kind: 'image', sha256: '0'.repeat(64) }), true)
    const item = await f.upload(`unsupported ${missing}`)
    const { id, store } = await f.candidate(item)
    const result = await store.cleanup(id, guard)
    assertRetained(result)
    assert.equal(result.failed[0].code, 'ATTACHMENTS_OBSERVER_UNAVAILABLE')
    assert.equal(result.deferred, 0, 'unsupported backends remain errors, not normal Host protection')
    assert.equal(result.restartRequired, undefined)
    assert.equal(await exists(item.path), true)
  }))
}

test('the final synchronous guard check catches a newly started admission', () => fixture(async f => {
  const item = await f.upload('final guard race')
  const { id, store } = await f.candidate(item)
  let checks = 0
  const guard = { blocked() { checks += 1; return checks > 1 } }
  const result = await store.cleanup(id, guard)
  assert.equal(checks, 2)
  assert.equal(result.deferred, 1)
  assert.equal(result.removed, 0)
  assert.equal(await exists(item.path), true)
}))

test('a final live-state change refuses unlink and preserves the durable candidate', () => fixture(async f => {
  const item = await f.upload('live seq race')
  const { id, store } = await f.candidate(item)
  let finalChecks = 0
  const result = await store.cleanup(id, ALLOW, async () => () => {
    finalChecks += 1
    throw Object.assign(new Error('Live Sessions changed during attachment cleanup'), { code: 'TEST_LIVE_CHANGED' })
  })
  assert.equal(finalChecks, 1)
  assertRetained(result)
  assert.equal(result.failed[0].code, 'TEST_LIVE_CHANGED')
  assert.equal(await exists(item.path), true)
  assert.equal((await new AttachmentCleanupStore(f.home).cleanup(id, ALLOW)).removed, 1)
}))

test('a terminal ledger stamp failure preserves real reclaimed totals and the old journal can be retried', () => fixture(async f => {
  const item = await f.upload('collected before a ledger stamp failure')
  const { id, store } = await f.candidate(item)
  const ledger = await f.owned(join(f.home, 'attachment-cleanup', 'registry', `${id}.json`))
  const original = await readFile(ledger, 'utf8')
  let checks = 0
  const result = await store.cleanup(id, ALLOW, async () => () => {
    checks += 1
    appendFileSync(ledger, ' ')
  })
  assert.equal(checks, 1)
  assert.equal(result.removed, 1)
  assert.equal(result.bytes, item.bytes)
  assert.equal(result.retained, 0)
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].id, id)
  assert.match(result.failed[0].reason, /ledger changed before removal/)
  assert.equal(await exists(item.path), false)
  assert.equal(await readFile(ledger, 'utf8'), `${original} `)
  assert.deepEqual(await store.pending(), [{ sessionId: id, count: 1 }])
  assert.deepEqual(await new AttachmentCleanupStore(f.home).cleanup(id, ALLOW), { removed: 0, bytes: 0, retained: 0, deferred: 0, failed: [] })
  assert.deepEqual(await store.pending(), [])
  assert.equal(await exists(ledger), false)
}))

let failures = 0
for (const { name, run } of cases) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { failures += 1; console.error(`✗ ${name}\n${error.stack ?? error}`) }
}
console.log(`${cases.length - failures}/${cases.length} attachment module tests passed`)
if (failures) process.exitCode = 1
