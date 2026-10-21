/**
 * Restore-route tests.
 *
 * A successful restore consumes its backup (restore = take back), attaches the
 * session to the Workspace that owns its `cwd`, or — when no Workspace matches
 * — reports the Sidebar's native 「未分组」 bucket instead of a failure. A
 * refused restore (the session is already there) keeps the backup untouched.
 *
 * Runs with plain `node test/restore-route.mjs`.
 */
import assert from 'node:assert/strict'
import { mkdir, rm, stat as fsstat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'

const SESSION = 'session-restore-1'
const PROJ = '--Users-overspread-projects-demo--'
const WORKSPACE = '/Users/overspread/projects/demo'

const exists = (p) =>
  fsstat(p).then(
    () => true,
    () => false,
  )

function ok(message) {
  console.log(`✓ ${message}`)
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exitCode = 1
}

/** Fake Host ctx: connection.fetch registry + an optional workspace registry. */
function fakeCtx(registry) {
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {}, error: () => {} },
    get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    effect: (fn) => {
      const dispose = fn()
      return () => dispose?.()
    },
  }
  return { ctx, routes }
}

/** One backup directory (manifest + one log file) with no live session yet. */
async function makeHome(kind) {
  const home = join(tmpdir(), `dsh-sb-restore-${kind}-${process.pid}`)
  const dest = join(home, 'sessions', PROJ, SESSION)
  const group = join(home, 'backups', 'sessions', SESSION)
  const backupDir = join(group, '20261021-120000-Greeting')
  await mkdir(backupDir, { recursive: true })
  await writeFile(join(backupDir, 'session.v4.jsonl.zstd'), 'log-bytes')
  await writeFile(
    join(backupDir, 'backup.json'),
    JSON.stringify({
      version: 1,
      sessionId: SESSION,
      title: 'Greeting',
      dirName: '20261021-120000-Greeting',
      createdAt: new Date().toISOString(),
      sourcePath: dest,
      files: 1,
      bytes: 9,
      consistent: true,
      inconsistent: [],
    }),
  )
  return { home, dest, group, backupDir }
}

async function post(routes, path, body) {
  const route = routes.get(path)
  assert.ok(route, `route ${path} registered`)
  return await route.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

/** No workspace registry → the session lands in the native ungrouped bucket. */
async function runUngroupedAndConsume() {
  const home = await makeHome('ungrouped')
  const { ctx, routes } = fakeCtx(undefined)
  apply(ctx, { home: home.home })

  let res = await post(routes, '/api/session.backup.restore', { path: home.backupDir })
  assert.equal(res.status, 200, `restore answers 200 (got ${res.status})`)
  const restored = (await res.json()).restored
  assert.equal(restored.placement, 'ungrouped', 'placement reports the ungrouped bucket')
  assert.equal(restored.attached, false, 'no workspace to attach to')
  assert.equal(restored.backupConsumed, true, 'restore consumes its backup')
  assert.equal(await exists(home.dest), true, 'session files restored')
  assert.equal(await exists(home.backupDir), false, 'backup directory removed')
  assert.equal(await exists(home.group), false, 'empty session group pruned')
  ok('[ungrouped] files restored, backup consumed, group pruned, placement=ungrouped')

  // A second backup of the same session, restored while the session exists →
  // 409 conflict, and the copy is kept (never a silent overwrite).
  await mkdir(home.backupDir, { recursive: true })
  await writeFile(join(home.backupDir, 'session.v4.jsonl.zstd'), 'log-bytes')
  await writeFile(
    join(home.backupDir, 'backup.json'),
    JSON.stringify({
      version: 1,
      sessionId: SESSION,
      title: 'Greeting',
      dirName: '20261021-120000-Greeting',
      createdAt: new Date().toISOString(),
      sourcePath: home.dest,
      files: 1,
      bytes: 9,
      consistent: true,
      inconsistent: [],
    }),
  )
  res = await post(routes, '/api/session.backup.restore', { path: home.backupDir })
  assert.equal(res.status, 409, `conflict answers 409 (got ${res.status})`)
  assert.equal((await res.json()).error.code, 'session-backup/conflict')
  assert.equal(await exists(home.backupDir), true, 'refused restore keeps the backup')
  assert.equal(await exists(home.dest), true, 'existing session left untouched')
  ok('[ungrouped] restore over an existing session: 409, backup kept')

  await rm(home.home, { recursive: true, force: true })
}

/** A matching Workspace re-attaches the session and still consumes the backup. */
async function runAttached() {
  const home = await makeHome('attached')
  const calls = []
  const registry = {
    readSessionHeader: async () => ({ cwd: WORKSPACE }),
    list: () => [
      {
        id: 'ws-1',
        path: WORKSPACE,
        attachSession: async (sessionId) => calls.push(sessionId),
      },
    ],
  }
  const { ctx, routes } = fakeCtx(registry)
  apply(ctx, { home: home.home })

  const res = await post(routes, '/api/session.backup.restore', { path: home.backupDir })
  assert.equal(res.status, 200)
  const restored = (await res.json()).restored
  assert.equal(restored.attached, true, 'session re-attached')
  assert.equal(restored.placement, 'workspace')
  assert.equal(restored.workspaceId, 'ws-1')
  assert.deepEqual(calls, [SESSION], 'attachSession got the restored id')
  assert.equal(restored.backupConsumed, true)
  assert.equal(await exists(home.backupDir), false, 'backup consumed')
  assert.equal(await exists(home.dest), true, 'files restored')
  ok('[attached] re-attached to its workspace, backup consumed')

  await rm(home.home, { recursive: true, force: true })
}

await runUngroupedAndConsume()
await runAttached()
console.log(process.exitCode ? '✗ FAIL' : '✓ all restore-route tests passed')
