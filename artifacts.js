/** Session-owned temporary files. Only save() allocates deletion-owned paths. */
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RESERVED_SEGMENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i
const ID = /^[a-f0-9]{32}$/
const HASH = /^[a-f0-9]{64}$/
const INTEGER = /^\d+$/
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const queues = new Map()
let admissions = Promise.resolve()
const STAT_FIELDS = ['dev', 'ino', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs', 'mode']
const emptyResult = () => ({ removed: 0, bytes: 0, retained: 0, failed: [] })

function fail(message, code = 'ARTIFACTS_UNSAFE') {
  const error = new Error(message)
  error.code = code
  return error
}

function sessionIdOf(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value) || value.endsWith('.') || RESERVED_SEGMENT.test(value)) {
    throw fail('Invalid session id', 'ARTIFACTS_INVALID')
  }
  return value
}

function nameOf(value) {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..'
    || /[\u0000-\u001f\u007f/\\:*?"<>|]/u.test(value) || /[. ]$/u.test(value)
    || Buffer.byteLength(value, 'utf8') > 180) throw fail('Invalid artifact filename', 'ARTIFACTS_INVALID')
  return value
}

function inside(root, path) {
  const relation = relative(root, path)
  if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw fail('Artifact path escapes its managed root')
  }
  return path
}

const snapshot = info => Object.fromEntries(STAT_FIELDS.map(key => [key, String(info[key])]))
const same = (expected, info) => STAT_FIELDS.every(key => expected[key] === String(info[key]))
const missing = error => error?.code === 'ENOENT'
const owned = info => typeof process.getuid !== 'function' || info.uid === BigInt(process.getuid())

async function directory(path, privateDirectory = true) {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)
    || (privateDirectory && (info.mode & 0o077n) !== 0n) || await realpath(path) !== path) {
    throw fail('Managed directory is symlinked, non-private, or not owned by this user')
  }
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function childDirectory(parent, name, create) {
  const path = inside(parent, join(parent, name))
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 })
      await syncDirectory(parent)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  await directory(path)
  return path
}

/** Canonicalize only the caller-supplied home; managed descendants never follow links. */
async function homeOf(path, create) {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('Artifact home must be a directory, not a symlink')
    const home = await realpath(path)
    await directory(home, false)
    return home
  } catch (error) {
    if (!missing(error)) throw error
    if (!create) return null
    const parentPath = dirname(path)
    if (parentPath === path) throw error
    // Existing ancestors such as macOS /var may have a canonical spelling.
    let parent
    try { parent = await realpath(parentPath) }
    catch (parentError) {
      if (!missing(parentError)) throw parentError
      parent = await homeOf(parentPath, true)
    }
    const home = join(parent, basename(path))
    await childDirectory(parent, basename(path), true)
    return home
  }
}

async function serialized(home, run) {
  const previous = queues.get(home) ?? Promise.resolve()
  const operation = previous.then(run)
  const settled = operation.catch(() => {})
  queues.set(home, settled)
  try { return await operation }
  finally { if (queues.get(home) === settled) queues.delete(home) }
}

async function layout(home, create) {
  await directory(home, false)
  const root = await childDirectory(home, 'session-artifacts', create)
  const registry = await childDirectory(root, 'registry', create)
  const objects = await childDirectory(root, 'objects', create)
  return { home, root, registry, objects }
}

async function checkLayout(paths) {
  await directory(paths.home, false)
  await directory(paths.root)
  await directory(paths.registry)
}

function regular(info) {
  if (!info.isFile() || info.isSymbolicLink()) throw fail('Registered file is not a regular file')
  if (info.nlink !== 1n) throw fail('Registered file has hard links')
  if (!owned(info) || (info.mode & 0o077n) !== 0n) throw fail('Registered file is not private and user-owned')
}

async function readLedger(paths, sessionId) {
  await checkLayout(paths)
  const path = inside(paths.registry, join(paths.registry, `${sessionId}.json`))
  let handle
  try {
    const before = await lstat(path, { bigint: true })
    regular(before)
    if (before.size > 16n * 1024n * 1024n) throw fail('Artifact ledger is too large')
    handle = await open(path, constants.O_RDONLY | NOFOLLOW)
    const info = await handle.stat({ bigint: true })
    regular(info)
    if (!same(snapshot(before), info)) throw fail('Artifact ledger changed while opening it')
    const value = JSON.parse(await handle.readFile('utf8'))
    if (!same(snapshot(info), await handle.stat({ bigint: true }))) throw fail('Artifact ledger changed while reading it')
    if (value?.version !== 1 || value.sessionId !== sessionId || typeof value.pending !== 'boolean' || !Array.isArray(value.entries)) {
      throw fail('Invalid artifact ledger')
    }
    const ids = new Set()
    for (const entry of value.entries) {
      if (typeof entry?.id !== 'string' || !ID.test(entry.id) || ids.has(entry.id) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256) || !STAT_FIELDS.every(key => typeof entry.stat?.[key] === 'string' && INTEGER.test(entry.stat[key]))
        || entry.stat.size !== String(entry.bytes)) throw fail('Invalid artifact ledger entry')
      nameOf(entry.name)
      ids.add(entry.id)
    }
    return { value, stat: snapshot(info) }
  } catch (error) {
    if (missing(error)) return null
    throw error
  } finally { await handle?.close() }
}

async function expectLedger(paths, sessionId, expected) {
  await checkLayout(paths)
  const path = inside(paths.registry, join(paths.registry, `${sessionId}.json`))
  try {
    const info = await lstat(path, { bigint: true })
    regular(info)
    if (expected === null || !same(expected, info)) throw fail('Artifact ledger was replaced or modified')
  } catch (error) {
    if (!missing(error) || expected !== null) throw error
  }
  return path
}

async function writeLedger(paths, value, expected, onPublished) {
  await checkLayout(paths)
  const temporary = inside(paths.registry, join(paths.registry, `.${value.sessionId}-${randomBytes(16).toString('hex')}.tmp`))
  const body = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw fail('Artifact ledger is too large')
  const sha256 = createHash('sha256').update(body).digest('hex')
  let handle
  let written
  let published = false
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600)
    await handle.writeFile(body)
    await handle.sync()
    written = snapshot(await handle.stat({ bigint: true }))
    await handle.close()
    handle = undefined
    const path = await expectLedger(paths, value.sessionId, expected)
    const staging = await lstat(temporary, { bigint: true })
    regular(staging)
    if (!same(written, staging)) throw fail('Artifact ledger staging file was replaced')
    await rename(temporary, path)
    published = true
    // Publication already made these entries visible. A later durability error
    // must not let save() remove an object this ledger now owns.
    onPublished?.()
    await syncDirectory(paths.registry)
    return { value, stat: snapshot(await lstat(path, { bigint: true })) }
  } finally {
    await handle?.close()
    if (!published) {
      // This exact exclusive staging file belongs to this operation. A replaced
      // or symlinked registry must not redirect even staging-file housekeeping.
      try {
        await checkLayout(paths)
        const info = await lstat(temporary, { bigint: true })
        regular(info)
        if (written === undefined || !same(written, info)) throw fail('Changed staging file retained')
        const check = await open(temporary, constants.O_RDONLY | NOFOLLOW)
        try {
          if (!same(written, await check.stat({ bigint: true })) || await digest(check) !== sha256) throw fail('Changed staging file retained')
        } finally { await check.close() }
        await checkLayout(paths)
        if (!same(written, await lstat(temporary, { bigint: true }))) throw fail('Changed staging file retained')
        await unlink(temporary)
      } catch { /* A failed write may leave an unregistered staging file. */ }
    }
  }
}

async function digest(handle) {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(64 * 1024)
  let position = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) return hash.digest('hex')
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
}

async function objectPath(paths, sessionId, entry) {
  await checkLayout(paths)
  await directory(paths.objects)
  const session = inside(paths.objects, join(paths.objects, sessionId))
  await directory(session)
  return inside(session, join(session, `${entry.id}-${entry.name}`))
}

/** Check identity and bytes through a non-following descriptor, then check again before unlink. */
async function removeEntry(paths, sessionId, entry) {
  let handle
  try {
    const path = await objectPath(paths, sessionId, entry)
    const info = await lstat(path, { bigint: true })
    regular(info)
    if (!same(entry.stat, info)) throw fail('Registered file was modified or replaced')
    handle = await open(path, constants.O_RDONLY | NOFOLLOW)
    const opened = await handle.stat({ bigint: true })
    regular(opened)
    if (!same(entry.stat, opened) || await digest(handle) !== entry.sha256) throw fail('Registered file identity or content changed')
    regular(await handle.stat({ bigint: true }))
    if (!same(entry.stat, await handle.stat({ bigint: true }))) throw fail('Registered file changed during verification')
    await objectPath(paths, sessionId, entry)
    const last = await lstat(path, { bigint: true })
    regular(last)
    if (!same(entry.stat, last)) throw fail('Registered file changed before removal')
    await unlink(path)
    await syncDirectory(dirname(path))
    return true
  } catch (error) {
    if (missing(error)) return false // A previous interrupted cleanup may already have unlinked it.
    throw error
  } finally { await handle?.close() }
}

/**
 * In-process operations serialize by canonical home, including separate store
 * instances. Other processes must not concurrently write this store. Private
 * directories and repeated no-follow/identity checks reject unsafe paths; Node
 * has no portable fd-relative unlink, so a hostile same-user rename racing the
 * final check and unlink is outside this guarantee.
 */
export class SessionArtifactStore {
  constructor(home) {
    if (typeof home !== 'string' || home.trim() === '') throw fail('An artifact home is required', 'ARTIFACTS_INVALID')
    this.home = resolve(home)
  }

  async run(create, absent, run) {
    // Reserve canonical queues in call order: asynchronous home checks must not
    // let cleanup overtake a save. Release admission once queued, so independent
    // homes can still perform their file operations concurrently.
    const admitted = admissions.then(async () => {
      const home = await homeOf(this.home, create)
      return { operation: home === null ? Promise.resolve().then(absent) : serialized(home, async () => {
        let paths
        try { paths = await layout(home, create) }
        catch (error) { if (!create && missing(error)) return absent(); throw error }
        return await run(paths)
      }) }
    })
    admissions = admitted.then(() => undefined, () => undefined)
    const { operation } = await admitted
    return await operation
  }

  async save(sessionId, name, data) {
    sessionIdOf(sessionId)
    nameOf(name)
    const bytes = typeof data === 'string' ? Buffer.from(data)
      : data instanceof Uint8Array ? Buffer.from(data)
        : data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : null
    if (bytes === null) throw fail('Artifact data must be text or binary bytes', 'ARTIFACTS_INVALID')
    return await this.run(true, () => undefined, async paths => {
      const ledger = await readLedger(paths, sessionId)
      if (ledger?.value.pending) throw fail('Artifact cleanup is pending for this session', 'ARTIFACTS_PENDING')
      const session = await childDirectory(paths.objects, sessionId, true)
      const id = randomBytes(16).toString('hex')
      const path = inside(session, join(session, `${id}-${name}`))
      let handle
      let entry
      let published = false
      try {
        await objectPath(paths, sessionId, { id, name })
        handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NOFOLLOW, 0o600)
        await handle.writeFile(bytes)
        await handle.sync()
        const info = await handle.stat({ bigint: true })
        regular(info)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        if (await digest(handle) !== sha256 || !same(snapshot(info), await handle.stat({ bigint: true }))) throw fail('New artifact changed during save')
        entry = { id, name, bytes: bytes.length, sha256, stat: snapshot(info) }
        await handle.close()
        handle = undefined
        await objectPath(paths, sessionId, entry)
        if (!same(entry.stat, await lstat(path, { bigint: true }))) throw fail('New artifact was replaced during save')
        await syncDirectory(session)
        await writeLedger(paths, {
          version: 1, sessionId, pending: false, entries: [...(ledger?.value.entries ?? []), entry],
        }, ledger?.stat ?? null, () => { published = true })
        return { id, sessionId, path, bytes: bytes.length }
      } catch (error) {
        await handle?.close()
        handle = undefined
        if (entry !== undefined && !published) {
          try { await removeEntry(paths, sessionId, entry) } catch { /* Preserve changed/unregistered files. */ }
        }
        throw error
      } finally { await handle?.close() }
    })
  }

  async has(sessionId) {
    sessionIdOf(sessionId)
    return await this.run(false, () => false, async paths => (await readLedger(paths, sessionId))?.value.entries.length > 0)
  }

  async markPending(sessionId) {
    return await this.setPending(sessionId, true)
  }

  async cancelPending(sessionId) {
    return await this.setPending(sessionId, false)
  }

  async setPending(sessionId, pending) {
    sessionIdOf(sessionId)
    return await this.run(false, () => undefined, async paths => {
      const ledger = await readLedger(paths, sessionId)
      if (ledger !== null && ledger.value.pending !== pending) {
        await writeLedger(paths, { ...ledger.value, pending }, ledger.stat)
      }
    })
  }

  /** Discover healthy pending inventories; report and retain unreadable ledgers individually. */
  async pending({ onError } = {}) {
    if (onError !== undefined && typeof onError !== 'function') {
      throw fail('onError must be a function', 'ARTIFACTS_INVALID')
    }
    return await this.run(false, () => [], async paths => {
      const result = []
      for (const file of (await readdir(paths.registry)).sort()) {
        if (!file.endsWith('.json')) continue
        const sessionId = file.slice(0, -5)
        try { sessionIdOf(sessionId) } catch { continue }
        try {
          const ledger = await readLedger(paths, sessionId)
          if (ledger?.value.pending) result.push({ sessionId, count: ledger.value.entries.length })
        } catch (error) {
          // A damaged or unsafe inventory must neither hide healthy sessions nor
          // be rewritten/deleted just because it cannot be read safely.
          onError?.({ sessionId, code: error?.code ?? 'ARTIFACTS_INVALID', reason: String(error?.message ?? error) })
        }
      }
      return result
    })
  }

  async cleanup(sessionId) {
    sessionIdOf(sessionId)
    return await this.run(false, emptyResult, async paths => {
      let ledger = await readLedger(paths, sessionId)
      if (ledger === null) return emptyResult()
      if (!ledger.value.pending) ledger = await writeLedger(paths, { ...ledger.value, pending: true }, ledger.stat)
      const result = emptyResult()
      const retained = []
      for (const entry of ledger.value.entries) {
        try {
          if (await removeEntry(paths, sessionId, entry)) {
            result.removed += 1
            result.bytes += entry.bytes
          }
        } catch (error) {
          retained.push(entry)
          result.failed.push({ id: entry.id, reason: String(error?.message ?? error) })
        }
      }
      result.retained = retained.length
      if (retained.length > 0) {
        await writeLedger(paths, { ...ledger.value, entries: retained }, ledger.stat)
      } else {
        const path = await expectLedger(paths, sessionId, ledger.stat)
        await unlink(path)
        await syncDirectory(paths.registry)
      }
      // Never recursively remove objects directories: unregistered files survive.
      return result
    })
  }
}
