/** Route-level optional cleanup regressions. All real files belong to one verified temporary root per case. */
import assert from 'node:assert/strict'
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { SessionArtifactStore } from '../artifacts.js'

const ROOT_PREFIX = 'dsh-cleanup-routes-'
const API = '/api/session.backup'
const cases = []
const test = (name, run) => cases.push({ name, run })
const exists = async path => {
  try { await lstat(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function fixture(run, config = {}) {
  const temporaryParent = await realpath(tmpdir())
  const root = await realpath(await mkdtemp(join(temporaryParent, ROOT_PREFIX)))
  assert.equal(dirname(root), temporaryParent)
  assert.ok(basename(root).startsWith(ROOT_PREFIX))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await mkdir(home, { mode: 0o700 })
  await mkdir(workspace, { mode: 0o700 })
  const records = new Map()
  const live = new Map()
  const routes = new Map()
  const services = new Map()
  const effects = []
  const warnings = []
  const editCalls = []
  const events = []
  const state = { removeError: null, beforeRemove: null, afterRemove: null, removes: 0 }

  const verifyOwned = async path => {
    const target = resolve(path)
    const relation = relative(root, target)
    assert.ok(relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation),
      `mutation target must be strictly inside the test-owned root: ${target}`)
    let ancestor = target
    while (!(await exists(ancestor))) ancestor = dirname(ancestor)
    assert.equal(await realpath(ancestor), ancestor, 'a mutation may not follow a redirected test path')
    return target
  }
  const removeOwned = async (path, options = {}) => rm(await verifyOwned(path), options)
  const replaceOwned = async (path, content) => {
    const replacement = join(dirname(path), `test-replacement-${randomUUID()}`)
    await writeFile(replacement, content, { mode: 0o600 })
    await verifyOwned(replacement)
    await verifyOwned(path)
    await rename(replacement, path)
  }
  const createSession = async () => {
    const id = `session-${randomUUID()}`
    const dir = join(home, 'sessions', 'fixture-project', id)
    const log = join(dir, 'session.v4.jsonl')
    await mkdir(dir, { recursive: true })
    await writeFile(log, 'original\n')
    const record = { id, dir, log }
    records.set(id, record)
    live.set(id, { id })
    return record
  }
  const primary = await createSession()
  const persistence = {
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
      assert.ok(record, 'native remove addresses fixture sessions only')
      state.removes += 1
      if (state.removeError) throw state.removeError
      await state.beforeRemove?.(record)
      await removeOwned(record.dir, { recursive: true })
      await state.afterRemove?.(record)
    },
  }
  const sessions = {
    get: id => live.get(id),
    flush: async () => {},
    store: { get: id => live.has(id) ? { detach: () => live.delete(id) } : undefined },
  }
  const entry = { id: 'session-backup-test-entry', config: { home, ...config } }
  const editor = {
    async edit(target, update) {
      assert.equal(target, entry, 'the live fiber entry is passed to configEditor')
      assert.equal(typeof update, 'function')
      const current = structuredClone(entry.config)
      const next = update(current)
      editCalls.push({ target, current, next })
      entry.config = next
    },
  }
  services.set('sessionPersistence', persistence)
  services.set('sessions', sessions)
  services.set('configEditor', editor)
  const ctx = {
    fiber: { entry },
    get: name => services.get(name),
    provide(name, service) { services.set(name, service) },
    logger: { warn: message => warnings.push(String(message)), error: message => warnings.push(String(message)) },
    waterfall: async () => [],
    parallel: async () => {},
    emit: (name, id) => events.push({ name, id }),
    connection: { fetch: { register(route) {
      assert.equal(routes.has(route.path), false, `route registered only once: ${route.path}`)
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
    assert.ok(route, `actual apply() route registered: ${path}`)
    assert.ok(route.methods.includes(method), `${method} is supported for ${path}`)
    const init = { method }
    if (method !== 'GET' && method !== 'HEAD') {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body ?? {})
    }
    const response = await route.fetch(new Request(`http://fixture.invalid${path}`, init))
    assert.match(response.headers.get('content-type'), /^application\/json/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return { status: response.status, body: await response.json() }
  }
  const success = async (action, body, method) => {
    const result = await request(action, body, method)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    return result.body
  }
  const f = {
    ...primary, root, home, workspace, records, live, routes, services, effects, warnings, events,
    editCalls, entry, editor, ctx, state, persistence, sessions, createSession, verifyOwned, removeOwned,
    replaceOwned, request, success, remount,
    store: new SessionArtifactStore(home),
    facade: () => services.get('sessionArtifacts'),
    settings: async () => (await success('cleanup-settings', undefined, 'GET')).settings,
    backups: async () => (await success('list', undefined, 'GET')).backups,
  }
  try { await run(f) }
  finally {
    for (const dispose of effects.splice(0)) dispose?.()
    const target = await realpath(root)
    assert.equal(target, root, 'test root identity remains canonical before recursive cleanup')
    assert.equal(dirname(target), temporaryParent, 'only this direct test-owned temp child is removed')
    assert.ok(basename(target).startsWith(ROOT_PREFIX))
    await rm(target, { recursive: true, force: true })
  }
}

const pendingFor = async (f, id = f.id) => (await f.settings()).pending.find(row => row.sessionId === id)
const save = (f, name = 'screenshot.png', data = 'owned screenshot', id = f.id) => f.facade().save(id, name, data)
const assertError = (result, status, code) => {
  assert.equal(result.status, status, JSON.stringify(result.body))
  if (code) assert.equal(result.body.error.code, code)
  assert.equal(typeof result.body.error.message, 'string')
}

test('apply exposes seven actual routes and default-off settings, including editable capability', () => fixture(async f => {
  assert.deepEqual([...f.routes.keys()].sort(), [
    'cleanup-retry', 'cleanup-settings', 'create', 'delete', 'list', 'remove', 'restore',
  ].map(action => `${API}.${action}`).sort())
  assert.deepEqual(await f.settings(), {
    cleanupOnDelete: false, cleanupAttachmentsOnDelete: false,
    editable: true, pending: [], attachmentPending: [],
  })
  assert.equal(typeof f.facade()?.save, 'function')
}))

test('default-off policy ignores a request-body cleanup override and does not mark inventory pending', () => fixture(async f => {
  const artifact = await save(f)
  const response = await f.success('delete', { sessionId: f.id, cleanupOnDelete: true })
  assert.deepEqual(response.deleted, { deleted: true })
  assert.equal(await exists(f.log), false)
  assert.equal(await readFile(artifact.path, 'utf8'), 'owned screenshot')
  assert.equal(await pendingFor(f), undefined)
  assert.equal((await f.backups()).length, 1)
  assertError(await f.request('cleanup-retry', { cleanupOnDelete: true }), 409, 'session-backup/conflict')
  assert.equal(await exists(artifact.path), true)
}))

test('enabled cleanup follows final backup and log removal, preserving every unrelated file', () => fixture(async f => {
  const owned = await save(f)
  const second = await save(f, 'tool-output.txt', 'private text')
  const other = await f.createSession()
  const otherArtifact = await save(f, 'other.png', 'other session', other.id)
  const workspaceFile = join(f.workspace, 'report.png')
  const sharedAttachment = join(f.home, 'attachments', 'v1', 'objects', 'shared.png')
  const unregistered = join(dirname(owned.path), 'unregistered.png')
  await writeFile(workspaceFile, 'user file')
  await mkdir(dirname(sharedAttachment), { recursive: true })
  await writeFile(sharedAttachment, 'shared attachment')
  await writeFile(unregistered, 'unregistered', { mode: 0o600 })
  f.ctx.parallel = async (event, { sessionId }) => {
    assert.equal(event, 'workspace/session-stop')
    assert.equal(sessionId, f.id)
    await appendFile(f.log, 'stop completed\n')
  }
  let sawFinalBackup = false
  let sawRemovedLogBeforeArtifactCleanup = false
  f.state.beforeRemove = async () => {
    assert.equal(await exists(owned.path), true, 'artifacts remain until the log is removed')
    assert.equal(await exists(second.path), true)
    assert.equal((await pendingFor(f)).count, 2, 'intent is durable before removal')
    const backups = await f.backups()
    assert.equal(backups.length, 1)
    assert.equal(await readFile(join(backups[0].path, 'session.v4.jsonl'), 'utf8'), 'original\nstop completed\n')
    sawFinalBackup = true
  }
  f.state.afterRemove = async () => {
    assert.equal(await exists(f.log), false)
    assert.equal(await exists(owned.path), true)
    sawRemovedLogBeforeArtifactCleanup = true
  }
  const { deleted } = await f.success('delete', { sessionId: f.id, stopActivity: true, cleanupOnDelete: false })
  assert.equal(sawFinalBackup, true)
  assert.equal(sawRemovedLogBeforeArtifactCleanup, true)
  assert.deepEqual(deleted.cleanup, { removed: 2, bytes: owned.bytes + second.bytes, retained: 0, failed: [] })
  for (const path of [owned.path, second.path]) assert.equal(await exists(path), false)
  assert.equal(await readFile(workspaceFile, 'utf8'), 'user file')
  assert.equal(await readFile(sharedAttachment, 'utf8'), 'shared attachment')
  assert.equal(await readFile(unregistered, 'utf8'), 'unregistered')
  assert.equal(await readFile(otherArtifact.path, 'utf8'), 'other session')
  assert.equal(await exists(other.log), true)
  assert.deepEqual((await f.settings()).pending, [])
  assert.deepEqual(f.events, [{ name: 'api-session/removed', id: f.id }])
}, { cleanupOnDelete: true }))

test('a final-backup failure preserves the log and registered artifact; deleting again can recover', () => fixture(async f => {
  const artifact = await save(f)
  const { backup } = await f.success('create', { sessionId: f.id })
  await appendFile(f.log, 'latest\n')
  const staging = join(f.home, 'backups', 'sessions', '.pending')
  await f.removeOwned(staging, { recursive: true })
  await writeFile(staging, 'blocked staging')
  const refused = await f.request('delete', { sessionId: f.id })
  assertError(refused, 500)
  assert.match(refused.body.error.message, /final backup could not be saved/)
  assert.equal(await readFile(f.log, 'utf8'), 'original\nlatest\n')
  assert.equal(await exists(artifact.path), true)
  assert.equal(await pendingFor(f), undefined)
  assert.equal(await readFile(join(backup.path, 'session.v4.jsonl'), 'utf8'), 'original\n')
  assert.equal(f.state.removes, 0)
  await f.removeOwned(staging)
  const result = await f.success('delete', { sessionId: f.id })
  assert.equal(result.deleted.cleanup.removed, 1)
  assert.equal(await exists(artifact.path), false)
}, { cleanupOnDelete: true }))

test('a stop/schedule purge failure preserves the log and artifacts without creating cleanup intent', () => fixture(async f => {
  const artifact = await save(f)
  f.services.set('schedule', { deleteSessionTasks: async () => { throw new Error('fixture schedule purge failed') } })
  const result = await f.request('delete', { sessionId: f.id, stopActivity: true })
  assertError(result, 500)
  assert.match(result.body.error.message, /scheduled reminders could not be removed/)
  assert.equal(await exists(f.log), true)
  assert.equal(await exists(artifact.path), true)
  assert.equal(await pendingFor(f), undefined)
  assert.equal(f.state.removes, 0)
  assert.equal((await f.backups()).length, 1, 'preflight retains a safe backup before stopping or purging reminders')
  f.services.delete('schedule')
  assert.equal((await f.success('delete', { sessionId: f.id })).deleted.cleanup.removed, 1)
}, { cleanupOnDelete: true }))

test('a refused native log removal cancels intent only after proving the log exists', () => fixture(async f => {
  const artifact = await save(f)
  f.state.removeError = new Error('fixture remove refused')
  assertError(await f.request('delete', { sessionId: f.id }), 500)
  assert.equal(await exists(f.log), true)
  assert.equal(await exists(artifact.path), true)
  assert.equal(await pendingFor(f), undefined, 'proven-live inventory can accept new artifacts again')
  const later = await save(f, 'later.txt', 'still live')
  f.state.removeError = null
  assert.equal((await f.success('delete', { sessionId: f.id })).deleted.cleanup.removed, 2)
  assert.equal(await exists(artifact.path), false)
  assert.equal(await exists(later.path), false)
}, { cleanupOnDelete: true }))

test('unknown state after refused log removal keeps intent; retry refuses until absence is proven', () => fixture(async f => {
  const artifact = await save(f)
  const stat = f.persistence.stat
  f.persistence.remove = async () => {
    f.persistence.stat = async () => { throw new Error('fixture stat unavailable') }
    throw new Error('fixture removal outcome unknown')
  }
  assertError(await f.request('delete', { sessionId: f.id }), 500)
  assert.equal(await exists(f.log), true)
  assert.equal(await exists(artifact.path), true)
  assert.equal((await pendingFor(f)).count, 1)
  const first = await f.success('cleanup-retry', {})
  assert.equal(first.results[0].removed, 0)
  assert.equal(first.results[0].failed.length, 1)
  f.persistence.stat = stat
  const second = await f.success('cleanup-retry', {})
  assert.equal(second.results[0].removed, 0)
  assert.match(second.results[0].failed[0].reason, /still exists/)
  assert.equal(await exists(artifact.path), true)
  assert.equal((await pendingFor(f)).count, 1)
}, { cleanupOnDelete: true }))

for (const mutation of ['modified', 'replaced']) {
  test(`${mutation} artifacts report partial cleanup, remain pending on repeat delete, and recover on retry`, () => fixture(async f => {
    const intact = await save(f, 'intact.png', 'intact')
    const changed = await save(f, 'changed.png', 'before')
    if (mutation === 'modified') await writeFile(changed.path, 'changed after registration')
    else await f.replaceOwned(changed.path, 'replacement file')
    const { deleted } = await f.success('delete', { sessionId: f.id })
    assert.equal(deleted.deleted, true)
    assert.equal(deleted.cleanup.removed, 1)
    assert.equal(deleted.cleanup.bytes, intact.bytes)
    assert.equal(deleted.cleanup.retained, 1)
    assert.equal(deleted.cleanup.failed[0].id, changed.id)
    assert.match(deleted.cleanup.failed[0].reason, /modified|replaced|changed/)
    assert.equal(await exists(f.log), false)
    assert.equal(await exists(intact.path), false)
    assert.equal(await exists(changed.path), true)
    assert.equal((await pendingFor(f)).count, 1)
    const repeat = await f.success('delete', { sessionId: f.id })
    assert.equal(repeat.deleted.cleanup.removed, 0)
    assert.equal(repeat.deleted.cleanup.retained, 1)
    assert.equal(f.state.removes, 1, 'repeat deletion does not remove the log twice')
    await f.removeOwned(changed.path)
    const retry = await f.success('cleanup-retry', {})
    assert.deepEqual(retry.results, [{ sessionId: f.id, removed: 0, bytes: 0, retained: 0, failed: [] }])
    assert.deepEqual(retry.settings.pending, [])
  }, { cleanupOnDelete: true }))
}

test('retry processes only pending, proven-absent inventories and ignores caller-supplied session ids', () => fixture(async f => {
  const pending = await save(f)
  const other = await f.createSession()
  const unmarked = await save(f, 'unmarked.png', 'unmarked', other.id)
  await f.removeOwned(f.dir, { recursive: true })
  await f.removeOwned(other.dir, { recursive: true })
  f.live.delete(f.id)
  f.live.delete(other.id)
  await f.store.markPending(f.id)
  const result = await f.success('cleanup-retry', { sessionId: other.id, path: unmarked.path })
  assert.deepEqual(result.results, [{ sessionId: f.id, removed: 1, bytes: pending.bytes, retained: 0, failed: [] }])
  assert.equal(await exists(pending.path), false)
  assert.equal(await readFile(unmarked.path, 'utf8'), 'unmarked')
}, { cleanupOnDelete: true }))

for (const blocker of ['no stat service', 'stat error', 'persisted session', 'live session', 'on-disk session']) {
  test(`retry retains pending artifacts when absence is blocked by ${blocker}`, () => fixture(async f => {
    const artifact = await save(f)
    await f.store.markPending(f.id)
    if (blocker !== 'persisted session' && blocker !== 'on-disk session') await f.removeOwned(f.dir, { recursive: true })
    if (blocker !== 'live session') f.live.delete(f.id)
    if (blocker === 'no stat service') delete f.persistence.stat
    if (blocker === 'stat error') f.persistence.stat = async () => { throw new Error('stat probe failed') }
    if (blocker === 'on-disk session') f.persistence.stat = async () => undefined
    const result = await f.success('cleanup-retry', {})
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].sessionId, f.id)
    assert.equal(result.results[0].removed, 0)
    assert.equal(result.results[0].failed.length, 1)
    assert.equal(await exists(artifact.path), true)
    assert.equal((await pendingFor(f)).count, 1)
  }, { cleanupOnDelete: true }))
}

test('restore cancels pending cleanup and consumes the backup; retries cannot delete restored artifacts', () => fixture(async f => {
  const artifact = await save(f)
  await writeFile(artifact.path, 'edited screenshot is retained')
  const { deleted } = await f.success('delete', { sessionId: f.id })
  assert.equal(deleted.cleanup.retained, 1)
  assert.equal((await pendingFor(f)).count, 1)
  const backups = await f.backups()
  assert.equal(backups.length, 1)
  const { restored } = await f.success('restore', { path: backups[0].path })
  assert.equal(restored.sessionId, f.id)
  assert.equal(restored.backupConsumed, true)
  assert.equal(await readFile(f.log, 'utf8'), 'original\n')
  assert.equal(await readFile(artifact.path, 'utf8'), 'edited screenshot is retained')
  assert.deepEqual((await f.settings()).pending, [])
  assert.deepEqual((await f.success('cleanup-retry', {})).results, [])
  assert.equal((await f.backups()).length, 0)
  const newArtifact = await save(f, 'restored.txt', 'belongs to restored session')
  assert.equal(await exists(newArtifact.path), true)
}, { cleanupOnDelete: true }))

test('settings POST uses configEditor and the current fiber entry while preserving unrelated configuration', () => fixture(async f => {
  const initial = structuredClone(f.entry.config)
  const saved = await f.success('cleanup-settings', { cleanupOnDelete: true, home: '/must-not-be-used', other: 999 })
  assert.equal(saved.settings.cleanupOnDelete, true)
  assert.equal(saved.settings.editable, true)
  assert.equal(f.editCalls.length, 1)
  assert.deepEqual(f.editCalls[0].current, initial)
  assert.deepEqual(f.entry.config, { ...initial, cleanupOnDelete: true })
  f.remount() // ConfigEditor normally remounts the plugin with the saved config.
  assert.equal((await f.settings()).cleanupOnDelete, true)
  const artifact = await save(f)
  assert.equal((await f.success('delete', { sessionId: f.id })).deleted.cleanup.removed, 1)
  assert.equal(await exists(artifact.path), false)
}, { other: { retained: ['custom', 3] } }))

test('invalid settings never reach configEditor or alter policy', () => fixture(async f => {
  for (const value of [undefined, null, 'true', 1, [], {}]) {
    const body = value === undefined ? {} : { cleanupOnDelete: value }
    assertError(await f.request('cleanup-settings', body), 400, 'session-backup/bad-request')
  }
  assert.equal(f.editCalls.length, 0)
  assert.equal((await f.settings()).cleanupOnDelete, false)
}))

for (const missing of ['editor', 'fiber entry']) {
  test(`settings reports read-only capability and refuses saving without ${missing}`, () => fixture(async f => {
    if (missing === 'editor') f.services.delete('configEditor')
    else delete f.ctx.fiber.entry
    assert.equal((await f.settings()).editable, false)
    assertError(await f.request('cleanup-settings', { cleanupOnDelete: true }), 409, 'session-backup/conflict')
    assert.equal(f.editCalls.length, 0)
  }))
}

test('a failed configEditor write is reported and leaves the previous persisted config intact', () => fixture(async f => {
  const initial = structuredClone(f.entry.config)
  f.services.set('configEditor', { edit: async () => { throw new Error('fixture config write refused') } })
  const result = await f.request('cleanup-settings', { cleanupOnDelete: true })
  assertError(result, 500)
  assert.match(result.body.error.message, /config write refused/)
  assert.deepEqual(f.entry.config, initial)
  assert.equal((await f.settings()).cleanupOnDelete, false)
}))

test('the producer facade allocates only for live persisted sessions and rejects path-like filenames', () => fixture(async f => {
  const unknown = `session-${randomUUID()}`
  await assert.rejects(save(f, 'unknown.png', 'unknown', unknown), error => error.code === 'session/not-found')
  assert.equal(await exists(join(f.home, 'session-artifacts')), false, 'unknown session creates no store')
  await assert.rejects(save(f, '../workspace-user-file.png'), /filename/)
  assert.equal(await exists(join(f.home, 'session-artifacts')), false)
  const artifact = await save(f)
  let attemptedDuringDeletion = false
  f.state.beforeRemove = async () => {
    await assert.rejects(save(f, 'racing.png'), error => error.code === 'session-backup/conflict')
    attemptedDuringDeletion = true
  }
  await f.success('delete', { sessionId: f.id })
  assert.equal(attemptedDuringDeletion, true)
  assert.equal(await exists(artifact.path), false)
  await assert.rejects(save(f, 'after-delete.png'), error => error.code === 'session/not-found')
  assert.deepEqual((await f.settings()).pending, [])
}, { cleanupOnDelete: true }))

test('the producer facade refuses allocation when persisted session state cannot be verified', () => fixture(async f => {
  delete f.persistence.stat
  await assert.rejects(save(f), error => error.code === 'session/not-found')
  assert.equal(await exists(join(f.home, 'session-artifacts')), false)
}))

test('a corrupt ledger is reported without blocking settings or healthy pending cleanup', () => fixture(async f => {
  const healthy = await save(f, 'healthy.png', 'healthy')
  const other = await f.createSession()
  const corrupt = await save(f, 'corrupt.png', 'retained', other.id)
  await f.store.markPending(f.id)
  await f.store.markPending(other.id)
  await f.removeOwned(f.dir, { recursive: true })
  await f.removeOwned(other.dir, { recursive: true })
  f.live.delete(f.id)
  f.live.delete(other.id)
  const ledger = join(f.home, 'session-artifacts', 'registry', `${other.id}.json`)
  await writeFile(await f.verifyOwned(ledger), '{broken-json')
  const settings = await f.settings()
  assert.deepEqual(settings.pending.map(row => row.sessionId), [f.id])
  assert.equal(settings.pendingErrors.length, 1)
  assert.equal(settings.pendingErrors[0].sessionId, other.id)
  assert.equal(typeof settings.pendingErrors[0].reason, 'string')
  const result = await f.success('cleanup-retry', {})
  assert.equal(result.results.find(row => row.sessionId === f.id).removed, 1)
  assert.equal(result.results.find(row => row.sessionId === other.id).failed.length, 1)
  assert.equal(await exists(healthy.path), false)
  assert.equal(await readFile(corrupt.path, 'utf8'), 'retained')
  assert.equal(await readFile(ledger, 'utf8'), '{broken-json')
  assert.deepEqual(result.settings.pending, [])
  assert.equal(result.settings.pendingErrors[0].sessionId, other.id)
}, { cleanupOnDelete: true }))

let failures = 0
for (const { name, run } of cases) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { failures += 1; console.error(`✗ ${name}\n${error.stack ?? error}`) }
}
console.log(`${cases.length - failures}/${cases.length} optional cleanup route tests passed`)
if (failures > 0) process.exitCode = 1
