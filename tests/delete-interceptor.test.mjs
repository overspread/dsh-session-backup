import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'

/**
 * Load the generated browser bundle the way the Harness web host does: a
 * classic script registering itself through `window.__ModuleLoader__.load`,
 * with `require` resolving the two seed modules from the boot graph.
 */
const bundle = await (async () => {
  let entry
  globalThis.window = { __ModuleLoader__: { load: (loaded) => { entry = loaded } } }
  await import('../client.js')
  const react = {
    createElement: () => null,
    Fragment: 'Fragment',
    useEffect: () => {},
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useSyncExternalStore: () => ({}),
  }
  const primitives = new Proxy({}, { get: () => () => null })
  return entry.factory((specifier) => (specifier === 'react' ? react : primitives))
})()

/** The sibling plugin this one subsumes; skipped when it is not present. */
const fix = await (async () => {
  try {
    return await import('../../remote-session-inject-fix/index.js')
  } catch {
    return undefined
  }
})()

/**
 * The shipped geometry: `remote` plus the `remote.session` namespace, read by
 * a fiber that injects only `remote` — which is exactly the undeclared
 * compound read `dsh-client-ui-workspace` performs.
 */
async function geometry() {
  const root = new Context()
  const deleted = []
  const face = {
    deleteSession: async (request) => {
      deleted.push(request)
      return { ok: true, value: request }
    },
    peek: () => 'untouched',
  }
  await root
    .plugin({
      apply(ctx) {
        ctx.provide('remote.session', face)
        ctx.provide('remote.otherFace', { peek: () => 'other' })
      },
    })
    .await()
  await root
    .plugin(
      class Remote extends Service {
        constructor(ctx) {
          super(ctx, 'remote')
        }
      },
    )
    .await()
  // The browser face also registers locale dictionaries and slot entries; a
  // bare context has neither service, so stand in for the renderer and locale.
  await root
    .plugin({
      apply(ctx) {
        ctx.provide('locale', { register: () => () => {} })
        ctx.provide('slots', { inject: () => {}, register: () => ({}) })
      },
    })
    .await()
  return { root, face, deleted }
}

/** Install a listener-bearing plugin on the root and read as the workspace does. */
async function readSessionService(root, plugins = []) {
  // The plugin's own `inject` is what makes `locale`/`slots`/`remote` readable;
  // the reader below deliberately injects only `remote`, like ui-workspace.
  for (const apply of plugins) await root.plugin({ apply, inject: bundle.inject }).await()
  let read
  let caught
  await root
    .plugin({
      inject: ['remote'],
      apply(ctx) {
        try {
          read = ctx.remote.session
        } catch (error) {
          caught = error
        }
      },
    })
    .await()
  return { read, caught }
}

/** Record every browser-side call and answer with a canned response. */
function stubFetch(handler) {
  const calls = []
  const previous = globalThis.fetch
  const warnings = []
  const warn = console.warn
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init })
    return handler({ url, init })
  }
  console.warn = (message) => warnings.push(String(message))
  return {
    calls,
    warnings,
    restore: () => {
      globalThis.fetch = previous
      console.warn = warn
    },
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const backupAccepted = () => json({ backup: { sessionId: 'sid-1', title: '标题' } })

describe('session-backup: delete interception', () => {
  it('resolves the undeclared compound read that would otherwise throw', async () => {
    const { root, face } = await geometry()
    const { read, caught } = await readSessionService(root, [bundle.apply])
    assert.equal(caught, undefined, `read threw: ${caught}`)
    assert.notEqual(read, face, 'the raw service was handed out unwrapped')
    assert.equal(read.peek(), 'untouched', 'other members were not forwarded')
  })

  it('backs the session up before handing the delete to the host', async () => {
    const { root, deleted } = await geometry()
    const { read } = await readSessionService(root, [bundle.apply])
    const fetch = stubFetch(backupAccepted)
    try {
      const result = await read.deleteSession({ sessionId: 'sid-1', stopActivity: true })
      assert.equal(fetch.calls.length, 1)
      assert.equal(fetch.calls[0].url, 'api/session.backup.create')
      assert.equal(fetch.calls[0].init.method, 'POST')
      assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { sessionId: 'sid-1' })
      assert.deepEqual(deleted, [{ sessionId: 'sid-1', stopActivity: true }], 'the delete itself changed')
      assert.deepEqual(result, { ok: true, value: { sessionId: 'sid-1', stopActivity: true } })
    } finally {
      fetch.restore()
    }
  })

  it('refuses the delete when the backup genuinely fails', async () => {
    const { root, deleted } = await geometry()
    const { read } = await readSessionService(root, [bundle.apply])
    const fetch = stubFetch(() => json({ error: { code: 'session-backup/internal', message: 'disk full' } }, 500))
    try {
      const result = await read.deleteSession({ sessionId: 'sid-1' })
      assert.deepEqual(deleted, [], 'the session was deleted without a backup')
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'session-backup/failed')
      assert.match(result.error.message, /disk full/)
    } finally {
      fetch.restore()
    }
  })

  it('deletes anyway when the host face is not mounted in this profile', async () => {
    const { root, deleted } = await geometry()
    const { read } = await readSessionService(root, [bundle.apply])
    const fetch = stubFetch(() => new Response('<html>404</html>', { status: 404 }))
    try {
      const result = await read.deleteSession({ sessionId: 'sid-1' })
      assert.equal(deleted.length, 1, 'the plugin became a delete-blocker')
      assert.deepEqual(result, { ok: true, value: { sessionId: 'sid-1' } })
      assert.equal(fetch.warnings.length, 1)
      assert.match(fetch.warnings[0], /no backup taken for sid-1/)
    } finally {
      fetch.restore()
    }
  })

  it('deletes when the session has no directory left to back up', async () => {
    const { root, deleted } = await geometry()
    const { read } = await readSessionService(root, [bundle.apply])
    const fetch = stubFetch(() => json({ error: { code: 'session-backup/not-found', message: 'gone' } }, 404))
    try {
      await read.deleteSession({ sessionId: 'sid-1' })
      assert.equal(deleted.length, 1)
      assert.equal(fetch.warnings.length, 1)
    } finally {
      fetch.restore()
    }
  })

  it('leaves every other property to the normal resolution', async () => {
    const { root } = await geometry()
    await root.plugin({ apply: bundle.apply, inject: bundle.inject }).await()
    let read
    let caught
    await root
      .plugin({
        // A different compound name still resolves the ordinary way: our
        // interceptor forwards every property except `remote.session`.
        inject: ['remote', 'remote.otherFace'],
        apply(ctx) {
          try {
            read = ctx.remote.otherFace.peek()
          } catch (error) {
            caught = error
          }
        },
      })
      .await()
    assert.equal(caught, undefined)
    assert.equal(read, 'other')
  })

  it('still wraps when dsh-remote-session-inject-fix is installed too', { skip: fix === undefined && 'sibling plugin not present' }, async () => {
    // Tree order: the fix registers first; our listener must still be outermost.
    const forward = await geometry()
    const { read: readForward } = await readSessionService(forward.root, [fix.apply, bundle.apply])
    const first = stubFetch(backupAccepted)
    try {
      await readForward.deleteSession({ sessionId: 'sid-1' })
      assert.equal(first.calls[0].url, 'api/session.backup.create')
    } finally {
      first.restore()
    }

    // The reverse order must behave identically.
    const reverse = await geometry()
    const { read: readReverse } = await readSessionService(reverse.root, [bundle.apply, fix.apply])
    const second = stubFetch(backupAccepted)
    try {
      await readReverse.deleteSession({ sessionId: 'sid-1' })
      assert.equal(second.calls[0].url, 'api/session.backup.create')
      assert.equal(reverse.deleted.length, 1)
    } finally {
      second.restore()
    }
  })
})
