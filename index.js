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
 * session directory alone is a complete, restorable copy. Identical contents
 * reuse a stored copy. A delete refreshes the latest backup after stopping
 * work, so a manual backup followed by deletion retains one up-to-date copy.
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
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SessionArtifactStore } from './artifacts.js'

export const name = 'session-backup'

/** Validate the plugin's two settings without adding a runtime dependency. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-session-backup',
    validate(value = {}) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'Session backup configuration must be an object' }] }
      }
      if (value.cleanupOnDelete !== undefined && typeof value.cleanupOnDelete !== 'boolean') {
        return { issues: [{ message: 'cleanupOnDelete must be a boolean', path: ['cleanupOnDelete'] }] }
      }
      if (value.home !== undefined && (typeof value.home !== 'string' || value.home.trim() === '')) {
        return { issues: [{ message: 'home must be a nonempty path', path: ['home'] }] }
      }
      return { value: { ...value, cleanupOnDelete: value.cleanupOnDelete ?? false } }
    },
  },
}

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
const MANIFEST_VERSION = 2
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
  // A failed flush means the on-disk prefix may be stale. Abort the backup;
  // the delete caller must never destroy the only up-to-date live copy.
  await store.flush(session)
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

/**
 * Content fingerprint of one directory: sorted `relative/path:sha256` lines.
 *
 * A stored copy fingerprints like its source because lease and cruft files
 * never enter a backup and `backup.json` is excluded here. Hashing bytes — not
 * sizes — means only identical content reuses a backup; a source that kept
 * appending mid-copy differs from its pre-copy fingerprint, and the manifest
 * written after the copy records the destination's own fingerprint, which is
 * what a later request compares against.
 * @param root - session directory or stored backup directory to fingerprint.
 * @returns sorted fingerprint lines, comparable with `every()`.
 */
async function inventoryOf(root) {
  const files = await walkFiles(root)
  const lines = []
  for (const file of files) {
    if (file.rel === MANIFEST_FILE) continue
    const digest = createHash('sha256').update(await readFile(file.path)).digest('hex')
    lines.push(`${file.rel}:${digest}`)
  }
  return lines.sort()
}

/** Read valid backups for this exact session and original location, newest first. */
async function storedBackups(group, sessionId, source) {
  let entries
  try {
    entries = await readdir(group, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const copies = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = assertInside(group, join(group, entry.name), 'stored backup')
    const manifest = await readManifest(path)
    if (manifest?.sessionId !== sessionId || manifest.sourcePath !== source || manifest.consistent !== true) continue
    copies.push({ ...manifest, dirName: entry.name, path })
  }
  return copies.sort((left, right) => right.createdAt.localeCompare(left.createdAt)
    || right.dirName.localeCompare(left.dirName))
}

/** Serialize backup creation for one on-disk session group, including failed requests. */
const backupWrites = new Map()

/**
 * Copy or reuse one session backup. Before deletion, refresh the newest backup
 * in place when the log changed; ordinary explicit snapshots retain history.
 * A replacement is fully copied and verified before the old backup is moved.
 * @param ctx - Host context for the flush barrier and title lookup.
 * @param sessionId - session to copy.
 * @param options - roots, optional title/stamp, and beforeDelete (refresh newest).
 * @returns the manifest and path, with reused/updated describing the result.
 */
export async function createBackup(ctx, sessionId, options = {}) {
  assertSessionId(sessionId)
  const backups = options.backupRoot ?? backupRoot(options.home ?? dshHome())
  return withBackupGroup(resolve(backups, sessionId), () => createBackupNow(ctx, sessionId, options))
}

async function withBackupGroup(key, run) {
  const previous = backupWrites.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(run)
  backupWrites.set(key, operation)
  try {
    return await operation
  } finally {
    if (backupWrites.get(key) === operation) backupWrites.delete(key)
  }
}

/** Only a direct backup entry may be restored or removed, never staging or a whole group. */
function backupGroupForPath(backups, path) {
  const target = assertInside(backups, path, 'backup path')
  const segments = relative(resolve(backups), target).split(sep)
  if (segments.length !== 2) throw badRequest('backup path must name one backup entry')
  const sessionId = assertSessionId(segments[0])
  if (deleting.has(sessionId)) throw conflict('the session is being deleted; retry after deletion completes')
  return dirname(target)
}

async function createBackupNow(ctx, sessionId, options) {
  const home = options.home ?? dshHome()
  const sessions = options.sessionsRoot ?? sessionsRoot(home)
  const backups = options.backupRoot ?? backupRoot(home)
  const source = await locateSessionDir(sessionId, sessions)
  if (source === undefined) throw notFound(`session "${sessionId}" has no directory under ${sessions}`)
  await flushLiveSession(ctx, sessionId)
  const group = assertInside(backups, join(backups, sessionId), 'backup group')
  const copies = await storedBackups(group, sessionId, source)
  const wanted = await inventoryOf(source)
  for (const copy of copies) {
    const stored = await inventoryOf(copy.path)
    if (stored.length === wanted.length && stored.every((line, index) => line === wanted[index])) {
      return { ...copy, reused: true, updated: false }
    }
  }

  const replacement = options.beforeDelete === true ? copies[0] : undefined
  const supplied = typeof options.title === 'string' && options.title.trim() !== '' ? options.title : undefined
  const title = supplied ?? (await readSessionTitle(ctx, sessionId)) ?? FALLBACK_TITLE
  const dirName = replacement?.dirName ?? await uniqueBackupName(backups, sessionId, options.stamp ?? timestamp(), title)
  const destination = assertInside(group, join(group, dirName), 'backup destination')
  // Staging is outside session groups, so list/match never expose partial copies.
  const pendingRoot = join(backups, '.pending')
  await mkdir(pendingRoot, { recursive: true })
  const staging = assertInside(pendingRoot, await mkdtemp(join(pendingRoot, `${sessionId}-`)), 'backup staging')
  const prepared = join(staging, 'new')
  const previous = join(staging, 'previous')
  let keepPrevious = false
  try {
    const copied = await copySessionDir(source, prepared)
    const inventory = await inventoryOf(prepared)
    const current = await inventoryOf(source)
    if (copied.inconsistent.length > 0 || inventory.length !== current.length
      || !inventory.every((line, index) => line === current[index])) {
      throw conflict('session changed while its backup was copied; retry after the session becomes idle')
    }
    const manifest = {
      version: MANIFEST_VERSION,
      sessionId,
      title,
      dirName,
      createdAt: new Date().toISOString(),
      sourcePath: source,
      files: copied.files,
      bytes: copied.bytes,
      consistent: true,
      inconsistent: [],
      inventory,
    }
    await writeFile(join(prepared, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await mkdir(group, { recursive: true })
    if (replacement !== undefined) {
      // Preserve the last good copy until the new one is published; failure rolls it back.
      await rename(destination, previous)
      keepPrevious = true
      try {
        await rename(prepared, destination)
      } catch (error) {
        try {
          await rename(previous, destination)
          keepPrevious = false
        } catch (rollback) {
          throw new AggregateError([error, rollback], `backup replacement failed; original retained at ${previous}`)
        }
        throw error
      }
      keepPrevious = false
    } else {
      await rename(prepared, destination)
    }
    return { ...manifest, path: destination, reused: false, updated: replacement !== undefined }
  } finally {
    if (!keepPrevious) await rm(staging, { recursive: true, force: true })
  }
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
    if (!group.isDirectory() || group.name === '.pending') continue
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
  const backups = options.backupRoot ?? backupRoot(options.home ?? dshHome())
  const group = backupGroupForPath(backups, path)
  return withBackupGroup(group, () => restoreBackupNow(path, options))
}

async function restoreBackupNow(path, options) {
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
  // Restoration already copied the log; an unsafe/unreadable optional registry
  // cannot turn it into a generic failure before attachment and pinning. Retry
  // checks persisted Session absence, so the retained files stay protected.
  let cleanupWarning
  try {
    await new SessionArtifactStore(home).cancelPending(sessionId)
  } catch (error) {
    cleanupWarning = String(error?.message ?? error)
    options.logger?.warn?.(`session-backup: restored '${sessionId}' but its cleanup marker could not be reset: ${cleanupWarning}`)
  }
  const attachment = await reattachRestoredSession(options.registry, sessionId)
  // Surface the restored Session ahead of every unpinned row: the registry's
  // pin is registry-global (covers the native Ungrouped bucket too) and its
  // `pinned` frame reaches the sidebar live. Best-effort — a restore that
  // already succeeded never fails because a pin was refused (archived id).
  let pinned = false
  const registry = options.registry
  if (registry !== undefined && typeof registry.pinSession === 'function') {
    try {
      await registry.pinSession(sessionId)
      pinned = true
    } catch (error) {
      options.logger?.warn?.(`session-backup: restored but could not pin it: ${String(error)}`)
    }
  }
  // Restoring consumes the backup: the bytes are back at their live location, so
  // the copy is spent — restoring again would only be refused as a conflict
  // anyway. Removal is best-effort (a failed prune never fails a restore that
  // already succeeded) and reported through `backupConsumed`.
  let backupConsumed = false
  try {
    await removeBackupNow(source, { home, backupRoot: backups })
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
    pinned,
    ...(cleanupWarning === undefined ? {} : { cleanupWarning }),
    ...attachment,
  }
}

/** Delete one backup directory, pruning its session group once empty. */
export async function removeBackup(path, options = {}) {
  const backups = options.backupRoot ?? backupRoot(options.home ?? dshHome())
  const group = backupGroupForPath(backups, path)
  return withBackupGroup(group, () => removeBackupNow(path, options))
}

async function removeBackupNow(path, options) {
  const home = options.home ?? dshHome()
  const backups = options.backupRoot ?? backupRoot(home)
  const target = assertInside(backups, path, 'backup path')
  if (!(await pathExists(target))) throw notFound(`no backup at ${target}`)
  await rm(target, { recursive: true, force: true })
  const group = dirname(target)
  if (group !== backups) {
    await rmdir(group).catch((error) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
    })
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
 * handle stays open across final backup and filesystem removal. Busy is
 * retried (a detach's lease retirement lands asynchronously) and, once
 * exhausted, refused as active with an empty activity list — exactly the
 * kernel's empty-activity lease refusal.
 */
async function acquireDeletionLease(ctx, sessionId) {
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
    }
    return handle
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
  const paths = options.paths ?? deletePaths()
  const group = resolve(paths.backupRoot ?? backupRoot(paths.home ?? dshHome()), sessionId)
  // Restore, deletion (including orphaned logs), and artifact cleanup share the
  // same group lock. Re-evaluate session existence only after obtaining it.
  const operation = withBackupGroup(group, () => runDelete(ctx, sessionId, options.stopActivity === true, paths, options.cleanupOnDelete === true))
  deleting.set(sessionId, operation)
  try {
    return await operation
  } finally {
    if (deleting.get(sessionId) === operation) deleting.delete(sessionId)
  }
}

/**
 * Any trace of the id left after its log directory vanished: a live in-memory
 * Session, its projection checkpoint, or workspace accounting. A delete that
 * only checks disk answers 404 for such a half-deleted residue and strands a
 * row the Sidebar still lists forever, so this decides between "clean up the
 * leftovers" and a genuine not-found refusal.
 */
async function hasResidual(ctx, sessionId, paths) {
  try {
    const live = ctx.get('sessions')?.get?.(sessionId)
    if (live !== undefined && live !== null) return true
  } catch {
    // a store that cannot answer falls through to the on-disk probes
  }
  const storages = paths.storagesRoot ?? join(paths.home ?? dshHome(), 'storages')
  if (await pathExists(join(storages, 'session_projcache', 'sessions', `${sessionId}.json`))) return true
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
    for (const workspace of registry.list()) {
      const members = Reflect.get(workspace, 'sessionIds')
      if (Array.isArray(members) && members.includes(sessionId)) return true
    }
  }
  return false
}

async function runDelete(ctx, sessionId, stopActivity, explicitPaths, cleanupOnDelete) {
  const paths = explicitPaths ?? deletePaths()
  const artifacts = new SessionArtifactStore(paths.home ?? dshHome())
  const persistence = ctx.get('sessionPersistence')
  const finish = async (result) => {
    removed.add(sessionId)
    emitRemoved(ctx, sessionId)
    if (!cleanupOnDelete) return result
    return { ...result, cleanup: await cleanupDeletedArtifacts(ctx, sessionId, paths, artifacts) }
  }
  // Idempotent repeat: this process already destroyed the id.
  if (removed.has(sessionId)) {
    const still = persistence !== undefined && persistence !== null && typeof persistence.stat === 'function'
      ? await persistence.stat(sessionId)
      : undefined
    if (still === undefined || still === null) return await finish({ deleted: true })
  }
  // A missing log is either a genuinely unknown id (refuse) or a half-deleted
  // residue whose row the Sidebar still shows (finish the cleanup below).
  let orphaned = false
  if (persistence !== undefined && persistence !== null && typeof persistence.stat === 'function') {
    const snapshot = await persistence.stat(sessionId).catch(() => undefined)
    if (snapshot === undefined || snapshot === null) {
      if (!(await hasResidual(ctx, sessionId, paths)) && !(await artifacts.has(sessionId))) throw notFoundError(sessionId)
      orphaned = true
    }
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
  // Cache cleanup runs BEFORE the log leaves the disk, and it is no longer
  // swallowed: a step that fails aborts the delete while the Session is still
  // whole and retryable. Removing the log first and merely warning on later
  // failures produced the half-deleted residue this plugin used to 404 on —
  // a dangling Sidebar row whose only log was already gone.
  const failed = await cascadeCaches(ctx, sessionId, paths)
  if (failed.length > 0) {
    throw internalError(sessionId, `its ${failed.join(', ')} could not be cleared; the session was not deleted`, new Error('cache cleanup failed'))
  }
  if (orphaned) {
    // No log left: the activity gate above already stopped work and detached
    // the live entry, and the cache cascade just ran. The only work left is the
    // event the Sidebar waits on, so a half-deleted id disappears.
    if (cleanupOnDelete) await artifacts.markPending(sessionId)
    return await finish({ deleted: true, alreadyGone: true })
  }
  const backups = paths.backupRoot ?? backupRoot(paths.home ?? dshHome())
  let lease = await acquireDeletionLease(ctx, sessionId)
  try {
    // Stop/detach may append closing events; capture them while no writer can
    // re-enter. The outer group lock keeps restore/remove off this copy.
    if (await locateSessionDir(sessionId, paths.sessionsRoot) !== undefined) {
      try {
        await createBackupNow(ctx, sessionId, { ...paths, backupRoot: backups, beforeDelete: true })
      } catch (error) {
        throw internalError(sessionId, 'its final backup could not be saved; the session was not deleted', error)
      }
    }
    // Older native remove APIs acquire their own deletion lock, so hand the
    // write lease back immediately before entering that atomic native path.
    if (typeof persistence?.remove === 'function' && typeof lease?.close === 'function') {
      await lease.close()
      lease = undefined
    }
    // Keep deletion intent outside the log, so an interrupted cleanup remains
    // reviewable and retryable after the Session directory has disappeared.
    if (cleanupOnDelete) await artifacts.markPending(sessionId)
    try {
      await removeStored(ctx, sessionId, paths)
    } catch (error) {
      // A refused log deletion leaves a live Session; release its pending flag
      // only when the log is positively present. Unknown state stays pending.
      if (cleanupOnDelete && await persistence?.stat?.(sessionId).catch(() => undefined) != null) {
        await artifacts.cancelPending(sessionId).catch(cause => ctx.logger?.warn?.(String(cause)))
      }
      throw error
    }
  } finally {
    if (typeof lease?.close === 'function') await lease.close()
  }
  return await finish({ deleted: true })
}

/** Only a proven-absent Session may lose its registered temporary files. */
async function assertDeletedSession(ctx, sessionId, paths) {
  const persistence = ctx.get('sessionPersistence')
  if (typeof persistence?.stat !== 'function') throw conflict('Session absence cannot be verified in this profile')
  if (await persistence.stat(sessionId) != null || ctx.get('sessions')?.get?.(sessionId) != null
      || await locateSessionDir(sessionId, paths.sessionsRoot) !== undefined) {
    throw conflict('The session still exists; its temporary files were retained')
  }
}

/** A cleanup failure never disguises an already completed log deletion. */
async function cleanupDeletedArtifacts(ctx, sessionId, paths, artifacts) {
  try {
    await assertDeletedSession(ctx, sessionId, paths)
    return await artifacts.cleanup(sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`session-backup: temporary files for '${sessionId}' were retained: ${String(error)}`)
    return { removed: 0, bytes: 0, retained: null, failed: [{ id: sessionId, reason: String(error?.message ?? error) }] }
  }
}

/** Retry only marked inventories, serializing with backup restoration. */
export async function retryArtifactCleanup(ctx, paths) {
  const artifacts = new SessionArtifactStore(paths.home ?? dshHome())
  const results = []
  for (const { sessionId } of await artifacts.pending()) {
    if (deleting.has(sessionId)) continue
    const group = resolve(paths.backupRoot ?? backupRoot(paths.home ?? dshHome()), sessionId)
    results.push(await withBackupGroup(group, async () => {
      // Restoration may have cancelled this marker while we waited for its lock.
      if (!(await artifacts.pending()).some(entry => entry.sessionId === sessionId)) return { sessionId, skipped: true }
      return { sessionId, ...await cleanupDeletedArtifacts(ctx, sessionId, paths, artifacts) }
    }))
  }
  return results
}

/**
 * Tell the GUI's session list the row is gone (it listens for this one, so the
 * row disappears without a full refresh — the kernel emits it on the same
 * removal). Never throws: a listener failure must not turn a completed delete
 * into an error the user retries.
 */
function emitRemoved(ctx, sessionId) {
  try {
    ctx.emit?.('api-session/removed', sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`session-backup: removed-event for '${sessionId}' failed: ${String(error)}`)
  }
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
export function apply(ctx, rawConfig = {}) {
  const validation = Config['~standard'].validate(rawConfig)
  if (validation.issues) throw badRequest(validation.issues[0].message)
  const config = validation.value
  const home = config.home ?? dshHome()
  const paths = {
    home,
    sessionsRoot: sessionsRoot(home),
    backupRoot: backupRoot(home),
    storagesRoot: join(home, 'storages'),
  }
  const artifacts = new SessionArtifactStore(home)
  // Producers opt into ownership by allocating files through this service. It
  // accepts bytes, never a path to an existing file; cleanup stays Host-owned.
  if (typeof ctx.provide === 'function') ctx.provide('sessionArtifacts', {
    save: async (sessionId, filename, data) => {
      assertSessionId(sessionId)
      if (deleting.has(sessionId)) throw conflict('The session is being deleted')
      return withBackupGroup(resolve(paths.backupRoot, sessionId), async () => {
        if (deleting.has(sessionId)) throw conflict('The session is being deleted')
        const persistence = ctx.get('sessionPersistence')
        if (typeof persistence?.stat !== 'function' || await persistence.stat(sessionId) == null) {
          throw notFoundError(sessionId)
        }
        return artifacts.save(sessionId, filename, data)
      })
    },
  })
  const settings = async () => ({
    cleanupOnDelete: config.cleanupOnDelete,
    editable: ctx.fiber?.entry !== undefined && typeof ctx.get('configEditor')?.edit === 'function',
    pending: await artifacts.pending(),
  })
  const fetch = connectionOf(ctx).fetch
  ctx.effect(() => {
    const registered = [
      fetch.register({
        path: `${API_PATH}.cleanup-settings`,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: route(ctx, async (request, body) => {
          if (request.method === 'GET') return { settings: await settings() }
          if (typeof body?.cleanupOnDelete !== 'boolean') throw badRequest('cleanupOnDelete must be a boolean')
          const editor = ctx.get('configEditor')
          const entry = ctx.fiber?.entry
          if (entry === undefined || typeof editor?.edit !== 'function') {
            throw conflict('Configuration cannot be saved in this profile')
          }
          await editor.edit(entry, current => ({ ...current, cleanupOnDelete: body.cleanupOnDelete }))
          return { settings: { ...await settings(), cleanupOnDelete: body.cleanupOnDelete } }
        }),
      }),
      fetch.register({
        path: `${API_PATH}.cleanup-retry`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: route(ctx, async () => {
          if (!config.cleanupOnDelete) throw conflict('Temporary-file cleanup is turned off')
          return { results: await retryArtifactCleanup(ctx, paths), settings: await settings() }
        }),
      }),
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
          backup: await createBackup(ctx, assertSessionId(body?.sessionId), {
            ...paths, beforeDelete: body?.beforeDelete !== false,
          }),
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
            cleanupOnDelete: config.cleanupOnDelete,
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
