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
  const requests = []
  const refreshes = []
  const hookStates = new Map()
  let currentHooks
  let store
  const context = createContext({
    call: async (action, body) => {
      requests.push({ action, body: plain(body) })
      return await respond(action, body)
    },
    messageOf: error => String(error?.message ?? error),
    useStore: () => store.getSnapshot(),
    useState: initial => {
      const hooks = currentHooks
      const index = hooks.cursor++
      if (!(index in hooks.values)) hooks.values[index] = initial
      return [hooks.values[index], value => {
        hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value
      }]
    },
    useEffect: (effect, dependencies) => {
      const hooks = currentHooks
      const index = hooks.cursor++
      const previous = hooks.values[index]
      if (!previous || dependencies.some((value, i) => value !== previous[i])) hooks.effects.push(effect)
      hooks.values[index] = dependencies
    },
    refreshList: () => refreshes.push('refreshList'),
    leaveIfCurrent: id => refreshes.push(id),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment', Modal: 'Modal', Button: 'Button', IconArchiveOutlineRegular: 'Archive',
  })
  store = new Script(`${declaration('createStore')}\ncreateStore()`).runInContext(context)
  context.store = store
  for (const name of ['busyActivityOf', 'activityLineOf', 'formatBytes', 'formatWhen', 'cleanupSettingsOf', 'cleanupSummary', 'attachmentCleanupDetails']) {
    context[name] = new Script(`${declaration(name)}\n${name}`).runInContext(context)
  }
  const actions = new Script(`${declaration('createActions')}\ncreateActions({})`).runInContext(context)
  const render = (name, runEffects = false) => {
    const component = new Script(`${declaration(name)}\n${name}`).runInContext(context)
    return props => {
      if (!hookStates.has(name)) hookStates.set(name, { values: [], cursor: 0, effects: [] })
      currentHooks = hookStates.get(name)
      currentHooks.cursor = 0
      currentHooks.effects = []
      const tree = component(props)
      if (runEffects) for (const effect of currentHooks.effects) effect()
      return tree
    }
  }
  return { actions, store, requests, refreshes, render, state: () => plain(store.getSnapshot()), set: store.set }
}
function nodes(tree) {
  return tree == null || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)]
}
function textOf(tree) {
  if (tree == null) return ''
  if (typeof tree !== 'object') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join(' ')
  return textOf(tree.children.length > 0 ? tree.children : tree.props.children)
}
const translate = (key, params = {}) => `${key} ${JSON.stringify(params)}`
const flush = () => new Promise(resolve => setImmediate(resolve))
function confirmButton(dialog) {
  return nodes(dialog.props.footer).find(node => node.props.key === 'confirm')
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

test('footer puts File cleanup immediately after Backups', () => {
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
  const attachmentCheckbox = body.find(node => node.props.name === 'cleanupAttachmentsOnDelete')
  assert.equal(attachmentCheckbox.props.checked, false)
  assert.equal(attachmentCheckbox.props.disabled, true)
  const retry = body.find(node => node.type === 'Button' && node.props.children === 'cleanup.retry')
  assert.equal(retry.props.disabled, true)
  f.set({ cleanupSettings: { cleanupOnDelete: true, editable: true, pending: [] }, cleanupSaving: true })
  const saving = nodes(f.render('CleanupDialog')({ open: true, t: key => key, actions: f.actions }).props.children)
  assert.equal(saving.filter(node => node.type === 'input').length, 2)
  assert.ok(saving.filter(node => node.type === 'input').every(node => node.props.disabled))
})

test('unreadable ledgers show session ids and reasons and allow retry without healthy pending entries', async () => {
  const settings = {
    cleanupOnDelete: true, editable: true, pending: [],
    pendingErrors: [{ sessionId: 'session-corrupt', code: 'invalid-ledger', reason: 'ledger JSON is invalid' }],
  }
  const f = fixture(async action => action === 'cleanup-settings' ? { settings } : {
    settings, results: [{ removed: 0, failed: [{ id: 'session-corrupt', reason: 'ledger JSON is invalid' }] }],
  })
  await f.actions.refreshCleanup()
  const dialog = f.render('CleanupDialog')({ open: true, t: translate, actions: f.actions })
  assert.match(textOf(dialog.props.children), /session-corrupt/)
  assert.match(textOf(dialog.props.children), /ledger JSON is invalid/)
  const retry = nodes(dialog.props.children).find(node => node.type === 'Button')
  assert.equal(retry.props.disabled, false)
  retry.props.onClick()
  await flush()
  assert.deepEqual(f.requests.map(request => request.action), ['cleanup-settings', 'cleanup-retry'])
  assert.equal(f.state().cleanupStatus.key, 'cleanup.partial')
  assert.equal(f.state().cleanupSettings.pendingErrors.length, 1)
  f.set({ cleanupSettings: { ...settings, cleanupOnDelete: false } })
  const disabled = nodes(f.render('CleanupDialog')({ open: true, t: translate, actions: f.actions }).props.children)
    .find(node => node.type === 'Button')
  assert.equal(disabled.props.disabled, true)
})

test('attachment cleanup defaults off independently of an enabled legacy setting', async () => {
  const f = fixture(async () => ({ settings: { cleanupOnDelete: true, editable: true, pending: [] } }))
  await f.actions.refreshCleanup()
  assert.equal(f.state().cleanupSettings.cleanupOnDelete, true)
  assert.equal(f.state().cleanupSettings.cleanupAttachmentsOnDelete, false)
  assert.deepEqual(f.state().cleanupSettings.attachmentPending, [])
  const dialog = f.render('CleanupDialog')({ open: true, t: translate, actions: f.actions })
  const inputs = nodes(dialog.props.children).filter(node => node.type === 'input')
  assert.deepEqual(inputs.map(input => input.props.checked), [true, false])
})

test('both checkbox callbacks save only their own setting and retain the acknowledged other value', async () => {
  let settings = { cleanupOnDelete: true, cleanupAttachmentsOnDelete: false, editable: true, pending: [], attachmentPending: [] }
  const f = fixture(async (_action, body) => ({ settings: settings = { ...settings, ...body } }))
  await f.actions.refreshCleanup()
  const render = f.render('CleanupDialog')
  const checkbox = name => nodes(render({ open: true, t: translate, actions: f.actions }).props.children)
    .find(node => node.props.name === name)
  checkbox('cleanupAttachmentsOnDelete').props.onChange({ target: { checked: true } })
  await flush()
  assert.equal(f.state().cleanupSettings.cleanupOnDelete, true)
  assert.equal(checkbox('cleanupAttachmentsOnDelete').props.checked, true)
  checkbox('cleanupOnDelete').props.onChange({ target: { checked: false } })
  await flush()
  assert.equal(checkbox('cleanupOnDelete').props.checked, false)
  assert.equal(f.state().cleanupSettings.cleanupAttachmentsOnDelete, true)
  assert.deepEqual(f.requests, [
    { action: 'cleanup-settings', body: undefined },
    { action: 'cleanup-settings', body: { cleanupAttachmentsOnDelete: true } },
    { action: 'cleanup-settings', body: { cleanupOnDelete: false } },
  ])
})

test('failed attachment saves and missing acknowledgments cannot enable the new checkbox', async () => {
  for (const respond of [async () => { throw new Error('configuration refused') },
    async () => ({ settings: { cleanupOnDelete: true } })]) {
    const f = fixture(respond)
    f.set({ cleanupSettings: { cleanupOnDelete: true, cleanupAttachmentsOnDelete: false } })
    await f.actions.saveAttachmentCleanup(true)
    assert.equal(f.state().cleanupSettings.cleanupAttachmentsOnDelete, false)
    assert.equal(f.state().cleanupSettings.cleanupOnDelete, true)
    assert.equal(f.state().cleanupStatus, null)
    assert.ok(f.state().cleanupError)
    assert.equal(f.state().cleanupSaving, false)
  }
})

test('retry is enabled only by a pending inventory or error for its own enabled setting', () => {
  const f = fixture(async () => ({}))
  const inventories = ['pending', 'pendingErrors', 'attachmentPending', 'attachmentPendingErrors']
  for (const inventory of inventories) {
    for (const cleanupOnDelete of [false, true]) {
      for (const cleanupAttachmentsOnDelete of [false, true]) {
        f.set({ cleanupSettings: {
          cleanupOnDelete, cleanupAttachmentsOnDelete, editable: true,
          [inventory]: [{ sessionId: 'session-pending', count: 1, reason: 'inventory unavailable' }],
        } })
        const dialog = f.render('CleanupDialog')({ open: true, t: translate, actions: f.actions })
        const retry = nodes(dialog.props.children).find(node => node.type === 'Button')
        assert.equal(retry.props.disabled, !(inventory.startsWith('attachment') ? cleanupAttachmentsOnDelete : cleanupOnDelete),
          `${inventory}: temporary=${cleanupOnDelete}, attachments=${cleanupAttachmentsOnDelete}`)
      }
    }
  }
})

test('attachment inventory errors show their session and reason and can retry with temporary cleanup off', async () => {
  const settings = {
    cleanupOnDelete: false, cleanupAttachmentsOnDelete: true, pending: [], attachmentPending: [], editable: true,
    attachmentPendingErrors: [{ sessionId: 'session-upload', reason: 'candidate inventory unreadable', code: 'invalid-candidates' }],
  }
  const f = fixture(async action => action === 'cleanup-settings' ? { settings } : { settings, results: [
    { kind: 'attachments', removed: 0, bytes: 0, retained: 0, deferred: 0, failed: [{ reason: 'candidate inventory unreadable' }] },
  ] })
  await f.actions.refreshCleanup()
  const dialog = f.render('CleanupDialog')({ open: true, t: translate, actions: f.actions })
  assert.match(textOf(dialog.props.children), /cleanup.attachmentPendingErrors/)
  assert.match(textOf(dialog.props.children), /session-upload/)
  assert.match(textOf(dialog.props.children), /candidate inventory unreadable/)
  const retry = nodes(dialog.props.children).find(node => node.type === 'Button')
  assert.equal(retry.props.disabled, false)
  retry.props.onClick()
  await flush()
  assert.equal(f.requests.at(-1).action, 'cleanup-retry')
  assert.equal(f.state().cleanupStatus.key, 'cleanup.partial')
  const warning = nodes(f.render('CleanupDialog')({ open: true, t: translate, actions: f.actions }).props.children)
    .find(node => node.props.role === 'alert')
  assert.match(textOf(warning), /status.attachmentsFailed/)
  assert.match(textOf(warning), /candidate inventory unreadable/)
})

test('mixed retries total actual removals and treat referenced or deferred uploads as normal retention', async () => {
  const f = fixture(async () => ({
    settings: { cleanupOnDelete: true, cleanupAttachmentsOnDelete: true, pending: [], attachmentPending: [{ sessionId: 'a', count: 3 }] },
    results: [
      { removed: 2, bytes: 20, failed: [] },
      { kind: 'attachments', removed: 3, bytes: 1024, retained: 2, deferred: 1, failed: [] },
      { kind: 'attachments', removed: 1, bytes: 1024, retained: 1, deferred: 0, failed: [] },
    ],
  }))
  await f.actions.retryCleanup()
  assert.deepEqual(f.state().cleanupStatus, {
    key: 'cleanup.done', params: { count: 6 }, details: [
      { key: 'status.attachmentsCleaned', params: { count: 4, bytes: '2.0 KB' } },
      { key: 'status.attachmentsRetained', params: { count: 3 } },
      { key: 'status.attachmentsDeferred', params: { count: 1 } },
    ],
  })
  const rendered = textOf(f.render('CleanupDialog')({ open: true, t: translate, actions: f.actions }).props.children)
  assert.match(rendered, /status.attachmentsRetained/)
  assert.match(rendered, /status.attachmentsDeferred/)
  assert.doesNotMatch(rendered, /status.attachmentsFailed|cleanup.partial/)
})

test('mixed retry failures include reasons from both artifact kinds', async () => {
  const f = fixture(async () => ({
    settings: { cleanupOnDelete: true, cleanupAttachmentsOnDelete: true, pending: [], attachmentPending: [] },
    results: [
      { removed: 1, failed: [{ reason: 'temporary file changed' }] },
      { kind: 'attachments', removed: 2, bytes: 22, retained: 0, deferred: 0, failed: [{ id: 'upload', reason: 'upload is unreadable' }] },
    ],
  }))
  await f.actions.retryCleanup()
  assert.equal(f.state().cleanupStatus.key, 'cleanup.partial')
  assert.equal(f.state().cleanupStatus.params.message, 'temporary file changed; upload is unreadable')
  assert.deepEqual(f.state().cleanupStatus.details.at(-1), {
    key: 'status.attachmentsFailed', params: { count: 1, message: 'upload is unreadable' },
  })
})

test('localized cleanup text explains independent policies and upload retention in both languages', () => {
  const dictionary = locale => {
    const match = source.match(new RegExp(`^const ${locale} = \\{[\\s\\S]*?^\\}`, 'm'))
    assert.ok(match)
    return new Script(`${match[0]}\n${locale}`).runInNewContext()
  }
  const zh = dictionary('zh')
  const en = dictionary('en')
  assert.equal(zh['footer.cleanup'], '文件清理')
  assert.equal(en['footer.cleanup'], 'File cleanup')
  assert.match(zh['cleanup.attachmentsDescription'], /原件不受影响/)
  assert.match(zh['cleanup.attachmentsDescription'], /备份或其他会话.*最后引用删除/)
  assert.match(zh['cleanup.attachmentsDescription'], /仅回收已登记候选.*不扫描历史孤儿/)
  assert.match(en['cleanup.attachmentsDescription'], /originals are unaffected/)
  assert.match(en['cleanup.attachmentsDescription'], /backups or other sessions.*last reference is deleted/)
  assert.match(en['cleanup.attachmentsDescription'], /Only registered upload candidates.*historical orphan files are not scanned/)
  for (const key of ['cleanup.attachmentsDescription', 'status.attachmentsRetained', 'status.attachmentsDeferred']) {
    assert.match(zh[key], /本次 Host 运行.*Host 重启/)
    assert.match(en[key], /this Host run.*Host restart/)
  }
  assert.match(zh['cleanup.attachmentsDescription'], /即使已不再使用也会保留/)
  assert.match(en['cleanup.attachmentsDescription'], /even after use ends/)
  assert.match(zh['status.attachmentsDeferred'], /重启后重试回收.*不是清理错误/)
  assert.match(en['status.attachmentsDeferred'], /Host restarts.*not a cleanup error/)
  assert.match(zh['cleanup.default'], /独立/)
  assert.match(en['cleanup.default'], /independently/)
})

test('status and error components render raw warnings and translated progress details', () => {
  const f = fixture(async () => ({}))
  const details = ['cleanup marker warning', {
    key: 'status.batchDeleteProgress', params: { deleted: 2, active: 1, pending: 1, files: 3 },
  }]
  f.set({
    status: { key: 'status.deletedCleanupPending', details },
    error: { key: 'error.deleteFailed', params: { message: 'backup failed' }, details },
  })
  const footer = f.render('FooterActions')({ t: translate, actions: f.actions })
  const error = f.render('ErrorDialog')({ open: true, t: translate })
  for (const rendered of [textOf(footer), textOf(error.props.children)]) {
    assert.match(rendered, /cleanup marker warning/)
    assert.match(rendered, /status.batchDeleteProgress/)
    assert.match(rendered, /"deleted":2/)
    assert.match(rendered, /"active":1/)
    assert.match(rendered, /"pending":1/)
  }
})

test('unsafe historical backups show the actual warning and disable restore', () => {
  const f = fixture(async () => ({}))
  const warning = 'Backup directory is a symbolic link'
  const row = f.render('BackupRow')({
    backup: { path: 'session-a/old', title: 'Old backup', warning, consistent: false, restorable: false },
    pending: false, t: key => key, actions: f.actions,
  })
  assert.match(textOf(row), /Backup directory is a symbolic link/)
  assert.doesNotMatch(textOf(row), /dialog.backups.inconsistent/)
  const restore = nodes(row).find(node => node.props.key === 'restore')
  assert.equal(restore.props.disabled, true)
  assert.equal(restore.props.title, warning)
})

test('single-delete errors reset after close and when opening a different session', async () => {
  const f = fixture(async () => { throw new Error('first request failed') })
  const render = f.render('DeleteOneDialog', true)
  f.store.openDeleteOne('session-a', 'A')
  confirmButton(render({ open: true, t: translate, actions: f.actions })).props.onClick()
  await flush()
  const failed = render({ open: true, t: translate, actions: f.actions })
  assert.match(textOf(failed.props.children), /first request failed/)
  failed.props.onClose()
  assert.equal(f.state().deleteReq, null)
  assert.equal(render({ open: false, t: translate, actions: f.actions }), null)
  f.store.openDeleteOne('session-a', 'A')
  assert.doesNotMatch(textOf(render({ open: true, t: translate, actions: f.actions })), /first request failed/)
  confirmButton(render({ open: true, t: translate, actions: f.actions })).props.onClick()
  await flush()
  f.store.openDeleteOne('session-b', 'B')
  assert.doesNotMatch(textOf(render({ open: true, t: translate, actions: f.actions })), /first request failed/)
})

for (const code of ['gateway/internal', 'workspace/session-active']) {
  test(`an old single-delete ${code} response cannot alter a new session dialog`, async () => {
    let reject
    const pending = new Promise((_resolve, rejectRequest) => { reject = rejectRequest })
    const f = fixture(() => pending)
    const render = f.render('DeleteOneDialog', true)
    f.store.openDeleteOne('session-a', 'A')
    confirmButton(render({ open: true, t: translate, actions: f.actions })).props.onClick()
    f.store.openDeleteOne('session-b', 'B')
    render({ open: true, t: translate, actions: f.actions })
    reject(Object.assign(new Error('old failure'), {
      code, details: { activity: [{ kind: 'agent', items: [{ id: 'run-a' }] }] },
    }))
    await flush()
    const current = render({ open: true, t: translate, actions: f.actions })
    assert.equal(f.state().deleteReq.sessionId, 'session-b')
    assert.deepEqual(plain(f.state().deleteReq.activity), [])
    assert.doesNotMatch(textOf(current), /old failure/)
    assert.match(current.props.title, /deleteOne.title/)
  })
}

test('single-delete success includes cache and temporary-file cleanup warnings', async () => {
  const f = fixture(async () => ({ deleted: {
    cleanup: { removed: 1, failed: [{ reason: 'file changed' }] }, warnings: ['cache unavailable'],
  } }))
  f.store.openDeleteOne('session-a', 'A')
  const dialog = f.render('DeleteOneDialog', true)({ open: true, t: translate, actions: f.actions })
  confirmButton(dialog).props.onClick()
  await flush()
  assert.equal(f.state().deleteReq, null)
  assert.deepEqual(plain(f.state().status), {
    key: 'status.deletedCleanupPending', params: { title: 'A', count: 1 },
    details: [{ key: 'status.deleteWarning', params: { message: 'file changed; cache unavailable' } }],
  })
  assert.deepEqual(f.refreshes, ['refreshList', 'session-a'])
})

test('single delete totals uploaded copies and explains retention without a cleanup error', async () => {
  const f = fixture(async () => ({ deleted: {
    cleanup: { removed: 1, failed: [] },
    attachments: { removed: 2, bytes: 2048, retained: 3, deferred: 1, failed: [] },
  } }))
  f.store.openDeleteOne('session-a', 'A')
  confirmButton(f.render('DeleteOneDialog', true)({ open: true, t: translate, actions: f.actions })).props.onClick()
  await flush()
  assert.deepEqual(f.state().status, {
    key: 'status.deletedOneCleaned', params: { title: 'A', count: 3 }, details: [
      { key: 'status.attachmentsCleaned', params: { count: 2, bytes: '2.0 KB' } },
      { key: 'status.attachmentsRetained', params: { count: 3 } },
      { key: 'status.attachmentsDeferred', params: { count: 1 } },
    ],
  })
  assert.equal(f.state().error, null)
  assert.equal(f.state().deleteReq, null)
})

test('single delete explicitly warns about attachment failures after the session is deleted', async () => {
  const f = fixture(async () => ({ deleted: { attachments: {
    removed: 0, bytes: 0, retained: 1, deferred: 0, failed: [{ id: 'upload', reason: 'candidate changed' }],
  } } }))
  f.store.openDeleteOne('session-a', 'A')
  confirmButton(f.render('DeleteOneDialog', true)({ open: true, t: translate, actions: f.actions })).props.onClick()
  await flush()
  assert.equal(f.state().status.key, 'status.deletedCleanupPending')
  assert.deepEqual(f.state().status.details.at(-1), {
    key: 'status.attachmentsFailed', params: { count: 1, message: 'candidate changed' },
  })
  assert.equal(f.state().deleteReq, null)
  const warning = nodes(f.render('FooterActions')({ t: translate, actions: f.actions }))
    .find(node => node.props.role === 'alert')
  assert.equal(warning.props.className, 'dshsb-error')
  assert.match(textOf(warning), /candidate changed/)
  assert.deepEqual(f.refreshes, ['refreshList', 'session-a'])
})
