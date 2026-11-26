/** Actual apply() routes with fixture-only sessions and attachments; no Host or profile is started. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { apply, Config } from '../index.js'
import { AttachmentCleanupStore } from '../attachments.js'

const PREFIX = 'dsh-attachment-routes-'
const API = '/api/session.backup'
const cases = []
const test = (name, run) => cases.push({ name, run })
const exists = async path => {
  try { await lstat(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
const line = value => `${JSON.stringify(value)}\n`

async function fixture(run, config = {}, options = {}) {
  const parent = await realpath(tmpdir())
  const root = await realpath(await mkdtemp(join(parent, PREFIX)))
  assert.ok(isAbsolute(root))
  assert.equal(dirname(root), parent)
  assert.ok(basename(root).startsWith(PREFIX))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await mkdir(home, { mode: 0o700 })
  await mkdir(workspace, { mode: 0o700 })
  const records = new Map()
  const live = new Map()
  const services = new Map()
  const routes = new Map()
  const effects = []
  const editCalls = []
  const flushCalls = []
  const warnings = []
  const events = []
  const state = { beforeRemove: null, afterRemove: null, removes: 0 }
  const owned = async path => {
    assert.equal(await realpath(root), root)
    const target = resolve(path)
    const rel = relative(root, target)
    assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `fixture-only mutation: ${target}`)
    assert.equal(await realpath(dirname(target)), dirname(target), 'mutations do not follow a redirected parent')
    return target
  }
  const remove = async (path, opts = {}) => rm(await owned(path), opts)
  const createSession = async () => {
    const id = `session-${randomUUID()}`
    const dir = join(home, 'sessions', 'fixture-project', id)
    const log = join(dir, 'session.v4.jsonl')
    await mkdir(dir, { recursive: true })
    await writeFile(log, line({ type: 'fixture', sessionId: id }))
    const record = { id, dir, log }
    records.set(id, record)
    live.set(id, { id, seq: 0 })
    return record
  }
  const primary = await createSession()
  const persistence = {
    config: { root: join(home, 'sessions') },
    async stat(id) {
      const record = records.get(id)
      return record && await exists(record.log) ? { header: { id, cwd: workspace } } : undefined
    },
    async open(id) {
      assert.ok(records.has(id), 'write-lease probes address fixture sessions only')
      return { close: async () => {} }
    },
    async remove(id) {
      const record = records.get(id)
      assert.ok(record, 'native removal addresses fixture sessions only')
      state.removes += 1
      await state.beforeRemove?.(record)
      await remove(record.dir, { recursive: true })
      await state.afterRemove?.(record)
    },
  }
  const sessions = {
    get: id => live.get(id),
    list: () => [],
    async flush(session) { flushCalls.push(session) },
    store: { get: id => live.has(id) ? { detach: () => live.delete(id) } : undefined },
  }
  const makeBackend = () => {
    const attachmentRoot = join(home, 'attachments', 'v1')
    return {
      root: attachmentRoot,
      imageHostPath: ref => join(attachmentRoot, 'objects', ref.attachmentId.slice(7, 9), ref.attachmentId.slice(7)),
      fileHostPath: ref => join(attachmentRoot, 'files', ref.attachmentId.slice(7, 9), ref.attachmentId.slice(7), ref.name),
      async saveImage(ref) { return ref },
      async saveFile(ref) { return ref },
    }
  }
  const entry = { id: `attachment-test-${randomUUID()}`, config: { home, ...config } }
  services.set('sessionPersistence', persistence)
  services.set('sessions', sessions)
  services.set('attachments', makeBackend())
  services.set('webServer', { port: options.hot ? 3080 : undefined })
  services.set('configEditor', {
    async edit(target, update) {
      assert.equal(target, entry)
      const current = structuredClone(entry.config)
      const next = update(current)
      editCalls.push({ current, next })
      entry.config = next
    },
  })
  const ctx = {
    fiber: { entry },
    get: name => services.get(name),
    provide: (name, service) => services.set(name, service),
    logger: { warn: text => warnings.push(String(text)), error: text => warnings.push(String(text)) },
    waterfall: async () => [],
    parallel: async () => {},
    emit: (name, id) => events.push({ name, id }),
    connection: { fetch: { register(route) {
      assert.equal(routes.has(route.path), false)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    } } },
    effect(runEffect) { effects.push(runEffect()) },
  }
  const remount = () => {
    for (const dispose of effects.splice(0)) dispose?.()
    apply(ctx, entry.config)
  }
  remount()
  const request = async (action, body, method = 'POST') => {
    const path = `${API}.${action}`
    const route = routes.get(path)
    assert.ok(route, `actual apply() route: ${path}`)
    assert.ok(route.methods.includes(method))
    const init = { method }
    if (method !== 'GET') {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body ?? {})
    }
    const response = await route.fetch(new Request(`http://fixture.invalid${path}`, init))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(response.headers.get('content-type'), /^application\/json/)
    return { status: response.status, body: await response.json() }
  }
  const success = async (action, body, method) => {
    const response = await request(action, body, method)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body
  }
  const upload = async (data = 'fixture upload', kind = 'image', names = ['upload.txt']) => {
    const digest = createHash('sha256').update(data).digest('hex')
    const ref = {
      attachmentId: `sha256:${digest}`, bytes: Buffer.byteLength(data),
      ...(kind === 'image' ? { mediaType: 'image/png', width: 1, height: 1 } : { mediaType: 'text/plain', name: names[0] }),
    }
    const path = join(home, 'attachments', 'v1', kind === 'image' ? 'objects' : 'file-objects', digest.slice(0, 2), digest)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data, { mode: 0o600 })
    const aliases = []
    if (kind === 'file') {
      const dir = join(home, 'attachments', 'v1', 'files', digest.slice(0, 2), digest)
      await mkdir(dir, { recursive: true })
      for (const name of names) {
        const alias = join(dir, name)
        await link(path, alias)
        aliases.push(alias)
      }
    }
    return { ref, path, aliases, data, bytes: ref.bytes }
  }
  const attach = async (item, record = primary) => appendFile(record.log, line({ history: { request: { toolResult: { content: [item.ref] } } } }))
  const store = new AttachmentCleanupStore(home)
  const queue = async (item, record = primary) => {
    await attach(item, record)
    await store.capture(record.id, record.dir)
    await remove(record.dir, { recursive: true })
    live.delete(record.id)
    return record
  }
  const f = {
    ...primary, root, home, workspace, records, live, services, routes, entry, ctx, state,
    sessions, persistence, editCalls, flushCalls, warnings, events, createSession, owned, remove,
    makeBackend, remount, request, success, upload, attach, store, queue,
    settings: async () => (await success('cleanup-settings', undefined, 'GET')).settings,
    backups: async () => (await success('list', undefined, 'GET')).backups,
    artifact: (name = 'generated.png', data = 'generated screenshot') => services.get('sessionArtifacts').save(primary.id, name, data),
  }
  try { await run(f) }
  finally {
    for (const dispose of effects.splice(0)) dispose?.()
    const target = await realpath(root)
    assert.ok(isAbsolute(target))
    assert.equal(target, root, 'canonical temporary root is verified immediately before recursive cleanup')
    assert.equal(dirname(target), parent)
    assert.ok(basename(target).startsWith(PREFIX))
    await rm(target, { recursive: true, force: true })
  }
}

const assertError = (response, status, code) => {
  assert.equal(response.status, status, JSON.stringify(response.body))
  if (code) assert.equal(response.body.error.code, code)
  assert.equal(typeof response.body.error.message, 'string')
}
const attachmentResult = (response, id) => response.results.find(row => row.kind === 'attachments' && row.sessionId === id)

test('Config defaults both cleanup settings off and validates them independently', () => {
  const validate = value => Config['~standard'].validate(value)
  assert.deepEqual(validate({}).value, { cleanupOnDelete: false, cleanupAttachmentsOnDelete: false })
  assert.deepEqual(validate({ cleanupOnDelete: true }).value, { cleanupOnDelete: true, cleanupAttachmentsOnDelete: false })
  assert.deepEqual(validate({ cleanupAttachmentsOnDelete: true }).value, { cleanupOnDelete: false, cleanupAttachmentsOnDelete: true })
  for (const key of ['cleanupOnDelete', 'cleanupAttachmentsOnDelete']) {
    for (const value of [null, 1, 'true', [], {}]) assert.equal(validate({ [key]: value }).issues[0].path[0], key)
  }
})

test('apply exposes actual routes with default-off attachment policy and separate pending lists', () => fixture(async f => {
  assert.equal(f.routes.size, 7)
  assert.deepEqual(await f.settings(), {
    cleanupOnDelete: false, cleanupAttachmentsOnDelete: false, editable: true, pending: [], attachmentPending: [],
  })
  assertError(await f.request('cleanup-retry', { cleanupAttachmentsOnDelete: true }), 409, 'session-backup/conflict')
}))

test('default-off deletion ignores body overrides and leaves uploads, artifacts and inventory unmarked', () => fixture(async f => {
  const image = await f.upload()
  await f.attach(image)
  const artifact = await f.artifact()
  const { deleted } = await f.success('delete', { sessionId: f.id, cleanupOnDelete: true, cleanupAttachmentsOnDelete: true })
  assert.deepEqual(deleted, { deleted: true })
  assert.equal(await exists(f.log), false)
  assert.equal(await exists(image.path), true)
  assert.equal(await exists(artifact.path), true)
  assert.deepEqual((await f.settings()).pending, [])
  assert.deepEqual((await f.settings()).attachmentPending, [])
  const backups = await f.backups()
  assert.equal(backups.length, 1)
  const { removed } = await f.success('remove', { path: backups[0].path, cleanupAttachmentsOnDelete: true })
  assert.equal(Object.hasOwn(removed, 'attachments'), false)
  assert.equal(await exists(image.path), true)
}))

for (const key of ['cleanupOnDelete', 'cleanupAttachmentsOnDelete']) {
  test(`settings saving ${key} preserves the other flag and unrelated configuration`, () => fixture(async f => {
    const initial = structuredClone(f.entry.config)
    const other = key === 'cleanupOnDelete' ? 'cleanupAttachmentsOnDelete' : 'cleanupOnDelete'
    const response = await f.success('cleanup-settings', { [key]: true, home: '/must-not-be-used', unrelated: 5 })
    assert.equal(response.settings[key], true)
    assert.equal(response.settings[other], false)
    assert.deepEqual(f.entry.config, { ...initial, [key]: true })
    assert.equal(f.editCalls.length, 1)
    f.remount()
    const settings = await f.settings()
    assert.equal(settings[key], true)
    assert.equal(settings[other], false)
    assert.equal(f.entry.config.custom.deep, 'preserved')
  }, { custom: { deep: 'preserved' } }))
}

test('settings can save both flags atomically and rejects invalid values without a partial edit', () => fixture(async f => {
  const saved = await f.success('cleanup-settings', { cleanupOnDelete: true, cleanupAttachmentsOnDelete: true })
  assert.equal(saved.settings.cleanupOnDelete, true)
  assert.equal(saved.settings.cleanupAttachmentsOnDelete, true)
  assert.equal(f.editCalls.length, 1)
  for (const value of [null, 1, 'true', [], {}]) {
    assertError(await f.request('cleanup-settings', { cleanupOnDelete: false, cleanupAttachmentsOnDelete: value }), 400, 'session-backup/bad-request')
  }
  assert.equal(f.editCalls.length, 1)
  assert.equal(f.entry.config.cleanupOnDelete, true)
  assert.equal(f.entry.config.cleanupAttachmentsOnDelete, true)
}))

test('artifact-only cleanup deletes registered output while leaving uploaded attachments unqueued', () => fixture(async f => {
  const item = await f.upload()
  await f.attach(item)
  const artifact = await f.artifact()
  const { deleted } = await f.success('delete', { sessionId: f.id, cleanupAttachmentsOnDelete: true })
  assert.equal(deleted.cleanup.removed, 1)
  assert.equal(Object.hasOwn(deleted, 'attachments'), false)
  assert.equal(await exists(artifact.path), false)
  assert.equal(await exists(item.path), true)
  assert.deepEqual((await f.settings()).attachmentPending, [])
  const [backup] = await f.backups()
  await f.success('remove', { path: backup.path })
  assert.equal(await exists(item.path), true)
}, { cleanupOnDelete: true }))

test('attachment-only deletion preserves the final backup reference and reclaims only after its removal', () => fixture(async f => {
  const image = await f.upload('image referenced by final backup')
  const file = await f.upload('file referenced by final backup', 'file', ['first.txt', 'second.txt'])
  const unregistered = await f.upload('unregistered original')
  await f.attach(image)
  await f.attach(file)
  const artifact = await f.artifact()
  const cache = join(f.home, 'attachments', 'v1', 'cache', 'preview.bin')
  await mkdir(dirname(cache), { recursive: true })
  await writeFile(cache, 'cached preview')
  let sawJournalBeforeRemove = false
  f.state.beforeRemove = async () => {
    assert.deepEqual((await f.settings()).attachmentPending, [{ sessionId: f.id, count: 2 }])
    assert.equal((await f.backups()).length, 1)
    assert.equal(await exists(image.path), true)
    sawJournalBeforeRemove = true
  }
  const { deleted } = await f.success('delete', { sessionId: f.id, cleanupAttachmentsOnDelete: false })
  assert.equal(sawJournalBeforeRemove, true)
  assert.deepEqual(deleted.attachments, { removed: 0, bytes: 0, retained: 2, deferred: 0, failed: [] })
  assert.equal(Object.hasOwn(deleted, 'cleanup'), false)
  assert.equal(await exists(artifact.path), true)
  assert.equal(await exists(image.path), true)
  const [backup] = await f.backups()
  const { removed } = await f.success('remove', { path: backup.path })
  assert.deepEqual(removed.attachments, { removed: 2, bytes: image.bytes + file.bytes, retained: 0, deferred: 0, failed: [] })
  for (const path of [image.path, file.path, ...file.aliases]) assert.equal(await exists(path), false)
  assert.equal(await readFile(unregistered.path, 'utf8'), unregistered.data)
  assert.equal(await readFile(cache, 'utf8'), 'cached preview')
  assert.equal(await exists(artifact.path), true)
  assert.deepEqual((await f.settings()).attachmentPending, [])
}, { cleanupAttachmentsOnDelete: true }))

test('removing one of several backup references retains the upload until the last backup is removed', () => fixture(async f => {
  const item = await f.upload('shared across snapshots')
  await f.attach(item)
  const first = (await f.success('create', { sessionId: f.id, beforeDelete: false })).backup
  await appendFile(f.log, line({ type: 'new event', seq: 1 }))
  const second = (await f.success('create', { sessionId: f.id, beforeDelete: false })).backup
  assert.notEqual(first.path, second.path)
  await f.success('delete', { sessionId: f.id })
  assert.equal((await f.backups()).length, 2)
  const once = (await f.success('remove', { path: first.path })).removed.attachments
  assert.equal(once.removed, 0)
  assert.equal(once.retained, 1)
  assert.equal(await exists(item.path), true)
  const last = (await f.success('remove', { path: second.path })).removed.attachments
  assert.equal(last.removed, 1)
  assert.equal(await exists(item.path), false)
}, { cleanupAttachmentsOnDelete: true }))

test('a fork historical reference in another workspace survives removal of the final backup', () => fixture(async f => {
  const item = await f.upload('shared with fork')
  await f.attach(item)
  const other = await f.createSession()
  const history = join(other.dir, 'forks', 'history')
  await mkdir(history, { recursive: true })
  await writeFile(join(history, 'session.v1.jsonl'), line({ checkpoint: { request: { content: [item.ref] } } }))
  await f.success('delete', { sessionId: f.id })
  const [backup] = await f.backups()
  const removed = (await f.success('remove', { path: backup.path })).removed.attachments
  assert.equal(removed.removed, 0)
  assert.equal(removed.retained, 1)
  assert.equal(await exists(item.path), true)
  await f.remove(other.dir, { recursive: true })
  f.live.delete(other.id)
  assert.equal(attachmentResult(await f.success('cleanup-retry', {}), f.id).removed, 1)
}, { cleanupAttachmentsOnDelete: true }))

test('restoring consumes the backup but restored durable references protect attachments on retry', () => fixture(async f => {
  const item = await f.upload('restore receipt')
  await f.attach(item)
  await f.success('delete', { sessionId: f.id })
  const [backup] = await f.backups()
  const { restored } = await f.success('restore', { path: backup.path })
  assert.equal(restored.sessionId, f.id)
  assert.equal(restored.backupConsumed, true)
  assert.equal((await f.backups()).length, 0)
  assert.equal(await exists(f.log), true)
  const retry = attachmentResult(await f.success('cleanup-retry', {}), f.id)
  assert.equal(retry.removed, 0)
  assert.equal(retry.retained, 1)
  assert.equal(await exists(item.path), true)
}, { cleanupAttachmentsOnDelete: true }))

test('retry only processes journaled attachments and ignores requested orphan paths or ids', () => fixture(async f => {
  const tracked = await f.upload('journaled receipt')
  const orphan = await f.upload('orphan without journal')
  await f.queue(tracked)
  const retry = await f.success('cleanup-retry', { sessionId: 'arbitrary', path: orphan.path })
  assert.equal(retry.results.length, 1)
  assert.equal(attachmentResult(retry, f.id).removed, 1)
  assert.equal(await exists(tracked.path), false)
  assert.equal(await exists(orphan.path), true)
}, { cleanupAttachmentsOnDelete: true }))

test('settings/retry isolate corrupt attachment ledgers and clean a healthy candidate', () => fixture(async f => {
  const healthy = await f.upload('healthy queued upload')
  const corrupt = await f.upload('corrupt queued upload')
  const other = await f.createSession()
  await f.queue(healthy)
  await f.queue(corrupt, other)
  const ledger = join(f.home, 'attachment-cleanup', 'registry', `${other.id}.json`)
  await writeFile(ledger, '{corrupt-ledger')
  const settings = await f.settings()
  assert.deepEqual(settings.attachmentPending, [{ sessionId: f.id, count: 1 }])
  assert.equal(settings.attachmentPendingErrors.length, 1)
  assert.equal(settings.attachmentPendingErrors[0].sessionId, other.id)
  assert.deepEqual(settings.pending, [])
  const result = await f.success('cleanup-retry', {})
  assert.equal(attachmentResult(result, f.id).removed, 1)
  assert.equal(attachmentResult(result, other.id).failed.length, 1)
  assert.equal(await exists(healthy.path), false)
  assert.equal(await readFile(corrupt.path, 'utf8'), corrupt.data)
  assert.equal(await readFile(ledger, 'utf8'), '{corrupt-ledger')
  assert.deepEqual(result.settings.attachmentPending, [])
  assert.equal(result.settings.attachmentPendingErrors[0].sessionId, other.id)
}, { cleanupAttachmentsOnDelete: true }))

for (const blocker of ['missing list', 'missing flush', 'mismatching persistence root', 'invalid seq']) {
  test(`actual route retains pending uploads with ${blocker}`, () => fixture(async f => {
    const item = await f.upload(`blocked ${blocker}`)
    await f.queue(item)
    if (blocker === 'missing list') delete f.sessions.list
    if (blocker === 'missing flush') delete f.sessions.flush
    if (blocker === 'mismatching persistence root') f.persistence.config.root = join(f.root, 'not-the-corpus')
    if (blocker === 'invalid seq') f.sessions.list = () => [{ id: 'fixture-live', seq: undefined }]
    const result = attachmentResult(await f.success('cleanup-retry', {}), f.id)
    assert.equal(result.removed, 0)
    assert.equal(result.retained, 1)
    assert.equal(result.failed.length, 1)
    assert.equal(await exists(item.path), true)
  }, { cleanupAttachmentsOnDelete: true }))
}

test('actual route flushes all live Sessions before proving the corpus and collecting uploads', () => fixture(async f => {
  const item = await f.upload('flush-protected upload')
  await f.queue(item)
  const liveOne = { id: 'fixture-live-a', seq: 5 }
  const liveTwo = { id: 'fixture-live-b', seq: 9 }
  f.sessions.list = () => [liveOne, liveTwo]
  assert.equal(attachmentResult(await f.success('cleanup-retry', {}), f.id).removed, 1)
  assert.deepEqual(f.flushCalls, [liveOne, liveTwo])
}, { cleanupAttachmentsOnDelete: true }))

for (const change of ['seq', 'membership']) {
  test(`the final live ${change} check defers unlink after the reference scan`, () => fixture(async f => {
    const item = await f.upload(`final live ${change}`)
    await f.queue(item)
    const active = { id: 'fixture-active', seq: 4 }
    let calls = 0
    f.sessions.list = () => {
      calls += 1
      if (calls >= 3) {
        if (change === 'seq') active.seq += 1
        else return []
      }
      return [active]
    }
    const result = attachmentResult(await f.success('cleanup-retry', {}), f.id)
    assert.equal(calls, 3, 'the final synchronous check runs after prepare/flush and the reference scan')
    assert.equal(result.removed, 0)
    assert.equal(result.retained, 1)
    assert.match(result.failed[0].reason, /Live Sessions changed/)
    assert.equal(await exists(item.path), true)
    f.sessions.list = () => [active]
    assert.equal(attachmentResult(await f.success('cleanup-retry', {}), f.id).removed, 1)
  }, { cleanupAttachmentsOnDelete: true }))
}

test('a same-root attachment provider replacement pins a new admission and retains the old cleanup ledger', () => fixture(async f => {
  const item = await f.upload('same hash admitted by a replacement provider')
  await f.queue(item)
  const backend = f.services.get('attachments')
  const guard = backend[Symbol.for('dsh-session-backup.attachment-use.v1')]
  const blocked = guard.blocked
  let switched = false
  let admission
  guard.blocked = function (entry) {
    if (!switched) {
      switched = true
      const replacement = f.makeBackend()
      assert.equal(replacement.root, backend.root, 'the replacement uses the same filesystem corpus')
      f.services.set('attachments', replacement)
      f.remount()
      admission = replacement.saveImage(item.ref)
    }
    return blocked.call(this, entry)
  }
  const result = attachmentResult(await f.success('cleanup-retry', {}), f.id)
  await admission
  assert.equal(switched, true, 'provider replacement occurs between reference scanning and final unlink')
  assert.equal(result.removed, 0)
  assert.equal(result.retained, 1)
  assert.match(result.failed[0].reason, /storage changed/)
  assert.equal(await exists(item.path), true)
  assert.deepEqual((await f.settings()).attachmentPending, [{ sessionId: f.id, count: 1 }])
  const retry = attachmentResult(await f.success('cleanup-retry', {}), f.id)
  assert.equal(retry.deferred, 1, 'the newly admitted receipt stays pinned on the replacement backend')
  assert.equal(await exists(item.path), true)
}, { cleanupAttachmentsOnDelete: true }))

for (const change of ['sessions provider', 'persistence provider', 'persistence root']) {
  test(`a ${change} change during object verification retains the candidate ledger`, () => fixture(async f => {
    const item = await f.upload(`replacement race: ${change}`)
    await f.queue(item)
    const active = { id: 'fixture-stable-live', seq: 7 }
    f.sessions.list = () => [active]
    const backend = f.services.get('attachments')
    const guard = backend[Symbol.for('dsh-session-backup.attachment-use.v1')]
    const blocked = guard.blocked
    let switched = false
    guard.blocked = function (entry) {
      if (!switched) {
        switched = true
        if (change === 'sessions provider') f.services.set('sessions', { ...f.sessions })
        if (change === 'persistence provider') f.services.set('sessionPersistence', { ...f.persistence, config: { ...f.persistence.config } })
        if (change === 'persistence root') f.persistence.config.root = join(f.root, 'different-session-corpus')
      }
      return blocked.call(this, entry)
    }
    const result = attachmentResult(await f.success('cleanup-retry', {}), f.id)
    assert.equal(switched, true)
    assert.equal(result.removed, 0)
    assert.equal(result.retained, 1)
    assert.match(result.failed[0].reason, /storage changed/)
    assert.equal(await exists(item.path), true)
    assert.deepEqual((await f.settings()).attachmentPending, [{ sessionId: f.id, count: 1 }])
    f.services.set('sessions', f.sessions)
    f.services.set('sessionPersistence', f.persistence)
    f.persistence.config.root = join(f.home, 'sessions')
    assert.equal(attachmentResult(await f.success('cleanup-retry', {}), f.id).removed, 1)
  }, { cleanupAttachmentsOnDelete: true }))
}

test('flush explicitly returning false retains the upload and ledger until a successful retry', () => fixture(async f => {
  const item = await f.upload('flush refused durable persistence')
  await f.queue(item)
  const active = { id: 'fixture-undurable-live', seq: 3 }
  f.sessions.list = () => [active]
  const flush = f.sessions.flush
  f.sessions.flush = async session => { f.flushCalls.push(session); return false }
  const result = attachmentResult(await f.success('cleanup-retry', {}), f.id)
  assert.deepEqual(f.flushCalls, [active])
  assert.equal(result.removed, 0)
  assert.equal(result.retained, 1)
  assert.match(result.failed[0].reason, /durability could not be verified/)
  assert.equal(await exists(item.path), true)
  assert.deepEqual((await f.settings()).attachmentPending, [{ sessionId: f.id, count: 1 }])
  f.sessions.flush = flush
  assert.equal(attachmentResult(await f.success('cleanup-retry', {}), f.id).removed, 1)
}, { cleanupAttachmentsOnDelete: true }))

test('a plugin remount during object verification preserves the same backend and allows collection', () => fixture(async f => {
  const item = await f.upload('same providers across a plugin remount')
  await f.queue(item)
  const backend = f.services.get('attachments')
  const guard = backend[Symbol.for('dsh-session-backup.attachment-use.v1')]
  const blocked = guard.blocked
  let remounted = false
  guard.blocked = function (entry) {
    if (!remounted) {
      remounted = true
      f.remount()
      assert.equal(f.services.get('attachments'), backend)
      assert.equal(backend[Symbol.for('dsh-session-backup.attachment-use.v1')], guard)
    }
    return blocked.call(this, entry)
  }
  const result = attachmentResult(await f.success('cleanup-retry', {}), f.id)
  assert.equal(remounted, true)
  assert.equal(result.removed, 1)
  assert.deepEqual(result.failed, [])
  assert.equal(await exists(item.path), false)
  assert.deepEqual((await f.settings()).attachmentPending, [])
}, { cleanupAttachmentsOnDelete: true }))

test('hot first activation remains deferred across remount; a simulated restart permits retry', () => fixture(async f => {
  const item = await f.upload('hot observer candidate')
  await f.queue(item)
  let result = attachmentResult(await f.success('cleanup-retry', {}), f.id)
  assert.equal(result.deferred, 1)
  assert.match(result.failed[0].reason, /Restart/)
  f.services.set('webServer', { port: undefined })
  f.remount()
  result = attachmentResult(await f.success('cleanup-retry', {}), f.id)
  assert.equal(result.deferred, 1, 'remount cannot discard a guard attached to the backend Symbol')
  assert.equal(await exists(item.path), true)
  f.services.set('attachments', f.makeBackend())
  f.remount()
  assert.equal(attachmentResult(await f.success('cleanup-retry', {}), f.id).removed, 1)
}, { cleanupAttachmentsOnDelete: true }, { hot: true }))

test('uploads admitted while disabled stay pinned after enabling cleanup and remounting the plugin', () => fixture(async f => {
  const item = await f.upload('staged while disabled', 'file', ['staged.txt'])
  const backend = f.services.get('attachments')
  const wrapper = backend.saveFile
  assert.equal(await backend.saveFile(item.ref), item.ref)
  await f.queue(item)
  await f.success('cleanup-settings', { cleanupAttachmentsOnDelete: true })
  f.remount()
  assert.equal(backend.saveFile, wrapper, 'the existing backend observer is reused')
  const result = attachmentResult(await f.success('cleanup-retry', {}), f.id)
  assert.equal(result.removed, 0)
  assert.equal(result.deferred, 1)
  assert.equal(await exists(item.path), true)
  for (const alias of item.aliases) assert.equal(await exists(alias), true)
}))

test('an in-flight upload admission blocks route cleanup until it settles', () => fixture(async f => {
  const item = await f.upload('existing object during admission')
  await f.queue(item)
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const backend = f.makeBackend()
  backend.saveImage = async () => pending
  f.services.set('attachments', backend)
  f.remount()
  const admission = backend.saveImage('raw new bytes')
  const deferred = attachmentResult(await f.success('cleanup-retry', {}), f.id)
  assert.equal(deferred.deferred, 1)
  assert.equal(await exists(item.path), true)
  finish({ complete: true })
  await admission
  assert.equal(attachmentResult(await f.success('cleanup-retry', {}), f.id).removed, 1)
}, { cleanupAttachmentsOnDelete: true }))

test('a corrupt unrelated compressed log reports retained upload cleanup without touching cache', () => fixture(async f => {
  const item = await f.upload('queued behind corrupt history')
  await f.queue(item)
  const other = await f.createSession()
  await writeFile(join(other.dir, 'session.v1.jsonl.zstd'), 'not zstd')
  const cache = join(f.home, 'attachments', 'v1', 'cache', 'keep.png')
  await mkdir(dirname(cache), { recursive: true })
  await writeFile(cache, 'cache content')
  const result = attachmentResult(await f.success('cleanup-retry', {}), f.id)
  assert.equal(result.removed, 0)
  assert.equal(result.retained, 1)
  assert.equal(result.failed.length, 1)
  assert.equal(await exists(item.path), true)
  assert.equal(await readFile(cache, 'utf8'), 'cache content')
}, { cleanupAttachmentsOnDelete: true }))

let failures = 0
for (const { name, run } of cases) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { failures += 1; console.error(`✗ ${name}\n${error.stack ?? error}`) }
}
console.log(`${cases.length - failures}/${cases.length} attachment route tests passed`)
if (failures) process.exitCode = 1
