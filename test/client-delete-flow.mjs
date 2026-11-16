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
const declaration = source.match(/^function createActions\(ctx\) \{\r?\n[\s\S]*?^\}/m)?.[0]
assert.ok(declaration, 'extract the real createActions declaration from src/client.mjs')
const script = new Script(`"use strict";\n${declaration}\ncreateActions`, {
  filename: clientUrl.pathname,
})
const plain = value => structuredClone(value)

function fixture(respond = () => ({ deleted: { deleted: true } })) {
  const requests = []
  const statuses = []
  const failures = []
  const refreshes = []
  const sets = []
  const unexpected = name => () => { throw new Error(`Unexpected client boundary: ${name}`) }
  const context = createContext({
    call: async (action, body) => {
      const request = { action, body: plain(body) }
      requests.push(request)
      return await respond(request, requests.length)
    },
    store: {
      setStatus: status => statuses.push(plain(status)),
      fail: error => failures.push(plain(error)),
      // `refreshBackups` marks loading via store.set; recording instead of
      // throwing lets the action run through to its list fetch.
      set: value => sets.push(plain(value)),
      clearSelection: unexpected('store.clearSelection'),
    },
    messageOf: error => String(error?.message ?? error),
    refreshList: () => refreshes.push('refreshList'),
    leaveIfCurrent: unexpected('leaveIfCurrent'),
    fetch: unexpected('fetch'),
  })
  const createActions = script.runInContext(context)
  const actions = createActions({})
  assert.equal(typeof actions.backupOne, 'function')
  assert.equal(typeof actions.deleteOne, 'function')
  return { actions, requests, statuses, failures, refreshes, sets }
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

console.log(`✓ ${passed} client delete-flow tests passed (actual createActions; no network or session writes)`)
