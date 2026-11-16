/**
 * Content-aware backup reuse: an unchanged session must not be copied twice.
 *
 * The regression this pins — back up manually, then delete — used to leave two
 * identical directories under `<backupRoot>/<sessionId>/` because the delete's
 * pre-flight backup copied unconditionally. Now every create request fingerprints
 * the session directory (sorted `rel:sha256` lines) and answers from the stored
 * backup that matches it exactly (`reused: true`), writing nothing new; content
 * that actually changed still costs a fresh directory.
 *
 * Runs with plain `node test/reuse-backup.mjs`.
 */
import assert from 'node:assert/strict'
import { appendFile, mkdir, readdir, readFile, rm, stat as fsstat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, backupRoot, createBackup, listBackups } from '../index.js'

const SESSION = 'session-reuse-1'
const PROJ = '--Users-overspread-projects-demo--'

const exists = (p) =>
  fsstat(p).then(
    () => true,
    () => false,
  )

function ok(message) {
  console.log(`✓ ${message}`)
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exitCode = 1
}

/** A temp home with one session directory holding two stable files. */
async function makeHome() {
  const home = join(tmpdir(), `dsh-sb-reuse-${process.pid}`)
  const dir = join(home, 'sessions', PROJ, SESSION)
  await mkdir(join(dir, 'inner'), { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl'), '{"t":"one"}\n')
  await writeFile(join(dir, 'inner', 'extra.json'), '{"a":1}\n')
  return { home, dir }
}

/** Fake Host ctx: connection.fetch registry only (create/delete never need more). */
function fakeCtx() {
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {}, error: () => {} },
    get: () => undefined,
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    effect: (fn) => {
      const dispose = fn()
      return () => dispose?.()
    },
  }
  return { ctx, routes }
}

async function post(routes, path, body) {
  const route = routes.get(path)
  assert.ok(route, `route ${path} registered`)
  const request = new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await route.fetch(request)
}

async function run() {
  const { home, dir } = await makeHome()
  const options = { home }
  const backups = backupRoot(home)
  try {
    // 1. manual backup writes one directory and records the v2 inventory.
    const first = await createBackup({}, SESSION, options)
    assert.equal(first.reused, false, 'first backup is written, not reused')
    const group = join(backups, SESSION)
    const afterFirst = await readdir(group)
    assert.equal(afterFirst.length, 1, 'exactly one backup after the first create')
    const manifest = JSON.parse(await readFile(join(first.path, 'backup.json'), 'utf8'))
    assert.ok(Array.isArray(manifest.inventory) && manifest.inventory.length === 2,
      `manifest carries the content fingerprint (got ${JSON.stringify(manifest.inventory)})`)
    const digest = createHash('sha256').update(await readFile(join(dir, 'session.v4.jsonl'))).digest('hex')
    assert.ok(manifest.inventory.includes(`session.v4.jsonl:${digest}`),
      `fingerprint is a sha256 content hash (got ${JSON.stringify(manifest.inventory)})`)
    assert.equal(manifest.version, 2, 'manifest version bumped with the inventory field')
    ok('first backup: one directory, v2 manifest with inventory')

    // 2. an unchanged session reuses that directory — the delete pre-flight case.
    const second = await createBackup({}, SESSION, options)
    assert.equal(second.reused, true, 'unchanged content is reused, not copied')
    assert.equal(second.path, first.path, 'reuse answers with the stored directory')
    const afterSecond = await readdir(group)
    assert.equal(afterSecond.length, 1, 'still exactly one backup — no duplicate copy')
    ok('unchanged session: reused, still one directory')

    // 3. the same reuse rule reached through the delete pre-flight route.
    const { ctx, routes } = fakeCtx()
    apply(ctx, options)
    const preflight = await post(routes, '/api/session.backup.create', { sessionId: SESSION })
    assert.equal(preflight.status, 200)
    const payload = await preflight.json()
    assert.equal(payload.backup.reused, true, 'route create answers reused for unchanged content')
    const afterRoute = await readdir(group)
    assert.equal(afterRoute.length, 1, 'route create wrote no second directory')
    ok('delete pre-flight route: reused, still one directory')

    // 4. real content change costs exactly one new backup.
    await appendFile(join(dir, 'session.v4.jsonl'), '{"t":"two"}\n')
    const third = await createBackup({}, SESSION, options)
    assert.equal(third.reused, false, 'changed content is copied again')
    const afterThird = await readdir(group)
    assert.equal(afterThird.length, 2, 'a real change adds exactly one directory')
    const listed = await listBackups(backups)
    assert.equal(listed.length, 2, 'both backups are listed, newest first')
    ok('changed content: one new backup, old copy kept')

    // 5. the older backup remains listable and restorable.
    const stale = listed.find((entry) => entry.dirName === first.dirName)
    assert.ok(stale !== undefined, 'the original backup is still restorable after reuse')
    assert.equal(stale.restorable, true, 'older manifest stays restorable')
    ok('older backup remains listable and restorable')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

try {
  await run()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
console.log(process.exitCode ? '✗ FAIL' : '✓ all reuse tests passed')
