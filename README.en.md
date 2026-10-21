# dsh-session-backup

English | [中文](./README.md)

Backs up every session **before** the DeepSeek Harness Web GUI deletes it, adds multi-select for batch delete/backup to the session list, and restores a backup in one click — all as a user plugin, without touching any installed harness file. From 0.2.0 **permanent deletion itself is also provided by this plugin** (the row-menu delete entry, the confirm dialog, and the cascade engine all live inside the plugin), so upgrading the harness can never take deletion away: upstream ≥ 0.2.1-alpha.5 has no kernel delete at all, and on the local alpha.3 build the kernel's delete row is shadowed — every version renders exactly this plugin's row.

## What you get

| feature | where you see it |
| --- | --- |
| automatic backup on delete | nowhere — confirming **彻底删除… (Delete session…)** silently writes a backup first |
| multi-select + batch backup/delete | **多选 (Select)** in the sidebar footer, a checkbox on each row, and a **选择/加入选择** row in each session's "…" menu |
| backup manager with one-click restore | **备份 (Backups)** in the sidebar footer. A successful restore consumes that backup (restore = take back); a session whose Workspace no longer exists appears under “Ungrouped” |

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

## How the delete engine works (since 0.2.0)

Deletion **no longer** goes through any kernel method — the old `internal/get` interceptor that wrapped `ctx.remote.session.deleteSession` is gone (upstream rc.2 has no such method; wrapping it threw `TypeError` right after the backup). The whole path is now this plugin's own:

1. **Menu row** — registered on the official `sidebar.workspaces.session.menu.item` slot with a **double registration** so exactly one delete row ever renders on any kernel: `id: 'delete'` at `priority: -1` registers a component that renders `null`, shadowing the local alpha.3 kernel's built-in row regardless of registration order; `id: 'session-delete'`, `order: 460` registers this plugin's real row (right after 归档 / Archive). Upstream rc.2 has no kernel row, so the shadow is inert and the menu order matches alpha.3 exactly.
2. **Confirm dialog** — injected into `shell.overlay`, opening the danger confirm up front (copy matches the kernel verbatim: permanent deletion of the log and caches, workspace files unaffected).
3. **Activity gate (409 upgrade)** — the host asks the `workspace/session-activity` waterfall (the same providers the kernel's archive gate uses). When work is active it answers `409 workspace/session-active` carrying the activity list — the client upgrades **the same dialog in place** to “停止并彻底删除此会话？ (Stop and delete this session?)” with the activity list and a “停止并删除 (Stop and delete)” button, matching the kernel's busy-upgrade behaviour byte for byte.
4. **Stop path** — with `stopActivity: true` it first fires `workspace/session-stop` (stopping agent/jobs/subagent turns *and* purging every schedule row for the session), then quiesces the bare agent and detaches the entered store entry (firing `session/disposed`, which closes the write handle — rc.2 exposes no by-id `dispose()` capability, and this detach seam works on both versions), polls the gate until it answers empty, and only then probes the write lease. **A failed schedule-row purge aborts the whole deletion** (`gateway/internal`): a surviving armed row would cold-resume the log this cascade is destroying.
5. **Cascade** — once the write lease is exclusive: remove the log directory (alpha.3 through the kernel's `remove()`; rc.2 has no `remove`, so the directory is located and `rm`'d with a post-verify), then best-effort spill / projection-cache / workspace-accounting cleanup (each seam feature-detected per version), then `ctx.emit('api-session/removed')` so the sidebar row disappears. Attachments are shared content-addressed blobs and are **never deleted** (spec A5); workspace folders and user files are untouched.
6. **Backup first** — both single and batch deletes run `/api/session.backup.create` first; a genuine backup failure refuses the delete and shows the error — the only copy of a session never disappears because a backup could not be written — while “nothing to back up” and “no Host face mounted” both proceed.

Concurrent deletes of the same id share the first request's outcome (idempotent): a repeat answers success without re-running the cascade.

Semantics of a failed backup:

| failure | result |
| --- | --- |
| backup route answers a real error (disk full, conflict, …) | delete **refused**, error dialog shown |
| session has no directory left to back up | delete proceeds (nothing to copy), console note |
| activity gate refusal (session is running) | 409 upgrades to the “Stop and delete” dialog for a second confirmation |
| schedule-row purge fails | delete aborts (`gateway/internal`) so a timer cannot resurrect the log |

## HTTP routes

All five are registered on the Host connection below `/api`, address document-relative by the browser (`.slice(1)`), and answer JSON:

| method | path | body | answers |
| --- | --- | --- | --- |
| `GET` | `/api/session.backup.list` | — | `{ backups: [...] }` newest first |
| `POST` | `/api/session.backup.create` | `{ sessionId }` | `{ backup }` with `path`, `title`, `dirName`, `bytes`, `consistent` |
| `POST` | `/api/session.backup.delete` | `{ sessionId, stopActivity? }` | `{ deleted }`; 409 + `details.activity` on an active refusal, 404 for an unknown id, 500 `gateway/internal` when the schedule purge fails |
| `POST` | `/api/session.backup.restore` | `{ path }` | `{ restored }` with `attached`, `placement`, `workspaceId` / `reason`, `backupConsumed`; 409 if the session exists again (the backup is kept) |
| `POST` | `/api/session.backup.remove` | `{ path }` | `{ removed }`; prunes an empty session group |

`sessionId` must match a plain id pattern and every client-supplied path is checked to be strictly inside its root, so no request can reach outside the store. The title comes from the `sessionQuery` service (`readTitle`), falling back to `untitled` when it cannot be read. Before copying a live session the host flushes its in-memory log through the `sessions` service — the same barrier `dsh-session-log-export` uses — and each file's size is re-verified after the copy, so a log still being appended is re-copied and a copy that never settles is reported in the manifest (`consistent: false`) instead of silently shipping a torn file.

`readTitle` answers with either a bare string or the title provider's snapshot record (`{ title, source, eventSeq, … }`), depending on which query service the profile has; both are unwrapped, so backups are named after the title the Sidebar shows rather than a generic `untitled`.

## Restore also puts the session back in the Sidebar

Copying the directory back is only half of a restore. Deleting a session does two things — it removes the directory *and* drops the id from its Workspace record — and the Sidebar lists Workspace membership, not the raw directory tree.

So `restore` finishes by re-attaching the id through the harness's own API, `workspace.attachSession(sessionId)`. That call re-reads the restored session's header from persistence and refuses unless its `cwd` resolves to that Workspace's path, so the restore cannot attach a session to the wrong project.

**A successful restore consumes its backup** (restore = take back; the response reports `backupConsumed: true`). The copy is kept only when the restore is refused (the session already exists → 409). Removal is best-effort: a failed prune never fails a restore that already succeeded, and `backupConsumed: false` reports it honestly.

A session with no matching Workspace does not disappear: rc.2's Sidebar has a native “Ungrouped” bucket, and sessions that belong to no Workspace are listed there (deleting a Workspace behaves the same way — its sessions move to Ungrouped). `placement` says where this restore landed:

| `restored.placement` | meaning |
| --- | --- |
| `workspace` | re-attached; `workspaceId` names the Workspace and the session is back in its group (reload the page if the list was already open) |
| `ungrouped` | files restored; the session is listed under “Ungrouped” — no Workspace matches the log's `cwd` (e.g. its Workspace was deleted), or this profile has no `workspaceRegistry` |
| `unknown` | rare: the restored header is unreadable, or `attachSession` refused — the files are back and `reason` says why |

A failed attachment never fails the request: the bytes are already back.

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
