/** Actual backup/delete and restore-route regressions using only test-owned temporary files. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, createBackup, deleteSessionCascade, listBackups, restoreBackup } from '../index.js'
import { SessionArtifactStore } from '../artifacts.js'

const ROOT_PREFIX = 'dsh-cleanup-concurrency-'
const API = '/api/session.backup'
const LOG_CONTENT = 'fixture original log\nclosing event retained\n'
const ARTIFACT_CONTENT = 'fixture-owned screenshot'

const exists = async path => {
  try { await lstat(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(run) {
  const temporaryParent = await realpath(tmpdir())
  const createdRoot = await mkdtemp(join(temporaryParent, ROOT_PREFIX))
  const root = await realpath(createdRoot)
  assert.equal(root, createdRoot, 'mkdtemp creates the exact canonical fixture root')
  assert.equal(dirname(root), temporaryParent)
  assert.ok(basename(root).startsWith(ROOT_PREFIX))
  const rootIdentity = await lstat(root)
  const effects = []

  const verifyRoot = async () => {
    const target = await realpath(root)
    const relation = relative(temporaryParent, target)
    assert.equal(target, createdRoot, 'cleanup addresses this exact mkdtemp result')
    assert.equal(relation, basename(createdRoot), 'fixture root is a direct temporary child')
    assert.ok(relation.startsWith(ROOT_PREFIX) && !isAbsolute(relation) && !relation.includes(sep))
    const identity = await lstat(target)
    assert.equal(identity.dev, rootIdentity.dev)
    assert.equal(identity.ino, rootIdentity.ino, 'fixture root was not replaced')
    return target
  }
  const verifyOwned = async path => {
    await verifyRoot()
    const target = resolve(path)
    const relation = relative(root, target)
    assert.ok(relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation),
      `mutation stays strictly inside the fixture root: ${target}`)
    let ancestor = target
    while (!(await exists(ancestor))) ancestor = dirname(ancestor)
    assert.equal(await realpath(ancestor), ancestor, 'a fixture mutation may not follow a redirected path')
    return target
  }
  const removeOwned = async (path, options = {}) => rm(await verifyOwned(path), options)

  try {
    const home = join(root, 'home')
    const workspace = join(root, 'workspace')
    const id = `session-${randomUUID()}`
    const dir = join(home, 'sessions', 'fixture-project', id)
    const log = join(dir, 'session.v4.jsonl')
    await mkdir(home, { mode: 0o700 })
    await mkdir(workspace, { mode: 0o700 })
    await mkdir(dir, { recursive: true })
    await writeFile(log, LOG_CONTENT, { mode: 0o600 })
    const paths = {
      home,
      sessionsRoot: join(home, 'sessions'),
      backupRoot: join(home, 'backups', 'sessions'),
      storagesRoot: join(home, 'storages'),
    }
    const routes = new Map()
    const services = new Map()
    const live = new Map([[id, { id }]])
    const order = []
    const warnings = []
    const state = { persisted: true, statCalls: 0, removes: 0, attaches: 0, pins: 0, beforeAttach: null, beforeRemove: null }
    const assertFixtureId = sessionId => assert.equal(sessionId, id, 'services address only this fixture session')
    const persistence = {
      async stat(sessionId) {
        assertFixtureId(sessionId)
        const persisted = state.persisted // Snapshot at invocation, before any queued restore can change it.
        state.statCalls += 1
        order.push('stat')
        return persisted ? { header: { id, cwd: workspace } } : undefined
      },
      async open(sessionId, mode) {
        assertFixtureId(sessionId)
        assert.equal(mode, 'write')
        return { close: async () => {} }
      },
      async remove(sessionId) {
        assertFixtureId(sessionId)
        state.removes += 1
        order.push('native:remove')
        assert.equal(await exists(log), true, 'native remove receives the restored log')
        await state.beforeRemove?.()
        assert.equal(await verifyOwned(dir), dir)
        await removeOwned(dir, { recursive: true })
        state.persisted = false
      },
    }
    const sessions = {
      get: sessionId => { assertFixtureId(sessionId); return live.get(sessionId) },
      flush: async session => assert.equal(session.id, id),
      store: { get: sessionId => {
        assertFixtureId(sessionId)
        return live.has(sessionId) ? { detach: () => { order.push('detach'); live.delete(sessionId) } } : undefined
      } },
    }
    const workspaceRecord = {
      id: 'fixture-workspace',
      path: workspace,
      sessionIds: [id],
      async attachSession(sessionId) {
        assertFixtureId(sessionId)
        order.push('restore:attach')
        assert.equal(await readFile(log, 'utf8'), LOG_CONTENT)
        await state.beforeAttach?.()
        state.attaches += 1
        if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
      },
    }
    const registry = {
      list: () => [workspaceRecord],
      async readSessionHeader(sessionId) {
        assertFixtureId(sessionId)
        assert.equal(await readFile(log, 'utf8'), LOG_CONTENT)
        state.persisted = true
        return { id, cwd: workspace }
      },
      async pinSession(sessionId) {
        assertFixtureId(sessionId)
        assert.equal(state.attaches, 1, 'attachment completes before pinning')
        state.pins += 1
        order.push('restore:pin')
      },
      async unaccountSession(sessionId) {
        assertFixtureId(sessionId)
        workspaceRecord.sessionIds = workspaceRecord.sessionIds.filter(member => member !== sessionId)
      },
    }
    services.set('sessionPersistence', persistence)
    services.set('sessions', sessions)
    services.set('workspaceRegistry', registry)
    const ctx = {
      get: name => services.get(name),
      provide: (name, service) => services.set(name, service),
      logger: { warn: message => warnings.push(String(message)), error: message => warnings.push(String(message)) },
      waterfall: async () => [],
      parallel: async () => {},
      emit: (event, sessionId) => { assertFixtureId(sessionId); order.push(event) },
      connection: { fetch: { register(route) {
        assert.equal(routes.has(route.path), false)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      } } },
      effect(runEffect) { effects.push(runEffect()) },
    }
    apply(ctx, { home, cleanupOnDelete: true })
    const request = async (action, body) => {
      const path = `${API}.${action}`
      const route = routes.get(path)
      assert.ok(route, `actual apply() route registered: ${path}`)
      assert.ok(route.methods.includes('POST'))
      const response = await route.fetch(new Request(`http://fixture.invalid${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }))
      assert.match(response.headers.get('content-type'), /^application\/json/)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      return { status: response.status, body: await response.json() }
    }
    await run({
      root, home, workspace, id, dir, log, paths, ctx, state, persistence, sessions, registry,
      live, routes, services, order, warnings, request, verifyOwned, removeOwned,
      store: new SessionArtifactStore(home),
      saveArtifact: () => services.get('sessionArtifacts').save(id, 'screenshot.png', ARTIFACT_CONTENT),
    })
  } finally {
    for (const dispose of effects.splice(0)) dispose?.()
    await rm(await verifyRoot(), { recursive: true, force: true })
  }
}

test('queued restore precedes delete existence checks and native removal under the actual backup group lock', { timeout: 15000 }, () => fixture(async f => {
  const artifact = await f.saveArtifact()
  const backup = await createBackup(f.ctx, f.id, f.paths)
  assert.equal(await readFile(join(backup.path, 'session.v4.jsonl'), 'utf8'), LOG_CONTENT)
  const entered = deferred()
  const release = deferred()
  const operations = []
  const observe = promise => {
    const result = promise.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
    operations.push(result)
    return result
  }
  f.state.beforeAttach = async () => {
    assert.equal(await exists(artifact.path), true, 'queued deletion must preserve artifacts until restore attaches')
    assert.equal(await readFile(artifact.path, 'utf8'), ARTIFACT_CONTENT)
  }
  f.state.beforeRemove = async () => {
    assert.equal(f.state.attaches, 1)
    assert.equal(f.state.pins, 1)
    assert.equal(await exists(artifact.path), true, 'cleanup follows native log removal')
    const copies = await listBackups(f.paths.backupRoot)
    assert.equal(copies.length, 1, 'native removal follows creation of the final backup')
    assert.equal(await readFile(join(copies[0].path, 'session.v4.jsonl'), 'utf8'), LOG_CONTENT)
  }
  f.sessions.flush = async session => {
    assert.equal(session.id, f.id)
    entered.resolve()
    await release.promise
  }
  const holder = observe(createBackup(f.ctx, f.id, f.paths))
  try {
    await entered.promise
    await f.removeOwned(f.dir, { recursive: true })
    f.state.persisted = false // Reading the restored header makes persistence visible again.
    assert.equal(await exists(f.log), false)
    const statCallsBeforeQueue = f.state.statCalls
    const restoring = observe(restoreBackup(backup.path, { ...f.paths, registry: f.registry, logger: f.ctx.logger }).then(result => {
      f.order.push('restore:completed')
      return result
    }))
    const deleting = observe(deleteSessionCascade(f.ctx, f.id, { paths: f.paths, cleanupOnDelete: true }))
    assert.equal(f.state.statCalls, statCallsBeforeQueue, 'delete does not classify orphaned state outside the group lock')
    assert.equal(f.state.attaches, 0)
    assert.equal(f.state.removes, 0)
    release.resolve()
    const [held, restored, deleted] = await Promise.all([holder, restoring, deleting])
    if (held.status === 'rejected') assert.ok(held.reason instanceof Error, 'a vanished source may fail the holding backup')
    else assert.equal(held.value.sessionId, f.id)
    assert.equal(restored.status, 'fulfilled', restored.reason?.stack)
    assert.equal(restored.value.attached, true)
    assert.equal(restored.value.pinned, true)
    assert.equal(restored.value.backupConsumed, true)
    assert.equal(deleted.status, 'fulfilled', deleted.reason?.stack)
    assert.equal(deleted.value.deleted, true)
    const finalBackups = await listBackups(f.paths.backupRoot)
    const evidence = {
      result: deleted.value,
      logExists: await exists(f.log),
      artifactExists: await exists(artifact.path),
      finalBackupCount: finalBackups.length,
    }
    assert.equal(f.state.removes, 1,
      `the restored session requires one native remove after persistence is rechecked: ${JSON.stringify(evidence)}`)
    assert.equal(deleted.value.alreadyGone, undefined)
    assert.deepEqual(deleted.value.cleanup, { removed: 1, bytes: artifact.bytes, retained: 0, failed: [] })
    const afterAttach = f.order.indexOf('restore:attach')
    const nextStat = f.order.indexOf('stat', afterAttach + 1)
    assert.ok(nextStat > afterAttach, 'delete rechecks persistence after restoration attaches')
    assert.ok(f.order.indexOf('restore:completed') < f.order.indexOf('native:remove'), 'restore completes before native deletion')
    assert.equal(await exists(f.log), false)
    assert.equal(await exists(artifact.path), false)
    assert.equal(finalBackups.length, 1, 'deletion retains its final backup after restore consumes the earlier copy')
    assert.equal(finalBackups[0].sessionId, f.id)
    assert.equal(await readFile(join(finalBackups[0].path, 'session.v4.jsonl'), 'utf8'), LOG_CONTENT)
  } finally {
    release.resolve()
    await Promise.all(operations) // Never remove the fixture while a queued real operation is still running.
  }
}))

test('actual restore POST tolerates a malformed pending ledger and still attaches, pins, and consumes the backup', { timeout: 15000 }, () => fixture(async f => {
  const artifact = await f.saveArtifact()
  const backup = await createBackup(f.ctx, f.id, f.paths)
  await f.store.markPending(f.id)
  assert.deepEqual(await f.store.pending(), [{ sessionId: f.id, count: 1 }])
  const ledger = join(f.home, 'session-artifacts', 'registry', `${f.id}.json`)
  assert.equal(JSON.parse(await readFile(ledger, 'utf8')).pending, true)
  await writeFile(await f.verifyOwned(ledger), '{}\n', { mode: 0o600 })
  await f.removeOwned(f.dir, { recursive: true })
  f.state.persisted = false
  f.live.delete(f.id)
  f.state.beforeAttach = async () => assert.equal(await exists(artifact.path), true)
  const response = await f.request('restore', { path: backup.path })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const { restored } = response.body
  assert.equal(restored.sessionId, f.id)
  assert.equal(restored.target, f.dir)
  assert.equal(restored.attached, true)
  assert.equal(restored.workspaceId, 'fixture-workspace')
  assert.equal(restored.placement, 'workspace')
  assert.equal(restored.pinned, true)
  assert.equal(restored.backupConsumed, true)
  assert.equal(f.state.attaches, 1)
  assert.equal(f.state.pins, 1)
  assert.ok(f.order.indexOf('restore:attach') < f.order.indexOf('restore:pin'))
  assert.equal(typeof restored.cleanupWarning, 'string')
  assert.ok(restored.cleanupWarning.trim().length > 0)
  assert.match(restored.cleanupWarning, /ledger/i)
  assert.equal(await readFile(f.log, 'utf8'), LOG_CONTENT)
  assert.equal(await readFile(artifact.path, 'utf8'), ARTIFACT_CONTENT)
  assert.equal(await readFile(ledger, 'utf8'), '{}\n', 'unsafe ledger remains untouched for review')
  assert.equal(await exists(backup.path), false)
  assert.deepEqual(await listBackups(f.paths.backupRoot), [])
  assert.equal(f.state.removes, 0)
}))
