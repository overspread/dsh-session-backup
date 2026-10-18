import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  assertInside,
  assertSessionId,
  backupRoot,
  createBackup,
  isoFromStamp,
  listBackups,
  locateSessionDir,
  readSessionTitle,
  reattachRestoredSession,
  removeBackup,
  restoreBackup,
  sanitizeTitle,
  sessionsRoot,
  timestamp,
} from '../index.js'

/** A ctx with no optional services: titles fall back and nothing flushes. */
const bareCtx = { get: () => undefined }

const temps = []
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true })
})

/** Fresh `$DSH_HOME`-shaped tree: `<home>/sessions`, plus `<home>/backups`. */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-backup-'))
  temps.push(home)
  await mkdir(sessionsRoot(home), { recursive: true })
  await mkdir(backupRoot(home), { recursive: true })
  return { home, sessions: sessionsRoot(home), backups: backupRoot(home) }
}

/** Write one stored session in the layout the Harness uses on disk. */
async function storeSession(sessions, sessionId, files = { 'session.v4.jsonl.zstd': 'log-bytes' }) {
  const dir = join(sessions, 'Users-example-project', sessionId)
  await mkdir(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body, 'utf8')
  return dir
}

describe('session-backup: naming', () => {
  it('turns a title into one path-safe fragment', () => {
    assert.equal(sanitizeTitle('Fix 深度研究/报错'), 'Fix 深度研究 报错')
    assert.equal(sanitizeTitle('  spaced   out  '), 'spaced out')
    assert.equal(sanitizeTitle('a:b*c?d"e<f>g|h'), 'a b c d e f g h')
    assert.equal(sanitizeTitle('line\nbreak\u0000nul'), 'line break nul')
  })

  it('falls back when nothing usable remains', () => {
    assert.equal(sanitizeTitle(''), 'untitled')
    assert.equal(sanitizeTitle('   '), 'untitled')
    assert.equal(sanitizeTitle('.'), 'untitled')
    assert.equal(sanitizeTitle('..'), 'untitled')
    assert.equal(sanitizeTitle(undefined), 'untitled')
    assert.equal(sanitizeTitle('/\\:*?"<>|'), 'untitled')
  })

  it('caps the fragment so the directory name stays inside one dirent', () => {
    assert.equal([...sanitizeTitle('长'.repeat(200))].length, 48)
    assert.ok(sanitizeTitle('x'.repeat(200)).length <= 48)
  })

  it('never leaves a fragment that could climb or hide', () => {
    const fragment = sanitizeTitle('../../etc/passwd')
    assert.equal(fragment.includes('/'), false)
    assert.notEqual(fragment, '.')
    assert.notEqual(fragment, '..')
  })

  it('stamps in local time and reads its own stamps back', () => {
    const at = new Date(2026, 9, 17, 8, 5, 3)
    assert.equal(timestamp(at), '20261017-080503')
    assert.equal(isoFromStamp('20261017-080503'), at.toISOString())
    assert.equal(isoFromStamp('nonsense'), undefined)
  })
})

describe('session-backup: inbound guards', () => {
  it('accepts uuid-shaped session ids', () => {
    const uuid = '088bdbf8-4e32-4d95-83f9-03c13df7cce0'
    assert.equal(assertSessionId(uuid), uuid)
    const prefixed = 'session-061d6fab-0000-4000-8000-000000000000'
    assert.equal(assertSessionId(prefixed), prefixed)
  })

  it('rejects anything that could reach outside a directory', () => {
    for (const bad of ['../escape', 'a/b', '..', '', 'a b', 'x'.repeat(200), null, 42]) {
      assert.throws(
        () => assertSessionId(bad),
        (error) => error.code === 'session-backup/bad-request',
        `accepted ${JSON.stringify(bad)}`,
      )
    }
  })

  it('keeps paths inside their root', async () => {
    const { backups } = await fixture()
    assert.equal(assertInside(backups, join(backups, 'abc', 'dir'), 'backup path'), join(backups, 'abc', 'dir'))
    for (const bad of [backups, join(backups, '..'), join(backups, '..', 'elsewhere'), '/etc']) {
      assert.throws(() => assertInside(backups, bad, 'backup path'), (error) => error.code === 'session-backup/bad-request')
    }
  })
})

describe('session-backup: locating a session directory', () => {
  it('probes the unknown project segment', async () => {
    const { sessions } = await fixture()
    const dir = await storeSession(sessions, 'sid-1')
    assert.equal(await locateSessionDir('sid-1', sessions), dir)
    assert.equal(await locateSessionDir('sid-missing', sessions), undefined)
  })

  it('answers undefined when the store itself is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-session-backup-'))
    temps.push(home)
    assert.equal(await locateSessionDir('sid-1', sessionsRoot(home)), undefined)
  })
})

describe('session-backup: createBackup', () => {
  it('copies the session directory under <stamp>-<title> with a manifest', async () => {
    const { home, sessions, backups } = await fixture()
    const source = await storeSession(sessions, 'sid-2', {
      'session.v4.jsonl.zstd': 'committed-log',
      'session.lock': 'lease',
      '.DS_Store': 'cruft',
    })
    const backup = await createBackup(bareCtx, 'sid-2', {
      home,
      title: '修复 深度研究 报错',
      stamp: '20261017-090000',
    })

    assert.equal(backup.sessionId, 'sid-2')
    assert.equal(backup.title, '修复 深度研究 报错')
    assert.equal(backup.dirName, '20261017-090000-修复 深度研究 报错')
    assert.equal(backup.path, join(backups, 'sid-2', backup.dirName))
    assert.equal(backup.sourcePath, source)
    assert.equal(backup.consistent, true)
    assert.deepEqual(backup.inconsistent, [])
    assert.equal(await readFile(join(backup.path, 'session.v4.jsonl.zstd'), 'utf8'), 'committed-log')

    const entries = await readdir(backup.path)
    assert.equal(entries.includes('session.lock'), false, 'lease file was copied')
    assert.equal(entries.includes('.DS_Store'), false, 'cruft was copied')
    assert.equal(entries.includes('backup.json'), true)

    const manifest = JSON.parse(await readFile(join(backup.path, 'backup.json'), 'utf8'))
    assert.equal(manifest.sessionId, 'sid-2')
    assert.equal(manifest.title, '修复 深度研究 报错')
    assert.equal(manifest.version, 1)
    assert.equal(manifest.bytes, 'committed-log'.length)
  })

  it('reads the title through sessionQuery when no title is supplied', async () => {
    const { home, sessions } = await fixture()
    await storeSession(sessions, 'sid-3')
    const ctx = { get: (key) => (key === 'sessionQuery' ? { readTitle: async () => '来自服务的标题' } : undefined) }
    const backup = await createBackup(ctx, 'sid-3', { home })
    assert.equal(backup.title, '来自服务的标题')
    assert.match(backup.dirName, /-来自服务的标题$/)
  })

  it('falls back to untitled when nothing can supply a title', async () => {
    const { home, sessions } = await fixture()
    await storeSession(sessions, 'sid-4')
    const backup = await createBackup(bareCtx, 'sid-4', { home })
    assert.equal(backup.title, 'untitled')
    assert.match(backup.dirName, /-untitled$/)
  })

  it('keeps two same-second backups apart', async () => {
    const { home, sessions } = await fixture()
    await storeSession(sessions, 'sid-5')
    const first = await createBackup(bareCtx, 'sid-5', { home, title: '同名', stamp: '20261017-090000' })
    const second = await createBackup(bareCtx, 'sid-5', { home, title: '同名', stamp: '20261017-090000' })
    const third = await createBackup(bareCtx, 'sid-5', { home, title: '同名', stamp: '20261017-090000' })
    assert.notEqual(first.path, second.path)
    assert.equal(second.dirName, '20261017-090000-同名-1')
    assert.equal(third.dirName, '20261017-090000-同名-2')
    assert.equal((await readdir(join(home, 'backups', 'sessions', 'sid-5'))).length, 3)
  })

  it('refuses a session that is not stored', async () => {
    const { home } = await fixture()
    await assert.rejects(
      () => createBackup(bareCtx, 'sid-absent', { home }),
      (error) => error.code === 'session-backup/not-found' && error.status === 404,
    )
  })

  it('refuses an id that could escape the store', async () => {
    const { home, sessions } = await fixture()
    await storeSession(sessions, 'sid-6')
    await assert.rejects(
      () => createBackup(bareCtx, '../sid-6', { home }),
      (error) => error.code === 'session-backup/bad-request' && error.status === 400,
    )
  })
})

describe('session-backup: listBackups', () => {
  it('is empty for a missing or unused store', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-session-backup-'))
    temps.push(home)
    assert.deepEqual(await listBackups(backupRoot(home)), [])
    const { backups } = await fixture()
    assert.deepEqual(await listBackups(backups), [])
  })

  it('lists every backup newest first with its size', async () => {
    const { home, sessions } = await fixture()
    await storeSession(sessions, 'sid-7', { 'session.v4.jsonl.zstd': 'first' })
    const older = await createBackup(bareCtx, 'sid-7', { home, title: '旧的', stamp: '20261017-090000' })
    await storeSession(sessions, 'sid-7', { 'session.v4.jsonl.zstd': 'second-longer' })
    const newer = await createBackup(bareCtx, 'sid-7', { home, title: '新的', stamp: '20261018-090000' })

    const listed = await listBackups(backupRoot(home))
    assert.equal(listed.length, 2)
    assert.equal(listed[0].path, newer.path)
    assert.equal(listed[0].title, '新的')
    assert.equal(listed[1].path, older.path)
    assert.equal(listed[0].bytes, 'second-longer'.length)
    assert.equal(listed[0].restorable, true)
    assert.equal(listed[0].sessionId, 'sid-7')
    assert.equal(listed[0].files, 1)
  })

  it('lists a manifest-less directory as not restorable instead of crashing', async () => {
    const { backups } = await fixture()
    const orphan = join(backups, 'sid-orph', '20261017-090000-manual')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'session.v4.jsonl.zstd'), 'x', 'utf8')
    const listed = await listBackups(backups)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].restorable, false)
    assert.equal(listed[0].sessionId, 'sid-orph')
    assert.equal(listed[0].createdAt, isoFromStamp('20261017-090000'))
  })
})

describe('session-backup: restoreBackup', () => {
  it('copies a backup back to its original directory', async () => {
    const { home, sessions } = await fixture()
    const source = await storeSession(sessions, 'sid-8', { 'session.v4.jsonl.zstd': 'keep me' })
    const backup = await createBackup(bareCtx, 'sid-8', { home, title: '恢复测试', stamp: '20261017-090000' })
    await rm(source, { recursive: true, force: true })

    const restored = await restoreBackup(backup.path, { home })
    assert.equal(restored.sessionId, 'sid-8')
    assert.equal(restored.title, '恢复测试')
    assert.equal(restored.target, source)
    assert.equal(await readFile(join(source, 'session.v4.jsonl.zstd'), 'utf8'), 'keep me')
    assert.equal((await readdir(source)).includes('backup.json'), false, 'manifest was restored into the session')
  })

  it('refuses to overwrite a session that exists again', async () => {
    const { home, sessions } = await fixture()
    await storeSession(sessions, 'sid-9')
    const backup = await createBackup(bareCtx, 'sid-9', { home, title: 'again' })
    await assert.rejects(
      () => restoreBackup(backup.path, { home }),
      (error) => error.code === 'session-backup/conflict' && error.status === 409,
    )
  })

  it('refuses a path outside the backup store and a backup without a manifest', async () => {
    const { home, backups } = await fixture()
    const orphan = join(backups, 'sid-orph', '20261017-090000-manual')
    await mkdir(orphan, { recursive: true })
    await assert.rejects(() => restoreBackup(orphan, { home }), (error) => error.code === 'session-backup/bad-request')
    await assert.rejects(
      () => restoreBackup(join(backups, '..', 'elsewhere'), { home }),
      (error) => error.code === 'session-backup/bad-request',
    )
  })
})

describe('session-backup: readSessionTitle', () => {
  it('reads a bare string title', async () => {
    const ctx = { get: () => ({ readTitle: async () => '网站技术栈识别' }) }
    assert.equal(await readSessionTitle(ctx, 'sid-t'), '网站技术栈识别')
  })

  it('unwraps the title snapshot the title provider actually returns', async () => {
    // `session-title-first-prompt-llm` answers with a record, not a bare string.
    const ctx = {
      get: () => ({
        readTitle: async () => ({
          title: '一、结构性：reader_page.dart 3500',
          messageSeqs: [9],
          source: { kind: 'provider', provider: 'session-title-first-prompt-llm' },
          eventSeq: 22,
        }),
      }),
    }
    assert.equal(await readSessionTitle(ctx, 'sid-t'), '一、结构性：reader_page.dart 3500')
  })

  it('reports nothing for a missing service, an empty title, or a throwing service', async () => {
    assert.equal(await readSessionTitle({ get: () => undefined }, 'sid-t'), undefined)
    assert.equal(await readSessionTitle({ get: () => ({ readTitle: async () => '   ' }) }, 'sid-t'), undefined)
    assert.equal(await readSessionTitle({ get: () => ({ readTitle: async () => { throw new Error('nope') } }) }, 'sid-t'), undefined)
    assert.equal(await readSessionTitle({ get: () => ({ readTitle: async () => ({}) }) }, 'sid-t'), undefined)
  })
})

describe('session-backup: restoreBackup re-attaches the session to its workspace', () => {
  /** A workspace whose `attachSession` records what it was asked to attach. */
  function fakeWorkspace(path, id = 'ws-1', attachSession = async () => {}) {
    return { id, path, attachSession }
  }

  it('attaches the restored session to the workspace whose path is the header cwd', async () => {
    const { home, sessions } = await fixture()
    const source = await storeSession(sessions, 'sid-a')
    const backup = await createBackup(bareCtx, 'sid-a', { home, title: '挂回工作区' })
    await rm(source, { recursive: true, force: true })

    const attached = []
    const workspace = fakeWorkspace(dirname(source), 'ws-1', async (id) => { attached.push(id) })
    const registry = {
      readSessionHeader: async () => ({ id: 'sid-a', cwd: dirname(source) }),
      list: () => [workspace],
    }

    const restored = await restoreBackup(backup.path, { home, registry })
    assert.equal(restored.attached, true)
    assert.equal(restored.workspaceId, 'ws-1')
    assert.deepEqual(attached, ['sid-a'])
    assert.equal(await readFile(join(source, 'session.v4.jsonl.zstd'), 'utf8'), 'log-bytes')
  })

  it('matches a workspace path through its symlink, the way attachSession resolves it', async () => {
    const { home, sessions } = await fixture()
    const source = await storeSession(sessions, 'sid-sym')
    const backup = await createBackup(bareCtx, 'sid-sym', { home })
    await rm(source, { recursive: true, force: true })

    const alias = join(dirname(dirname(source)), 'alias-dir')
    await symlink(dirname(source), alias)
    const attached = []
    const registry = {
      readSessionHeader: async () => ({ id: 'sid-sym', cwd: alias }),
      list: () => [fakeWorkspace(dirname(source), 'ws-sym', async (id) => { attached.push(id) })],
    }

    const restored = await restoreBackup(backup.path, { home, registry })
    assert.equal(restored.attached, true, restored.reason ?? '')
    assert.deepEqual(attached, ['sid-sym'])
  })

  it('reports "not attached" for a missing registry, an unreadable header, an unknown cwd, or a failing attach', async () => {
    const { home, sessions } = await fixture()
    const source = await storeSession(sessions, 'sid-b')
    const backup = await createBackup(bareCtx, 'sid-b', { home, title: '为何未挂回' })
    await rm(source, { recursive: true, force: true })

    const withoutRegistry = await restoreBackup(backup.path, { home })
    assert.equal(withoutRegistry.attached, false)
    assert.match(withoutRegistry.reason, /no workspace registry/)
    await rm(withoutRegistry.target, { recursive: true, force: true })

    const unreadable = await restoreBackup(backup.path, {
      home,
      registry: { readSessionHeader: async () => { throw new Error('persistence holds no such session') }, list: () => [] },
    })
    assert.equal(unreadable.attached, false)
    assert.match(unreadable.reason, /no readable header/)
    await rm(unreadable.target, { recursive: true, force: true })

    const elsewhere = await restoreBackup(backup.path, {
      home,
      registry: { readSessionHeader: async () => ({ cwd: '/somewhere/else' }), list: () => [fakeWorkspace('/not/it')] },
    })
    assert.equal(elsewhere.attached, false)
    assert.match(elsewhere.reason, /no workspace has cwd/)
    await rm(elsewhere.target, { recursive: true, force: true })

    const failing = await restoreBackup(backup.path, {
      home,
      registry: {
        readSessionHeader: async () => ({ cwd: dirname(source) }),
        list: () => [fakeWorkspace(dirname(source), 'ws-b', async () => { throw new Error('its cwd does not resolve') })],
      },
    })
    assert.equal(failing.attached, false, 'a failing attach must not fail the restore')
    assert.match(failing.reason, /does not resolve/)
    assert.equal(await readFile(join(failing.target, 'session.v4.jsonl.zstd'), 'utf8'), 'log-bytes', 'the files are restored anyway')
  })

  it('refuses a header with no cwd and leaves the registry service optional', async () => {
    const result = await reattachRestoredSession(undefined, 'sid-c')
    assert.deepEqual(result, { attached: false, reason: 'this profile has no workspace registry' })
    const noCwd = await reattachRestoredSession({
      readSessionHeader: async () => ({ id: 'sid-c' }),
      list: () => [fakeWorkspace('/somewhere')],
    }, 'sid-c')
    assert.equal(noCwd.attached, false)
    assert.match(noCwd.reason, /no cwd/)
  })
})

describe('session-backup: removeBackup', () => {
  it('deletes the directory and prunes its now-empty session group', async () => {
    const { home, sessions } = await fixture()
    await storeSession(sessions, 'sid-10')
    const backup = await createBackup(bareCtx, 'sid-10', { home, title: '待删' })
    const removed = await removeBackup(backup.path, { home })
    assert.equal(removed.path, backup.path)
    assert.deepEqual(await listBackups(backupRoot(home)), [])
    assert.deepEqual(await readdir(join(home, 'backups', 'sessions')), [])
  })

  it('keeps the group while a sibling backup remains', async () => {
    const { home, sessions } = await fixture()
    await storeSession(sessions, 'sid-11')
    const first = await createBackup(bareCtx, 'sid-11', { home, title: '一', stamp: '20261017-090000' })
    const second = await createBackup(bareCtx, 'sid-11', { home, title: '二', stamp: '20261018-090000' })
    await removeBackup(first.path, { home })
    const listed = await listBackups(backupRoot(home))
    assert.equal(listed.length, 1)
    assert.equal(listed[0].path, second.path)
  })

  it('refuses a path outside the store and an absent backup', async () => {
    const { home, backups } = await fixture()
    await assert.rejects(
      () => removeBackup(join(backups, '..', 'sessions'), { home }),
      (error) => error.code === 'session-backup/bad-request',
    )
    await assert.rejects(
      () => removeBackup(join(backups, 'sid-12', 'nope'), { home }),
      (error) => error.code === 'session-backup/not-found' && error.status === 404,
    )
  })
})
