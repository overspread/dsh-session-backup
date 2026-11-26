/** Real filesystem coverage; no Harness, live sessions, network, or dependencies. */
import assert from 'node:assert/strict'
import { appendFile, chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { SessionArtifactStore } from '../artifacts.js'

const blank = { removed: 0, bytes: 0, retained: 0, failed: [] }
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
const ledgerPath = (home, id) => join(home, 'session-artifacts', 'registry', `${id}.json`)

async function fixture(run) {
  const parent = await realpath(tmpdir())
  const home = await mkdtemp(join(parent, 'dsh-session-artifacts-test-'))
  try { await run({ home, store: new SessionArtifactStore(home) }) }
  finally {
    const target = resolve(home)
    const rel = relative(parent, target)
    assert.equal(dirname(target), parent)
    assert.ok(rel.startsWith('dsh-session-artifacts-test-') && !rel.includes(sep) && !isAbsolute(rel))
    assert.equal((await lstat(target)).isSymbolicLink(), false)
    await rm(target, { recursive: true, force: true })
  }
}

async function failures(store, sessionId, ids) {
  const result = await store.cleanup(sessionId)
  assert.equal(result.retained, ids.length)
  assert.deepEqual(result.failed.map(entry => entry.id).sort(), [...ids].sort())
  assert.ok(result.failed.every(entry => typeof entry.reason === 'string' && entry.reason.length > 0))
  return result
}

test('absent registry stays absent and all operations validate session ids', () => fixture(async ({ home, store }) => {
  assert.equal(await store.has('session-a'), false)
  assert.deepEqual(await store.pending(), [])
  assert.deepEqual(await store.cleanup('session-a'), blank)
  await store.markPending('session-a')
  await store.cancelPending('session-a')
  assert.deepEqual(await readdir(home), [])
  for (const id of ['..', '.', '', '../outside', '/outside', 'bad/id', 'bad\\id', 'bad\0id', 'a'.repeat(129), 'CON', 'bad.']) {
    for (const method of ['has', 'cleanup', 'markPending', 'cancelPending']) {
      await assert.rejects(store[method](id), { code: 'ARTIFACTS_INVALID' })
    }
    await assert.rejects(store.save(id, 'file.png', 'x'), { code: 'ARTIFACTS_INVALID' })
  }
  for (const name of ['..', '', '../screen.png', '/screen.png', 'screen\\shot', 'screen\0shot', 'x:y', 'x.', 'x ', 'a'.repeat(181)]) {
    await assert.rejects(store.save('session-a', name, 'x'), { code: 'ARTIFACTS_INVALID' })
  }
  await assert.rejects(store.save('session-a', 'file', { bytes: 'pretend' }), { code: 'ARTIFACTS_INVALID' })
  assert.deepEqual(await readdir(home), [])
}))

test('binary content, private writes, restart ownership, and isolation from workspace/unregistered files', () => fixture(async ({ home, store }) => {
  const buffer = Buffer.from([0, 255, 1, 128, 13, 10, 0, 77])
  const a = await store.save('session-a', '截屏 one.png', buffer)
  const b = await store.save('session-b', 'draft.bin', new Uint8Array([9, 8, 7]))
  const c = await store.save('session-a', 'empty.bin', new ArrayBuffer(0))
  assert.deepEqual(Object.keys(a).sort(), ['id', 'sessionId', 'path', 'bytes'].sort())
  assert.equal(a.sessionId, 'session-a')
  assert.match(a.id, /^[a-f0-9]{32}$/)
  assert.equal(a.bytes, buffer.length)
  assert.equal(dirname(a.path), join(home, 'session-artifacts', 'objects', 'session-a'))
  assert.deepEqual(await readFile(a.path), buffer)
  assert.equal(c.bytes, 0)
  assert.equal(await store.has('session-a'), true)
  assert.deepEqual(await store.pending(), [])
  if (process.platform !== 'win32') {
    assert.equal((await lstat(a.path)).mode & 0o777, 0o600)
    for (const path of [dirname(a.path), dirname(dirname(a.path)), join(home, 'session-artifacts'), join(home, 'session-artifacts', 'registry')]) {
      assert.equal((await lstat(path)).mode & 0o777, 0o700)
    }
  }
  const unregistered = join(dirname(a.path), 'unregistered.png')
  const workspace = join(home, 'workspace.png')
  await writeFile(unregistered, 'not allocated by save')
  await writeFile(workspace, 'user file')
  const restarted = new SessionArtifactStore(join(home, '.'))
  const result = await restarted.cleanup('session-a')
  assert.deepEqual(result, { removed: 2, bytes: buffer.length, retained: 0, failed: [] })
  assert.equal(await exists(a.path), false)
  assert.equal(await exists(c.path), false)
  assert.equal(await restarted.has('session-a'), false)
  assert.equal(await exists(ledgerPath(home, 'session-a')), false)
  assert.equal(await restarted.has('session-b'), true)
  assert.equal(await readFile(b.path, 'hex'), '090807')
  assert.equal(await readFile(unregistered, 'utf8'), 'not allocated by save')
  assert.equal(await readFile(workspace, 'utf8'), 'user file')
  assert.deepEqual(await restarted.cleanup('session-a'), blank)
}))

test('modified, byte-identically replaced, symlinked, and hardlinked files remain pending after restart', () => fixture(async ({ home, store }) => {
  const modified = await store.save('session-a', 'modified', 'original')
  const replaced = await store.save('session-a', 'replaced', 'same')
  const linked = await store.save('session-a', 'hardlink', 'hardlink data')
  const symbolic = await store.save('session-a', 'symlink', 'symlink data')
  const good = await store.save('session-a', 'ordinary', 'removable')
  await writeFile(modified.path, 'modified')
  const replacement = join(home, 'replacement')
  await copyFile(replaced.path, replacement)
  await chmod(replacement, 0o600)
  await rename(replacement, replaced.path)
  const hardlink = join(home, 'another-link')
  await link(linked.path, hardlink)
  const moved = join(home, 'moved-original')
  await rename(symbolic.path, moved)
  await symlink(moved, symbolic.path)
  const ids = [modified.id, replaced.id, linked.id, symbolic.id]
  const result = await failures(store, 'session-a', ids)
  assert.equal(result.removed, 1)
  assert.equal(result.bytes, good.bytes)
  assert.equal(await exists(good.path), false)
  assert.equal(await readFile(modified.path, 'utf8'), 'modified')
  assert.equal(await readFile(replaced.path, 'utf8'), 'same')
  assert.equal(await readFile(hardlink, 'utf8'), 'hardlink data')
  assert.equal((await lstat(symbolic.path)).isSymbolicLink(), true)
  assert.deepEqual(await new SessionArtifactStore(home).pending(), [{ sessionId: 'session-a', count: 4 }])
  const again = await failures(new SessionArtifactStore(home), 'session-a', ids)
  assert.equal(again.removed, 0)
  assert.equal(again.bytes, 0)
}))

test('same-byte rewrite is still a modification and retained', () => fixture(async ({ store }) => {
  const artifact = await store.save('session-a', 'unchanged-bytes', 'original')
  const old = await lstat(artifact.path, { bigint: true })
  // A normal append changes the identity revision even when bytes are restored.
  await appendFile(artifact.path, 'temporary change')
  await writeFile(artifact.path, 'original')
  const now = await lstat(artifact.path, { bigint: true })
  assert.ok(now.ctimeNs !== old.ctimeNs || now.mtimeNs !== old.mtimeNs)
  await failures(store, 'session-a', [artifact.id])
  assert.equal(await readFile(artifact.path, 'utf8'), 'original')
}))

test('symlinked object ancestor is retained and clearing the ancestor permits a restart retry', () => fixture(async ({ home, store }) => {
  const artifact = await store.save('session-a', 'screen.png', 'owned')
  const session = dirname(artifact.path)
  const held = join(home, 'held-session')
  const foreign = join(home, 'foreign')
  await mkdir(foreign)
  const foreignFile = join(foreign, basename(artifact.path))
  await writeFile(foreignFile, 'user file')
  await rename(session, held)
  await symlink(foreign, session)
  const first = await failures(store, 'session-a', [artifact.id])
  assert.equal(first.removed, 0)
  assert.equal(await readFile(foreignFile, 'utf8'), 'user file')
  assert.deepEqual(await new SessionArtifactStore(home).pending(), [{ sessionId: 'session-a', count: 1 }])
  await unlink(session)
  await rename(held, session)
  const retried = await new SessionArtifactStore(home).cleanup('session-a')
  assert.deepEqual(retried, { removed: 1, bytes: artifact.bytes, retained: 0, failed: [] })
  assert.equal(await readFile(foreignFile, 'utf8'), 'user file')
  assert.deepEqual(await store.pending(), [])
}))

test('all managed ancestor symlinks and an explicit symlink home are rejected', () => fixture(async ({ home, store }) => {
  const target = join(home, 'foreign')
  await mkdir(target)
  const alias = join(home, 'alias')
  await symlink(target, alias)
  await assert.rejects(new SessionArtifactStore(alias).save('session-a', 'x', 'x'), { code: 'ARTIFACTS_UNSAFE' })
  for (const part of ['session-artifacts', 'objects', 'registry']) {
    const ownHome = join(home, `case-${part}`)
    await mkdir(ownHome, { mode: 0o700 })
    const root = join(ownHome, 'session-artifacts')
    if (part !== 'session-artifacts') await mkdir(root, { mode: 0o700 })
    const symlinkPath = part === 'session-artifacts' ? root : join(root, part)
    await symlink(target, symlinkPath)
    await assert.rejects(new SessionArtifactStore(ownHome).save('session-a', 'x', 'x'), { code: 'ARTIFACTS_UNSAFE' })
    assert.deepEqual(await readdir(target), [])
  }
}))

test('ledger symlink and forged escaping entry fail closed without touching foreign files', () => fixture(async ({ home, store }) => {
  const artifact = await store.save('session-a', 'safe', 'owned')
  const path = ledgerPath(home, 'session-a')
  const original = await readFile(path, 'utf8')
  const foreign = join(home, 'user.json')
  await writeFile(foreign, original, { mode: 0o600 })
  await unlink(path)
  await symlink(foreign, path)
  await assert.rejects(store.cleanup('session-a'), { code: 'ARTIFACTS_UNSAFE' })
  assert.equal(await readFile(foreign, 'utf8'), original)
  assert.equal(await readFile(artifact.path, 'utf8'), 'owned')
  await unlink(path)
  const malformed = JSON.parse(original)
  malformed.entries[0].name = '../../user.json'
  await writeFile(path, JSON.stringify(malformed), { mode: 0o600 })
  await assert.rejects(store.cleanup('session-a'), { code: 'ARTIFACTS_INVALID' })
  assert.equal(await readFile(foreign, 'utf8'), original)
  assert.equal(await readFile(artifact.path, 'utf8'), 'owned')
}))

test('pending intent persists, blocks new saves, cancels without losing entries, and tolerates absent files', () => fixture(async ({ home, store }) => {
  const artifact = await store.save('session-a', 'safe', 'owned')
  await store.markPending('session-a')
  const marked = await readFile(ledgerPath(home, 'session-a'), 'utf8')
  await store.markPending('session-a')
  assert.equal(await readFile(ledgerPath(home, 'session-a'), 'utf8'), marked)
  const restarted = new SessionArtifactStore(home)
  assert.deepEqual(await restarted.pending(), [{ sessionId: 'session-a', count: 1 }])
  await assert.rejects(restarted.save('session-a', 'next', 'x'), { code: 'ARTIFACTS_PENDING' })
  assert.equal(await exists(artifact.path), true)
  await restarted.cancelPending('session-a')
  await restarted.cancelPending('session-a')
  assert.deepEqual(await restarted.pending(), [])
  assert.equal(await restarted.has('session-a'), true)
  const next = await restarted.save('session-a', 'next', 'next')
  await restarted.markPending('session-a')
  await unlink(artifact.path) // Emulate a crash after this file was unlinked, before ledger publication.
  const result = await new SessionArtifactStore(home).cleanup('session-a')
  assert.deepEqual(result, { removed: 1, bytes: next.bytes, retained: 0, failed: [] })
  assert.deepEqual(await restarted.pending(), [])
  assert.equal(await restarted.has('session-a'), false)
  assert.equal(await exists(ledgerPath(home, 'session-a')), false)
}))

test('pending zero-entry crash intent is visible and can be finalized', () => fixture(async ({ home, store }) => {
  const artifact = await store.save('session-a', 'safe', 'owned')
  await store.markPending('session-a')
  await unlink(artifact.path)
  const path = ledgerPath(home, 'session-a')
  const ledger = JSON.parse(await readFile(path, 'utf8'))
  ledger.entries = []
  await writeFile(path, JSON.stringify(ledger), { mode: 0o600 })
  assert.deepEqual(await new SessionArtifactStore(home).pending(), [{ sessionId: 'session-a', count: 0 }])
  assert.deepEqual(await store.cleanup('session-a'), blank)
  assert.equal(await exists(path), false)
}))

test('concurrent stores serialize saves and cleanup without losing ownership or crossing sessions', () => fixture(async ({ home, store }) => {
  const another = new SessionArtifactStore(join(home, '.'))
  const saved = await Promise.all(Array.from({ length: 24 }, (_, n) => (n % 2 ? store : another).save('session-a', 'same-name.bin', Buffer.from([n, 0, 255]))))
  assert.equal(new Set(saved.map(entry => entry.path)).size, 24)
  assert.equal(JSON.parse(await readFile(ledgerPath(home, 'session-a'), 'utf8')).entries.length, 24)
  const peer = await another.save('session-b', 'peer', 'other owner')
  const results = await Promise.all([store.cleanup('session-a'), another.cleanup('session-a'), store.cleanup('session-a')])
  assert.equal(results.reduce((count, value) => count + value.removed, 0), 24)
  assert.equal(results.reduce((count, value) => count + value.bytes, 0), 72)
  assert.ok(results.every(value => value.retained === 0 && value.failed.length === 0))
  assert.equal(await readFile(peer.path, 'utf8'), 'other owner')
  const more = Array.from({ length: 10 }, (_, n) => another.save('session-c', `item-${n}`, 'c'))
  const cleanup = store.cleanup('session-c')
  const [created, deleted] = await Promise.all([Promise.all(more), cleanup])
  assert.equal(deleted.removed, 10)
  assert.equal(await store.has('session-c'), false)
  assert.equal((await Promise.all(created.map(value => exists(value.path)))).some(Boolean), false)
}))
