/**
 * Session backup + permanent delete — browser face.
 *
 * Adds four things on top of the Host's routes:
 *
 *   1. A "彻底删除…" row on every session's `…` menu that raises a danger
 *      confirm dialog and drives the Host's own delete cascade (activity gate
 *      with a stop-first upgrade, scheduled reminders purged first, log +
 *      caches removed). On kernels that still ship their built-in delete row
 *      (the local alpha.3 build) that row is shadowed, so exactly one delete
 *      action renders on every version.
 *   2. A selection mode over the session list (row checkboxes + a menu row)
 *      that batches backup and delete — both through this plugin's own
 *      routes, never the kernel's `session/deleteSession` (absent upstream
 *      ≥ 0.2.1-alpha.5).
 *   3. An automatic backup taken just before any delete (single or batch): a
 *      failed backup refuses the delete instead of losing the only copy.
 *   4. A backup manager dialog listing every stored backup with one-click
 *      restore and delete. A restore consumes its backup: the copy is removed
 *      once the bytes are back in the live location, and a session whose
 *      Workspace is gone lands in the Sidebar's native 「未分组」 bucket — the
 *      status line says where it went instead of reporting a failed attach.
 *
 * The Host face owns the filesystem; this file owns only what a page can see.
 *
 * Delete-dialog flow mirrors the kernel's `session-actions/DeleteSession.tsx`
 * on purpose: a `workspace/session-active` refusal upgrades the same dialog to
 * its stop-first variant in place (the Host carries the activity list in the
 * error's `details`), and cancelling destroys nothing.
 *
 * Menu-shadow / route / leave-current primitives adapted from
 * `dsh-delete-session` (DDDMUC, MIT).
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
  'status.restoredDone': '已恢复「{title}」，它已重新出现在工作区列表里，本次备份已删除',
  'status.restoredUngrouped': '已恢复「{title}」，它显示在侧栏「未分组」分组下',
  'status.restoredUngroupedDone': '已恢复「{title}」，它显示在侧栏「未分组」分组下，本次备份已删除',
  'status.restoredDetached': '已恢复「{title}」的文件，但没能把它重新挂回工作区：{reason}',
  'status.backupRemoved': '已删除该备份',
  'error.requestFailed': '请求失败：{message}',
  'error.restoreExists': '无法恢复：该会话已经在列表里了（可能已恢复过，或删除没有完成）。需要的话请先彻底删除它，再恢复这份备份。',
  'error.deleteFailed': '删除失败：{message}',
  'error.backupBlockedDelete': '备份失败，已取消删除：{message}',
  'menu.deleteOne': '彻底删除…',
  'deleteOne.title': '彻底删除此会话？',
  'deleteOne.stopTitle': '停止并彻底删除此会话？',
  'deleteOne.desc': '将永久删除“{title}”的会话日志与相关缓存数据（含溢出缓存），无法恢复；删除前会先自动备份到本地备份目录。工作区文件夹中的文件不受影响。',
  'deleteOne.activity': '删除前将停止的工作',
  'deleteOne.action': '删除',
  'deleteOne.stopAction': '停止并删除',
  'deleteOne.pending': '正在删除会话…',
  'deleteOne.leaseBusy': '会话日志仍被占用：可能有正在收尾的运行，或被其它进程持有。已持续等待仍未释放，请稍等几秒后重试。',
  'status.deletedOne': '已删除「{title}」',
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
  'status.restoredDone': 'Restored “{title}”; it is listed under its workspace again, and this backup was removed',
  'status.restoredUngrouped': 'Restored “{title}”; it appears under “Ungrouped” in the sidebar',
  'status.restoredUngroupedDone': 'Restored “{title}”; it appears under “Ungrouped” in the sidebar, and this backup was removed',
  'status.restoredDetached': 'Restored the files for “{title}”, but could not re-attach it to a workspace: {reason}',
  'status.backupRemoved': 'Backup deleted',
  'error.requestFailed': 'Request failed: {message}',
  'error.restoreExists': 'Cannot restore: that session already exists in the list (it may already be restored, or the delete never completed). Delete it first if you want to restore this backup.',
  'error.deleteFailed': 'Delete failed: {message}',
  'error.backupBlockedDelete': 'Backup failed; the delete was cancelled: {message}',
  'menu.deleteOne': 'Delete session…',
  'deleteOne.title': 'Permanently delete this session?',
  'deleteOne.stopTitle': 'Stop and delete this session?',
  'deleteOne.desc': 'This permanently deletes the session log and related cached data for “{title}” (including spill caches) and cannot be undone; a backup is taken first. Files in the workspace folder are unaffected.',
  'deleteOne.activity': 'Work that will be stopped before deletion',
  'deleteOne.action': 'Delete',
  'deleteOne.stopAction': 'Stop and delete',
  'deleteOne.pending': 'Deleting session…',
  'deleteOne.leaseBusy': "The session's log is still held — work may be finishing, or another process owns it. It did not release in time; wait a few seconds and retry.",
  'status.deletedOne': 'Deleted “{title}”',
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
.dshsb-danger:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.dshsb-pending { font-size: 12px; opacity: .7; margin: 4px 0 0; }
.dshsb-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin: 4px 0 0; }
.dshsb-activity { margin: 8px 0 0; padding-left: 18px; font-size: 12px; opacity: .85; }
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
    deleteReq: null,
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
    /** Open the single-session danger confirm; `activity: []` = idle variant. */
    openDeleteOne: (sessionId, displayTitle) => set({ dialog: 'deleteOne', deleteReq: { sessionId, displayTitle, activity: [] } }),
    /** Upgrade the open dialog to its stop-first variant (Host busy refusal). */
    setDeleteActivity: (activity) => set({ deleteReq: state.deleteReq === null ? null : { ...state.deleteReq, activity } }),
    closeDeleteOne: () => set({ dialog: null, deleteReq: null }),
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
    error.details = payload?.error?.details
    error.routeMissing = code === undefined && (response.status === 404 || response.status === 405)
    throw error
  }
  return payload
}

function messageOf(error) {
  return String(error?.message ?? error)
}

/** True when the Host refused because the session has running work. */
function busyActivityOf(error) {
  if (error?.code !== 'workspace/session-active') return null
  const activity = Array.isArray(error?.details?.activity) ? error.details.activity : []
  // An empty list is the lease refusal (a writer no provider reported): show it
  // as the failure it is instead of a stop-first variant that lists nothing —
  // exactly the kernel's rule.
  return activity.length > 0 ? activity : null
}

// ---------------------------------------------------------------------------
// Post-delete housekeeping (menu-shadow / route / leave-current adapted from
// dsh-delete-session by DDDMUC, MIT)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/** The browser context captured at apply; post-delete helpers read services
 * (the session list refresh) through it without threading ctx everywhere. */
let hostCtx = null

/** Refresh the sidebar list; the Host's `api-session/removed` event already
 * drops the row — this is the belt for profiles whose listener lags. */
function refreshList() {
  try {
    const svc = hostCtx?.get?.('sessions')
    if (svc && typeof svc.refresh === 'function') {
      svc.refresh()
      return
    }
  } catch {
    // fall through
  }
  try {
    window.location.reload()
  } catch {
    // ignore
  }
}

/** Both id spellings the current-selection key may use. */
function deletedVariants(id) {
  return id.startsWith('session-') ? [id, id.slice('session-'.length)] : [id, `session-${id}`]
}

/** Deleting the session the main view is showing would leave a stale
 * neighbour selected: open a fresh session instead (or reload once the
 * selection key is cleared). */
function leaveIfCurrent(id) {
  let current = null
  try {
    const raw = localStorage.getItem('dsh.sessions.current')
    current = raw ? (JSON.parse(raw) || {}).sessionId || null : null
  } catch {
    return
  }
  if (!current || !deletedVariants(id).includes(current)) return
  const btn = document.querySelector(
    'button[class*="newSession"], button[aria-label*="New session" i], button[aria-label*="新会话"]',
  )
  if (btn) {
    try {
      btn.click()
      return
    } catch {
      // fall through to the state reset
    }
  }
  try {
    localStorage.removeItem('dsh.sessions.current')
    window.location.reload()
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Batch actions
// ---------------------------------------------------------------------------

/** Build the actions the injected components receive as props. */
function createActions(ctx) {
  /** Backup first (a failed backup refuses the delete; a missing directory or
   * a profile with no Host routes only warns), then run the Host's cascade. */
  const deleteOne = async (sessionId, options = {}) => {
    try {
      const { backup } = await call('create', { sessionId })
      store.setStatus({ key: 'status.backupBeforeDelete', params: { title: backup?.title ?? sessionId } })
    } catch (error) {
      const ignorable = error?.routeMissing === true || error?.code === 'session-backup/not-found'
      if (!ignorable) {
        const wrapped = new Error(`session backup failed: ${messageOf(error)}`)
        wrapped.cause = error
        wrapped.backupBlocked = true
        throw wrapped
      }
      console.warn(`session-backup: no backup taken for ${sessionId} (${messageOf(error)})`)
    }
    const payload = await call('delete', {
      sessionId,
      ...(options.stopActivity === true ? { stopActivity: true } : {}),
    })
    return payload?.deleted ?? { deleted: true }
  }

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

  /** Batch delete through this plugin's own route — never the kernel's
   * `session/deleteSession`, which upstream rc.2 does not have. Running
   * sessions are skipped, not stopped: batch is a cleanup sweep, and the
   * single-row flow owns the stop-first upgrade. */
  const deleteMany = async (sessionIds) => {
    if (sessionIds.length === 0) return
    let deleted = 0
    let active = 0
    for (const sessionId of sessionIds) {
      try {
        await deleteOne(sessionId)
      } catch (error) {
        if (error?.cause?.code === 'workspace/session-active' || error?.code === 'workspace/session-active') {
          active += 1
          continue
        }
        store.fail({ key: 'error.deleteFailed', params: { message: messageOf(error) } })
        return
      }
      refreshList()
      leaveIfCurrent(sessionId)
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
      // A restore whose cwd matches no Workspace lands in the Sidebar's native
      // 「未分组」 bucket — that is a success, so say where the session went
      // instead of reporting the attach step as a failure. `backupConsumed`
      // reports the copy this restore just removed.
      const consumed = restored.backupConsumed === true
      const key =
        restored.placement === 'ungrouped'
          ? consumed ? 'status.restoredUngroupedDone' : 'status.restoredUngrouped'
          : restored.attached === false
            ? 'status.restoredDetached'
            : consumed ? 'status.restoredDone' : 'status.restored'
      store.setStatus({ key, params: { title, reason: restored.reason ?? '' } })
      await refreshBackups()
    } catch (error) {
      // The raw kernel sentence ("session … already exists at …") reads like a
      // failure; this is the expected "already restored / not deleted" state.
      store.fail(error?.code === 'session-backup/conflict'
        ? { key: 'error.restoreExists', params: {} }
        : { key: 'error.requestFailed', params: { message: messageOf(error) } })
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

  return { deleteOne, backupOne, backupMany, deleteMany, refreshBackups, restoreOne, removeOne }
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
    createElement(DeleteOneDialog, { t, actions, open: state.dialog === 'deleteOne' }),
    createElement(ConfirmDeleteDialog, { t, actions, open: state.dialog === 'confirmDelete' }),
    createElement(BackupsDialog, { t, actions, open: state.dialog === 'backups' }),
    createElement(ErrorDialog, { t, open: state.error !== null }),
  )
}

/** `sidebar.workspaces.session.menu.item`: the permanent-delete row. Same id as
 * the kernel's built-in row, so on kernels that still ship it (local alpha.3)
 * this entry shadows theirs at a lower priority and exactly one row renders;
 * on upstream rc.2 (no built-in delete row) it is simply the delete row. */
function DeleteMenuRow({ sessionId, displayTitle, t, useMenuOpenState }) {
  // The slot injects this hook exactly as it does the kernel's own row (both
  // alpha.3 and rc.2 declare it), so it is called unconditionally.
  const [, setMenuOpen] = useMenuOpenState()
  return createElement(MenuItemButton, {
    danger: true,
    separatorBefore: true,
    icon: createElement(IconTrashOutlineRegular, { size: 14 }),
    onSelect: () => {
      try {
        setMenuOpen(false)
      } catch {
        // menu already closed
      }
      store.openDeleteOne(sessionId, displayTitle ?? sessionId)
    },
    children: t('menu.deleteOne'),
  })
}

/** The single-session danger confirm: idle variant up front; a Host
 * `workspace/session-active` refusal upgrades this same dialog in place to
 * its stop-first variant (kernel `DeleteSession.tsx` behaviour, replayed). */
function DeleteOneDialog({ open, t, actions }) {
  const state = useStore()
  const request = state.deleteReq
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState(null)
  if (request === null || request === undefined) return null
  const busy = Array.isArray(request.activity) && request.activity.length > 0
  const close = () => {
    if (deleting) return
    store.closeDeleteOne()
  }
  const confirm = () => {
    setDeleting(true)
    setError(null)
    actions
      .deleteOne(request.sessionId, busy ? { stopActivity: true } : undefined)
      .then(() => {
        setDeleting(false)
        store.closeDeleteOne()
        store.setStatus({ key: 'status.deletedOne', params: { title: request.displayTitle } })
        refreshList()
        leaveIfCurrent(request.sessionId)
      })
      .catch((reason) => {
        setDeleting(false)
        const cause = reason?.cause ?? reason
        const activity = busyActivityOf(cause)
        if (activity !== null) {
          // Upgrade this dialog to the stop-first variant; the user confirms again.
          store.setDeleteActivity(activity)
          return
        }
        // `session-active` with an EMPTY activity list is the lease refusal
        // (no provider reported work, so stop-first would gain nothing): the
        // raw kernel sentence reads as if something were running — say what is
        // actually happening instead.
        setError(cause?.code === 'workspace/session-active' ? t('deleteOne.leaseBusy') : messageOf(reason))
      })
  }
  return createElement(Modal, {
    open: open === true,
    onClose: close,
    title: t(busy ? 'deleteOne.stopTitle' : 'deleteOne.title'),
    description: t('deleteOne.desc', { title: request.displayTitle }),
    closeLabel: t('dialog.close'),
    footer: createElement(
      Fragment,
      null,
      createElement(Button, { key: 'cancel', variant: 'outline', disabled: deleting, onClick: close, children: t('dialog.delete.cancel') }),
      createElement(Button, {
        key: 'confirm',
        variant: 'outline',
        className: 'dshsb-danger',
        disabled: deleting,
        onClick: confirm,
        children: t(busy ? 'deleteOne.stopAction' : 'deleteOne.action'),
      }),
    ),
    children: createElement(
      Fragment,
      null,
      busy
        ? createElement(
            'ul',
            { className: 'dshsb-activity', 'aria-label': t('deleteOne.activity') },
            ...request.activity.map((entry, index) =>
              createElement('li', { key: `${entry.kind}-${String(index)}` }, activityLineOf(entry)),
            ),
          )
        : null,
      deleting ? createElement('div', { className: 'dshsb-pending', role: 'status' }, t('deleteOne.pending')) : null,
      error !== null ? createElement('div', { className: 'dshsb-error', role: 'alert' }, error) : null,
    ),
  })
}

/** One activity family rendered as a line: `kind` plus named items. */
function activityLineOf(entry) {
  const items = Array.isArray(entry.items) ? entry.items : []
  const names = items.map((item) => item.label ?? item.id).join('、')
  if (items.length > 0) return `${entry.kind}: ${names}`
  return String(entry.kind)
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Mount the backup + delete UI.
 * @param ctx - browser context carrying slots and locale.
 */
export function apply(ctx) {
  hostCtx = ctx
  const actions = createActions(ctx)
  injectStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-backup: locale')
  ctx.slots.inject('sidebar.session.row.leading', () =>
    ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'session-backup', order: 20, locale: NS }, RowSelectCheckbox),
  )
  // Exactly one permanent-delete row on every version, without racing the
  // kernel's registration (list slots throw on a duplicate id at the same
  // priority, so registration order must not matter):
  //   1. `id: 'delete', priority: -1` renders null — a shadow that keeps the
  //      kernel's built-in row (local alpha.3) from rendering, whatever order
  //      the two registrations land in. On rc.2 (no built-in row) it is inert.
  //   2. Our own row at the canonical slot (order 460, directly after
  //      归档 / Archive), so the menu reads identically on both kernels.
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => {
    ctx.slots.register(
      { name: 'sidebar.workspaces.session.menu.item', id: 'delete', order: 460, priority: -1, locale: NS },
      () => null,
    )
    ctx.slots.register(
      { name: 'sidebar.workspaces.session.menu.item', id: 'session-delete', order: 460, locale: NS },
      DeleteMenuRow,
    )
  })
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
 * Only `slots` and `locale` are required. The delete flow runs over this
 * plugin's own HTTP routes — never the kernel's `session/deleteSession` — so
 * no `remote` dependency and no interceptor: the batch delete cannot hit the
 * missing-method TypeError that upstream rc.2 would otherwise raise.
 */
export const inject = ['slots', 'locale']
