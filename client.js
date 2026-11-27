// GENERATED from src/client.mjs by scripts/build-client.mjs
// Edit src/client.mjs, then run: node scripts/build-client.mjs
window.__ModuleLoader__.load({
	id: "dsh-session-backup",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

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
 *   3. The Host takes the final backup after stopping the Session, before
 *      deleting its files. An existing latest backup is refreshed instead of
 *      creating an extra entry; failure prevents deletion.
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
const { createElement, Fragment, useEffect, useState, useSyncExternalStore } = require("react")
const { Button, Checkbox, IconArchiveOutlineRegular, IconCheckOutlineRegular, IconTrashOutlineRegular, MenuItemButton, Modal } = require("@deepseek-ai/dsh-client-ui-primitives")

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
  'footer.cleanup': '文件清理',
  'cleanup.title': '会话文件清理',
  'cleanup.description': '临时文件开关仅清理通过临时产物登记功能生成的截图和文件，工作区文件不受影响。临时文件不包含在会话备份中，清理后无法恢复。',
  'cleanup.enabled': '删除会话时清理已登记临时文件',
  'cleanup.attachmentsEnabled': '删除会话时回收上传的图片和文件副本',
  'cleanup.attachmentsDescription': '仅回收已登记候选中的上传副本，原件不受影响，不扫描历史孤儿文件。备份或其他会话仍有引用时保留，最后引用删除后可回收。本次 Host 运行使用过的副本会保护到 Host 重启，即使已不再使用也会保留；重启后可重试回收。',
  'cleanup.loading': '正在读取设置…',
  'cleanup.saving': '正在保存…',
  'cleanup.default': '两个开关默认关闭、独立保存，对单个和批量删除均生效。',
  'cleanup.readOnly': '当前配置无法在此保存，请在插件配置中分别设置 cleanupOnDelete 和 cleanupAttachmentsOnDelete。',
  'cleanup.pending': '有 {count} 个会话的临时文件等待清理重试。',
  'cleanup.pendingErrors': '有 {count} 个临时文件清理账本无法读取：',
  'cleanup.attachmentPending': '有 {count} 个会话的上传文件副本等待回收重试。',
  'cleanup.attachmentPendingErrors': '有 {count} 个上传文件候选清单无法读取：',
  'cleanup.pendingError': '{sessionId}：{reason}',
  'cleanup.retry': '重试待清理文件',
  'cleanup.saved': '已保存',
  'cleanup.done': '已清理 {count} 个文件。',
  'cleanup.partial': '警告：部分文件清理失败，可稍后重试：{message}',
  'status.deletedCleanupPending': '会话已删除；部分文件清理失败，可在「文件清理」中查看并重试。',
  'status.deletedOneCleaned': '已删除「{title}」，清理了 {count} 个文件',
  'status.deletedManyCleaned': '已删除 {count} 个会话，清理了 {files} 个文件',
  'status.attachmentsCleaned': '已回收 {count} 个上传文件副本（{bytes}）。',
  'status.attachmentsRetained': '已保留 {count} 个上传文件副本，原件不受影响。仍被备份或其他会话引用的副本，须在最后引用删除后才能回收。',
  'status.attachmentsDeferred': '其中 {count} 个上传文件副本受本次 Host 运行保护，暂缓回收。正在处理的上传结束后可重试；已使用过的副本须在 Host 重启后重试回收。这不是清理错误。',
  'status.attachmentsRestartRequired': '其中 {count} 个上传文件副本因附件观察器在 Host 启动后才启用而暂缓回收。请重启 Host 后重试；这不是清理错误。',
  'status.attachmentsFailed': '警告：{count} 个上传文件副本回收失败：{message}',
  'footer.count': '已选 {count} 个',
  'footer.backupSelected': '备份选中',
  'footer.deleteSelected': '删除选中',
  'footer.clear': '清空',
  'row.toggle': '选择此会话',
  'menu.select': '加入选择',
  'menu.deselect': '移出选择',
  'menu.backup': '立即备份',
  'dialog.delete.title': '删除选中的会话？',
  'dialog.delete.description': '将删除选中的 {count} 个会话，正在运行的会话会跳过。删除前会保存最新内容，更新已有备份而不新增副本；之后可在「备份」里恢复。文件清理按「文件清理」中的两个独立开关执行。',
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
  'status.backupOneReused': '内容与已有备份一致，未重复备份',
  'status.backupUpdated': '已更新现有备份，未新增副本',
  'status.backupManyReused': '这 {count} 个会话都已有一致的备份，未重复写入',
  'status.backupBeforeDelete': '已备份「{title}」',
  'status.backupReusedDelete': '已有内容相同的备份，未重复备份「{title}」',
  'status.deleted': '已删除 {count} 个会话',
  'status.deletedWithSkipped': '已删除 {deleted} 个会话，{active} 个正在运行的已跳过',
  'status.activeSkipped': '{count} 个会话正在运行，未删除',
  'status.batchDeleteProgress': '已删除 {deleted} 个；{active} 个运行中的会话已跳过；{pending} 个会话待清理；已清理 {files} 个文件。',
  'status.deleteWarning': '会话已删除，但部分缓存或临时文件未清理；可重试删除：{message}',
  'status.restoreRefreshFailed': '会话已恢复，但备份列表刷新失败：{message}',
  'status.restored': '已恢复「{title}」，它已重新出现在工作区列表里',
  'status.restoredDone': '已恢复「{title}」，它已重新出现在工作区列表里，本次备份已删除',
  'status.restoredUngrouped': '已恢复「{title}」，它显示在侧栏「未分组」分组下',
  'status.restoredUngroupedDone': '已恢复「{title}」，它显示在侧栏「未分组」分组下，本次备份已删除',
  'status.restoredDetached': '已恢复「{title}」的文件，但没能把它重新挂回工作区：{reason}',
  'status.backupRemoved': '已删除该备份',
  'status.backupRemoveRefreshFailed': '备份已删除，但备份列表刷新失败：{message}',
  'error.requestFailed': '请求失败：{message}',
  'error.restoreExists': '无法恢复：该会话已经在列表里了（可能已恢复过，或删除没有完成）。需要的话请先彻底删除它，再恢复这份备份。',
  'error.restoreDeleting': '该会话正在删除，请等待删除完成后再恢复备份。',
  'error.deleteFailed': '删除失败：{message}',
  'error.backupBlockedDelete': '备份失败，已取消删除：{message}',
  'menu.deleteOne': '彻底删除…',
  'deleteOne.title': '彻底删除此会话？',
  'deleteOne.stopTitle': '停止并彻底删除此会话？',
  'deleteOne.desc': '将删除“{title}”的会话日志与相关缓存数据。删除前会保存最新内容，更新已有备份而不新增副本；之后可在「备份」里恢复。文件清理按「文件清理」中的两个独立开关执行。工作区文件夹中的文件不受影响。',
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
  'footer.cleanup': 'File cleanup',
  'cleanup.title': 'Session file cleanup',
  'cleanup.description': 'The temporary-file setting only cleans up screenshots and files recorded by the temporary artifact registry. Workspace files are unaffected. Temporary files are not included in session backups and cannot be restored after cleanup.',
  'cleanup.enabled': 'Clean up registered temporary files when deleting sessions',
  'cleanup.attachmentsEnabled': 'Reclaim uploaded image and file copies when deleting sessions',
  'cleanup.attachmentsDescription': 'Only registered upload candidates are reclaimed; originals are unaffected and historical orphan files are not scanned. Copies referenced by backups or other sessions are retained until their last reference is deleted. Copies used during this Host run remain protected until the Host restarts, even after use ends; retry reclamation after restarting the Host.',
  'cleanup.loading': 'Loading settings…',
  'cleanup.saving': 'Saving…',
  'cleanup.default': 'Both settings are off by default and saved independently. They apply to individual and batch deletion.',
  'cleanup.readOnly': 'This profile cannot save configuration here. Set cleanupOnDelete and cleanupAttachmentsOnDelete separately in the plugin configuration.',
  'cleanup.pending': '{count} sessions have temporary files awaiting a cleanup retry.',
  'cleanup.pendingErrors': '{count} temporary-file cleanup ledgers could not be read:',
  'cleanup.attachmentPending': '{count} sessions have uploaded file copies awaiting a cleanup retry.',
  'cleanup.attachmentPendingErrors': '{count} upload candidate inventories could not be read:',
  'cleanup.pendingError': '{sessionId}: {reason}',
  'cleanup.retry': 'Retry pending cleanup',
  'cleanup.saved': 'Saved',
  'cleanup.done': 'Cleaned up {count} files.',
  'cleanup.partial': 'Warning: some files could not be cleaned up. You can retry later: {message}',
  'status.deletedCleanupPending': 'Sessions deleted; some file cleanup failed. Review and retry under “File cleanup”.',
  'status.deletedOneCleaned': 'Deleted “{title}” and cleaned up {count} files',
  'status.deletedManyCleaned': 'Deleted {count} sessions and cleaned up {files} files',
  'status.attachmentsCleaned': 'Reclaimed {count} uploaded file copies ({bytes}).',
  'status.attachmentsRetained': '{count} uploaded file copies are retained. Originals are unaffected. Copies still referenced by backups or other sessions can be reclaimed after their last reference is deleted.',
  'status.attachmentsDeferred': 'Of these, {count} uploaded file copies are protected during this Host run and deferred. Retry after active uploads finish; copies already used require a Host restart before retrying. This is not a cleanup error.',
  'status.attachmentsRestartRequired': 'Of these, {count} uploaded file copies are deferred because the attachment observer was activated after the Host started. Restart the Host, then retry; this is not a cleanup error.',
  'status.attachmentsFailed': 'Warning: {count} uploaded file copies could not be reclaimed: {message}',
  'footer.count': '{count} selected',
  'footer.backupSelected': 'Back up selected',
  'footer.deleteSelected': 'Delete selected',
  'footer.clear': 'Clear',
  'row.toggle': 'Select this session',
  'menu.select': 'Add to selection',
  'menu.deselect': 'Remove from selection',
  'menu.backup': 'Back up now',
  'dialog.delete.title': 'Delete the selected sessions?',
  'dialog.delete.description': 'Delete the {count} selected sessions, skipping any still running. Their latest contents are saved first, updating existing backups without adding another copy. Restore them from “Backups”. File cleanup follows the two independent settings under “File cleanup”.',
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
  'status.backupOneReused': 'Already backed up identically; nothing new was written',
  'status.backupUpdated': 'Updated the existing backup without adding another copy',
  'status.backupManyReused': 'All {count} sessions already have identical backups; nothing new was written',
  'status.backupBeforeDelete': 'Backed up “{title}”',
  'status.backupReusedDelete': 'An identical backup already existed; “{title}” was not copied again',
  'status.deleted': 'Deleted {count} sessions',
  'status.deletedWithSkipped': 'Deleted {deleted} sessions; skipped {active} still running',
  'status.activeSkipped': '{count} sessions are running and were not deleted',
  'status.batchDeleteProgress': 'Deleted {deleted}; skipped {active} running sessions; {pending} sessions need cleanup; cleaned {files} files.',
  'status.deleteWarning': 'The session was deleted, but some caches or temporary files were not cleaned up. Retry deletion: {message}',
  'status.restoreRefreshFailed': 'The session was restored, but refreshing the backup list failed: {message}',
  'status.restored': 'Restored “{title}”; it is listed under its workspace again',
  'status.restoredDone': 'Restored “{title}”; it is listed under its workspace again, and this backup was removed',
  'status.restoredUngrouped': 'Restored “{title}”; it appears under “Ungrouped” in the sidebar',
  'status.restoredUngroupedDone': 'Restored “{title}”; it appears under “Ungrouped” in the sidebar, and this backup was removed',
  'status.restoredDetached': 'Restored the files for “{title}”, but could not re-attach it to a workspace: {reason}',
  'status.backupRemoved': 'Backup deleted',
  'status.backupRemoveRefreshFailed': 'The backup was deleted, but refreshing the backup list failed: {message}',
  'error.requestFailed': 'Request failed: {message}',
  'error.restoreExists': 'Cannot restore: that session already exists in the list (it may already be restored, or the delete never completed). Delete it first if you want to restore this backup.',
  'error.restoreDeleting': 'This session is being deleted. Wait for deletion to finish, then retry restoring the backup.',
  'error.deleteFailed': 'Delete failed: {message}',
  'error.backupBlockedDelete': 'Backup failed; the delete was cancelled: {message}',
  'menu.deleteOne': 'Delete session…',
  'deleteOne.title': 'Permanently delete this session?',
  'deleteOne.stopTitle': 'Stop and delete this session?',
  'deleteOne.desc': 'This deletes the session log and related cached data for “{title}” after saving the latest contents. An existing backup is updated without adding another copy; restore it from “Backups”. File cleanup follows the two independent settings under “File cleanup”. Files in the workspace folder are unaffected.',
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
.dshsb-cleanup-setting { display: flex; align-items: flex-start; gap: 8px; }
.dshsb-cleanup-setting input { flex: none; margin-top: 3px; accent-color: var(--dsw-alias-accent-primary); }
.dshsb-cleanup-errors { margin: 4px 0 0; padding-left: 18px; overflow-wrap: anywhere; }
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
    cleanupSettings: null,
    cleanupLoading: false,
    cleanupSaving: false,
    cleanupError: null,
    cleanupStatus: null,
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
    removeIds: (ids) => set({ ids: state.ids.filter((id) => !ids.includes(id)) }),
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

/** Normalize older Hosts without borrowing the temporary-file permission. */
function cleanupSettingsOf(settings) {
  if (typeof settings?.cleanupOnDelete !== 'boolean'
    || (settings.cleanupAttachmentsOnDelete !== undefined && typeof settings.cleanupAttachmentsOnDelete !== 'boolean')) {
    throw new Error('Invalid cleanup settings response')
  }
  return {
    ...settings,
    cleanupAttachmentsOnDelete: settings.cleanupAttachmentsOnDelete === true,
    attachmentPending: Array.isArray(settings.attachmentPending) ? settings.attachmentPending : [],
  }
}

/** Temporary artifacts and attachment rows share these result fields. */
function cleanupSummary(results) {
  return results.reduce((summary, result) => ({
    removed: summary.removed + (result?.removed ?? 0),
    bytes: summary.bytes + (result?.bytes ?? 0),
    retained: summary.retained + (result?.retained ?? 0),
    deferred: summary.deferred + (result?.deferred ?? 0),
    restartRequired: summary.restartRequired + (result?.restartRequired ?? 0),
    failed: [...summary.failed, ...(Array.isArray(result?.failed) ? result.failed : [])],
  }), { removed: 0, bytes: 0, retained: 0, deferred: 0, restartRequired: 0, failed: [] })
}

/** Retention is normal; only failed candidates receive a warning. */
function attachmentCleanupDetails(results) {
  const present = results.filter(result => result != null)
  if (present.length === 0) return []
  const summary = cleanupSummary(present)
  return [
    { key: 'status.attachmentsCleaned', params: { count: summary.removed, bytes: formatBytes(summary.bytes) } },
    ...(summary.retained > 0 ? [{ key: 'status.attachmentsRetained', params: { count: summary.retained } }] : []),
    ...(summary.deferred > summary.restartRequired ? [{ key: 'status.attachmentsDeferred', params: { count: summary.deferred - summary.restartRequired } }] : []),
    ...(summary.restartRequired > 0 ? [{ key: 'status.attachmentsRestartRequired', params: { count: summary.restartRequired } }] : []),
    ...(summary.failed.length > 0 ? [{ key: 'status.attachmentsFailed', params: {
      count: summary.failed.length,
      message: [...new Set(summary.failed.map(failure => failure?.reason ?? failure?.code ?? failure?.id ?? 'Unknown error'))].join('; '),
    } }] : []),
  ]
}

// ---------------------------------------------------------------------------
// Batch actions
// ---------------------------------------------------------------------------

/** Build the actions the injected components receive as props. */
function createActions(ctx) {
  /** The Host stops work, refreshes the existing backup, then deletes the log. */
  const deleteOne = async (sessionId, options = {}) => {
    const payload = await call('delete', {
      sessionId,
      ...(options.stopActivity === true ? { stopActivity: true } : {}),
    })
    return payload?.deleted ?? { deleted: true }
  }

  const deletionWarnings = (result) => [
    ...(Array.isArray(result?.cleanup?.failed) ? result.cleanup.failed.map((failure) => failure?.reason) : []),
    ...(Array.isArray(result?.warnings) ? result.warnings : []),
  ].map((warning) => String(warning ?? '').trim()).filter(Boolean)
  const warningDetails = (warnings) => warnings.length > 0
    ? [{ key: 'status.deleteWarning', params: { message: warnings.join('; ') } }]
    : []

  const backupOne = async (sessionId) => {
    try {
      const { backup } = await call('create', { sessionId })
      store.setStatus({
        key: backup?.reused === true ? 'status.backupOneReused'
          : backup?.updated === true ? 'status.backupUpdated' : 'status.backupCreated',
        params: { count: 1 },
      })
    } catch (error) {
      store.fail({ key: 'error.requestFailed', params: { message: messageOf(error) } })
    }
  }

  const backupMany = async (sessionIds) => {
    if (sessionIds.length === 0) return
    try {
      let created = 0
      for (const sessionId of sessionIds) {
        const { backup } = await call('create', { sessionId })
        if (backup?.reused !== true) created += 1
      }
      store.setStatus({
        key: created === 0 ? 'status.backupManyReused' : 'status.backupCreated',
        params: { count: sessionIds.length },
      })
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
    let files = 0
    let pending = 0
    const warnings = []
    const attachments = []
    for (const sessionId of sessionIds) {
      try {
        const result = await deleteOne(sessionId)
        files += (result.cleanup?.removed ?? 0) + (result.attachments?.removed ?? 0)
        if ((result.cleanup?.failed?.length ?? 0) > 0 || (result.attachments?.failed?.length ?? 0) > 0) pending += 1
        warnings.push(...deletionWarnings(result))
        if (result.attachments) attachments.push(result.attachments)
      } catch (error) {
        if (error?.cause?.code === 'workspace/session-active' || error?.code === 'workspace/session-active') {
          active += 1
          continue
        }
        const details = [
          ...(deleted > 0 || active > 0 || pending > 0
            ? [{ key: 'status.batchDeleteProgress', params: { deleted, active, pending, files } }]
            : []),
          ...warningDetails(warnings),
          ...attachmentCleanupDetails(attachments),
        ]
        store.fail({
          key: 'error.deleteFailed',
          params: { message: messageOf(error) },
          ...(details.length > 0 ? { details } : {}),
        })
        return
      }
      refreshList()
      leaveIfCurrent(sessionId)
      deleted += 1
      store.removeIds([sessionId])
    }
    const details = [
      ...(active > 0 || pending > 0
        ? [{ key: 'status.batchDeleteProgress', params: { deleted, active, pending, files } }]
        : []),
      ...warningDetails(warnings),
      ...attachmentCleanupDetails(attachments),
    ]
    if (pending > 0) {
      store.setStatus({ key: 'status.deletedCleanupPending', ...(details.length > 0 ? { details } : {}) })
    } else if (active > 0) {
      store.setStatus({
        key: deleted > 0 ? 'status.deletedWithSkipped' : 'status.activeSkipped',
        params: { deleted, active, count: active },
        ...(details.length > 0 ? { details } : {}),
      })
    } else {
      store.setStatus({
        key: files > 0 ? 'status.deletedManyCleaned' : 'status.deleted',
        params: { count: deleted, files },
        ...(details.length > 0 ? { details } : {}),
      })
    }
  }

  const refreshBackups = async ({ silent = false } = {}) => {
    store.set({ backupsLoading: true })
    try {
      const payload = await call('list')
      store.set({ backups: Array.isArray(payload?.backups) ? payload.backups : [], backupsLoading: false })
      return null
    } catch (error) {
      store.set({ backupsLoading: false })
      if (!silent) store.fail({ key: 'error.requestFailed', params: { message: messageOf(error) } })
      return error
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
      const status = { key, params: { title, reason: restored.reason ?? '' } }
      const details = restored.cleanupWarning ? [String(restored.cleanupWarning)] : []
      store.setStatus({ ...status, ...(details.length > 0 ? { details } : {}) })
      // The Host event feed only announces removals; a restore has no event,
      // so push the sidebar list refresh here or the row appears only after
      // the user reloads the page.
      refreshList()
      const refreshError = await refreshBackups({ silent: true })
      if (refreshError) {
        store.setStatus({
          ...status,
          details: [...details, { key: 'status.restoreRefreshFailed', params: { message: messageOf(refreshError) } }],
        })
      }
    } catch (error) {
      // The raw kernel sentence ("session … already exists at …") reads like a
      // failure; this is the expected "already restored / not deleted" state.
      store.fail(error?.code === 'session-backup/deleting'
        ? { key: 'error.restoreDeleting', params: {} }
        : error?.code === 'session-backup/conflict'
          ? { key: 'error.restoreExists', params: {} }
          : { key: 'error.requestFailed', params: { message: messageOf(error) } })
    }
  }

  const removeOne = async (backup) => {
    try {
      const payload = await call('remove', { path: backup.path })
      const details = attachmentCleanupDetails([payload?.removed?.attachments])
      const status = { key: 'status.backupRemoved', params: {} }
      const backups = store.getSnapshot().backups
      store.set({
        removePending: null,
        ...(Array.isArray(backups) ? { backups: backups.filter(item => item.path !== backup.path) } : {}),
      })
      store.setStatus({ ...status, ...(details.length > 0 ? { details } : {}) })
      const refreshError = await refreshBackups({ silent: true })
      if (refreshError) {
        store.setStatus({
          ...status,
          details: [...details, { key: 'status.backupRemoveRefreshFailed', params: { message: messageOf(refreshError) } }],
        })
      }
    } catch (error) {
      store.fail({ key: 'error.requestFailed', params: { message: messageOf(error) } })
    }
  }

  const refreshCleanup = async () => {
    store.set({ cleanupLoading: true, cleanupError: null, cleanupStatus: null })
    try {
      const payload = await call('cleanup-settings')
      store.set({ cleanupSettings: cleanupSettingsOf(payload?.settings), cleanupLoading: false })
    } catch (error) {
      store.set({ cleanupLoading: false, cleanupSettings: null, cleanupError: messageOf(error) })
    }
  }

  const saveCleanupSetting = async (key, enabled) => {
    store.set({ cleanupSaving: true, cleanupError: null, cleanupStatus: null })
    try {
      const payload = await call('cleanup-settings', { [key]: enabled })
      if (payload?.settings?.[key] !== enabled) throw new Error('Cleanup setting was not saved')
      store.set({ cleanupSettings: cleanupSettingsOf(payload.settings), cleanupSaving: false, cleanupStatus: { key: 'cleanup.saved' } })
    } catch (error) {
      // Preserve the previous acknowledged setting; a failed save must not show
      // the proposed checkbox value as though the Host had accepted it.
      store.set({ cleanupSaving: false, cleanupError: messageOf(error) })
    }
  }

  const saveCleanup = enabled => saveCleanupSetting('cleanupOnDelete', enabled)
  const saveAttachmentCleanup = enabled => saveCleanupSetting('cleanupAttachmentsOnDelete', enabled)

  const retryCleanup = async () => {
    store.set({ cleanupSaving: true, cleanupError: null, cleanupStatus: null })
    try {
      const payload = await call('cleanup-retry', {})
      if (!Array.isArray(payload?.results)) throw new Error('Invalid cleanup result')
      const summary = cleanupSummary(payload.results)
      const details = attachmentCleanupDetails(payload.results.filter(result => result?.kind === 'attachments'))
      store.set({
        cleanupSettings: cleanupSettingsOf(payload.settings),
        cleanupSaving: false,
        cleanupStatus: {
          ...(summary.failed.length > 0
            ? { key: 'cleanup.partial', params: { message: [...new Set(summary.failed.map(failure => failure?.reason ?? failure?.code ?? failure?.id ?? 'Unknown error'))].join('; ') } }
            : { key: 'cleanup.done', params: { count: summary.removed } }),
          ...(details.length > 0 ? { details } : {}),
        },
      })
    } catch (error) {
      store.set({ cleanupSaving: false, cleanupError: messageOf(error) })
    }
  }

  return { deleteOne, backupOne, backupMany, deleteMany, refreshBackups, restoreOne, removeOne, refreshCleanup, saveCleanup, saveAttachmentCleanup, retryCleanup }
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
  const statusDetails = Array.isArray(state.status?.details)
    ? state.status.details
    : state.status?.details == null ? [] : [state.status.details]
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
    children.push(createElement(Button, {
      key: 'cleanup',
      size: 'sm',
      variant: 'outline',
      onClick: () => store.openDialog('cleanup'),
      children: t('footer.cleanup'),
    }))
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
    ...statusDetails.map((detail, index) => createElement('p', {
      key: `status-detail-${index}`,
      className: detail?.key === 'status.attachmentsFailed' ? 'dshsb-error' : 'dshsb-status',
      role: detail?.key === 'status.attachmentsFailed' ? 'alert' : undefined,
    }, typeof detail === 'string' ? detail : t(detail.key, detail.params ?? {})),
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
      backup.warning || backup.consistent === false || inconsistent > 0
        ? createElement('span', { className: 'dshsb-itemWarn' }, backup.warning || t('dialog.backups.inconsistent', { count: inconsistent }))
        : null,
    ),
    createElement(
      'div',
      { className: 'dshsb-itemActions' },
      createElement(Button, {
        key: 'restore',
        size: 'sm',
        disabled: backup.restorable === false,
        title: backup.restorable === false ? backup.warning || t('dialog.backups.notRestorable') : undefined,
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

/** Host-backed policies. Each file-cleanup permission is independently user-only. */
function CleanupDialog({ open, t, actions }) {
  const state = useStore()
  useEffect(() => {
    if (open) void actions.refreshCleanup()
  }, [open])
  const settings = state.cleanupSettings
  const inventories = [
    { enabled: settings?.cleanupOnDelete === true, pending: settings?.pending, errors: settings?.pendingErrors,
      pendingKey: 'cleanup.pending', errorKey: 'cleanup.pendingErrors' },
    { enabled: settings?.cleanupAttachmentsOnDelete === true, pending: settings?.attachmentPending, errors: settings?.attachmentPendingErrors,
      pendingKey: 'cleanup.attachmentPending', errorKey: 'cleanup.attachmentPendingErrors' },
  ].map(inventory => ({ ...inventory,
    pending: Array.isArray(inventory.pending) ? inventory.pending : [],
    errors: Array.isArray(inventory.errors) ? inventory.errors : [],
  }))
  const hasPending = inventories.some(inventory => inventory.pending.length > 0 || inventory.errors.length > 0)
  const canRetry = inventories.some(inventory => inventory.enabled && (inventory.pending.length > 0 || inventory.errors.length > 0))
  return createElement(Modal, {
    open,
    onClose: () => { if (!state.cleanupSaving) store.closeDialog() },
    title: t('cleanup.title'),
    description: t('cleanup.description'),
    closeLabel: t('dialog.close'),
    children: createElement(Fragment, null,
      state.cleanupLoading ? createElement('p', { role: 'status' }, t('cleanup.loading')) : null,
      settings === null ? null : createElement(Fragment, null,
        createElement('label', { className: 'dshsb-cleanup-setting' },
          createElement('input', {
            type: 'checkbox',
            name: 'cleanupOnDelete',
            checked: settings.cleanupOnDelete === true,
            disabled: !settings.editable || state.cleanupSaving || state.cleanupLoading,
            onChange: event => void actions.saveCleanup(event.target.checked),
          }),
          t('cleanup.enabled'),
        ),
        createElement('label', { className: 'dshsb-cleanup-setting' },
          createElement('input', {
            type: 'checkbox',
            name: 'cleanupAttachmentsOnDelete',
            checked: settings.cleanupAttachmentsOnDelete === true,
            disabled: !settings.editable || state.cleanupSaving || state.cleanupLoading,
            onChange: event => void actions.saveAttachmentCleanup(event.target.checked),
          }),
          t('cleanup.attachmentsEnabled'),
        ),
        createElement('p', null, t('cleanup.attachmentsDescription')),
        createElement('p', null, t('cleanup.default')),
        !settings.editable ? createElement('p', null, t('cleanup.readOnly')) : null,
        ...inventories.map(inventory => createElement(Fragment, { key: inventory.pendingKey },
          inventory.pending.length > 0 ? createElement('p', null, t(inventory.pendingKey, { count: inventory.pending.length })) : null,
          inventory.errors.length > 0 ? createElement('p', null, t(inventory.errorKey, { count: inventory.errors.length })) : null,
          inventory.errors.length > 0 ? createElement('ul', { className: 'dshsb-cleanup-errors' },
            ...inventory.errors.map((issue, index) => createElement('li', { key: `${issue.sessionId ?? 'unknown'}-${index}` },
              t('cleanup.pendingError', {
                sessionId: issue.sessionId ?? 'unknown',
                reason: issue.reason ?? issue.code ?? 'Unknown error',
              }),
            )),
          ) : null,
        )),
        hasPending ? createElement(Button, {
          disabled: state.cleanupSaving || state.cleanupLoading || !canRetry,
          onClick: () => void actions.retryCleanup(),
          children: t('cleanup.retry'),
        }) : null,
      ),
      state.cleanupSaving ? createElement('p', { role: 'status' }, t('cleanup.saving')) : null,
      state.cleanupStatus === null ? null : createElement('p', { role: 'status' }, t(state.cleanupStatus.key, state.cleanupStatus.params ?? {})),
      ...(state.cleanupStatus?.details ?? []).map((detail, index) => createElement('p', {
        key: `cleanup-detail-${index}`,
        role: detail.key === 'status.attachmentsFailed' ? 'alert' : 'status',
        className: detail.key === 'status.attachmentsFailed' ? 'dshsb-error' : undefined,
      }, t(detail.key, detail.params ?? {}))),
      state.cleanupError === null ? null : createElement('p', { role: 'alert', className: 'dshsb-error' }, state.cleanupError),
    ),
    footer: createElement(Button, {
      disabled: state.cleanupSaving,
      onClick: () => store.closeDialog(),
      children: t('dialog.close'),
    }),
  })
}

/** The failure dialog for errors the status line alone would bury. */
function ErrorDialog({ open, t }) {
  const state = useStore()
  const details = Array.isArray(state.error?.details)
    ? state.error.details
    : state.error?.details == null ? [] : [state.error.details]
  return createElement(Modal, {
    open,
    onClose: () => store.dismissError(),
    title: t('error.title'),
    closeLabel: t('dialog.close'),
    children: createElement(Fragment, null,
      createElement('p', null, state.error === null ? '' : t(state.error.key, state.error.params ?? {})),
      ...details.map((detail, index) => createElement('p', {
        key: `error-detail-${index}`,
        className: 'dshsb-error',
      }, typeof detail === 'string' ? detail : t(detail.key, detail.params ?? {})),
      ),
    ),
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
    createElement(CleanupDialog, { t, actions, open: state.dialog === 'cleanup' }),
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
  useEffect(() => {
    setError(null)
  }, [request?.sessionId, open])
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
      .then((result) => {
        setDeleting(false)
        if (store.getSnapshot().deleteReq === request) store.closeDeleteOne()
        const count = (result.cleanup?.removed ?? 0) + (result.attachments?.removed ?? 0)
        const key = (result.cleanup?.failed?.length ?? 0) > 0 || (result.attachments?.failed?.length ?? 0) > 0
          ? 'status.deletedCleanupPending' : count > 0 ? 'status.deletedOneCleaned' : 'status.deletedOne'
        const warnings = [
          ...(Array.isArray(result.cleanup?.failed) ? result.cleanup.failed.map((failure) => failure?.reason) : []),
          ...(Array.isArray(result.warnings) ? result.warnings : []),
        ].map((warning) => String(warning ?? '').trim()).filter(Boolean)
        const details = [
          ...(warnings.length > 0 ? [{ key: 'status.deleteWarning', params: { message: warnings.join('; ') } }] : []),
          ...attachmentCleanupDetails([result.attachments]),
        ]
        store.setStatus({
          key,
          params: { title: request.displayTitle, count },
          ...(details.length > 0 ? { details } : {}),
        })
        refreshList()
        leaveIfCurrent(request.sessionId)
      })
      .catch((reason) => {
        setDeleting(false)
        if (store.getSnapshot().deleteReq !== request) return
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
        setError({
          sessionId: request.sessionId,
          message: cause?.code === 'workspace/session-active' ? t('deleteOne.leaseBusy') : messageOf(reason),
        })
      })
  }
  const visibleError = error?.sessionId === request.sessionId ? error.message : null
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
      visibleError !== null ? createElement('div', { className: 'dshsb-error', role: 'alert' }, visibleError) : null,
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
function apply(ctx) {
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
const inject = ['slots', 'locale']

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
