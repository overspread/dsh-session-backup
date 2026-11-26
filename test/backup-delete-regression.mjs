/** Regression scenarios for manual backup followed by deletion, using real files and registered HTTP handlers. */
import assert from 'node:assert/strict'
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat as fsstat, symlink, writeFile } from 'node:fs/promises'
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

// A deleted log stays deleted even if a derived cache is unavailable. The
// response reports the warning, and idempotent retry revisits failed cleanup.
test('cache failure reports a completed deletion with a warning and remains retryable', () => fixture(async f => {
  const persistence = f.ctx.get('sessionPersistence')
  let unavailable = true
  let invalidations = 0
  f.ctx.get = (name) => name === 'sessionPersistence'
    ? persistence
    : name === 'sessionProjectionCache'
      ? { invalidate: async () => { invalidations += 1; if (unavailable) throw new Error('projection cache unavailable') } }
      : undefined
  const first = await f.post('delete', { sessionId: f.id })
  assert.deepEqual(first.deleted.warnings, ['projection checkpoint'])
  assert.equal(await exists(f.log), false)
  unavailable = false
  const retried = await f.post('delete', { sessionId: f.id })
  assert.equal(retried.deleted.warnings, undefined)
  assert.equal(invalidations, 2)
  assert.equal((await f.backups()).length, 1)
}))

for (const stopActivity of [false, true]) {
  test(`backup preflight failure preserves reminders and workspace membership (stopActivity=${stopActivity})`, () => fixture(async f => {
    const seen = []
    const baseGet = f.ctx.get
    f.ctx.get = name => name === 'schedule'
      ? { deleteSessionTasks: async () => seen.push('schedule') }
      : name === 'workspaceRegistry'
        ? { unaccountSession: async () => seen.push('workspace') }
        : baseGet(name)
    f.ctx.parallel = async () => seen.push('stop')
    f.ctx.emit = () => seen.push('removed')
    const staging = join(backupRoot(f.home), '.pending')
    await mkdir(backupRoot(f.home), { recursive: true })
    await writeFile(staging, 'cannot allocate staging')
    const result = await f.postRaw('delete', { sessionId: f.id, stopActivity })
    assert.equal(result.status, 500)
    assert.match(result.data.error.message, /final backup could not be saved/)
    assert.deepEqual(seen, [], 'no stop, schedule purge, workspace mutation or removal event before backup')
    assert.equal(await readFile(f.log, 'utf8'), 'original\n')
  }))
}

test('an initial persistence read error aborts without falsely deleting or unaccounting a live session', () => fixture(async f => {
  const baseGet = f.ctx.get
  const persistence = baseGet('sessionPersistence')
  const seen = []
  persistence.stat = async () => { throw Object.assign(new Error('fixture EIO'), { code: 'EIO' }) }
  persistence.remove = async () => seen.push('remove')
  f.ctx.get = name => name === 'sessionPersistence' ? persistence
    : name === 'workspaceRegistry' ? { list: () => [{ sessionIds: [f.id] }], unaccountSession: async () => seen.push('workspace') }
      : name === 'schedule' ? { deleteSessionTasks: async () => seen.push('schedule') } : baseGet(name)
  f.ctx.parallel = async () => seen.push('stop')
  f.ctx.emit = () => seen.push('removed')
  const result = await f.postRaw('delete', { sessionId: f.id })
  assert.equal(result.status, 500)
  assert.match(result.data.error.message, /stored state could not be read/)
  assert.deepEqual(seen, [])
  assert.equal(await readFile(f.log, 'utf8'), 'original\n')
}))

test('an absent persistence snapshot with an existing directory is never mistaken for an orphan', () => fixture(async f => {
  const baseGet = f.ctx.get
  const persistence = baseGet('sessionPersistence')
  const stat = persistence.stat
  let reads = 0
  persistence.stat = async () => ++reads === 1 ? undefined : stat()
  let removed = false
  const remove = persistence.remove
  persistence.remove = async () => { removed = true; await remove() }
  f.ctx.get = name => name === 'sessionPersistence' ? persistence : baseGet(name)
  const result = await f.post('delete', { sessionId: f.id })
  assert.equal(result.deleted.alreadyGone, undefined)
  assert.equal(removed, true)
  assert.equal(await exists(f.log), false)
  assert.equal((await f.backups()).length, 1)
}))

test('a session-directory symlink is refused without overwriting its target manifest', () => fixture(async f => {
  const target = join(f.home, 'linked-session-target')
  assert.ok(f.dir.startsWith(`${f.home}/sessions/`))
  await rename(f.dir, target)
  await writeFile(join(target, 'backup.json'), 'target manifest must survive')
  await symlink(target, f.dir)
  await assert.rejects(createBackup(f.ctx, f.id, f.options), { code: 'session-backup/unsafe-path' })
  assert.equal(await readFile(join(target, 'backup.json'), 'utf8'), 'target manifest must survive')
  assert.equal((await f.backups()).length, 0)
}))

for (const name of ['backup.json', 'nested-link']) {
  test(`a linked source entry (${name}) is rejected before publishing a backup`, () => fixture(async f => {
    const outside = join(f.home, 'outside.txt')
    await writeFile(outside, 'outside content')
    await symlink(outside, join(f.dir, name))
    await assert.rejects(createBackup(f.ctx, f.id, f.options), { code: 'session-backup/unsafe-path' })
    assert.equal(await readFile(outside, 'utf8'), 'outside content')
    assert.equal((await f.backups()).length, 0)
  }))
}

for (const kind of ['backups', 'staging']) {
  test(`a linked ${kind} store cannot redirect backup writes`, () => fixture(async f => {
    const outside = join(f.home, 'outside-store')
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'unchanged')
    const link = kind === 'backups' ? join(f.home, 'backups') : join(backupRoot(f.home), '.pending')
    if (kind === 'staging') await mkdir(backupRoot(f.home), { recursive: true })
    await symlink(outside, link)
    await assert.rejects(createBackup(f.ctx, f.id, f.options), { code: 'session-backup/unsafe-path' })
    assert.deepEqual(await readdir(outside), ['sentinel'])
  }))
}

test('a linked backup group cannot redirect restore or removal', () => fixture(async f => {
  const backup = await createBackup(f.ctx, f.id, f.options)
  const group = join(backupRoot(f.home), f.id)
  const outside = join(f.home, 'outside-backups')
  assert.equal(group, join(f.home, 'backups', 'sessions', f.id))
  await rename(group, outside)
  await symlink(outside, group)
  await assert.rejects(restoreBackup(backup.path, f.options), { code: 'session-backup/unsafe-path' })
  await assert.rejects(removeBackup(backup.path, f.options), { code: 'session-backup/unsafe-path' })
  assert.equal(await readFile(join(outside, backup.dirName, 'session.v4.jsonl'), 'utf8'), 'original\n')
  assert.equal((await lstat(group)).isSymbolicLink(), true)
}))

test('a linked restore parent is refused before writing live session bytes', () => fixture(async f => {
  const backup = await createBackup(f.ctx, f.id, f.options)
  assert.equal(f.dir, join(f.home, 'sessions', 'project', f.id))
  await rm(f.dir, { recursive: true })
  const project = join(f.home, 'sessions', 'project')
  const outside = join(f.home, 'outside-project')
  await rename(project, outside)
  await symlink(outside, project)
  await assert.rejects(restoreBackup(backup.path, f.options), { code: 'session-backup/unsafe-path' })
  assert.deepEqual(await readdir(outside), [])
  assert.equal(await exists(backup.path), true)
}))

test('a changing preflight source can be stopped, but the final backup must contain its closing events', () => fixture(async f => {
  // Inject one real append while the staged copy is fingerprinted. Allocation,
  // copying and final verification remain the actual production filesystem code.
  const original = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const artifactsUrl = new URL('../artifacts.js', import.meta.url).href
  const attachmentsUrl = new URL('../attachments.js', import.meta.url).href
  const source = original
    .replace('readdir, readFile, realpath', 'readdir, readFile as nativeReadFile, realpath')
    .replace("from './artifacts.js'", `from ${JSON.stringify(artifactsUrl)}`)
    .replace("from './attachments.js'", `from ${JSON.stringify(attachmentsUrl)}`) + `
let appendedDuringCopy = false
async function readFile(path, ...args) {
  const data = await nativeReadFile(path, ...args)
  if (!appendedDuringCopy && typeof path === 'string' && path.includes('/.pending/') && path.endsWith('/new/session.v4.jsonl')) {
    appendedDuringCopy = true
    await writeFile(${JSON.stringify(f.log)}, 'running append\\n', { flag: 'a' })
  }
  return data
}
`
  const isolated = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  isolated.apply(f.ctx, { home: f.home })
  let stopped = false
  f.ctx.parallel = async () => { stopped = true; await appendFile(f.log, 'stopped\n') }
  await f.post('delete', { sessionId: f.id, stopActivity: true })
  assert.equal(stopped, true, 'a source-changing preflight must not prevent the authorized stop')
  const copies = await f.backups()
  assert.equal(copies.length, 1)
  assert.equal(await readFile(join(copies[0].path, 'session.v4.jsonl'), 'utf8'), 'original\nrunning append\nstopped\n')
}))

test('legacy linked backups remain visible but cannot block healthy listing or a fresh backup', () => fixture(async f => {
  const legacy = await createBackup(f.ctx, f.id, f.options)
  const outside = join(f.home, 'legacy-link-target')
  await writeFile(outside, 'unchanged')
  await symlink(outside, join(legacy.path, 'legacy-link'))
  const fresh = await createBackup(f.ctx, f.id, { ...f.options, beforeDelete: true })
  assert.notEqual(fresh.path, legacy.path)
  const listed = await f.backups()
  assert.equal(listed.length, 2)
  assert.equal(listed.find(row => row.path === legacy.path).restorable, false)
  assert.match(listed.find(row => row.path === legacy.path).warning, /symbolic links/)
  assert.equal(listed.find(row => row.path === fresh.path).restorable, true)
  await assert.rejects(restoreBackup(legacy.path, f.options), { code: 'session-backup/unsafe-path' })
  assert.equal(await readFile(outside, 'utf8'), 'unchanged')
}))

for (const linkedRoot of ['backups', 'sessions']) {
  test(`external ${linkedRoot} root overrides reject a linked root before restore or removal`, () => fixture(async f => {
    const backup = await createBackup(f.ctx, f.id, f.options)
    const alternateHome = join(f.home, 'alternate-home')
    await mkdir(alternateHome)
    const root = linkedRoot === 'backups' ? backupRoot(f.home) : join(f.home, 'sessions')
    const outside = join(f.home, `outside-${linkedRoot}`)
    assert.ok(root.startsWith(`${f.home}/`))
    await rename(root, outside)
    await symlink(outside, root)
    const options = { home: alternateHome, backupRoot: backupRoot(f.home), sessionsRoot: join(f.home, 'sessions') }
    await assert.rejects(restoreBackup(backup.path, options), { code: 'session-backup/unsafe-path' })
    if (linkedRoot === 'backups') {
      await assert.rejects(removeBackup(backup.path, options), { code: 'session-backup/unsafe-path' })
      assert.equal(await readFile(join(outside, f.id, backup.dirName, 'session.v4.jsonl'), 'utf8'), 'original\n')
    }
  }))
}

let failures = 0
for (const { name, run } of cases) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { failures += 1; console.error(`✗ ${name}: ${error.message}`) }
}
if (failures > 0) process.exitCode = 1
