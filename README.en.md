# dsh-session-backup

English | [中文](./README.md)

Backs up every session **before** the DeepSeek Harness Web GUI deletes it, adds multi-select for batch delete/backup to the session list, and restores a backup in one click — all as a user plugin, without touching any installed harness file.

## What you get

| feature | where you see it |
| --- | --- |
| automatic backup on delete | nowhere — confirming **彻底删除… (Delete session…)** silently writes a backup first |
| multi-select + batch backup/delete | **多选 (Select)** in the sidebar footer, a checkbox on each row, and a **选择/加入选择** row in each session's "…" menu |
| backup manager with one-click restore | **备份 (Backups)** in the sidebar footer |

Batch delete reuses the same automatic backup, so a batch never removes a session that was not copied first. If a backup fails, the delete is refused and the error is shown — the only copy of a session never disappears because a backup could not be written.

Blank placeholder rows (the provisional 新建会话 / New session row) and archived rows carry no checkbox: the harness renders neither a status slot nor its own actions for them, so they cannot be selected. They hold no conversation to preserve, and the next 新建会话 adopts the blank one.

## Where backups live

```
$DSH_HOME/backups/sessions/<sessionId>/<timestamp>-<title>/
├── session.v4.jsonl.zstd        # the session's own directory, copied verbatim
├── …
└── backup.json                  # manifest: sessionId, title, createdAt, sourcePath, size
```

The directory name is the local timestamp (`20261017-184533`) followed by the session's **current title**, sanitized for the filesystem (`/ \ : * ? " < > |` and control characters become spaces, capped at 48 characters, `untitled` when nothing usable remains). Two backups inside the same second get `-1`, `-2` … suffixes. `session.lock` and `.DS_Store` never enter a backup; the manifest's `backup.json` never leaves one on restore.

Attachments are content-addressed and survive session deletion, so the session directory alone is a complete, restorable copy.

## How the delete hook works

`dsh-client-ui-workspace` reads `ctx.remote.session` — a compound Cordis service name — and calls `deleteSession` on it. That read walks the framework's `internal/get` waterfall, which is where this plugin wraps the service: the normal resolution runs first (whatever resolved it, including `dsh-remote-session-inject-fix`'s fallback), and this plugin wraps whatever comes back so `deleteSession` copies the session to the backup store before handing the request to the host.

The listener is registered with `prepend` so it stays outermost regardless of plugin order.

Semantics of a failed backup:

| failure | result |
| --- | --- |
| host route answers a real error (disk full, conflict, …) | delete **refused**, failed `RemoteResult` returned, error dialog shown |
| session has no directory left to back up | delete proceeds (nothing to copy), console note |
| this profile has no Host face mounted (404/405 without our error code) | delete proceeds, console note — the plugin can never become a delete-blocker |

## HTTP routes

All four are registered on the Host connection below `/api`, address document-relative by the browser (`.slice(1)`), and answer JSON:

| method | path | body | answers |
| --- | --- | --- | --- |
| `GET` | `/api/session.backup.list` | — | `{ backups: [...] }` newest first |
| `POST` | `/api/session.backup.create` | `{ sessionId }` | `{ backup }` with `path`, `title`, `dirName`, `bytes`, `consistent` |
| `POST` | `/api/session.backup.restore` | `{ path }` | `{ restored }` with `attached`, `workspaceId` / `reason`; 409 if the session exists again |
| `POST` | `/api/session.backup.remove` | `{ path }` | `{ removed }`; prunes an empty session group |

`sessionId` must match a plain id pattern and every client-supplied path is checked to be strictly inside its root, so no request can reach outside the store. The title comes from the `sessionQuery` service (`readTitle`), falling back to `untitled` when it cannot be read. Before copying a live session the host flushes its in-memory log through the `sessions` service — the same barrier `dsh-session-log-export` uses — and each file's size is re-verified after the copy, so a log still being appended is re-copied and a copy that never settles is reported in the manifest (`consistent: false`) instead of silently shipping a torn file.

`readTitle` answers with either a bare string or the title provider's snapshot record (`{ title, source, eventSeq, … }`), depending on which query service the profile has; both are unwrapped, so backups are named after the title the Sidebar shows rather than a generic `untitled`.

## Restore also puts the session back in the Sidebar

Copying the directory back is only half of a restore. Deleting a session does two things — it removes the directory *and* drops the id from its Workspace record — and the Sidebar lists Workspace membership, not the raw directory tree, so a restore that only copies files leaves an invisible session behind (verified: it stays hidden even after a full `dsh web` restart).

So `restore` finishes by re-attaching the id through the harness's own API, `workspace.attachSession(sessionId)`. That call re-reads the restored session's header from persistence and refuses unless its `cwd` resolves to that Workspace's path, so the restore cannot attach a session to the wrong project. The response reports the outcome:

| `restored.attached` | meaning |
| --- | --- |
| `true` | re-attached; `workspaceId` names the Workspace, and the session is listed again (reload the page if the list was already open) |
| `false` | files are restored but the session stays unlisted; `reason` says why — no Workspace matches the log's `cwd`, the header is unreadable, or this profile has no `workspaceRegistry` |

A failed attachment never fails the request: the bytes are already back, and the copy would only be refused as a conflict on a retry.

## Two faces: `index.js` and `client.js`

The Harness loads this package twice, from two different module systems:

| face | file | consumed by |
| --- | --- | --- |
| host (Node) | `index.js` | `dsh` importing `exports["."]` |
| browser | `client.js` | the web host, via `exports["./client"]` |

The web host concatenates every `dsh.client.platform: "web"` package's client file into a **classic script** batch served from `/plugins/...`, so `client.js` must register itself with `window.__ModuleLoader__.load({ id, factory })`. Handing it raw ESM makes the whole batch fail with `SyntaxError: Unexpected token 'export'` and the boot screen reports `import failed (see console for the import error)`.

`client.js` is generated from `src/client.mjs` — never edit it directly:

```sh
node scripts/build-client.mjs   # regenerate client.js after editing src/client.mjs
```

The build rewrites each ESM import into a `require()` of the same specifier (`react` and `@deepseek-ai/dsh-client-ui-primitives` are seed words), strips `export` while recording the exported names, and fails loudly on Node built-ins, `export default`, or any form it cannot carry.

## Install

From npm:

```sh
dsh plugin --profile <your-profile> add dsh-session-backup
```

From GitHub (pin a tag or commit for a reproducible install):

```sh
dsh plugin --profile <your-profile> add github:overspread/dsh-session-backup
```

From a local checkout:

```sh
dsh plugin --profile <your-profile> add /path/to/session-backup
dsh --profile <your-profile> --dump-config   # expect a "# == dsh-session-backup" layer
```

Then restart the `dsh web` server — the host caches each package's resolved client-bundle path in memory, so an added, removed, or re-pointed `exports["./client"]` only takes effect on a fresh boot.

## Survives harness upgrades

The plugin lives in your profile (`~/.dsh/profiles/<name>`), not inside the installed harness, so upgrading `dsh` does not remove it. Uninstall with `dsh plugin --profile <name> remove dsh-session-backup`.

## Distribution

Releasing a new version:

```sh
node scripts/build-client.mjs
npm version patch
npm publish                # needs an npm login; the tarball ships client.js as built
git push --follow-tags
```

The package has no runtime dependencies; run the build before packing so the tarball ships a `client.js` matching the current `src/client.mjs`. The `files` list in `package.json` keeps `node_modules` and `src/` out of the tarball.

## License

[MIT](./LICENSE) © overspread.

This is a personal, community plugin. It is not developed, endorsed, or supported by DeepSeek, and it is not part of the DeepSeek Harness distribution. It only reads and writes inside your own `$DSH_HOME`; review the source before installing, as with any third-party plugin that runs on your machine.
