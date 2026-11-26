/** Exercise actual Client actions and control callbacks without a running profile. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script, createContext } from 'node:vm'
import test from 'node:test'

const source = await readFile(new URL('../src/client.mjs', import.meta.url), 'utf8')
function declaration(name) {
  const match = source.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{\\r?\\n[\\s\\S]*?^\\}`, 'm'))
  assert.ok(match, `Actual ${name} source must be present`)
  return match[0]
}
const plain = value => structuredClone(value)
function fixture(respond) {
  let state = {
    selecting: false, ids: [], status: null, cleanupSettings: null, cleanupLoading: false,
    cleanupSaving: false, cleanupError: null, cleanupStatus: null,
  }
  const requests = []
  const context = createContext({
    call: async (action, body) => {
      requests.push({ action, body: plain(body) })
      return await respond(action, body)
    },
    messageOf: error => String(error?.message ?? error),
    store: { set: patch => { state = { ...state, ...plain(patch) } } },
    useStore: () => state,
    useEffect() {},
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment', Modal: 'Modal', Button: 'Button', IconArchiveOutlineRegular: 'Archive',
  })
  const actions = new Script(`${declaration('createActions')}\ncreateActions({})`).runInContext(context)
  const render = name => new Script(`${declaration(name)}\n${name}`).runInContext(context)
  return { actions, requests, render, state: () => state, set: patch => { state = { ...state, ...patch } } }
}
function nodes(tree) {
  return tree == null || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)]
}

test('cleanup settings load the Host value and never guess enabled on failed reads', async () => {
  const f = fixture(async () => ({ settings: { cleanupOnDelete: false, editable: true, pending: [] } }))
  await f.actions.refreshCleanup()
  assert.deepEqual(f.requests, [{ action: 'cleanup-settings', body: undefined }])
  assert.equal(f.state().cleanupSettings.cleanupOnDelete, false)
  assert.equal(f.state().cleanupLoading, false)
  const refused = fixture(async () => { throw new Error('Host unavailable') })
  await refused.actions.refreshCleanup()
  assert.equal(refused.state().cleanupSettings, null)
  assert.equal(refused.state().cleanupError, 'Host unavailable')
})

test('checkbox changes acknowledge persisted settings, with no optimistic enable on failure', async () => {
  const f = fixture(async (_action, body) => ({ settings: { cleanupOnDelete: body.cleanupOnDelete, editable: true, pending: [] } }))
  await f.actions.saveCleanup(true)
  assert.deepEqual(f.requests, [{ action: 'cleanup-settings', body: { cleanupOnDelete: true } }])
  assert.equal(f.state().cleanupSettings.cleanupOnDelete, true)
  assert.deepEqual(f.state().cleanupStatus, { key: 'cleanup.saved' })
  const refused = fixture(async () => { throw new Error('Configuration is overridden') })
  refused.set({ cleanupSettings: { cleanupOnDelete: false } })
  await refused.actions.saveCleanup(true)
  assert.equal(refused.state().cleanupSettings.cleanupOnDelete, false)
  assert.equal(refused.state().cleanupError, 'Configuration is overridden')
  assert.equal(refused.state().cleanupSaving, false)
})

test('a malformed settings response cannot show a saved setting', async () => {
  const f = fixture(async () => ({}))
  f.set({ cleanupSettings: { cleanupOnDelete: false } })
  await f.actions.saveCleanup(true)
  assert.equal(f.state().cleanupSettings.cleanupOnDelete, false)
  assert.equal(f.state().cleanupStatus, null)
  assert.match(f.state().cleanupError, /not saved/)
})

test('retry reports partial failures and keeps Host pending inventory visible', async () => {
  const f = fixture(async () => ({
    settings: { cleanupOnDelete: true, editable: true, pending: [{ sessionId: 'session-a', count: 1 }] },
    results: [{ removed: 2, failed: [] }, { removed: 0, failed: [{ id: 'a', reason: 'file changed' }] }],
  }))
  await f.actions.retryCleanup()
  assert.deepEqual(f.requests, [{ action: 'cleanup-retry', body: {} }])
  assert.deepEqual(f.state().cleanupStatus, { key: 'cleanup.partial', params: { message: 'file changed' } })
  assert.equal(f.state().cleanupSettings.pending.length, 1)
  assert.equal(f.state().cleanupSaving, false)
})

test('retry reports actual removal count and transport failures', async () => {
  const f = fixture(async () => ({ settings: { cleanupOnDelete: true, pending: [] }, results: [{ removed: 3, failed: [] }] }))
  await f.actions.retryCleanup()
  assert.deepEqual(f.state().cleanupStatus, { key: 'cleanup.done', params: { count: 3 } })
  const refused = fixture(async () => { throw new Error('cleanup off') })
  await refused.actions.retryCleanup()
  assert.equal(refused.state().cleanupStatus, null)
  assert.equal(refused.state().cleanupError, 'cleanup off')
})

test('footer puts Temporary files immediately after Backups', () => {
  const f = fixture(async () => ({}))
  const tree = f.render('FooterActions')({ t: key => key, actions: f.actions })
  const buttons = nodes(tree).filter(node => node.type === 'Button')
  assert.deepEqual(buttons.map(node => node.props.children), ['footer.select', 'footer.backups', 'footer.cleanup'])
})

test('cleanup controls reflect Host state, prevent uneditable changes and guard retry while off', () => {
  const f = fixture(async () => ({}))
  f.set({ cleanupSettings: { cleanupOnDelete: false, editable: false, pending: [{ sessionId: 'x', count: 1 }] } })
  const dialog = f.render('CleanupDialog')({ open: true, t: key => key, actions: f.actions })
  const body = nodes(dialog.props.children)
  const checkbox = body.find(node => node.type === 'input')
  assert.equal(checkbox.props.type, 'checkbox')
  assert.equal(checkbox.props.checked, false)
  assert.equal(checkbox.props.disabled, true)
  const retry = body.find(node => node.type === 'Button' && node.props.children === 'cleanup.retry')
  assert.equal(retry.props.disabled, true)
  f.set({ cleanupSettings: { cleanupOnDelete: true, editable: true, pending: [] }, cleanupSaving: true })
  const saving = nodes(f.render('CleanupDialog')({ open: true, t: key => key, actions: f.actions }).props.children)
  assert.equal(saving.find(node => node.type === 'input').props.disabled, true)
})
