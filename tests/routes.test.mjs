import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { apply as hostApply, backupRoot, sessionsRoot } from '../index.js'

const temps = []
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true })
})

/**
 * Mount the Host face on a fake connection and hand back the registered
 * routes, so the tests drive the real handlers with real Requests.
 */
async function mount() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-backup-routes-'))
  temps.push(home)
  await mkdir(sessionsRoot(home), { recursive: true })
  const routes = new Map()
  const logged = []
  let disposer = () => {}
  const ctx = {
    get: () => undefined,
    effect: (fn) => {
      disposer = fn()
      return disposer
    },
    logger: { error: (message) => logged.push(String(message)) },
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }
  hostApply(ctx, { home })
  const call = async (path, { method = 'GET', body } = {}) => {
    const route = routes.get(path)
    assert.ok(route, `no route registered at ${path}`)
    const request = new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.equal(route.methods.includes(method), true, `${path} does not accept ${method}`)
    const response = await route.fetch(request)
    return { response, payload: await response.json() }
  }
  return { home, routes, call, logged, unmount: () => disposer() }
}

async function storeSession(sessions, sessionId, body = 'log-bytes') {
  const dir = join(sessions, 'Users-example-project', sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), body, 'utf8')
  return dir
}

describe('session-backup: routes', () => {
  it('registers the four routes below /api', async () => {
    const { routes } = await mount()
    assert.deepEqual(
      [...routes.keys()].sort(),
      ['/api/session.backup.create', '/api/session.backup.list', '/api/session.backup.remove', '/api/session.backup.restore'],
    )
  })

  it('backs up, lists, restores, and removes over HTTP', async () => {
    const { home, call } = await mount()
    const sessions = sessionsRoot(home)
    const source = await storeSession(sessions, 'sid-http', 'hello')

    const created = await call('/api/session.backup.create', { method: 'POST', body: { sessionId: 'sid-http' } })
    assert.equal(created.response.status, 200)
    assert.equal(created.payload.backup.sessionId, 'sid-http')
    assert.equal(created.payload.backup.title, 'untitled')
    assert.equal(created.payload.backup.sourcePath, source)
    const backupPath = created.payload.backup.path

    const listed = await call('/api/session.backup.list')
    assert.equal(listed.response.status, 200)
    assert.equal(listed.payload.backups.length, 1)
    assert.equal(listed.payload.backups[0].path, backupPath)
    assert.equal(listed.payload.backups[0].restorable, true)

    await rm(source, { recursive: true, force: true })
    const restored = await call('/api/session.backup.restore', { method: 'POST', body: { path: backupPath } })
    assert.equal(restored.response.status, 200)
    assert.equal(restored.payload.restored.target, source)

    const removed = await call('/api/session.backup.remove', { method: 'POST', body: { path: backupPath } })
    assert.equal(removed.response.status, 200)
    const afterRemoval = await call('/api/session.backup.list')
    assert.deepEqual(afterRemoval.payload.backups, [])
  })

  it('answers JSON errors with the right status', async () => {
    const { home, call, logged } = await mount()
    await storeSession(sessionsRoot(home), 'sid-guard')

    const malformed = await call('/api/session.backup.create', { method: 'POST' })
    assert.equal(malformed.response.status, 400)
    assert.equal(malformed.payload.error.code, 'session-backup/bad-request')

    const traversal = await call('/api/session.backup.create', { method: 'POST', body: { sessionId: '../sid-guard' } })
    assert.equal(traversal.response.status, 400)

    const absent = await call('/api/session.backup.create', { method: 'POST', body: { sessionId: 'sid-nope' } })
    assert.equal(absent.response.status, 404)
    assert.equal(absent.payload.error.code, 'session-backup/not-found')

    const removeEscape = await call('/api/session.backup.remove', { method: 'POST', body: { path: '/etc' } })
    assert.equal(removeEscape.response.status, 400)

    assert.deepEqual(logged, [], 'client errors were logged as server failures')
  })

  it('answers a corrupt manifest as a client error without logging it', async () => {
    const { home, call, logged } = await mount()
    const sessions = sessionsRoot(home)
    const source = await storeSession(sessions, 'sid-internal')
    const created = await call('/api/session.backup.create', { method: 'POST', body: { sessionId: 'sid-internal' } })
    // A manifest that is not JSON turns the restore into a bad request.
    await writeFile(join(created.payload.backup.path, 'backup.json'), 'not json', 'utf8')
    await rm(source, { recursive: true, force: true })

    const restored = await call('/api/session.backup.restore', { method: 'POST', body: { path: created.payload.backup.path } })
    assert.equal(restored.response.status, 400)
    assert.equal(restored.payload.error.code, 'session-backup/bad-request')
    assert.deepEqual(logged, [])
  })

  it('unregisters every route when the plugin is disposed', async () => {
    const { routes, unmount } = await mount()
    assert.equal(routes.size, 4)
    unmount()
    assert.equal(routes.size, 0)
  })
})
