/** Reference-aware collection of explicitly queued local upload objects. */
import { constants, unlinkSync } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import * as zlib from 'node:zlib'

const HASH = /^[a-f0-9]{64}$/
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const LOG = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const MAX_LEDGER = 16 * 1024 * 1024
const MAX_LINE = 64 * 1024 * 1024
const USE_GUARD = Symbol.for('dsh-session-backup.attachment-use.v1')
const queues = new Map()
const scope = new AsyncLocalStorage()
const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode']
const identity = info => fields.map(key => String(info[key])).join(':')
const missing = error => error?.code === 'ENOENT'
const keyOf = entry => `${entry.kind}:${entry.sha256}`
const empty = () => ({ removed: 0, bytes: 0, retained: 0, deferred: 0, failed: [] })
const fail = (message, code = 'ATTACHMENTS_UNSAFE') => Object.assign(new Error(message), { code })

function sessionOf(id) {
  if (typeof id !== 'string' || !SESSION.test(id) || id.endsWith('.')) throw fail('Invalid attachment-cleanup session id')
  return id
}

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw fail('Attachment path escapes its managed root')
  return target
}

async function infoOf(path) {
  try { return await lstat(path, { bigint: true }) }
  catch (error) { if (missing(error)) return null; throw error }
}

async function directory(path) {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw fail(`Unsafe directory: ${path}`)
  return info
}

async function checkedPath(home, path, allowMissing = false) {
  const root = resolve(home)
  const target = resolve(path)
  if (target !== root) inside(root, target)
  await directory(root)
  let current = root
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part)
    if (allowMissing && await infoOf(current) === null) return false
    await directory(current)
  }
  return true
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function managedDirectory(home, parts, create) {
  await directory(home)
  let parent = home
  for (const part of parts) {
    const path = inside(home, join(parent, part))
    if (create) {
      try { await mkdir(path, { mode: 0o700 }); await syncDirectory(parent) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const info = await directory(path)
    if ((info.mode & 0o077n) !== 0n || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))) {
      throw fail('Attachment-cleanup registry must be private and user-owned')
    }
    parent = path
  }
  return parent
}

/** Same-process backup mutations and reference scans share this reentrant home gate. */
export async function withAttachmentReferences(home, run) {
  const root = await realpath(resolve(home)).catch(error => { if (missing(error)) return resolve(home); throw error })
  if (scope.getStore()?.has(root)) return await run()
  const prior = queues.get(root) ?? Promise.resolve()
  const operation = prior.catch(() => {}).then(() => scope.run(new Set([...(scope.getStore() ?? []), root]), run))
  const settled = operation.catch(() => {})
  queues.set(root, settled)
  try { return await operation }
  finally { if (queues.get(root) === settled) queues.delete(root) }
}

/** Collect complete durable refs, including nested historical/request/tool records. */
export function attachmentRefs(value, target = new Map()) {
  const pending = [value]
  const seen = new Set()
  while (pending.length > 0) {
    const item = pending.pop()
    if (!item || typeof item !== 'object' || seen.has(item) || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) continue
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) continue
    seen.add(item)
    const digest = typeof item.attachmentId === 'string' ? item.attachmentId.slice(7) : ''
    if (item.attachmentId === `sha256:${digest}` && HASH.test(digest) && Number.isSafeInteger(item.bytes) && item.bytes >= 0) {
      const image = typeof item.mediaType === 'string' && item.mediaType.startsWith('image/')
        && Number.isSafeInteger(item.width) && item.width > 0 && Number.isSafeInteger(item.height) && item.height > 0
      if (image || typeof item.name === 'string') {
        const entry = { kind: image ? 'image' : 'file', sha256: digest, bytes: item.bytes }
        target.set(keyOf(entry), entry)
      }
    }
    for (const child of Object.values(item)) if (child && typeof child === 'object') pending.push(child)
  }
  return target
}

/**
 * Observe the existing backend from before this Web listener binds. New admissions
 * stay pinned for the backend lifetime: a staged upload need not have a log row.
 * The observer belongs to the backend, surviving this plugin's config reloads.
 * A hot first activation is intentionally unable to unlink anything until restart.
 */
export function observeAttachmentUse(ctx, home) {
  const store = ctx.get('attachments')
  if (!store || typeof store.root !== 'string' || resolve(store.root) !== resolve(home, 'attachments', 'v1')) {
    return { reason: 'A matching local attachment backend is required; uploaded files were retained', blocked: () => true }
  }
  let guard = store[USE_GUARD]
  if (guard) return guard
  const web = ctx.get('webServer')
  if (web == null || !('port' in web)) {
    return { reason: 'A standard single-Host Web listener is required for safe upload collection', blocked: () => true }
  }
  const probe = { attachmentId: `sha256:${'0'.repeat(64)}`, bytes: 0, name: 'probe' }
  if (typeof store.imageHostPath !== 'function' || typeof store.fileHostPath !== 'function'
      || store.imageHostPath({ ...probe, mediaType: 'image/png', width: 1, height: 1 }) !== join(store.root, 'objects', '00', '0'.repeat(64))
      || store.fileHostPath(probe) !== join(store.root, 'files', '00', '0'.repeat(64), 'probe')) {
    return { reason: 'The attachment backend does not use the supported local object layout', blocked: () => true }
  }
  const early = web.port === undefined
  guard = {
    active: 0, pins: new Set(), early,
    reason: early ? '' : 'Restart the Host before reclaiming uploads: the attachment observer was activated after startup',
    blocked(entry) { return !this.early || this.active > 0 || this.pins.has(keyOf(entry)) },
  }
  const pin = value => { for (const key of attachmentRefs(value).keys()) guard.pins.add(key) }
  // Only storage/admission methods are async. The native stream and host-path
  // entry points pin their input synchronously before returning unchanged values.
  for (const name of ['saveImage', 'saveImages', 'saveFile', 'saveFileStream', 'admitPromptContent', 'admitEncodedFile', 'admitEncodedImages', 'readImage', 'readImageRequest']) {
    if (typeof store[name] !== 'function') continue
    const original = store[name]
    const wrapper = async function (...args) {
      guard.active += 1
      pin(args)
      try { const value = await original.apply(this, args); pin(value); return value }
      finally { guard.active -= 1 }
    }
    Object.defineProperty(store, name, { configurable: true, writable: true, value: wrapper })
  }
  for (const name of ['readFileStream', 'imageHostPath', 'fileHostPath']) {
    if (typeof store[name] !== 'function') continue
    const original = store[name]
    const wrapper = function (...args) { pin(args); return original.apply(this, args) }
    Object.defineProperty(store, name, { configurable: true, writable: true, value: wrapper })
  }
  // A symbol lives on the underlying Cordis service, rather than a use-site
  // proxy. These transparent observers deliberately last as long as the backend:
  // removing them on this plugin's config reload would reopen an admission gap.
  // They delegate unchanged and never perform collection themselves.
  Object.defineProperty(store, USE_GUARD, { value: guard, configurable: false })
  return guard
}

async function scanLog(path, refs, stamps) {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw fail(`Unsafe session log: ${path}`)
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW)
  try {
    if (identity(before) !== identity(await handle.stat({ bigint: true }))) throw fail('Session log changed while opening')
    const decoder = new StringDecoder('utf8')
    let pending = ''
    const consume = text => {
      pending += text
      let cut
      while ((cut = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, cut)
        pending = pending.slice(cut + 1)
        if (line.length > MAX_LINE) throw fail('Session log record is too large to prove attachment references')
        if (line.trim() !== '') attachmentRefs(JSON.parse(line), refs)
      }
      if (pending.length > MAX_LINE) throw fail('Session log record is too large to prove attachment references')
    }
    const sink = async source => { for await (const bytes of source) consume(decoder.write(bytes)); consume(decoder.end()) }
    const source = handle.createReadStream({ autoClose: false })
    if (path.endsWith('.zstd')) {
      if (typeof zlib.createZstdDecompress !== 'function') throw fail('This Node runtime cannot inspect compressed session references')
      await pipeline(source, zlib.createZstdDecompress(), sink)
    } else await pipeline(source, sink)
    if (pending.trim() !== '') throw fail(`Incomplete session log retained: ${path}`)
    if (identity(before) !== identity(await handle.stat({ bigint: true }))) throw fail('Session log changed while reading')
    stamps.set(path, identity(before))
  } finally { await handle.close() }
}

async function scanTree(home, root, refs, stamps, { optional = true } = {}) {
  if (!(await checkedPath(home, root, optional))) return
  const pending = [root]
  let count = 0
  while (pending.length > 0) {
    if (++count > 250000) throw fail('Reference tree is too large to inspect safely')
    const path = pending.pop()
    const info = await directory(path)
    const entries = await readdir(path, { withFileTypes: true })
    stamps.set(path, identity(info))
    for (const entry of entries) {
      const child = inside(home, join(path, entry.name))
      if (entry.isSymbolicLink()) throw fail(`Linked reference tree retained: ${child}`)
      if (entry.isDirectory()) pending.push(child)
      else if (LOG.test(entry.name)) await scanLog(child, refs, stamps)
      else if (/^session.*\.jsonl(?:\.|$)/i.test(entry.name)) throw fail(`Unsupported session log encoding or generation retained: ${child}`)
    }
  }
}

async function unchanged(stamps) {
  for (const [path, expected] of stamps) {
    const info = await lstat(path, { bigint: true })
    if (identity(info) !== expected) throw fail('Session or backup references changed; retry cleanup when idle', 'ATTACHMENTS_REFERENCES_CHANGED')
  }
}

async function readLedger(home, registry, id) {
  const path = inside(registry, join(registry, `${sessionOf(id)}.json`))
  await checkedPath(home, registry)
  const info = await infoOf(path)
  if (info === null) return null
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(MAX_LEDGER)
      || (info.mode & 0o077n) !== 0n || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))) throw fail('Unsafe attachment-cleanup ledger')
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW)
  try {
    if (identity(info) !== identity(await handle.stat({ bigint: true }))) throw fail('Attachment ledger changed while opening')
    const value = JSON.parse(await handle.readFile('utf8'))
    if (identity(info) !== identity(await handle.stat({ bigint: true }))) throw fail('Attachment ledger changed while reading')
    if (value?.version !== 1 || value.sessionId !== id || !Array.isArray(value.entries)) throw fail('Invalid attachment-cleanup ledger')
    const keys = new Set()
    for (const entry of value.entries) {
      if (!['image', 'file'].includes(entry?.kind) || !HASH.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || keys.has(keyOf(entry))) throw fail('Invalid attachment-cleanup candidate')
      keys.add(keyOf(entry))
    }
    return { value, stamp: identity(info) }
  } finally { await handle.close() }
}

async function writeLedger(home, registry, value, expected) {
  const path = inside(registry, join(registry, `${sessionOf(value.sessionId)}.json`))
  const temporary = inside(registry, join(registry, `.${value.sessionId}-${randomBytes(16).toString('hex')}.tmp`))
  const text = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(text) > MAX_LEDGER) throw fail('Attachment-cleanup ledger is too large')
  await checkedPath(home, registry)
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600)
  try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
  await checkedPath(home, registry)
  const current = await infoOf(path)
  if ((current === null ? null : identity(current)) !== expected) throw fail('Attachment-cleanup ledger was replaced')
  await rename(temporary, path)
  await syncDirectory(registry)
}

async function verifiedObject(home, root, path, entry, canonical) {
  await checkedPath(home, dirname(path), true)
  const info = await infoOf(path)
  if (info === null) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size !== BigInt(entry.bytes)
      || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))) throw fail(`Changed or unsafe attachment retained: ${path}`)
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW)
  try {
    if (identity(info) !== identity(await handle.stat({ bigint: true }))) throw fail('Attachment changed while opening')
    const hash = createHash('sha256')
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes)
    if (hash.digest('hex') !== entry.sha256 || identity(info) !== identity(await handle.stat({ bigint: true }))) throw fail('Changed attachment content retained')
    if (canonical && entry.kind === 'image' && info.nlink !== 1n) throw fail('Image attachment has unexpected hard links')
    return { path, info, stamp: identity(info) }
  } finally { await handle.close() }
}

async function objectFiles(home, entry) {
  const root = join(home, 'attachments', 'v1')
  const digest = entry.sha256
  const base = join(root, entry.kind === 'image' ? 'objects' : 'file-objects', digest.slice(0, 2))
  const baseExists = await checkedPath(home, base, true)
  const main = baseExists ? await verifiedObject(home, root, join(base, digest), entry, true) : null
  const files = main ? [main] : []
  if (entry.kind === 'file') {
    const aliases = join(root, 'files', digest.slice(0, 2), digest)
    if (await checkedPath(home, aliases, true)) {
      for (const name of await readdir(aliases)) {
        const path = inside(aliases, join(aliases, name))
        const alias = await verifiedObject(home, root, path, entry, false)
        if (alias) files.push(alias)
      }
    }
    if (files.length > 0) {
      const first = files[0].info
      if (files.some(file => file.info.dev !== first.dev || file.info.ino !== first.ino || file.info.nlink !== BigInt(files.length))) {
        throw fail('File attachment has replaced aliases or links outside its managed object family')
      }
    }
  }
  return files
}

/** Candidates come only from a log explicitly being deleted, never a store-wide sweep. */
export class AttachmentCleanupStore {
  constructor(home, paths = {}) {
    this.home = resolve(home)
    this.sessions = paths.sessionsRoot ?? join(this.home, 'sessions')
    this.backups = paths.backupRoot ?? join(this.home, 'backups', 'sessions')
  }

  async registry(create = false) {
    try { return await managedDirectory(this.home, ['attachment-cleanup', 'registry'], create) }
    catch (error) { if (!create && missing(error)) return null; throw error }
  }

  async capture(sessionId, source) {
    sessionOf(sessionId)
    return await withAttachmentReferences(this.home, async () => {
      const refs = new Map()
      const stamps = new Map()
      await scanTree(this.home, source, refs, stamps, { optional: false })
      await unchanged(stamps)
      if (refs.size === 0) return 0
      const registry = await this.registry(true)
      const ledger = await readLedger(this.home, registry, sessionId)
      const entries = new Map((ledger?.value.entries ?? []).map(entry => [keyOf(entry), entry]))
      for (const [key, entry] of refs) entries.set(key, entry)
      await writeLedger(this.home, registry, { version: 1, sessionId, entries: [...entries.values()] }, ledger?.stamp ?? null)
      return entries.size
    })
  }

  async pending({ onError } = {}) {
    return await withAttachmentReferences(this.home, async () => {
      const registry = await this.registry()
      if (registry === null) return []
      const result = []
      for (const name of (await readdir(registry)).sort()) {
        if (!name.endsWith('.json') || !SESSION.test(name.slice(0, -5))) continue
        const sessionId = name.slice(0, -5)
        try {
          const ledger = await readLedger(this.home, registry, sessionId)
          if (ledger?.value.entries.length > 0) result.push({ sessionId, count: ledger.value.entries.length })
        } catch (error) { onError?.({ sessionId, code: error.code ?? 'ATTACHMENTS_INVALID', reason: String(error.message ?? error) }) }
      }
      return result
    })
  }

  async cleanup(sessionId, guard, prepareLive) {
    sessionOf(sessionId)
    return await withAttachmentReferences(this.home, async () => {
      const result = empty()
      const registry = await this.registry()
      if (registry === null) return result
      const ledger = await readLedger(this.home, registry, sessionId)
      if (!ledger?.value.entries.length) return result
      const retained = []
      const refs = new Map()
      const stamps = new Map()
      let checkLive = () => {}
      try {
        if (prepareLive) checkLive = await prepareLive()
        await scanTree(this.home, this.sessions, refs, stamps)
        await scanTree(this.home, this.backups, refs, stamps)
        await unchanged(stamps)
      } catch (error) {
        return { ...result, retained: ledger.value.entries.length, failed: [{ id: sessionId, code: error.code ?? 'ATTACHMENTS_REFERENCES_UNREADABLE', reason: String(error.message ?? error) }] }
      }
      for (const entry of ledger.value.entries) {
        const key = keyOf(entry)
        if (refs.has(key)) { retained.push(entry); continue }
        if (!guard || guard.blocked(entry)) {
          retained.push(entry)
          if (guard?.early === false) {
            // A hot first activation is expected protection, not a failed unlink.
            // Keep this as a subset of deferred for older result consumers.
            result.deferred += 1
            result.restartRequired = (result.restartRequired ?? 0) + 1
          } else if (guard?.reason) {
            result.failed.push({ id: key, code: 'ATTACHMENTS_OBSERVER_UNAVAILABLE', reason: guard.reason })
          } else result.deferred += 1
          continue
        }
        try {
          const files = await objectFiles(this.home, entry)
          await unchanged(stamps)
          for (const file of files) {
            await checkedPath(this.home, dirname(file.path))
            if (file.stamp !== identity(await lstat(file.path, { bigint: true }))) throw fail('Attachment changed before collection')
          }
          // No await between the final in-flight/pin check and unlinking this
          // entire hard-link family. An admission starts synchronously and pins
          // before completing, so it cannot fall into this critical section.
          checkLive()
          if (guard.blocked(entry)) { retained.push(entry); result.deferred += 1; continue }
          for (const file of files.slice().reverse()) unlinkSync(file.path)
          if (files.length > 0) { result.removed += 1; result.bytes += entry.bytes }
          for (const parent of new Set(files.map(file => dirname(file.path)))) await syncDirectory(parent)
        } catch (error) {
          retained.push(entry)
          result.failed.push({ id: key, code: error.code ?? 'ATTACHMENTS_CLEANUP_FAILED', reason: String(error.message ?? error) })
        }
      }
      result.retained = retained.length
      try {
        if (retained.length > 0) {
          await writeLedger(this.home, registry, { ...ledger.value, entries: retained }, ledger.stamp)
        } else {
          await checkedPath(this.home, registry)
          const path = inside(registry, join(registry, `${sessionId}.json`))
          if (identity(await lstat(path, { bigint: true })) !== ledger.stamp) throw fail('Attachment ledger changed before removal')
          await unlink(path)
          await syncDirectory(registry)
        }
      } catch (error) {
        // Unlinks already happened. A ledger/durability error must not erase the
        // actual reclaimed count; any older candidates are safe to retry.
        result.failed.push({ id: sessionId, code: error.code ?? 'ATTACHMENTS_LEDGER_UPDATE_FAILED', reason: String(error.message ?? error) })
      }
      return result
    })
  }
}
