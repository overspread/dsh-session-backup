/** Regression scenarios for manual backup followed by deletion, using real files and registered HTTP handlers. */
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat as fsstat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, backupRoot, createBackup, listBackups, removeBackup, restoreBackup } from '../index.js'

const cases = []
const test = (name, run) => cases.push({ name, run })

const exists = (p) => fsstat(p).then(() => true, () => false)

async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-backup-regression-'))
  const id = `session-${randomUUID()}`
  const dir = join(home, 'sessions', 'project', id)
  const log = join(dir, 'session.v4.jsonl')
  await mkdir(dir, { recursive: true })
  await writeFile(log, 'original\n')
  const routes = new Map()
  const options = { home }
  const ctx = {
    get(name) {
      if (name === 'sessionPersistence') return {
        stat: async () => readFile(log).then(() => ({ header: {} }), () => undefined),
        open: async () => ({ close: async () => {} }),
        remove: async () => { await rm(dir, { recursive: true }) },
      }
    },
    logger: { warn() {}, error() {} },
    waterfall: async () => [],
    parallel: async () => {},
    emit() {},
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    effect: runEffect => runEffect(),
  }
  apply(ctx, options)
  const postRaw = async (action, body) => {
    const response = await routes.get(`/api/session.backup.${action}`).fetch(new Request('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    return { status: response.status, data: await response.json() }
  }
  const post = async (action, body) => {
    const { status, data } = await postRaw(action, body)
    assert.equal(status, 200, JSON.stringify(data))
    return data
  }
  const backups = () => listBackups(backupRoot(home))
  try { await run({ home, id, dir, log, ctx, post, postRaw, backups, options }) }
  finally {
    const target = await realpath(home)
    assert.ok(target.startsWith(`${await realpath(tmpdir())}/dsh-backup-regression-`))
    await rm(target, { recursive: true, force: true })
  }
}

test('changed log: delete preflight refreshes the existing backup, preserving the latest bytes', () => fixture(async f => {
  const first = await createBackup(f.ctx, f.id, f.options)
  await appendFile(f.log, 'new event\n')
  const refreshed = await createBackup(f.ctx, f.id, { ...f.options, beforeDelete: true })
  assert.equal((await f.backups()).length, 1, 'pre-delete backup must not add a second directory')
  assert.equal(refreshed.path, first.path)
  assert.equal(await readFile(join(first.path, 'session.v4.jsonl'), 'utf8'), 'original\nnew event\n')
}))

test('simultaneous manual and pre-delete backups produce exactly one valid backup', () => fixture(async f => {
  const results = await Promise.allSettled([
    createBackup(f.ctx, f.id, { ...f.options, stamp: '20261115-100001' }),
    createBackup(f.ctx, f.id, { ...f.options, beforeDelete: true, stamp: '20261115-100002' }),
  ])
  assert.ok(results.every(result => result.status === 'fulfilled'), 'both requests must finish successfully')
  assert.equal((await f.backups()).length, 1)
}))

test('equal-sized edits refresh bytes instead of treating the backup as identical', () => fixture(async f => {
  const first = await createBackup(f.ctx, f.id, f.options)
  await writeFile(f.log, 'modified\n')
  assert.equal(Buffer.byteLength('original\n'), Buffer.byteLength('modified\n'))
  const updated = await createBackup(f.ctx, f.id, { ...f.options, beforeDelete: true })
  assert.equal(updated.updated, true)
  assert.equal((await f.backups()).length, 1)
  assert.equal(await readFile(join(first.path, 'session.v4.jsonl'), 'utf8'), 'modified\n')
}))

test('v1 backups without inventory are refreshed and keep their original path', () => fixture(async f => {
  const first = await createBackup(f.ctx, f.id, f.options)
  const manifestPath = join(first.path, 'backup.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.version = 1
  delete manifest.inventory
  await writeFile(manifestPath, JSON.stringify(manifest))
  await appendFile(f.log, 'latest\n')
  const updated = await createBackup(f.ctx, f.id, { ...f.options, beforeDelete: true })
  assert.equal(updated.path, first.path)
  assert.equal(updated.version, 2)
  assert.equal((await f.backups()).length, 1)
  assert.equal(await readFile(join(first.path, 'session.v4.jsonl'), 'utf8'), 'original\nlatest\n')
}))

test('cached client create requests refresh instead of creating an extra backup', () => fixture(async f => {
  await f.post('create', { sessionId: f.id })
  await appendFile(f.log, 'after manual backup\n')
  await f.post('create', { sessionId: f.id })
  assert.equal((await f.backups()).length, 1)
}))

test('full delete route captures stop-time events in one backup, which restores completely', () => fixture(async f => {
  await f.post('create', { sessionId: f.id })
  await appendFile(f.log, 'new message\n')
  f.ctx.parallel = async () => { await appendFile(f.log, 'stop completed\n') }
  await f.post('delete', { sessionId: f.id, stopActivity: true })
  const copies = await f.backups()
  assert.equal(copies.length, 1)
  const expected = 'original\nnew message\nstop completed\n'
  assert.equal(await readFile(join(copies[0].path, 'session.v4.jsonl'), 'utf8'), expected)
  await restoreBackup(copies[0].path, f.options)
  assert.equal(await readFile(f.log, 'utf8'), expected)
  assert.equal((await f.backups()).length, 0, 'successful restore still consumes the backup')
}))

test('cached-client preflight followed by deletion still produces one latest backup', () => fixture(async f => {
  await f.post('create', { sessionId: f.id })
  await appendFile(f.log, 'changed\n')
  await f.post('create', { sessionId: f.id })
  await f.post('delete', { sessionId: f.id })
  const copies = await f.backups()
  assert.equal(copies.length, 1)
  assert.equal(await readFile(join(copies[0].path, 'session.v4.jsonl'), 'utf8'), 'original\nchanged\n')
}))

test('a failed replacement keeps the old backup and live session intact', () => fixture(async f => {
  const first = await createBackup(f.ctx, f.id, f.options)
  await appendFile(f.log, 'new event\n')
  // A filesystem failure allocating the new copy must not erase the old one.
  const { rmdir } = await import('node:fs/promises')
  const pending = join(backupRoot(f.home), '.pending')
  assert.equal(pending, join(f.home, 'backups', 'sessions', '.pending'))
  await rmdir(pending)
  await writeFile(pending, 'cannot allocate staging here')
  await assert.rejects(createBackup(f.ctx, f.id, { ...f.options, beforeDelete: true }))
  assert.equal(await readFile(join(first.path, 'session.v4.jsonl'), 'utf8'), 'original\n')
  assert.equal(await readFile(f.log, 'utf8'), 'original\nnew event\n')
  assert.equal((await f.backups()).length, 1)
}))

test('a backup failure in the delete route leaves the session and last good backup', () => fixture(async f => {
  const first = await createBackup(f.ctx, f.id, f.options)
  await appendFile(f.log, 'not yet backed up\n')
  const { rmdir } = await import('node:fs/promises')
  const pending = join(backupRoot(f.home), '.pending')
  assert.equal(pending, join(f.home, 'backups', 'sessions', '.pending'))
  await rmdir(pending)
  await writeFile(pending, 'cannot stage')
  await assert.rejects(f.post('delete', { sessionId: f.id }), /final backup could not be saved/)
  assert.equal(await readFile(f.log, 'utf8'), 'original\nnot yet backed up\n')
  assert.equal(await readFile(join(first.path, 'session.v4.jsonl'), 'utf8'), 'original\n')
}))

test('filesystem deletion holds the write lease until the log is gone', () => fixture(async f => {
  const baseGet = f.ctx.get
  const persistence = baseGet('sessionPersistence')
  delete persistence.remove // installed rc.3 filesystem-delete branch
  let held = false
  let checked = false
  persistence.open = async () => {
    assert.equal(held, false)
    held = true
    return { close: async () => {
      await assert.rejects(readFile(f.log), { code: 'ENOENT' })
      held = false
    } }
  }
  const stat = persistence.stat
  persistence.stat = async () => {
    const result = await stat()
    if (result === undefined) {
      assert.equal(held, true, 'lease remains held through filesystem removal and verification')
      checked = true
    }
    return result
  }
  f.ctx.get = name => name === 'sessionPersistence' ? persistence : baseGet(name)
  await f.post('delete', { sessionId: f.id })
  assert.equal(checked, true)
  assert.equal(held, false)
  assert.equal((await f.backups()).length, 1)
}))

test('remove and restore cannot consume a final backup while deletion is saving it', () => fixture(async f => {
  const first = await createBackup(f.ctx, f.id, f.options)
  await appendFile(f.log, 'final content\n')
  let resume
  let entered
  const barrier = new Promise(resolve => { resume = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  const baseGet = f.ctx.get
  f.ctx.get = name => name === 'sessions'
    ? { get: () => ({}), flush: async () => { entered(); await barrier } }
    : baseGet(name)
  const deletion = f.post('delete', { sessionId: f.id })
  try {
    await ready
    await assert.rejects(removeBackup(first.path, f.options), /being deleted/)
    await assert.rejects(restoreBackup(first.path, f.options), /being deleted/)
  } finally { resume(); await deletion }
  assert.equal((await f.backups()).length, 1)
  assert.equal(await readFile(join(first.path, 'session.v4.jsonl'), 'utf8'), 'original\nfinal content\n')
}))

// Half-deleted residues: the log directory vanished (an earlier delete died
// between directory removal and cleanup) but the projection checkpoint / live
// in-memory Session survived, so the Sidebar still lists a row every retry
// answers 404 for. Such an id must be finished, not refused.
test('half-deleted residue (log gone, projection cache left) is cleaned, not 404', () => fixture(async f => {
  const cache = join(f.home, 'storages', 'session_projcache', 'sessions', `${f.id}.json`)
  await mkdir(join(cache, '..'), { recursive: true })
  await writeFile(cache, '{"rows":[]}')
  await rm(f.dir, { recursive: true, force: true })
  const events = []
  f.ctx.emit = (name, id) => events.push({ name, id })
  const body = await f.post('delete', { sessionId: f.id })
  assert.deepEqual(body.deleted, { deleted: true, alreadyGone: true }, 'residue delete reports done-not-found')
  assert.equal(await exists(cache), false, 'projection residue removed')
  assert.deepEqual(events, [{ name: 'api-session/removed', id: f.id }], 'sidebar removal event emitted')
  assert.equal((await f.backups()).length, 0, 'nothing to copy: no backup written for a vanished log')
}))

test('half-deleted residue with a live in-memory Session is detached and cleaned', () => fixture(async f => {
  const persistence = f.ctx.get('sessionPersistence')
  let detached = 0
  const entry = { detach: () => { detached += 1 } }
  const sessions = {
    get: (id) => (id === f.id ? { id } : undefined),
    store: { get: (id) => (id === f.id ? entry : undefined) },
  }
  f.ctx.get = (name) =>
    name === 'sessionPersistence' ? persistence
      : name === 'sessions' ? sessions
        : undefined
  await rm(f.dir, { recursive: true, force: true })
  const events = []
  f.ctx.emit = (name, id) => events.push({ name, id })
  const body = await f.post('delete', { sessionId: f.id })
  assert.deepEqual(body.deleted, { deleted: true, alreadyGone: true })
  assert.equal(detached, 1, 'live store entry detached so the id stops being visible')
  assert.deepEqual(events, [{ name: 'api-session/removed', id: f.id }], 'sidebar removal event emitted')
  assert.equal((await f.backups()).length, 0)
}))

test('an id with no log and no residue is still refused as not found', () => fixture(async f => {
  await rm(f.dir, { recursive: true, force: true })
  const { status, data } = await f.postRaw('delete', { sessionId: f.id })
  assert.equal(status, 404, 'a genuinely unknown id keeps the 404 refusal')
  assert.equal(data.error.code, 'session/not-found')
}))

// The failure that stranded this session in the first place: cache cleanup was
// best-effort AND ran after the log was already gone, so one failed step left a
// Sidebar row no delete could ever reach. Cleanup now runs first and aborts.
test('a failing cache step aborts the delete and leaves the log retryable', () => fixture(async f => {
  const persistence = f.ctx.get('sessionPersistence')
  f.ctx.get = (name) => name === 'sessionPersistence'
    ? persistence
    : name === 'sessionProjectionCache'
      ? { invalidate: async () => { throw new Error('projection cache unavailable') } }
      : undefined
  const { status, data } = await f.postRaw('delete', { sessionId: f.id })
  assert.equal(status, 500, 'a real cleanup failure refuses the delete')
  assert.match(data.error.message, /could not be cleared/)
  assert.equal(await exists(f.log), true, 'nothing is half-deleted: the log survives for a retry')
}))

let failures = 0
for (const { name, run } of cases) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { failures += 1; console.error(`✗ ${name}: ${error.message}`) }
}
if (failures > 0) process.exitCode = 1
