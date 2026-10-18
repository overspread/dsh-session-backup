/**
 * Session backup — browser face.
 *
 * Adds three things on top of the Host's backup store:
 *
 *   1. An automatic backup taken just before the delete-session RPC removes a
 *      directory. The `remote.session` service is read through Cordis's
 *      `internal/get` waterfall, so the wrapper rides every context that reads
 *      it — including `dsh-client-ui-workspace`'s delete dialog. A failed
 *      backup refuses the delete instead of losing the only copy.
 *   2. A selection mode over the session list (row checkboxes + a menu row)
 *      that batches backup and delete.
 *   3. A backup manager dialog listing every stored backup with one-click
 *      restore and delete.
 *
 * The Host face owns the filesystem; this file owns only what a page can see.
 */
import { createElement, Fragment, useEffect, useState, useSyncExternalStore } from 'react'
import {
  Button,
  Checkbox,
  IconArchiveOutlineRegular,
  IconCheckOutlineRegular,
  IconTrashOutlineRegular,
  MenuItemButton,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Cordis plugin id; also the module id this file registers under. */
const name = 'session-backup'
/** Locale namespace; every dictionary key below lives in it. */
const NS = 'dsh-session-backup'
/** Document-relative form of the Host routes, as session-log-export does it. */
const ROUTE = '/api/session.backup'.slice(1)

const zh = {
  'footer.select': '多选',
  'footer.exit': '退出多选',
  'footer.backups': '备份',
  'footer.count': '已选 {count} 个',
  'footer.backupSelected': '备份选中',
  'footer.deleteSelected': '删除选中',
  'footer.clear': '清空',
  'row.toggle': '选择此会话',
  'menu.select': '加入选择',
  'menu.deselect': '移出选择',
  'menu.backup': '立即备份',
  'dialog.delete.title': '删除选中的会话？',
  'dialog.delete.description': '将彻底删除 {count} 个会话。每个会话在删除前都会先自动备份到本地备份目录，之后可以在「备份」里一键恢复。',
  'dialog.delete.confirm': '删除',
  'dialog.delete.cancel': '取消',
  'dialog.backups.title': '会话备份',
  'dialog.backups.empty': '还没有备份。删除会话时会自动备份，也可以勾选会话后点「备份选中」。',
  'dialog.backups.loading': '正在读取备份…',
  'dialog.backups.restore': '恢复',
  'dialog.backups.remove': '删除备份',
  'dialog.backups.removeConfirm': '确认删除',
  'dialog.backups.notRestorable': '缺少清单，无法恢复',
  'dialog.backups.inconsistent': '有 {count} 个文件在复制时仍在写入',
  'dialog.close': '关闭',
  'error.title': '操作失败',
  'error.dismiss': '知道了',
  'status.backupCreated': '已备份 {count} 个会话',
  'status.backupBeforeDelete': '已备份「{title}」',
  'status.deleted': '已删除 {count} 个会话',
  'status.deletedWithSkipped': '已删除 {deleted} 个会话，{active} 个正在运行的已跳过',
  'status.activeSkipped': '{count} 个会话正在运行，未删除',
  'status.restored': '已恢复「{title}」，它已重新出现在工作区列表里',
  'status.restoredDetached': '已恢复「{title}」的文件，但没能把它重新挂回工作区：{reason}',
  'status.backupRemoved': '已删除该备份',
  'error.requestFailed': '请求失败：{message}',
  'error.deleteFailed': '删除失败：{message}',
  'error.backupBlockedDelete': '备份失败，已取消删除：{message}',
}

const en = {
  'footer.select': 'Select',
  'footer.exit': 'Exit select',
  'footer.backups': 'Backups',
  'footer.count': '{count} selected',
  'footer.backupSelected': 'Back up selected',
  'footer.deleteSelected': 'Delete selected',
  'footer.clear': 'Clear',
  'row.toggle': 'Select this session',
  'menu.select': 'Add to selection',
  'menu.deselect': 'Remove from selection',
  'menu.backup': 'Back up now',
  'dialog.delete.title': 'Delete the selected sessions?',
  'dialog.delete.description': 'This permanently deletes {count} sessions. Each one is backed up to the local backup directory first, and any backup can be restored in one click from “Backups”.',
  'dialog.delete.confirm': 'Delete',
  'dialog.delete.cancel': 'Cancel',
  'dialog.backups.title': 'Session backups',
  'dialog.backups.empty': 'No backups yet. Deleting a session backs it up first; you can also select sessions and press “Back up selected”.',
  'dialog.backups.loading': 'Loading backups…',
  'dialog.backups.restore': 'Restore',
  'dialog.backups.remove': 'Delete backup',
  'dialog.backups.removeConfirm': 'Confirm delete',
  'dialog.backups.notRestorable': 'Manifest missing; cannot restore',
  'dialog.backups.inconsistent': '{count} files were still being written during the copy',
  'dialog.close': 'Close',
  'error.title': 'Operation failed',
  'error.dismiss': 'Dismiss',
  'status.backupCreated': 'Backed up {count} sessions',
  'status.backupBeforeDelete': 'Backed up “{title}”',
  'status.deleted': 'Deleted {count} sessions',
  'status.deletedWithSkipped': 'Deleted {deleted} sessions; skipped {active} still running',
  'status.activeSkipped': '{count} sessions are running and were not deleted',
  'status.restored': 'Restored “{title}”; it is listed under its workspace again',
  'status.restoredDetached': 'Restored the files for “{title}”, but could not re-attach it to a workspace: {reason}',
  'status.backupRemoved': 'Backup deleted',
  'error.requestFailed': 'Request failed: {message}',
  'error.deleteFailed': 'Delete failed: {message}',
  'error.backupBlockedDelete': 'Backup failed; the delete was cancelled: {message}',
}

const CSS = `
.dshsb-footer { display: flex; flex-direction: column; gap: 4px; width: 100%; min-width: 0; }
.dshsb-bar { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.dshsb-count, .dshsb-status { font-size: 11px; line-height: 16px; opacity: .7; margin: 0; overflow-wrap: anywhere; }
.dshsb-status:empty { display: none; }
.dshsb-row { display: inline-flex; align-items: center; }
.dshsb-rowCheckbox { padding: 2px; }
.dshsb-rowCheckbox > span { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.dshsb-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dshsb-backups { max-height: 56vh; overflow: auto; }
.dshsb-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border: 1px solid rgba(127,127,127,.28); border-radius: 8px; }
.dshsb-itemMain { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dshsb-itemTitle { font-size: 12px; overflow-wrap: anywhere; }
.dshsb-itemMeta, .dshsb-itemWarn { font-size: 11px; opacity: .7; }
.dshsb-itemActions { display: flex; gap: 4px; flex: none; }
.dshsb-empty { font-size: 12px; opacity: .7; margin: 0; }
`

/**
 * Insert this plugin's stylesheet once per page. Guarded by the same
 * `style[data-plugin-css]` marker first-party packages use, so a second
 * evaluation (HMR) does not stack a duplicate tag.
 */
function injectStyles() {
  const tagId = `${NS}.css`
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = NS
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * One page-wide store: selection mode, the checked ids, the open dialog, the
 * last status line, and the loaded backup list. The snapshot object only ever
 * changes identity inside `set`, which is what `useSyncExternalStore` needs to
 * avoid render loops.
 */
function createStore() {
  let state = {
    selecting: false,
    ids: [],
    dialog: null,
    removePending: null,
    status: null,
    error: null,
    backups: null,
    backupsLoading: false,
  }
  const listeners = new Set()
  const set = (patch) => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const toggleId = (id) =>
    set({ ids: state.ids.includes(id) ? state.ids.filter((value) => value !== id) : [...state.ids, id] })
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    set,
    enterSelecting: () => set({ selecting: true }),
    exitSelecting: () => set({ selecting: false, ids: [], dialog: null }),
    toggleId,
    toggleFromMenu: (id) => set({ selecting: true, ids: state.ids.includes(id) ? state.ids.filter((value) => value !== id) : [...state.ids, id] }),
    clearSelection: () => set({ ids: [] }),
    openDialog: (dialog) => set({ dialog, removePending: null }),
    closeDialog: () => set({ dialog: null, removePending: null }),
    setRemovePending: (path) => set({ removePending: path }),
    setStatus: (status) => set({ status }),
    fail: (error) => set({ error, status: error }),
    dismissError: () => set({ error: null }),
  }
}

const store = createStore()

const useStore = () => useSyncExternalStore(store.subscribe, store.getSnapshot)

// ---------------------------------------------------------------------------
// Host API
// ---------------------------------------------------------------------------

/**
 * Call one Host route. Failures carry the transport facts the delete wrapper
 * needs to tell "the Host refused" apart from "this profile has no Host face".
 */
async function call(action, body) {
  const init =
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  const response = await fetch(`${ROUTE}.${action}`, init)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const code = payload?.error?.code
  if (!response.ok || code !== undefined) {
    const error = new Error(payload?.error?.message ?? `${ROUTE}.${action} failed (${response.status})`)
    error.code = code
    error.status = response.status
    error.routeMissing = code === undefined && (response.status === 404 || response.status === 405)
    throw error
  }
  return payload
}

function messageOf(error) {
  return String(error?.message ?? error)
}

// ---------------------------------------------------------------------------
// Delete interception
// ---------------------------------------------------------------------------

const wrappedRemotes = new WeakMap()

/**
 * Wrap the `remote.session` service so its `deleteSession` backs up first.
 * Cached per underlying service, and every other member is forwarded and
 * bound to the original so tracing and RPC semantics stay untouched.
 *
 * Exported for the tests.
 */
export function wrapSessionRemote(service) {
  if (service === null || typeof service !== 'object') return service
  const cached = wrappedRemotes.get(service)
  if (cached !== undefined) return cached
  const wrapper = new Proxy(service, {
    get(target, prop) {
      if (prop === 'deleteSession') return (request) => deleteSessionWithBackup(target, request)
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrappedRemotes.set(service, wrapper)
  return wrapper
}

/**
 * Copy the session to the backup store, then let the delete proceed.
 * A genuine backup failure answers the caller with a failed RemoteResult so
 * the directory outlives the attempt; a profile with no Host routes (or a
 * session that is already gone) only warns, so the plugin can never turn into
 * a delete-blocker.
 */
async function deleteSessionWithBackup(target, request) {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : undefined
  if (sessionId !== undefined) {
    try {
      const { backup } = await call('create', { sessionId })
      store.setStatus({ key: 'status.backupBeforeDelete', params: { title: backup?.title ?? sessionId } })
    } catch (error) {
      const ignorable = error?.routeMissing === true || error?.code === 'session-backup/not-found'
      if (!ignorable) {
        store.fail({ key: 'error.backupBlockedDelete', params: { message: messageOf(error) } })
        return {
          ok: false,
          error: { code: 'session-backup/failed', message: `session backup failed: ${messageOf(error)}` },
        }
      }
      console.warn(`session-backup: no backup taken for ${sessionId} (${messageOf(error)})`)
    }
  }
  return target.deleteSession(request)
}

/**
 * Install the `internal/get` wrapper ahead of every other listener.
 *
 * `remote.session` is a compound service name; reading it walks the waterfall
 * and the built-in terminal throws `without inject` unless the reader declared
 * it. Registering with `prepend` keeps this wrapper outermost, so it sees the
 * value whichever listener below resolved it — including
 * `dsh-remote-session-inject-fix`'s fallback, which this then subsumes.
 *
 * Exported for the tests, which drive it against a real Cordis context.
 */
export function installInterceptor(ctx) {
  ctx.on(
    'internal/get',
    function interceptSessionRemote(readCtx, prop, error, next) {
      if (prop !== 'remote.session') return next()
      let service
      try {
        service = next()
      } catch (reason) {
        if (reason !== error) throw reason
        service = readCtx.get(prop)
        if (service === undefined) throw reason
      }
      return wrapSessionRemote(service)
    },
    { prepend: true },
  )
}

// ---------------------------------------------------------------------------
// Batch actions
// ---------------------------------------------------------------------------

/** Build the actions the injected components receive as props. */
function createActions(ctx) {
  const sessionService = () => ctx.remote.session

  const backupOne = async (sessionId) => {
    try {
      await call('create', { sessionId })
      store.setStatus({ key: 'status.backupCreated', params: { count: 1 } })
    } catch (error) {
      store.fail({ key: 'error.requestFailed', params: { message: messageOf(error) } })
    }
  }

  const backupMany = async (sessionIds) => {
    if (sessionIds.length === 0) return
    try {
      for (const sessionId of sessionIds) await call('create', { sessionId })
      store.setStatus({ key: 'status.backupCreated', params: { count: sessionIds.length } })
    } catch (error) {
      store.fail({ key: 'error.requestFailed', params: { message: messageOf(error) } })
    }
  }

  const deleteMany = async (sessionIds) => {
    if (sessionIds.length === 0) return
    const service = sessionService()
    let deleted = 0
    let active = 0
    for (const sessionId of sessionIds) {
      let result
      try {
        result = await service.deleteSession({ sessionId })
      } catch (error) {
        store.fail({ key: 'error.deleteFailed', params: { message: messageOf(error) } })
        return
      }
      if (result?.ok === false) {
        if (result.error?.code === 'workspace/session-active') {
          active += 1
          continue
        }
        store.fail({ key: 'error.deleteFailed', params: { message: messageOf(result.error) } })
        return
      }
      deleted += 1
    }
    store.clearSelection()
    if (active > 0) {
      store.setStatus({
        key: deleted > 0 ? 'status.deletedWithSkipped' : 'status.activeSkipped',
        params: { deleted, active, count: active },
      })
    } else {
      store.setStatus({ key: 'status.deleted', params: { count: deleted } })
    }
  }

  const refreshBackups = async () => {
    store.set({ backupsLoading: true })
    try {
      const payload = await call('list')
      store.set({ backups: Array.isArray(payload?.backups) ? payload.backups : [], backupsLoading: false })
    } catch (error) {
      store.set({ backupsLoading: false })
      store.fail({ key: 'error.requestFailed', params: { message: messageOf(error) } })
    }
  }

  const restoreOne = async (backup) => {
    try {
      const payload = await call('restore', { path: backup.path })
      const restored = payload?.restored ?? {}
      const title = restored.title ?? backup.title
      store.setStatus(restored.attached === false
        ? { key: 'status.restoredDetached', params: { title, reason: restored.reason ?? '' } }
        : { key: 'status.restored', params: { title } })
      await refreshBackups()
    } catch (error) {
      store.fail({ key: 'error.requestFailed', params: { message: messageOf(error) } })
    }
  }

  const removeOne = async (backup) => {
    try {
      await call('remove', { path: backup.path })
      store.setStatus({ key: 'status.backupRemoved', params: {} })
      await refreshBackups()
    } catch (error) {
      store.fail({ key: 'error.requestFailed', params: { message: messageOf(error) } })
    }
  }

  return { backupOne, backupMany, deleteMany, refreshBackups, restoreOne, removeOne }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 1024) return `${Math.max(0, Math.round(value || 0))} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let scaled = value / 1024
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[unit]}`
}

function formatWhen(iso) {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return String(iso ?? '')
  return at.toLocaleString()
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** `sidebar.session.row.leading`: a checkbox on rows that show no status dots. */
function RowSelectCheckbox({ sessionId, t }) {
  const state = useStore()
  if (!state.selecting) return null
  return createElement(
    'div',
    {
      className: 'dshsb-row',
      // The row's own onClick opens the session; selecting must not navigate.
      onClick: (event) => event.stopPropagation(),
    },
    createElement(Checkbox, {
      checked: state.ids.includes(sessionId),
      onChange: () => store.toggleId(sessionId),
      label: t('row.toggle'),
      title: t('row.toggle'),
      className: 'dshsb-rowCheckbox',
    }),
  )
}

/** `sidebar.workspaces.session.menu.item`: select toggle + immediate backup. */
function SessionMenuItems({ sessionId, t, actions }) {
  const state = useStore()
  const selected = state.ids.includes(sessionId)
  return createElement(
    Fragment,
    null,
    createElement(MenuItemButton, {
      key: 'select',
      separatorBefore: true,
      icon: createElement(IconCheckOutlineRegular, { size: 14 }),
      onSelect: () => store.toggleFromMenu(sessionId),
      children: selected ? t('menu.deselect') : t('menu.select'),
    }),
    createElement(MenuItemButton, {
      key: 'backup',
      icon: createElement(IconArchiveOutlineRegular, { size: 14 }),
      onSelect: () => void actions.backupOne(sessionId),
      children: t('menu.backup'),
    }),
  )
}

/** `sidebar.footer.action`: the select-mode switch and the batch action bar. */
function FooterActions({ wide, t, actions }) {
  const state = useStore()
  const count = state.ids.length
  const children = []
  if (!state.selecting) {
    children.push(
      createElement(
        Button,
        {
          key: 'select',
          size: 'sm',
          variant: 'outline',
          onClick: () => store.enterSelecting(),
          children: t('footer.select'),
        },
      ),
    )
    children.push(
      createElement(
        Button,
        {
          key: 'backups',
          size: 'sm',
          variant: 'outline',
          icon: createElement(IconArchiveOutlineRegular, { size: 14 }),
          onClick: () => store.openDialog('backups'),
          children: t('footer.backups'),
        },
      ),
    )
  } else {
    children.push(createElement('span', { key: 'count', className: 'dshsb-count' }, t('footer.count', { count })))
    children.push(
      createElement(
        Button,
        {
          key: 'backup',
          size: 'sm',
          disabled: count === 0,
          onClick: () => void actions.backupMany(state.ids),
          children: t('footer.backupSelected'),
        },
      ),
    )
    children.push(
      createElement(
        Button,
        {
          key: 'delete',
          size: 'sm',
          disabled: count === 0,
          onClick: () => store.openDialog('confirmDelete'),
          children: t('footer.deleteSelected'),
        },
      ),
    )
    children.push(
      createElement(
        Button,
        {
          key: 'clear',
          size: 'sm',
          disabled: count === 0,
          onClick: () => store.clearSelection(),
          children: t('footer.clear'),
        },
      ),
    )
    children.push(
      createElement(
        Button,
        { key: 'exit', size: 'sm', onClick: () => store.exitSelecting(), children: t('footer.exit') },
      ),
    )
  }
  return createElement(
    'div',
    { className: 'dshsb-footer', 'data-wide': wide === true ? 'true' : undefined },
    createElement('div', { className: 'dshsb-bar' }, ...children),
    createElement(
      'p',
      { className: 'dshsb-status', role: 'status' },
      state.status === null ? '' : t(state.status.key, state.status.params ?? {}),
    ),
  )
}

/** The batch-delete confirmation. */
function ConfirmDeleteDialog({ open, t, actions }) {
  const state = useStore()
  const [busy, setBusy] = useState(false)
  const close = () => {
    if (!busy) store.closeDialog()
  }
  const confirm = () => {
    const ids = state.ids
    setBusy(true)
    store.closeDialog()
    void actions.deleteMany(ids).finally(() => setBusy(false))
  }
  return createElement(Modal, {
    open,
    onClose: close,
    title: t('dialog.delete.title'),
    description: t('dialog.delete.description', { count: state.ids.length }),
    closeLabel: t('dialog.close'),
    footer: createElement(
      Fragment,
      null,
      createElement(
        Button,
        { key: 'cancel', onClick: close, disabled: busy, children: t('dialog.delete.cancel') },
      ),
      createElement(Button, {
        key: 'confirm',
        variant: 'primary',
        onClick: confirm,
        disabled: busy,
        'data-modal-autofocus': true,
        children: t('dialog.delete.confirm'),
      }),
    ),
  })
}

/** One backup row: metadata, restore, and a two-click destructive remove. */
function BackupRow({ backup, pending, t, actions }) {
  const inconsistent = Array.isArray(backup.inconsistent) ? backup.inconsistent.length : 0
  return createElement(
    'li',
    { className: 'dshsb-item', 'data-backup-path': backup.path },
    createElement(
      'div',
      { className: 'dshsb-itemMain' },
      createElement('span', { className: 'dshsb-itemTitle' }, backup.title),
      createElement(
        'span',
        { className: 'dshsb-itemMeta' },
        `${formatWhen(backup.createdAt)} · ${formatBytes(backup.bytes)}`,
      ),
      backup.consistent === false || inconsistent > 0
        ? createElement('span', { className: 'dshsb-itemWarn' }, t('dialog.backups.inconsistent', { count: inconsistent }))
        : null,
    ),
    createElement(
      'div',
      { className: 'dshsb-itemActions' },
      createElement(Button, {
        key: 'restore',
        size: 'sm',
        disabled: backup.restorable === false,
        title: backup.restorable === false ? t('dialog.backups.notRestorable') : undefined,
        onClick: () => void actions.restoreOne(backup),
        children: t('dialog.backups.restore'),
      }),
      createElement(Button, {
        key: 'remove',
        size: 'sm',
        onClick: () => (pending ? void actions.removeOne(backup) : store.setRemovePending(backup.path)),
        children: pending ? t('dialog.backups.removeConfirm') : t('dialog.backups.remove'),
      }),
    ),
  )
}

/** The backup manager: the list, refresh on open, restore, and delete. */
function BackupsDialog({ open, t, actions }) {
  const state = useStore()
  useEffect(() => {
    if (open) void actions.refreshBackups()
  }, [open])
  const rows = (state.backups ?? []).map((backup) =>
    createElement(BackupRow, {
      key: backup.path,
      backup,
      t,
      actions,
      pending: state.removePending === backup.path,
    }),
  )
  let body
  if (rows.length === 0) {
    body = createElement(
      'p',
      { className: 'dshsb-empty' },
      state.backupsLoading ? t('dialog.backups.loading') : t('dialog.backups.empty'),
    )
  } else {
    body = createElement('ul', { className: 'dshsb-list' }, ...rows)
  }
  return createElement(Modal, {
    open,
    onClose: () => store.closeDialog(),
    title: t('dialog.backups.title'),
    closeLabel: t('dialog.close'),
    contentClassName: 'dshsb-backups',
    children: body,
    footer: createElement(Button, { onClick: () => store.closeDialog(), children: t('dialog.close') }),
  })
}

/** The failure dialog for errors the status line alone would bury. */
function ErrorDialog({ open, t }) {
  const state = useStore()
  return createElement(Modal, {
    open,
    onClose: () => store.dismissError(),
    title: t('error.title'),
    closeLabel: t('dialog.close'),
    children: createElement('p', null, state.error === null ? '' : t(state.error.key, state.error.params ?? {})),
    footer: createElement(
      Button,
      { variant: 'primary', onClick: () => store.dismissError(), children: t('error.dismiss') },
    ),
  })
}

/** `shell.overlay`: the dialogs, so they survive a collapsed sidebar. */
function BackupOverlay({ t, actions }) {
  const state = useStore()
  return createElement(
    Fragment,
    null,
    createElement(ConfirmDeleteDialog, { t, actions, open: state.dialog === 'confirmDelete' }),
    createElement(BackupsDialog, { t, actions, open: state.dialog === 'backups' }),
    createElement(ErrorDialog, { t, open: state.error !== null }),
  )
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Mount the backup UI and the delete interceptor.
 * @param ctx - browser context carrying slots, locale, and the remote service.
 */
export function apply(ctx) {
  const actions = createActions(ctx)
  installInterceptor(ctx)
  injectStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-backup: locale')
  ctx.slots.inject('sidebar.session.row.leading', () =>
    ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'session-backup', order: 20, locale: NS }, RowSelectCheckbox),
  )
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-backup',
        order: 500,
        locale: NS,
        inject: () => ({ actions }),
      },
      SessionMenuItems,
    ),
  )
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'session-backup', locale: NS, inject: () => ({ actions }) },
      FooterActions,
    ),
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'session-backup', locale: NS, inject: () => ({ actions }) },
      BackupOverlay,
    ),
  )
}

/**
 * `remote` is declared so this plugin's own batch delete can read the service;
 * the compound `remote.session` read itself is resolved by the interceptor
 * above, exactly as `dsh-client-ui-workspace` relies on its own listener.
 */
export const inject = ['slots', 'locale', 'remote']
