/**
 * Route-level tests for the delete engine: drive `apply()` against a fake
 * connection and a fake host ctx, in both seam shapes (alpha.3: `remove()` +
 * `deleteSessionTasks` + `invalidate` + `unaccountSession`; rc.2: none of
 * those, located directory + `list`/`delete` + file paths + per-workspace
 * calls). Runs with plain `node test/delete-routes.mjs`.
 */
import assert from 'node:assert/strict'
import { mkdir, readdir, rm, stat as fsstat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'

const SESSION = 'test-session-1'
const PROJ = '--Users-overspread-projects-demo--'

function fail(message) {
  console.error(`✗ ${message}`)
  process.exitCode = 1
}
function ok(message) {
  console.log(`✓ ${message}`)
}
const exists = (p) =>
  fsstat(p).then(
    () => true,
    () => false,
  )

/** Fake host ctx with the full seam surface both versions use. */
function fakeCtx(mode, calls) {
  const dir = mode.dir
  const ctx = {
    logger: { warn: (m) => calls.warnings.push(m), error: (m) => calls.warnings.push(m) },
    get: (name) => {
      if (name === 'sessionPersistence') {
        const base = {
          flush: async () => calls.push('flush'),
          open: async () => ({ close: async () => calls.push('close') }),
          stat: async () =>
            (await exists(dir)) ? { header: { cwd: '/Users/overspread/projects/demo' } } : undefined,
        }
        if (typeof mode.openBusy === 'function') {
          // rc.2 kernel shape: the store's entered entry holds the write lease
          // until detach fires `session/disposed`; an idle-but-opened session
          // therefore refuses the lease probe until the cascade detaches it.
          base.open = async () => {
            if (mode.openBusy()) {
              const error = new Error('write lease held by the kernel store')
              error.name = 'SessionAlreadyOwnedError'
              throw error
            }
            calls.push('persistence.open')
            return { close: async () => calls.push('close') }
          }
        }
        if (mode.kind === 'alpha3') {
          base.remove = async (id) => {
            if (!(await exists(dir))) {
              const err = new Error('not found')
              err.name = 'SessionPersistenceNotFoundError'
              throw err
            }
            calls.push('persistence.remove')
            await rm(dir, { recursive: true, force: true })
          }
        }
        return base
      }
      if (name === 'schedule') {
        if (mode.kind === 'alpha3') return { deleteSessionTasks: async () => calls.push('schedule.deleteSessionTasks') }
        return {
          list: async ({ sessionId }) => {
            assert.equal(sessionId, SESSION)
            calls.push('schedule.list')
            return [{ id: 'task-1' }]
          },
          delete: async (req) => {
            assert.deepEqual(req, { sessionId: SESSION, id: 'task-1' })
            calls.push('schedule.delete')
          },
        }
      }
      if (name === 'spillStore') {
        return mode.kind === 'alpha3'
          ? { removeSession: async () => (calls.push('spill.removeSession'), 1) }
          : { root: mode.spillRoot }
      }
      if (name === 'sessionProjectionCache') {
        return mode.kind === 'alpha3' ? { invalidate: async () => calls.push('projection.invalidate') } : undefined
      }
      if (name === 'workspaceRegistry') {
        if (mode.kind === 'alpha3') return { unaccountSession: async () => calls.push('registry.unaccountSession') }
        return {
          list: () => [
            {
              unarchiveSession: async () => calls.push('ws.unarchive'),
              unpinSession: async () => calls.push('ws.unpin'),
              detachSession: async () => calls.push('ws.detach'),
            },
          ],
        }
      }
      if (name === 'agents') return { disposeAgent: async () => calls.push('agents.disposeAgent') }
      if (name === 'sessions') return mode.sessions
      return undefined
    },
    waterfall: async (name, req) => {
      assert.equal(name, 'workspace/session-activity')
      assert.equal(req.sessionId, SESSION)
      calls.push('activity.ask')
      return mode.stopped ? [] : (mode.activity ?? [])
    },
    parallel: async (name, req) => {
      assert.equal(name, 'workspace/session-stop')
      assert.equal(req.sessionId, SESSION)
      calls.push('session.stop')
      mode.stopped = true
    },
    emit: (name, id) => {
      assert.equal(name, 'api-session/removed')
      assert.equal(id, SESSION)
      calls.push('emit.removed')
    },
    connection: {
      fetch: {
        register: (route) => {
          calls.routes.set(route.path, route)
          return () => calls.routes.delete(route.path)
        },
      },
    },
    effect: (fn) => {
      const dispose = fn()
      return () => dispose?.()
    },
  }
  return ctx
}

/** Build a temp home whose session directory (and caches) exist. */
async function makeHome(kind) {
  const home = join(tmpdir(), `dsh-sb-test-${kind}-${process.pid}`)
  const dir = join(home, 'sessions', PROJ, SESSION)
  await mkdir(join(dir, 'inner'), { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl'), '{"t":"x"}\n')
  await writeFile(join(dir, 'session.lock'), 'lease')
  const projCache = join(home, 'storages', 'session_projcache', 'sessions', `${SESSION}.json`)
  await mkdir(join(projCache, '..'), { recursive: true })
  await writeFile(projCache, '{"rows":[]}')
  const spillRoot = join(home, 'spills')
  const hash = createHash('sha256').update(SESSION).digest('hex').slice(0, 12)
  await mkdir(join(spillRoot, `session-${hash}`), { recursive: true })
  await writeFile(join(spillRoot, `session-${hash}`, 'scratch.txt'), 'spill')
  return { home, dir, projCache, spillRoot, spillDir: join(spillRoot, `session-${hash}`) }
}

async function post(routes, path, body) {
  const route = routes.get(path)
  assert.ok(route, `route ${path} registered`)
  const request = new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await route.fetch(request)
}

async function runMode(kind) {
  const calls = { routes: new Map(), warnings: [] }
  const seen = []
  const record = (name) => seen.push(name)
  const home = await makeHome(kind)
  const mode = { kind, dir: home.dir, spillRoot: home.spillRoot }
  const ctx = fakeCtx(mode, calls)
  const innerPush = calls.push
  calls.push = (name) => {
    record(name)
    if (Array.isArray(innerPush)) innerPush.push(name)
  }
  // calls.push used by fakes as an array-like recorder
  calls.push = Object.assign((name) => record(name), { routes: calls.routes, warnings: calls.warnings })

  apply(ctx, { home: home.home })
  assert.deepEqual([...calls.routes.keys()].sort(), [
    '/api/session.backup.create',
    '/api/session.backup.delete',
    '/api/session.backup.list',
    '/api/session.backup.remove',
    '/api/session.backup.restore',
  ])
  ok(`[${kind}] 5 routes registered`)

  // 1. idle delete succeeds, full cascade, emit last-ish
  let res = await post(calls.routes, '/api/session.backup.delete', { sessionId: SESSION })
  assert.equal(res.status, 200)
  let payload = await res.json()
  assert.deepEqual(payload, { deleted: { deleted: true } })
  assert.equal(await exists(home.dir), false, 'log dir removed')
  if (kind === 'rc2') {
    assert.equal(await exists(home.projCache), false, 'projection json removed')
    assert.equal(await exists(home.spillDir), false, 'spill dir removed')
  }
  assert.ok(seen.includes('activity.ask'), 'activity gate asked')
  assert.ok(seen.includes('session.stop'), 'session-stop fired (schedule purge layer 1)')
  assert.ok(seen.includes('emit.removed'), 'removed event emitted')
  assert.ok(seen.indexOf('activity.ask') < seen.indexOf('emit.removed'), 'gate before emit')
  assert.ok(seen.includes(kind === 'alpha3' ? 'persistence.remove' : 'schedule.delete'), 'version-native removal')
  ok(`[${kind}] idle delete: log + caches gone, event emitted`)

  // 2. idempotent repeat answers success without redoing the cascade
  seen.length = 0
  res = await post(calls.routes, '/api/session.backup.delete', { sessionId: SESSION })
  assert.equal(res.status, 200)
  payload = await res.json()
  assert.equal(payload.deleted.deleted, true)
  assert.ok(!seen.includes('persistence.remove') && !seen.includes('schedule.deleteSessionTasks'), 'no re-cascade')
  ok(`[${kind}] repeat delete is idempotent`)

  await rm(home.home, { recursive: true, force: true })
}

async function runBusyAndNotFound() {
  const calls = { routes: new Map(), warnings: [] }
  const home = await makeHome('busy')
  const mode = { kind: 'alpha3', dir: home.dir, spillRoot: home.spillRoot, activity: [{ kind: 'turn' }] }
  const ctx = fakeCtx(mode, calls)
  calls.push = Object.assign(() => {}, { routes: calls.routes, warnings: calls.warnings })
  apply(ctx, { home: home.home })

  // busy refusal carries the archive code + activity details, destroys nothing
  let res = await post(calls.routes, '/api/session.backup.delete', { sessionId: SESSION })
  assert.equal(res.status, 409)
  let payload = await res.json()
  assert.equal(payload.error.code, 'workspace/session-active')
  assert.deepEqual(payload.error.details.activity, [{ kind: 'turn' }])
  assert.equal(await exists(home.dir), true, 'busy session untouched')
  ok('[busy] refusal: 409 + activity details, nothing destroyed')

  // stopActivity path: gate skipped, cascade runs
  res = await post(calls.routes, '/api/session.backup.delete', { sessionId: SESSION, stopActivity: true })
  assert.equal(res.status, 200)
  assert.equal(await exists(home.dir), false)
  ok('[busy] stopActivity:true stops and deletes')

  // unknown id → 404 session/not-found
  res = await post(calls.routes, '/api/session.backup.delete', { sessionId: 'never-existed-9' })
  assert.equal(res.status, 404)
  payload = await res.json()
  assert.equal(payload.error.code, 'session/not-found')
  ok('[busy] unknown id → 404 session/not-found')

  // invalid id → 400
  res = await post(calls.routes, '/api/session.backup.delete', { sessionId: 'bad/../id' })
  assert.equal(res.status, 400)
  ok('[busy] traversal id → 400')

  await rm(home.home, { recursive: true, force: true })
}

/**
 * The rc.2 regression this plugin broke on after the harness upgrade: an idle
 * session whose store entry still holds the write lease. The activity gate is
 * empty (nothing provider-visible is running), the first detach races and
 * fails, and only the belt's retry in the lease probe can release it. Without
 * both detach attempts the delete 409s with an EMPTY activity list — the dead
 * end behind "two backups, no deletion".
 */
async function runLeaseRefusal() {
  const calls = { routes: new Map(), warnings: [] }
  const seen = []
  const home = await makeHome('lease')
  const state = { lease: true, detachTries: 0 }
  const mode = {
    kind: 'rc2',
    dir: home.dir,
    spillRoot: home.spillRoot,
    openBusy: () => state.lease,
    sessions: {
      store: {
        get: (id) =>
          id === SESSION
            ? {
                detach: () => {
                  state.detachTries += 1
                  if (state.detachTries === 1) throw new Error('detach raced with a pending write')
                  state.lease = false
                  calls.push('sessions.detach')
                },
              }
            : undefined,
      },
    },
  }
  const ctx = fakeCtx(mode, calls)
  calls.push = Object.assign((name) => seen.push(name), { routes: calls.routes, warnings: calls.warnings })
  apply(ctx, { home: home.home })

  const res = await post(calls.routes, '/api/session.backup.delete', { sessionId: SESSION })
  assert.equal(res.status, 200, `idle delete must succeed under a store-held lease (got ${res.status})`)
  assert.equal(await exists(home.dir), false, 'log dir removed')
  assert.equal(state.detachTries, 2, 'idle detach attempted first, belt retried after the first failed')
  assert.ok(seen.includes('sessions.detach'), 'store entry detached')
  assert.ok(seen.includes('persistence.open'), 'lease probe passed after detach')
  assert.ok(seen.includes('emit.removed'), 'removed event emitted')
  ok('[lease] rc.2 store-held write lease: detach first + belt retry, delete succeeds')

  await rm(home.home, { recursive: true, force: true })
}

await runMode('alpha3')
await runMode('rc2')
await runBusyAndNotFound()
await runLeaseRefusal()
console.log(process.exitCode ? '✗ FAIL' : '✓ all delete-route tests passed')
