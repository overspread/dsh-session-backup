/**
 * Session backup — Host face.
 *
 * Owns the on-disk backup store (`$DSH_HOME/backups/sessions/<sessionId>/<stamp>-<title>/`)
 * and the four HTTP routes the Web GUI calls. Every operation is a plain
 * filesystem routine taking explicit roots, so the tests drive them against a
 * temp directory without booting a profile.
 *
 * A backup is a recursive copy of the session's own directory plus a
 * `backup.json` manifest describing what was taken. Attachments are
 * content-addressed and are NOT purged when a session is deleted, so the
 * session directory alone is a complete, restorable copy.
 */
import { copyFile, cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
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

/** Build an Error carrying a machine-readable `code` and an HTTP `status`. */
export function failure(code, message, status = 500) {
  const error = new Error(message)
  error.code = code
  error.status = status
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
 * @returns `{ attached: true, workspaceId }`, or `{ attached: false, reason }`
 *   when the session cannot be re-attached — the files are still restored, and
 *   the caller reports that instead of failing a request that already succeeded.
 */
export async function reattachRestoredSession(registry, sessionId) {
  if (registry === undefined || typeof registry.list !== 'function') {
    return { attached: false, reason: 'this profile has no workspace registry' }
  }
  let header
  try {
    header = await registry.readSessionHeader(sessionId)
  } catch (error) {
    return { attached: false, reason: `the restored log has no readable header: ${String(error?.message ?? error)}` }
  }
  const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
  if (cwd === undefined) return { attached: false, reason: 'the restored session header carries no cwd' }
  const resolvedCwd = await realpath(cwd).catch(() => cwd)
  for (const workspace of registry.list()) {
    const path = Reflect.get(workspace, 'path')
    if (typeof path !== 'string') continue
    const resolved = await realpath(path).catch(() => path)
    if (path !== cwd && resolved !== cwd && resolved !== resolvedCwd) continue
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      return { attached: false, reason: String(error?.message ?? error) }
    }
    return { attached: true, workspaceId: Reflect.get(workspace, 'id') ?? path }
  }
  return { attached: false, reason: `no workspace has cwd ${cwd}` }
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
  return {
    sessionId,
    title: typeof manifest.title === 'string' ? manifest.title : FALLBACK_TITLE,
    target: destination,
    restoredAt: new Date().toISOString(),
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
      return json({ error: { code: error?.code ?? 'session-backup/internal', message: error?.message ?? 'unexpected failure' } }, status)
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
  const paths = { home, sessionsRoot: sessionsRoot(home), backupRoot: backupRoot(home) }
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
    ]
    return () => {
      for (const dispose of registered) dispose?.()
    }
  }, 'session-backup: routes')
}
