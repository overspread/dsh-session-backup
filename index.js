/**
 * Session backup + permanent deletion — Host face.
 *
 * Owns two things: the on-disk backup store (`$DSH_HOME/backups/sessions/<sessionId>/<stamp>-<title>/`)
 * and the five HTTP routes the Web GUI calls (four backup routes plus `delete`).
 * Every operation is a plain filesystem routine taking explicit roots, so the
 * tests drive them against a temp directory without booting a profile.
 *
 * A backup is a recursive copy of the session's own directory plus a
 * `backup.json` manifest describing what was taken. Attachments are
 * content-addressed and are NOT purged when a session is deleted, so the
 * session directory alone is a complete, restorable copy.
 *
 * The delete engine (below, `deleteSessionCascade`) reproduces the harness's
 * permanent-deletion cascade as a self-contained plugin, so a profile whose
 * kernel has no `session/deleteSession` (upstream ≥ 0.2.1-alpha.5, rc line)
 * gains the same guarantees: activity gate with a stop-activity upgrade,
 * scheduled-reminder row purge before anything is destroyed, write-lease
 * probe, durable log removal, and a best-effort derived-cache cascade that
 * can never resurrect a deleted Session. Cascade steps are probed through
 * `ctx.get()` and feature-detected at call time, so the same file runs on
 * both the local alpha.3 build (richer service APIs) and upstream rc.2.
 */
import { copyFile, cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'session-backup'

/**
 * Hard dependency: the connection service owns the Web fetch registry.
 * `sessionQuery`, `sessions`, and `workspaceRegistry` are read through
 * `ctx.get()` instead, so a profile without them degrades (backups still
 * happen, titles fall back to the directory stamp, restore skips the
 * re-attachment) rather than refusing to activate.
 */
export const inject = ['connection']

/** Absolute registration path; the browser addresses the same route document-relative. */
const API_PATH = '/api/session.backup'
/** Manifest filename carried inside every backup directory. */
const MANIFEST_FILE = 'backup.json'
const MANIFEST_VERSION = 1
/** Lease and cruft files that carry no session content. */
const SKIP_NAMES = new Set(['session.lock', '.DS_Store'])
/** Session ids are uuid-ish segments; anything else never reaches a path join. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Used when a session has no readable title (never when one does). */
const FALLBACK_TITLE = 'untitled'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Resolve `$DSH_HOME`, defaulting to `~/.dsh`. */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  return join(homedir(), '.dsh')
}

/** `<home>/sessions` — where the Harness stores live session directories. */
export function sessionsRoot(home = dshHome()) {
  return join(home, 'sessions')
}

/** `<home>/backups/sessions` — this plugin's store. */
export function backupRoot(home = dshHome()) {
  return join(home, 'backups', 'sessions')
}

/**
 * Reject a path that is not strictly inside its root.
 * @returns the resolved target path.
 */
export function assertInside(root, target, label) {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const relation = relative(rootPath, targetPath)
  if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw badRequest(`${label} must stay inside ${rootPath}`)
  }
  return targetPath
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Turn a session title into one path-safe directory name fragment.
 * Separators, control characters, and trailing dots are dropped; an unusable
 * title becomes `untitled` so the directory never ends up unnamed.
 */
export function sanitizeTitle(title) {
  const source = typeof title === 'string' ? title : ''
  const cleaned = source
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
  const characters = [...cleaned].slice(0, 48).join('').trim()
  if (characters === '') return FALLBACK_TITLE
  return characters
}

/** Local-time `YYYYMMDD-HHMMSS` stamp — the human-sortable backup prefix. */
export function timestamp(at = new Date()) {
  const two = (value) => String(value).padStart(2, '0')
  return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
}

/** ISO instant for a `YYYYMMDD-HHMMSS` stamp, or undefined when it is not one. */
export function isoFromStamp(stamp) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(stamp))
  if (match === null) return undefined
  const [, year, month, day, hours, minutes, seconds] = match
  const value = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds))
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Build an Error carrying a machine-readable `code` and an HTTP `status`.
 * `details` rides the JSON error body so the browser can upgrade its confirm
 * dialog (the activity list of a `workspace/session-active` refusal). */
export function failure(code, message, status = 500, details = undefined) {
  const error = new Error(message)
  error.code = code
  error.status = status
  if (details !== undefined) error.details = details
  return error
}

function badRequest(message) {
  return failure('session-backup/bad-request', message, 400)
}

function notFound(message) {
  return failure('session-backup/not-found', message, 404)
}

function conflict(message) {
  return failure('session-backup/conflict', message, 409)
}

/** Validate an inbound session id before it is joined into a path. */
export function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw badRequest(`sessionId must be a plain id matching ${SESSION_ID_PATTERN.source}`)
  }
  return sessionId
}

function assertRequestPath(path) {
  if (typeof path !== 'string' || path.trim() === '') throw badRequest('path is required')
  return path
}

// ---------------------------------------------------------------------------
// Filesystem primitives
// ---------------------------------------------------------------------------

const isDirectory = (path) => stat(path).then((info) => info.isDirectory(), () => false)
const pathExists = (path) => stat(path).then(() => true, () => false)

const relKey = (base, path) => relative(base, path).split(sep).join('/')

/**
 * Every regular file under `dir`, skipping lease and cruft names.
 * @returns `[{ path, rel, bytes, mtimeMs }]` with `/`-separated relative keys.
 */
export async function walkFiles(dir, base = dir, found = []) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(path, base, found)
      continue
    }
    if (!entry.isFile() || SKIP_NAMES.has(entry.name)) continue
    const info = await stat(path)
    found.push({ path, rel: relKey(base, path), bytes: info.size, mtimeMs: info.mtimeMs })
  }
  return found
}

/**
 * Find the on-disk directory of one session.
 * Layout is `<sessionsRoot>/<encoded cwd>/<sessionId>/`; the project segment is
 * unknown in advance, so it is probed.
 * @returns the directory, or undefined when the session is not stored.
 */
export async function locateSessionDir(sessionId, root) {
  assertSessionId(sessionId)
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, sessionId)
    if (await isDirectory(candidate)) return candidate
  }
  return undefined
}

/**
 * Push a live session's in-memory log to disk before it is copied, so the copy
 * contains the durable prefix even while the session is running. Mirrors the
 * barrier `dsh-session-log-export` uses for ZIP export.
 */
export async function flushLiveSession(ctx, sessionId) {
  const store = ctx?.get?.('sessions')
  if (store === undefined || typeof store.get !== 'function' || typeof store.flush !== 'function') return
  let session
  try {
    session = store.get(sessionId)
  } catch {
    return
  }
  if (session === undefined || session === null) return
  try {
    await store.flush(session)
  } catch {
    // A session that stopped between get() and flush() has nothing to push.
  }
}

/** Read the session's current title, or undefined when it cannot be read. */
export async function readSessionTitle(ctx, sessionId) {
  const query = ctx?.get?.('sessionQuery')
  if (query === undefined || typeof query.readTitle !== 'function') return undefined
  try {
    const result = await query.readTitle(sessionId)
    // Depending on the installed query service this is either the bare title or
    // a snapshot record (`{ title, source, eventSeq, … }`) from the title provider.
    const title = typeof result === 'string' ? result : result?.title
    return typeof title === 'string' && title.trim() !== '' ? title : undefined
  } catch {
    return undefined
  }
}

/**
 * Copy one file and confirm the copy matches a stable read of its source.
 * A log being appended mid-copy reports a different size and is retried.
 */
async function copyStableFile(sourcePath, destinationPath) {
  let lastBytes = 0
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await copyFile(sourcePath, destinationPath)
    const [sourceInfo, copyInfo] = await Promise.all([stat(sourcePath), stat(destinationPath)])
    lastBytes = copyInfo.size
    if (sourceInfo.size === copyInfo.size) return { bytes: copyInfo.size, consistent: true }
  }
  return { bytes: lastBytes, consistent: false }
}

/**
 * Recursively copy a session directory, then re-verify each file's size.
 * Files the source kept writing during the copy are re-copied; any file that
 * never settles is reported instead of silently shipping a torn log.
 */
export async function copySessionDir(source, destination) {
  await cp(source, destination, { recursive: true, filter: (path) => !SKIP_NAMES.has(basename(path)) })
  const sourceFiles = await walkFiles(source)
  const copies = new Map((await walkFiles(destination)).map((file) => [file.rel, file]))
  const inconsistent = []
  let bytes = 0
  for (const file of sourceFiles) {
    const quick = copies.get(file.rel)
    if (quick !== undefined && quick.bytes === file.bytes) {
      bytes += quick.bytes
      continue
    }
    const settled = await copyStableFile(file.path, join(destination, file.rel))
    bytes += settled.bytes
    if (!settled.consistent) inconsistent.push(file.rel)
  }
  return { files: sourceFiles.length, bytes, inconsistent }
}

/** Pick `<stamp>-<title>`, disambiguating collisions within one session. */
async function uniqueBackupName(backups, sessionId, stamp, title) {
  const base = `${stamp}-${sanitizeTitle(title)}`
  const group = join(backups, sessionId)
  let candidate = base
  for (let suffix = 1; await pathExists(join(group, candidate)); suffix += 1) {
    candidate = `${base}-${suffix}`
  }
  return candidate
}

/** Read a backup's manifest, or undefined when it is unreadable or foreign. */
async function readManifest(dir) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  if (typeof parsed.sessionId !== 'string' || typeof parsed.createdAt !== 'string') return undefined
  return parsed
}

// ---------------------------------------------------------------------------
// Store operations
// ---------------------------------------------------------------------------

/**
 * Copy one session's directory into the backup store.
 * @param ctx - Host context used for the flush barrier and title lookup.
 * @param sessionId - session to copy.
 * @param options - `{ home, sessionsRoot, backupRoot, title, stamp }` (tests set roots explicitly).
 * @returns the written manifest, plus `path` — the backup directory.
 */
export async function createBackup(ctx, sessionId, options = {}) {
  assertSessionId(sessionId)
  const home = options.home ?? dshHome()
  const sessions = options.sessionsRoot ?? sessionsRoot(home)
  const backups = options.backupRoot ?? backupRoot(home)
  const source = await locateSessionDir(sessionId, sessions)
  if (source === undefined) throw notFound(`session "${sessionId}" has no directory under ${sessions}`)
  await flushLiveSession(ctx, sessionId)
  const supplied = typeof options.title === 'string' && options.title.trim() !== '' ? options.title : undefined
  const title = supplied ?? (await readSessionTitle(ctx, sessionId)) ?? FALLBACK_TITLE
  const dirName = await uniqueBackupName(backups, sessionId, options.stamp ?? timestamp(), title)
  const group = join(backups, sessionId)
  const destination = join(group, dirName)
  await mkdir(group, { recursive: true })
  const copied = await copySessionDir(source, destination)
  const manifest = {
    version: MANIFEST_VERSION,
    sessionId,
    title,
    dirName,
    createdAt: new Date().toISOString(),
    sourcePath: source,
    files: copied.files,
    bytes: copied.bytes,
    consistent: copied.inconsistent.length === 0,
    inconsistent: copied.inconsistent,
  }
  await writeFile(join(destination, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { ...manifest, path: destination }
}

/** Every backup on disk, newest first. */
export async function listBackups(root) {
  const backups = []
  let groups
  try {
    groups = await readdir(root, { withFileTypes: true })
  } catch {
    return backups
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    let entries
    try {
      entries = await readdir(join(root, group.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(root, group.name, entry.name)
      const manifest = await readManifest(path)
      const files = await walkFiles(path)
      backups.push({
        path,
        sessionId: manifest?.sessionId ?? group.name,
        title: manifest?.title ?? entry.name,
        dirName: entry.name,
        createdAt: manifest?.createdAt ?? isoFromStamp(entry.name.slice(0, 15)) ?? '',
        bytes: manifest?.bytes ?? files.reduce((sum, file) => sum + file.bytes, 0),
        files: manifest?.files ?? files.length,
        consistent: manifest?.consistent ?? true,
        restorable: manifest !== undefined && typeof manifest.sourcePath === 'string',
      })
    }
  }
  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

/**
 * Copy a backup back into the session store, refusing to overwrite anything.
 * @returns `{ sessionId, title, target, restoredAt }`.
 */
/**
 * Re-register a restored session with the Workspace that owns it.
 *
 * Deleting a session does two things: it removes the directory, and it drops
 * the id from its Workspace record. Copying the directory back therefore
 * restores the bytes but leaves the session invisible — the Sidebar lists
 * Workspace membership, not the raw directory tree. This puts the id back, and
 * lets the harness validate the restored log itself: `attachSession` re-reads
 * the session header from persistence and refuses unless its `cwd` resolves to
 * the Workspace's own path.
 *
 * @param registry - the `workspaceRegistry` service (`{ list, readSessionHeader }`).
 * @param sessionId - the restored session's id.
 * @returns `{ attached: true, workspaceId, placement: 'workspace' }`, or
 *   `{ attached: false, reason, placement }` where `placement` says where the
 *   restored session actually landed: `'ungrouped'` — the Sidebar's native
 *   bucket for sessions that belong to no Workspace (a deleted Workspace, no
 *   matching `cwd`, or a profile without a registry) — or `'unknown'` for the
 *   rare unreadable-header / refused-attach cases, which the caller reports as
 *   a caveat instead of failing a request that already succeeded.
 */
export async function reattachRestoredSession(registry, sessionId) {
  if (registry === undefined || typeof registry.list !== 'function') {
    return { attached: false, reason: 'this profile has no workspace registry', placement: 'ungrouped' }
  }
  let header
  try {
    header = await registry.readSessionHeader(sessionId)
  } catch (error) {
    return {
      attached: false,
      reason: `the restored log has no readable header: ${String(error?.message ?? error)}`,
      placement: 'unknown',
    }
  }
  const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
  if (cwd === undefined) {
    return { attached: false, reason: 'the restored session header carries no cwd', placement: 'ungrouped' }
  }
  const resolvedCwd = await realpath(cwd).catch(() => cwd)
  for (const workspace of registry.list()) {
    const path = Reflect.get(workspace, 'path')
    if (typeof path !== 'string') continue
    const resolved = await realpath(path).catch(() => path)
    if (path !== cwd && resolved !== cwd && resolved !== resolvedCwd) continue
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      return { attached: false, reason: String(error?.message ?? error), placement: 'unknown' }
    }
    return { attached: true, workspaceId: Reflect.get(workspace, 'id') ?? path, placement: 'workspace' }
  }
  return { attached: false, reason: `no workspace has cwd ${cwd}`, placement: 'ungrouped' }
}

export async function restoreBackup(path, options = {}) {
  const home = options.home ?? dshHome()
  const sessions = options.sessionsRoot ?? sessionsRoot(home)
  const backups = options.backupRoot ?? backupRoot(home)
  const source = assertInside(backups, path, 'backup path')
  const manifest = await readManifest(source)
  if (manifest === undefined) throw badRequest(`backup at ${source} has no usable ${MANIFEST_FILE} manifest`)
  const sessionId = assertSessionId(manifest.sessionId)
  if (typeof manifest.sourcePath !== 'string' || manifest.sourcePath === '') {
    throw badRequest(`backup manifest at ${source} has no sourcePath`)
  }
  const destination = assertInside(sessions, manifest.sourcePath, 'manifest sourcePath')
  if (basename(destination) !== sessionId) throw badRequest('manifest sourcePath does not end in its sessionId')
  if (await pathExists(destination)) throw conflict(`session "${sessionId}" already exists at ${destination}`)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, {
    recursive: true,
    filter: (entry) => basename(entry) !== MANIFEST_FILE && !SKIP_NAMES.has(basename(entry)),
  })
  const attachment = await reattachRestoredSession(options.registry, sessionId)
  // Restoring consumes the backup: the bytes are back at their live location, so
  // the copy is spent — restoring again would only be refused as a conflict
  // anyway. Removal is best-effort (a failed prune never fails a restore that
  // already succeeded) and reported through `backupConsumed`.
  let backupConsumed = false
  try {
    await removeBackup(source, { home, backupRoot: backups })
    backupConsumed = true
  } catch (error) {
    options.logger?.warn?.(`session-backup: restored but could not remove the backup: ${String(error)}`)
  }
  return {
    sessionId,
    title: typeof manifest.title === 'string' ? manifest.title : FALLBACK_TITLE,
    target: destination,
    restoredAt: new Date().toISOString(),
    backupConsumed,
    ...attachment,
  }
}

/** Delete one backup directory, pruning its session group once empty. */
export async function removeBackup(path, options = {}) {
  const home = options.home ?? dshHome()
  const backups = options.backupRoot ?? backupRoot(home)
  const target = assertInside(backups, path, 'backup path')
  if (!(await pathExists(target))) throw notFound(`no backup at ${target}`)
  await rm(target, { recursive: true, force: true })
  const group = dirname(target)
  if (group !== backups) {
    const remaining = await readdir(group).catch(() => [])
    if (remaining.length === 0) await rm(group, { recursive: true, force: true }).catch(() => {})
  }
  return { path: target, removedAt: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// Delete engine — the permanent-deletion cascade, self-contained
// ---------------------------------------------------------------------------

/** Lease-probe attempts and backoff: bounded so a batch stays responsive. */
const BUSY_RETRY_ATTEMPTS = 12
const BUSY_RETRY_DELAY_MS = 200
/** Transient lease/handle errors get a few quick retries before refusal. */
const REMOVE_RETRY_ATTEMPTS = 2
const REMOVE_RETRY_DELAY_MS = 50
/** One settle poll between activity checks while a stop lands. */
const STOP_SETTLE_POLL_MS = 300
/** Ceiling for waiting out a stop: turn cancellation, job abort and handle
 * closure each add their own async tail; past this the lease probe decides. */
const STOP_SETTLE_MAX_MS = 15000
/** Ids this process destroyed, so a repeat NotFound answers idempotently. */
const removed = new Set()
/** One delete per id at a time: a double-confirmed dialog shares the first outcome. */
const deleting = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const notFoundError = (sessionId) =>
  failure('session/not-found', `session "${sessionId}" not found`, 404, { sessionId })
const busyError = (sessionId, activity) =>
  failure('workspace/session-active', `cannot delete session '${sessionId}': the session is active`, 409, { sessionId, activity })
const internalError = (sessionId, what, cause) =>
  failure('gateway/internal', `cannot delete session '${sessionId}': ${what}`, 500, { sessionId, cause: String(cause?.message ?? cause) })

/** Persistence error names used by both the alpha.3 and rc.2 jsonl backends. */
const isNotFoundErr = (e) => e?.name === 'SessionPersistenceNotFoundError'
const isBusyErr = (e) =>
  e?.name === 'SessionPersistenceActiveError' || e?.name === 'SessionAlreadyOwnedError'

/**
 * The activity gate, asked exactly like the kernel's archive gate: the
 * `workspace/session-activity` waterfall with an empty default, so every
 * shipped provider (turn / job / subagent / schedule) answers.
 * @returns the active items; `[]` when the session is idle or no provider exists.
 */
async function askActivity(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') return []
  try {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    return Array.isArray(activity) ? activity : []
  } catch {
    // A provider that throws must not become a silent delete: treat as active.
    return [{ kind: 'unknown' }]
  }
}

/**
 * Stop one session's running work and purge its scheduled-reminder rows.
 * Two independent layers, because a surviving armed row would cold-resume the
 * log this cascade is about to destroy:
 *   1. `workspace/session-stop` — both kernel lines register the schedule
 *      purge plus agent/jobs/subagent turn cancellation on this event.
 *   2. A direct schedule purge, tried when the event is unavailable and as a
 *      belt after it: `deleteSessionTasks` on alpha.3, `list`+`delete` on rc.2.
 * A direct purge failure aborts the whole deletion (`gateway/internal`, the
 * kernel's code): deleting the log under armed rows leaves a delivery loop
 * hammering a resurrected Session.
 */
async function stopActivityAndPurgeSchedule(ctx, sessionId) {
  if (typeof ctx.parallel === 'function') {
    try {
      await ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error) {
      ctx.logger?.warn?.(`session-backup: session-stop providers failed for '${sessionId}': ${String(error)}`)
    }
  }
  const schedule = ctx.get('schedule')
  if (schedule === undefined || schedule === null) return
  try {
    if (typeof schedule.deleteSessionTasks === 'function') {
      await schedule.deleteSessionTasks(sessionId)
      return
    }
    if (typeof schedule.list === 'function' && typeof schedule.delete === 'function') {
      const rows = await schedule.list({ sessionId })
      for (const row of Array.isArray(rows) ? rows : []) {
        await schedule.delete({ sessionId, id: row.id })
      }
    }
  } catch (error) {
    throw internalError(sessionId, 'its scheduled reminders could not be removed', error)
  }
}

/** Best-effort: a live Agent's factory-owned disposer, when this kernel has one. */
async function disposeLiveAgent(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (typeof agents?.disposeAgent !== 'function') return
  try {
    await agents.disposeAgent(sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`session-backup: disposing live agent for '${sessionId}' failed: ${String(error)}`)
  }
}

/**
 * Cancel the bare Agent and detach the Session's entered store entry, so the
 * write-handle close starts before the lease probe races it.
 *
 * On rc.2 the agent teardown is a capability: only the creator's AgentHandle
 * holds `dispose()`, and `ctx.agents.get()` returns a bare Agent — a plugin can
 * never reach that handle by id. The detach seam is the entry itself: both
 * kernels keep the store map as a TS-`private` (not `#private`) field whose
 * entries carry `detach()`, the same seam `dsh-delete-session` rides, and it
 * fires `session/disposed` — the event whose (fire-and-forget) handler closes
 * the persistence write handle. Everything is feature-detected: a kernel that
 * hides the store simply keeps the old behaviour (stop → lease-probe retries).
 * @returns `true` when an entered entry was detached.
 */
async function quiesceAndDetach(ctx, sessionId) {
  const agents = ctx.get('agents')
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  if (agent !== undefined && agent !== null) {
    try {
      if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' })
    } catch {
      // the agent may already be settling
    }
    if (typeof agent.whenIdle === 'function') {
      try {
        await Promise.race([agent.whenIdle(), sleep(10000)])
      } catch {
        // a rejected whenIdle still leaves the detach below authoritative
      }
    }
  }
  let detached = false
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && sessions !== null) {
    try {
      const store = Reflect.get(sessions, 'store')
      if (store !== undefined && store !== null && typeof store.get === 'function') {
        const entry = store.get(sessionId)
        if (entry !== undefined && entry !== null && typeof entry.detach === 'function') {
          entry.detach()
          detached = true
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`session-backup: detaching session '${sessionId}' failed: ${String(error)}`)
    }
  }
  try {
    const persistence = ctx.get('sessionPersistence')
    const retirement = persistence?.retirements?.get?.(sessionId)
    if (retirement !== undefined && retirement !== null && typeof retirement.then === 'function') await retirement
  } catch {
    // no retirement registry on this kernel: the lease probe's bounded retry
    // below already covers the close's tail.
  }
  return detached
}

/**
 * Flush every write handle, then prove exclusive ownership of the id's write
 * lease: a successful `open(id,'write')` means no other writer lives, and the
 * handle is closed at once so the removal below is the only writer. Busy is
 * retried (a detach's lease retirement lands asynchronously) and, once
 * exhausted, refused as active with an empty activity list — exactly the
 * kernel's empty-activity lease refusal.
 */
async function assertNoActiveWriter(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || persistence === null) return
  if (typeof persistence.flush === 'function') {
    try {
      await persistence.flush()
    } catch {
      // A flush failure surfaces as a busy lease below instead of being hidden.
    }
  }
  if (typeof persistence.open !== 'function') return
  let lastBusy
  let triedDetach = false
  for (let attempt = 1; attempt <= BUSY_RETRY_ATTEMPTS; attempt += 1) {
    let handle
    try {
      handle = await persistence.open(sessionId, 'write')
    } catch (error) {
      if (isNotFoundErr(error)) throw notFoundError(sessionId)
      if (!isBusyErr(error)) throw error
      lastBusy = error
      if (!triedDetach) {
        // A busy lease with an empty activity list is this process's own store
        // entry (rc.2 keeps the handle for an opened Session): detach once and
        // let the retry window observe the retirement, instead of refusing a
        // delete the user already confirmed. A writer in another process has no
        // detachable entry — quiesceAndDetach is a no-op and the window still
        // refuses honestly.
        triedDetach = true
        await quiesceAndDetach(ctx, sessionId)
      }
      if (attempt < BUSY_RETRY_ATTEMPTS) await sleep(BUSY_RETRY_DELAY_MS)
      continue
    } finally {
      if (handle !== undefined && typeof handle.close === 'function') {
        try {
          await handle.close()
        } catch {
          // A failed release only delays the rm below; the lease is ours anyway.
        }
      }
    }
    return
  }
  throw busyError(sessionId, [])
}

/** Remove the durable log. Prefers the kernel's `remove()` (alpha.3); falls
 * back to a located directory + `rm` with a post-verify (rc.2, which ships
 * no remove). NotFound answers from this process's removal record so a repeat
 * delete is the idempotent success the UI expects. */
async function removeStored(ctx, sessionId, paths) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || persistence === null) throw notFoundError(sessionId)
  if (typeof persistence.remove === 'function') {
    let transient
    for (let attempt = 0; attempt <= REMOVE_RETRY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(REMOVE_RETRY_DELAY_MS)
      try {
        await persistence.remove(sessionId)
        return
      } catch (error) {
        if (isNotFoundErr(error)) {
          if (removed.has(sessionId)) return
          throw notFoundError(sessionId)
        }
        if (isBusyErr(error)) {
          transient = error
          continue
        }
        throw error
      }
    }
    throw busyError(sessionId, [])
  }
  // No remove(): stat proves existence, the probe above proved exclusivity.
  const snapshot = typeof persistence.stat === 'function' ? await persistence.stat(sessionId) : undefined
  if (snapshot === undefined || snapshot === null) {
    if (removed.has(sessionId)) return
    throw notFoundError(sessionId)
  }
  const dir = await locateSessionDir(sessionId, paths.sessionsRoot)
  if (dir === undefined) throw internalError(sessionId, 'its log directory could not be located', new Error('no directory'))
  await rm(dir, { recursive: true, force: true })
  const after = typeof persistence.stat === 'function' ? await persistence.stat(sessionId) : undefined
  if (after !== undefined && after !== null) {
    throw internalError(sessionId, 'its log directory survived removal', new Error(`still visible at ${dir}`))
  }
}

/**
 * Best-effort derived-cache cascade after the log is gone. Every step is
 * optional and fail-soft — a residual cache row cannot resurrect a destroyed
 * Session, and the attachment blob store is content-addressed/shared, so it is
 * never touched (spec A5). Workspace accounting runs last so a failed step
 * above cannot leave a detached id behind.
 * @returns the steps that failed, for the caller's log line.
 */
async function cascadeCaches(ctx, sessionId, paths) {
  const failed = []
  const warn = (step, error) => {
    failed.push(step)
    ctx.logger?.warn?.(`session-backup: deleting ${step} for '${sessionId}' failed: ${String(error)}`)
  }
  // spill: the alpha.3 store owns removeSession; rc.2's store exposes only its
  // root, whose per-session directory is `session-<sha256(id) first 12>`.
  try {
    const spill = ctx.get('spillStore')
    if (spill !== undefined && spill !== null) {
      if (typeof spill.removeSession === 'function') await spill.removeSession(sessionId)
      else if (typeof spill.root === 'string' && spill.root !== '') {
        const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
        await rm(join(spill.root, `session-${hash}`), { recursive: true, force: true })
      }
    }
  } catch (error) {
    warn('spill cache', error)
  }
  // projection cache: the alpha.3 service invalidates; rc.2 stores one JSON
  // file per session under <storages>/session_projcache/sessions/.
  try {
    const projection = ctx.get('sessionProjectionCache')
    if (projection !== undefined && projection !== null && typeof projection.invalidate === 'function') {
      await projection.invalidate(sessionId)
    } else {
      await rm(join(paths.storagesRoot, 'session_projcache', 'sessions', `${sessionId}.json`), { force: true })
    }
  } catch (error) {
    warn('projection checkpoint', error)
  }
  // workspace accounting: alpha.3 has unaccountSession (clears archived +
  // pinned + every entity's sessionIds in one chain); rc.2 needs the three
  // public calls per workspace.
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && registry !== null) {
      if (typeof registry.unaccountSession === 'function') {
        await registry.unaccountSession(sessionId)
      } else if (typeof registry.list === 'function') {
        for (const workspace of registry.list()) {
          try {
            if (typeof workspace.unarchiveSession === 'function') await workspace.unarchiveSession(sessionId)
            if (typeof workspace.unpinSession === 'function') await workspace.unpinSession(sessionId)
            if (typeof workspace.detachSession === 'function') await workspace.detachSession(sessionId)
          } catch (error) {
            warn(`workspace accounting (${Reflect.get(workspace, 'id') ?? 'unknown'})`, error)
          }
        }
      }
    }
  } catch (error) {
    warn('workspace accounting', error)
  }
  return failed
}

/**
 * Permanently delete one Session: scheduled reminders, durable log, spill,
 * projection checkpoint, workspace accounting. Idle sessions delete outright;
 * running work is refused (`workspace/session-active` + the activity list, so
 * the dialog upgrades in place to its stop-first variant) unless the caller
 * chose `stopActivity`, which stops that work first — the kernel's gate,
 * replayed on the plugin's own routes.
 * @param ctx - host context, source of every cascade service.
 * @param sessionId - the Session to destroy.
 * @param options - `{ stopActivity }`.
 * @returns `{ deleted: true }`, including for an id this process already deleted.
 */
export async function deleteSessionCascade(ctx, sessionId, options = {}) {
  assertSessionId(sessionId)
  const existing = deleting.get(sessionId)
  if (existing !== undefined) return await existing
  const operation = runDelete(ctx, sessionId, options.stopActivity === true, options.paths)
  deleting.set(sessionId, operation)
  try {
    return await operation
  } finally {
    if (deleting.get(sessionId) === operation) deleting.delete(sessionId)
  }
}

async function runDelete(ctx, sessionId, stopActivity, explicitPaths) {
  const paths = explicitPaths ?? deletePaths()
  const persistence = ctx.get('sessionPersistence')
  // Idempotent repeat: this process already destroyed the id.
  if (removed.has(sessionId)) {
    const still = persistence !== undefined && persistence !== null && typeof persistence.stat === 'function'
      ? await persistence.stat(sessionId).catch(() => undefined)
      : undefined
    if (still === undefined || still === null) return { deleted: true }
  }
  if (persistence !== undefined && persistence !== null && typeof persistence.stat === 'function') {
    const snapshot = await persistence.stat(sessionId).catch(() => undefined)
    if (snapshot === undefined || snapshot === null) throw notFoundError(sessionId)
  }

  if (stopActivity) {
    await stopActivityAndPurgeSchedule(ctx, sessionId)
    // Cancel the bare agent and detach the entered entry FIRST: on rc.2 the
    // teardown capability is unreachable by id, and the write-handle close is
    // a fire-and-forget tail of `session/disposed` — without this the lease
    // probe below refuses a stop the user already confirmed.
    await quiesceAndDetach(ctx, sessionId)
    // Stop providers are fire-and-warn: a cancelled turn, an aborted job and
    // the write-handle close each land on their own async tails. Wait until the
    // activity gate answers empty (the same providers the first confirmation
    // asked), so the lease probe below does not race a half-settled stop and
    // refuse as busy. The ceiling is generous; past it the lease probe's own
    // bounded retry still refuses honestly.
    const settleDeadline = Date.now() + STOP_SETTLE_MAX_MS
    for (;;) {
      const activity = await askActivity(ctx, sessionId)
      if (activity.length === 0) break
      if (Date.now() >= settleDeadline) break
      await sleep(STOP_SETTLE_POLL_MS)
    }
  } else {
    // The gate is the archive gate: same providers, same code, same payload,
    // so the client's busy-confirm rendering covers deletion unchanged.
    const activity = await askActivity(ctx, sessionId)
    if (activity.length > 0) throw busyError(sessionId, activity)
    // Idle or not, armed schedule rows die first — they would cold-resume the
    // log this cascade destroys (kernel step order, spec B1 1a).
    await stopActivityAndPurgeSchedule(ctx, sessionId)
    // rc.2's kernel store keeps the write handle open for an opened — even
    // idle — Session until `session/disposed` closes it, so the lease probe
    // below would exhaust its retries and refuse with an EMPTY activity list:
    // a refusal the client cannot render as a stop-first upgrade, and the
    // dead end that broke idle deletes after the rc.2 upgrade (two backups,
    // no deletion). Detach first — the same seam the stop branch rides.
    await quiesceAndDetach(ctx, sessionId)
  }

  await disposeLiveAgent(ctx, sessionId)
  await assertNoActiveWriter(ctx, sessionId)
  await removeStored(ctx, sessionId, paths)
  removed.add(sessionId)
  const failed = await cascadeCaches(ctx, sessionId, paths)
  // The GUI's session list listens for this one; the row disappears without a
  // full refresh (the kernel emits it on the same removal).
  try {
    ctx.emit?.('api-session/removed', sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`session-backup: removed-event for '${sessionId}' failed: ${String(error)}`)
  }
  if (failed.length > 0) {
    ctx.logger?.warn?.(`session-backup: '${sessionId}' deleted with residual cache steps: ${failed.join(', ')}`)
  }
  return { deleted: true }
}

/** Resolve every root this cascade touches from the current home. */
function deletePaths() {
  const home = dshHome()
  return { home, sessionsRoot: sessionsRoot(home), storagesRoot: join(home, 'storages') }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function readJson(request) {
  try {
    return await request.json()
  } catch {
    throw badRequest('request body must be a JSON object')
  }
}

function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/** Wrap one route handler so every failure answers with a JSON error body. */
function route(ctx, handler) {
  return async (request) => {
    try {
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readJson(request)
      return json(await handler(request, body))
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      if (status >= 500) ctx.logger.error(`session-backup: route ${request.url} failed: ${String(error)}`)
      const payload = { code: error?.code ?? 'session-backup/internal', message: error?.message ?? 'unexpected failure' }
      if (error?.details !== undefined) payload.details = error.details
      return json({ error: payload }, status)
    }
  }
}

/**
 * Register the four API routes on the Host connection.
 * @param ctx - Host context carrying the connection service.
 * @param config - `{ home }` override; defaults to `$DSH_HOME`.
 */
export function apply(ctx, config = {}) {
  const home = config.home ?? dshHome()
  const paths = {
    home,
    sessionsRoot: sessionsRoot(home),
    backupRoot: backupRoot(home),
    storagesRoot: join(home, 'storages'),
  }
  const fetch = connectionOf(ctx).fetch
  ctx.effect(() => {
    const registered = [
      fetch.register({
        path: `${API_PATH}.list`,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: route(ctx, async () => ({ backups: await listBackups(paths.backupRoot) })),
      }),
      fetch.register({
        path: `${API_PATH}.create`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: route(ctx, async (request, body) => ({
          backup: await createBackup(ctx, assertSessionId(body?.sessionId), paths),
        })),
      }),
      fetch.register({
        path: `${API_PATH}.restore`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: route(ctx, async (request, body) => ({
          restored: await restoreBackup(assertRequestPath(body?.path), {
            ...paths,
            registry: ctx?.get?.('workspaceRegistry'),
            logger: ctx.logger,
          }),
        })),
      }),
      fetch.register({
        path: `${API_PATH}.remove`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: route(ctx, async (request, body) => ({
          removed: await removeBackup(assertRequestPath(body?.path), paths),
        })),
      }),
      fetch.register({
        path: `${API_PATH}.delete`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: route(ctx, async (request, body) => ({
          deleted: await deleteSessionCascade(ctx, assertSessionId(body?.sessionId), {
            stopActivity: body?.stopActivity === true,
            paths,
          }),
        })),
      }),
    ]
    return () => {
      for (const dispose of registered) dispose?.()
    }
  }, 'session-backup: routes')
}
