/**
 * Client request regressions, run with: node test/client-delete-flow.mjs
 *
 * Execute the actual createActions declaration from src/client.mjs in a Node VM.
 * Only its API/store/browser boundaries are stubbed: no rewritten action logic,
 * React/Cordis imports, network requests, or session/filesystem writes.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script, createContext } from 'node:vm'

const clientUrl = new URL('../src/client.mjs', import.meta.url)
const source = await readFile(clientUrl, 'utf8')
// Top-level declarations end with an unindented brace; nested braces retain
// indentation. Fail clearly if that source boundary changes rather than falling
// back to a separately maintained implementation of the actions.
function declaration(name) {
  const match = source.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{\\r?\\n[\\s\\S]*?^\\}`, 'm'))
  assert.ok(match, `extract the real ${name} declaration from src/client.mjs`)
  return match[0]
}
const script = new Script(`"use strict";\n${declaration('createActions')}\ncreateActions`, {
  filename: clientUrl.pathname,
})
const plain = value => structuredClone(value)

function fixture(respond = () => ({ deleted: { deleted: true } })) {
  const requests = []
  const statuses = []
  const failures = []
  const refreshes = []
  const sets = []
  const leaves = []
  const unexpected = name => () => { throw new Error(`Unexpected client boundary: ${name}`) }
  const context = createContext({
    call: async (action, body) => {
      const request = { action, body: plain(body) }
      requests.push(request)
      return await respond(request, requests.length)
    },
    messageOf: error => String(error?.message ?? error),
    refreshList: () => refreshes.push('refreshList'),
    leaveIfCurrent: id => leaves.push(id),
    fetch: unexpected('fetch'),
  })
  const store = new Script(`${declaration('createStore')}\ncreateStore()`).runInContext(context)
  for (const [method, records] of [['setStatus', statuses], ['fail', failures], ['set', sets]]) {
    const original = store[method]
    store[method] = value => { records.push(plain(value)); original(value) }
  }
  context.store = store
  for (const name of ['formatBytes', 'cleanupSettingsOf', 'cleanupSummary', 'attachmentCleanupDetails']) {
    context[name] = new Script(`${declaration(name)}\n${name}`).runInContext(context)
  }
  const createActions = script.runInContext(context)
  const actions = createActions({})
  assert.equal(typeof actions.backupOne, 'function')
  assert.equal(typeof actions.deleteOne, 'function')
  return { actions, store, requests, statuses, failures, refreshes, sets, leaves }

}

let passed = 0
async function test(name, run) {
  await run()
  passed += 1
  console.log(`✓ ${name}`)
}

const sessionId = 'session-client-delete-flow-fixture'

await test('manual backupOne then deleteOne sends exactly create, delete', async () => {
  const deleted = { deleted: true, sessionId }
  const f = fixture(({ action }) => action === 'create'
    ? { backup: { reused: false, updated: false } }
    : { deleted })
  await f.actions.backupOne(sessionId)
  const result = await f.actions.deleteOne(sessionId)
  assert.deepEqual(f.requests, [
    { action: 'create', body: { sessionId } },
    { action: 'delete', body: { sessionId } },
  ])
  assert.equal(result, deleted, 'return the Host delete result')
  assert.deepEqual(f.statuses, [{ key: 'status.backupCreated', params: { count: 1 } }])
  assert.deepEqual(f.failures, [])
})

await test('deleteOne alone sends exactly one delete and no create', async () => {
  const f = fixture()
  assert.deepEqual(plain(await f.actions.deleteOne(sessionId)), { deleted: true })
  assert.deepEqual(f.requests, [{ action: 'delete', body: { sessionId } }])
  assert.deepEqual(f.statuses, [])
  assert.deepEqual(f.failures, [])
})

for (const manualBackup of [false, true]) {
  await test(`busy refusal then stopActivity retry sends only delete again${manualBackup ? ' after manual backup' : ''}`, async () => {
    const activity = [{ kind: 'agent', items: [{ id: 'fixture-run', label: 'Fixture run' }] }]
    const busy = Object.assign(new Error('Session has active work'), {
      code: 'workspace/session-active',
      status: 409,
      details: { activity },
    })
    let deleteCalls = 0
    const f = fixture(({ action }) => {
      if (action === 'create') return { backup: { reused: true } }
      assert.equal(action, 'delete')
      if (++deleteCalls === 1) throw busy
      return { deleted: { deleted: true } }
    })
    if (manualBackup) await f.actions.backupOne(sessionId)
    await assert.rejects(f.actions.deleteOne(sessionId), error => {
      assert.equal(error, busy, 'preserve the Host busy error for dialog upgrade')
      assert.deepEqual(error.details.activity, activity)
      return true
    })
    const beforeRetry = [
      ...(manualBackup ? [{ action: 'create', body: { sessionId } }] : []),
      { action: 'delete', body: { sessionId } },
    ]
    assert.deepEqual(f.requests, beforeRetry, 'busy refusal must not create a backup')
    assert.deepEqual(plain(await f.actions.deleteOne(sessionId, { stopActivity: true })), { deleted: true })
    assert.deepEqual(f.requests, [
      ...beforeRetry,
      { action: 'delete', body: { sessionId, stopActivity: true } },
    ], 'retry forwards stopActivity and adds no create request')
    assert.equal(deleteCalls, 2)
    assert.deepEqual(f.failures, [], 'busy errors propagate rather than becoming backup failures')
    assert.deepEqual(f.statuses, manualBackup
      ? [{ key: 'status.backupOneReused', params: { count: 1 } }]
      : [])
  })
}

await test('stopActivity is sent only for the boolean true and does not leak other options', async () => {
  for (const value of [true, false, undefined, null, 'true', 1]) {
    const f = fixture()
    await f.actions.deleteOne(sessionId, { stopActivity: value, unrelated: 'do not send' })
    assert.deepEqual(f.requests, [{
      action: 'delete',
      body: value === true ? { sessionId, stopActivity: true } : { sessionId },
    }], `request body for stopActivity=${String(value)}`)
  }
})

for (const [label, backup, key] of [
  ['reused', { reused: true }, 'status.backupOneReused'],
  ['updated', { reused: false, updated: true }, 'status.backupUpdated'],
  ['created', { reused: false, updated: false }, 'status.backupCreated'],
  ['reuse takes precedence', { reused: true, updated: true }, 'status.backupOneReused'],
]) {
  await test(`manual backupOne reports the ${label} status`, async () => {
    const f = fixture(({ action }) => {
      assert.equal(action, 'create')
      return { backup }
    })
    await f.actions.backupOne(sessionId)
    assert.deepEqual(f.requests, [{ action: 'create', body: { sessionId } }])
    assert.deepEqual(f.statuses, [{ key, params: { count: 1 } }])
    assert.deepEqual(f.failures, [])
  })
}

await test('successful restoreOne refreshes the sidebar list so no reload is needed', async () => {
  const f = fixture(({ action }) => action === 'restore'
    ? { restored: { attached: true, placement: 'workspace', backupConsumed: true, pinned: true, title: 'Restored' } }
    : { backups: [] })
  await f.actions.restoreOne({ path: 'session-x/backup', title: 'Restored' })
  assert.deepEqual(f.requests.map((r) => r.action), ['restore', 'list'],
    'restore, then the backup-list refresh')
  assert.deepEqual(f.refreshes, ['refreshList'], 'sidebar session list refreshed once')
  assert.deepEqual(f.statuses, [{ key: 'status.restoredDone', params: { title: 'Restored', reason: '' } }])
  assert.deepEqual(f.failures, [])
})

await test('refused restoreOne (already exists) does not refresh the sidebar list', async () => {
  const conflict = Object.assign(new Error('already exists'), { code: 'session-backup/conflict', status: 409 })
  const f = fixture(({ action }) => {
    if (action === 'restore') throw conflict
    assert.fail('no list refresh runs after a refused restore')
  })
  await f.actions.restoreOne({ path: 'session-x/backup', title: 'Restored' })
  assert.deepEqual(f.refreshes, [], 'nothing changed for the sidebar on conflict')
  assert.deepEqual(f.requests.map((r) => r.action), ['restore'])
  assert.equal(f.failures.length, 1, 'conflict surfaces the localized expected-state message')
  assert.equal(f.failures[0].key, 'error.restoreExists')
})

await test('restoreOne surfaces cleanup warnings while preserving its successful placement status', async () => {
  const f = fixture(({ action }) => action === 'restore'
    ? { restored: { placement: 'ungrouped', cleanupWarning: 'cleanup marker could not be reset', title: 'Recovered' } }
    : { backups: [] })
  await f.actions.restoreOne({ path: 'session-x/backup', title: 'Original' })
  assert.deepEqual(f.statuses, [{
    key: 'status.restoredUngrouped', params: { title: 'Recovered', reason: '' },
    details: ['cleanup marker could not be reset'],
  }])
  assert.deepEqual(f.failures, [])
})

await test('backup-list refresh failure cannot turn a successful restore into a failed restore', async () => {
  const f = fixture(({ action }) => {
    if (action === 'restore') return { restored: { attached: true, backupConsumed: true, cleanupWarning: 'marker warning' } }
    throw new Error('list unavailable')
  })
  await f.actions.restoreOne({ path: 'session-x/backup', title: 'Recovered' })
  assert.deepEqual(f.failures, [])
  assert.deepEqual(f.statuses.at(-1), {
    key: 'status.restoredDone', params: { title: 'Recovered', reason: '' },
    details: ['marker warning', { key: 'status.restoreRefreshFailed', params: { message: 'list unavailable' } }],
  })
  assert.equal(f.store.getSnapshot().backupsLoading, false)
  assert.deepEqual(f.refreshes, ['refreshList'])
})

await test('restore during deletion asks to wait rather than deleting the session again', async () => {
  const f = fixture(() => { throw Object.assign(new Error('deletion in progress'), { code: 'session-backup/deleting' }) })
  await f.actions.restoreOne({ path: 'session-x/backup', title: 'Recovered' })
  assert.deepEqual(f.failures, [{ key: 'error.restoreDeleting', params: {} }])
  assert.deepEqual(f.requests.map(request => request.action), ['restore'])
})

await test('standalone backup-list refresh still reports request failures', async () => {
  const f = fixture(() => { throw new Error('list unavailable') })
  await f.actions.refreshBackups()
  assert.deepEqual(f.failures, [{ key: 'error.requestFailed', params: { message: 'list unavailable' } }])
})

await test('partial batch failure preserves deletion counts, warnings and only the remaining selection', async () => {
  const ids = ['session-done', 'session-active', 'session-failed', 'session-unattempted']
  const f = fixture(({ action, body }) => {
    assert.equal(action, 'delete')
    if (body.sessionId === ids[0]) return { deleted: {
      deleted: true, cleanup: { removed: 2, failed: [{ reason: 'object changed' }] }, warnings: ['cache unavailable'],
    } }
    if (body.sessionId === ids[1]) throw Object.assign(new Error('running'), { code: 'workspace/session-active' })
    throw new Error('backup failed')
  })
  f.store.set({ ids })
  await f.actions.deleteMany(ids)
  assert.deepEqual(plain(f.store.getSnapshot().ids), ids.slice(1))
  assert.deepEqual(f.requests.map(request => request.body.sessionId), ids.slice(0, 3))
  assert.deepEqual(f.leaves, [ids[0]])
  assert.deepEqual(f.refreshes, ['refreshList'])
  assert.deepEqual(f.failures, [{
    key: 'error.deleteFailed', params: { message: 'backup failed' }, details: [
      { key: 'status.batchDeleteProgress', params: { deleted: 1, active: 1, pending: 1, files: 2 } },
      { key: 'status.deleteWarning', params: { message: 'object changed; cache unavailable' } },
    ],
  }])
})

await test('batch completion displays both active skips and pending cleanup and retains active selections', async () => {
  const ids = ['session-done', 'session-active']
  const f = fixture(({ body }) => {
    if (body.sessionId === ids[1]) throw Object.assign(new Error('running'), { code: 'workspace/session-active' })
    return { deleted: { cleanup: { removed: 1, failed: [{ reason: 'file changed' }] } } }
  })
  f.store.set({ ids })
  await f.actions.deleteMany(ids)
  assert.deepEqual(plain(f.store.getSnapshot().ids), [ids[1]])
  assert.deepEqual(f.statuses, [{ key: 'status.deletedCleanupPending', details: [
    { key: 'status.batchDeleteProgress', params: { deleted: 1, active: 1, pending: 1, files: 1 } },
    { key: 'status.deleteWarning', params: { message: 'file changed' } },
  ] }])
  assert.deepEqual(f.failures, [])
})

await test('successful batch surfaces post-delete cache warnings and clears only deleted selections', async () => {
  const f = fixture(() => ({ deleted: { warnings: ['workspace cache unavailable'] } }))
  f.store.set({ ids: ['session-done', 'session-selected-later'] })
  await f.actions.deleteMany(['session-done'])
  assert.deepEqual(plain(f.store.getSnapshot().ids), ['session-selected-later'])
  assert.deepEqual(f.statuses, [{ key: 'status.deleted', params: { count: 1, files: 0 }, details: [
    { key: 'status.deleteWarning', params: { message: 'workspace cache unavailable' } },
  ] }])
})

await test('batch deletion aggregates uploaded object counts and retains references without a failure status', async () => {
  const ids = ['session-a', 'session-b']
  const f = fixture(({ body }) => ({ deleted: {
    cleanup: { removed: 1, failed: [] }, attachments: body.sessionId === ids[0]
      ? { removed: 2, bytes: 1024, retained: 2, deferred: 1, failed: [] }
      : { removed: 1, bytes: 1024, retained: 1, deferred: 0, failed: [] },
  } }))
  f.store.set({ ids })
  await f.actions.deleteMany(ids)
  assert.deepEqual(f.statuses, [{ key: 'status.deletedManyCleaned', params: { count: 2, files: 5 }, details: [
    { key: 'status.attachmentsCleaned', params: { count: 3, bytes: '2.0 KB' } },
    { key: 'status.attachmentsRetained', params: { count: 3 } },
    { key: 'status.attachmentsDeferred', params: { count: 1 } },
  ] }])
  assert.deepEqual(f.failures, [])
  assert.deepEqual(plain(f.store.getSnapshot().ids), [])
})

await test('batch attachment failures preserve actual counts and warnings when a later delete fails', async () => {
  const ids = ['session-a', 'session-failed']
  const f = fixture(({ body }) => {
    if (body.sessionId === ids[1]) throw new Error('backup failed')
    return { deleted: { attachments: {
      removed: 2, bytes: 50, retained: 1, deferred: 0, failed: [{ id: 'upload', reason: 'upload changed' }],
    } } }
  })
  f.store.set({ ids })
  await f.actions.deleteMany(ids)
  assert.deepEqual(f.failures, [{ key: 'error.deleteFailed', params: { message: 'backup failed' }, details: [
    { key: 'status.batchDeleteProgress', params: { deleted: 1, active: 0, pending: 1, files: 2 } },
    { key: 'status.attachmentsCleaned', params: { count: 2, bytes: '50 B' } },
    { key: 'status.attachmentsRetained', params: { count: 1 } },
    { key: 'status.attachmentsFailed', params: { count: 1, message: 'upload changed' } },
  ] }])
  assert.deepEqual(plain(f.store.getSnapshot().ids), [ids[1]])
})

await test('completed batch attachment failures explicitly report cleanup pending', async () => {
  const f = fixture(() => ({ deleted: { attachments: {
    removed: 1, bytes: 30, retained: 0, deferred: 0, failed: [{ id: 'upload', code: 'invalid-candidate' }],
  } } }))
  await f.actions.deleteMany(['session-a'])
  assert.equal(f.statuses.at(-1).key, 'status.deletedCleanupPending')
  assert.deepEqual(f.statuses.at(-1).details.at(-1), {
    key: 'status.attachmentsFailed', params: { count: 1, message: 'invalid-candidate' },
  })
  assert.deepEqual(f.failures, [])
})

await test('backup removal reports actual upload reclamation, retained copies and failure reasons', async () => {
  const f = fixture(({ action }) => action === 'remove' ? { removed: { attachments: {
    removed: 4, bytes: 3072, retained: 2, deferred: 1, failed: [{ id: 'upload', reason: 'file changed' }],
  } } } : { backups: [] })
  await f.actions.removeOne({ path: 'session-x/backup', title: 'Backup' })
  assert.deepEqual(f.requests, [
    { action: 'remove', body: { path: 'session-x/backup' } },
    { action: 'list', body: undefined },
  ])
  assert.deepEqual(f.statuses, [{ key: 'status.backupRemoved', params: {}, details: [
    { key: 'status.attachmentsCleaned', params: { count: 4, bytes: '3.0 KB' } },
    { key: 'status.attachmentsRetained', params: { count: 2 } },
    { key: 'status.attachmentsDeferred', params: { count: 1 } },
    { key: 'status.attachmentsFailed', params: { count: 1, message: 'file changed' } },
  ] }])
  assert.deepEqual(f.failures, [])
})

await test('a backup-list refresh failure preserves successful removal, reclamation and the removed row', async () => {
  const backup = { path: 'session-x/backup', title: 'Backup' }
  const remaining = { path: 'session-y/backup', title: 'Remaining' }
  const f = fixture(({ action }) => {
    if (action === 'remove') return { removed: { attachments: { removed: 2, bytes: 128, retained: 0, deferred: 0, failed: [] } } }
    throw new Error('list unavailable')
  })
  f.store.set({ backups: [backup, remaining], removePending: backup.path })
  await f.actions.removeOne(backup)
  assert.deepEqual(f.failures, [])
  assert.deepEqual(f.statuses.at(-1), { key: 'status.backupRemoved', params: {}, details: [
    { key: 'status.attachmentsCleaned', params: { count: 2, bytes: '128 B' } },
    { key: 'status.backupRemoveRefreshFailed', params: { message: 'list unavailable' } },
  ] })
  assert.deepEqual(plain(f.store.getSnapshot().backups), [remaining])
  assert.equal(f.store.getSnapshot().removePending, null)
  assert.equal(f.store.getSnapshot().backupsLoading, false)
})

await test('refused backup removal keeps the backup row and does not refresh the list', async () => {
  const backup = { path: 'session-x/backup', title: 'Backup' }
  const f = fixture(() => { throw new Error('backup in use') })
  f.store.set({ backups: [backup] })
  await f.actions.removeOne(backup)
  assert.deepEqual(f.failures, [{ key: 'error.requestFailed', params: { message: 'backup in use' } }])
  assert.deepEqual(plain(f.store.getSnapshot().backups), [backup])
  assert.deepEqual(f.requests.map(request => request.action), ['remove'])
  assert.deepEqual(f.statuses, [])
})

await test('legacy backup removal responses still report success', async () => {
  const f = fixture(({ action }) => action === 'remove' ? {} : { backups: [] })
  await f.actions.removeOne({ path: 'session-x/backup' })
  assert.deepEqual(f.statuses, [{ key: 'status.backupRemoved', params: {} }])
  assert.deepEqual(f.failures, [])
})

console.log(`✓ ${passed} client delete-flow tests passed (actual createActions/store; no network or session writes)`)
