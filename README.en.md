# dsh-session-backup

English | [中文](./README.md) · [Changelog](./CHANGELOG.md)

Backs up every session **before** the DeepSeek Harness Web GUI permanently deletes it, adds multi-select batch delete/backup to the session list, and restores a backup in one click — all as a user plugin, without touching any installed harness file.

**Permanent deletion itself is also provided by this plugin** (the row-menu delete entry, the confirm dialog, and the cascade engine all live inside the plugin), so upgrading the harness can never take deletion away: upstream ≥ 0.2.1-alpha.5 has no kernel delete at all, and on the local alpha.3 build the kernel's delete row is shadowed — every version renders exactly this plugin's row.

## What you get

| feature | where you see it |
| --- | --- |
| automatic backup on delete | nothing to do — confirming **Delete session…** silently saves the latest backup first; the log is removed only after that save succeeds |
| multi-select + batch backup/delete | **多选 (Select)** in the sidebar footer, a checkbox on each row, and a **选择/加入选择** row in each session's "…" menu |
| backup manager with one-click restore | **备份 (Backups)** in the sidebar footer. A successful restore takes the backup (restore = take back) and the session appears pinned at the front of its group; a session whose Workspace no longer exists appears under “Ungrouped” |

Blank placeholder rows (the provisional 新建会话 / New session row) and archived rows carry no checkbox: the harness renders neither a status slot nor its own actions for them, so they cannot be selected. They hold no conversation to preserve, and the next 新建会话 adopts the blank one.

## What the backup guarantees

- **Back up before deleting** — single and batch deletion attempt a preflight backup, then verify and save the **final backup** after stopping work and acquiring the write lease. Preflight path and I/O errors do not stop activity, purge reminders, or remove workspace membership. Only a consistency failure caused by a changing source may proceed with an explicitly authorized stop, followed by a strict final backup. A final-backup failure preserves the existing backup and live log. Residual-only cleanup requires both persistence and directory checks to confirm that the log is absent.
- **One copy per content** — a per-file `relative path:sha256` fingerprint decides: an exact match **reuses** the existing backup (`reused: true`) with no new directory; changed content **refreshes the latest backup at the same path** (`updated: true`), so “back up manually, then delete” always leaves exactly one entry. The new copy is fully written and verified before replacing the old one; failures keep the old backup and abort the delete. A repeated backup request refreshes the same way, and existing historical backups are never pruned in bulk.
- **Concurrency-safe** — backup / restore / remove-backup requests for one session run serialized, so clicking a manual backup and a delete together never writes two copies.

## Optional session file cleanup

Open **File cleanup** beside **Backups** in the sidebar footer for two independent settings. **Both default to off** and apply to individual and batch deletion:

- `cleanupOnDelete`: clean registered temporary files when deleting a session.
- `cleanupAttachmentsOnDelete`: after deleting a session or backup, reclaim uploaded image and file copies no longer referenced by any session or retained backup.

Each setting is saved separately. Existing temporary-file permission never enables upload collection automatically. An unavailable or rejected configuration save is reported.

### Registered temporary files

Only files allocated by a producer through `ctx.get('sessionArtifacts').save(sessionId, filename, bytes)` are eligible. Objects live under `$DSH_HOME/session-artifacts/objects/<sessionId>/`, with separate ownership ledgers in `session-artifacts/registry/`. The API accepts content bytes, never an existing file path. **Existing screenshots, arbitrary shell outputs, and older unregistered session files are not imported automatically**; producers must adopt the API.

After the final backup succeeds, deletion records cleanup intent and removes artifacts only after confirming the session log is gone. Failed inventories survive restarts and can be retried under **File cleanup → Retry pending cleanup** after verifying session absence again. Individual corrupt ledgers are retained and reported without blocking healthy inventories or retries. Restoring a session cancels its temporary-file pending marker; a reset failure completes restoration and displays `cleanupWarning`. A subsequent list-refresh failure also preserves the successful restore result.

Workspace files, uploads, and backups are outside this setting's scope. Modified or replaced files, links, and unsafe permissions cause retention. Temporary artifacts **are not included in session backups and cannot be recovered by restoring a session after cleanup**. Only one Host process may write the registry.

### Uploaded image and file copies

Uploaded copies are independent of the user's originals. Candidates come only from the logs of a session or backup explicitly being deleted; inventories live in `$DSH_HOME/attachment-cleanup/registry/`. There is no historical orphan sweep. Reference scans cover all physical log generations (including zstd), history, forks, pre-compaction records, and all retained backups. Incomplete reads or changing references retain candidates and report the reason.

**Deleting a session normally retains its uploads**, because its automatic final backup still references them. Removing the last referencing backup permits collection; other sessions and restored sessions continue to protect their uploads. Generic file objects and their internal named hard links are verified and reclaimed together. Changed contents, replaced files, symlinks, or extra hard links cause retention. Originals, workspace files, derived request-image caches, and temporary upload files are never deleted. The UI reports reclaimed counts and bytes separately from retention, deferral, and failures; candidates survive restarts and can be retried.

Safe collection requires a single standard Web Host, matching local attachment and session stores, and a use observer installed before the Web listener starts. A first hot activation retains uploads until a Host restart. Uploads admitted, read, or resolved to host paths during the current backend lifetime remain protected until that backend exits, preventing collection of uploads not yet committed to a session. SDK/ACP, custom startup writers, and shared storage with multiple Hosts are unsupported; leave this option off in those deployments.

See the [changelog](./CHANGELOG.md) for plugin releases. Screenshot producer integration and DSH core per-version release notes still require the core source project and are not supplied by this plugin.

## Quick start

1. Install (see [Install](#install) below), then restart `dsh web` once.
2. **Back up**: a session's "…" menu → **Back up now**; tick several → **备份 (Back up selected)** in the sidebar footer.
3. **Delete**: **彻底删除… (Delete session…)** — while the session is running, the dialog upgrades in place to “Stop and delete”; tick several → **删除选中 (Delete selected)**.
4. **View / restore**: sidebar footer → **备份 (Backups)** → **恢复 (Restore)**. The session appears pinned at the front of its group and the sidebar refreshes itself — no manual reload.

## Where backups live

```
$DSH_HOME/backups/sessions/<sessionId>/<timestamp>-<title>/
├── session.v4.jsonl.zstd        # the session's own directory, copied verbatim
├── …
└── backup.json                  # manifest: sessionId, title, createdAt, sourcePath, size, inventory (content fingerprint)
```

The directory name is the local timestamp (`20261017-184533`) followed by the session's **current title**, sanitized for the filesystem (`/ \ : * ? " < > |` and control characters become spaces, capped at 48 characters, `untitled` when nothing usable remains). Two backups inside the same second get `-1`, `-2` … suffixes. `session.lock` and `.DS_Store` never enter a backup; the manifest's `backup.json` never leaves one on restore.

Backups copy session logs; attachments remain in the content-addressed store under the same `$DSH_HOME` and are not embedded in the backup directory. With upload collection disabled they retain existing storage behavior; with it enabled, retained backup references also protect them. A backup directory is not a standalone migration archive without the original attachment store.

## How the delete engine works

The whole deletion path lives inside this plugin and goes through no kernel method — upstream rc.2 has no `ctx.remote.session.deleteSession`, and this plugin does not depend on it:

1. **Menu row** — registered on the official `sidebar.workspaces.session.menu.item` slot with a **double registration** so exactly one delete row ever renders on any kernel: `id: 'delete'` at `priority: -1` registers a component that renders `null`, shadowing the local alpha.3 kernel's built-in row regardless of registration order; `id: 'session-delete'`, `order: 460` registers this plugin's real row (right after 归档 / Archive). Upstream rc.2 has no kernel row, so the shadow is inert and the menu order matches alpha.3 exactly.
2. **Confirm dialog** — injected into `shell.overlay`, opening the danger confirm up front (copy matches the kernel verbatim: permanent deletion of the log and caches, workspace files unaffected).
3. **Activity gate (409 upgrade)** — the host asks the `workspace/session-activity` waterfall (the same providers the kernel's archive gate uses). When work is active it answers `409 workspace/session-active` carrying the activity list — the client upgrades **the same dialog in place** to “停止并彻底删除此会话？ (Stop and delete this session?)” with the activity list and a “停止并删除 (Stop and delete)” button, matching the kernel's busy-upgrade behaviour byte for byte.
4. **Preflight and stop** — read persistence and inspect the directory first; storage errors refuse deletion. Save a preflight backup before invoking `workspace/session-stop` for `stopActivity: true`. That event stops agent/jobs/subagent work and the Host schedule provider also removes active reminders. Quiesce and detach the live entry, then wait for activity to settle. Idle deletion does not invoke the stop event. Stopping cannot be rolled back: if the final backup fails afterward, the log and existing backup remain, but stopped activity and removed reminders are not restored.
5. **Cascade** — acquire the exclusive write lease → save the final backup including closing events → optionally persist cleanup intent → purge schedule rows (failure aborts) → remove and verify the log → best-effort spill / projection / workspace cleanup → emit `api-session/removed`. Keep the lease across filesystem deletion; release it before a native `remove()` that owns its own lease. Post-deletion cache failures are returned in `deleted.warnings` and retried by repeating deletion, without misreporting a completed log deletion as a failure. The independent upload setting may reclaim unreferenced candidates; retained backups still protect uploads, and workspace directories and user originals remain untouched.
6. **Backup first** — preflight and final backups share content fingerprints and the existing path, reusing unchanged content without duplicate copies. Failures never publish an incomplete replacement. Symlinks in source entries, restore targets, and store directories are refused so they cannot redirect copying or manifest writes.

Concurrent deletes of the same id share the first request's outcome. Repeated deletion answers success and retries cache cleanup, plus pending artifact cleanup when enabled.

Semantics of a failed backup:

| failure | result |
| --- | --- |
| backup route answers a real error (disk full, conflict, …) | delete **refused**, error dialog shown |
| post-deletion cache cleanup fails | deletion succeeds with `deleted.warnings`; the final backup remains, and repeated deletion retries cache cleanup |
| session has no directory left to back up | nothing to copy; a missing Session still returns 404 as before |
| activity gate refusal (session is running) | 409 upgrades to the “Stop and delete” dialog for a second confirmation |
| schedule-row purge fails | delete aborts (`gateway/internal`) so a timer cannot resurrect the log |

## HTTP routes

All seven route paths are registered on the Host connection below `/api`, address document-relative by the browser (`.slice(1)`), and answer JSON:

| method | path | body | answers |
| --- | --- | --- | --- |
| `GET` | `/api/session.backup.list` | — | `{ backups: [...] }` newest first |
| `POST` | `/api/session.backup.create` | `{ sessionId, beforeDelete? }` | `{ backup }` with `path`, `title`, `dirName`, `bytes`, `consistent`, `reused` (identical contents), `updated` (existing directory refreshed); refreshing the latest backup is the default, with explicit `beforeDelete: false` preserving an independent historical snapshot |
| `POST` | `/api/session.backup.delete` | `{ sessionId, stopActivity? }` | `{ deleted }`; 409 + `details.activity` on an active refusal, 404 for an unknown id, 500 `gateway/internal` when the schedule purge fails |
| `POST` | `/api/session.backup.restore` | `{ path }` | `{ restored }` with `attached`, `placement`, `workspaceId` / `reason`, `backupConsumed`, `pinned` (`true` when pinned to the front of its group, `false` when the pin was refused); 409 if the session exists again (the backup is kept) |
| `POST` | `/api/session.backup.remove` | `{ path }` | `{ removed }`; prunes an empty session group; includes `removed.attachments` when upload collection is enabled |
| `GET` / `POST` | `/api/session.backup.cleanup-settings` | none for GET; `{ cleanupOnDelete?: boolean, cleanupAttachmentsOnDelete?: boolean }`, at least one, to save | `{ settings: { cleanupOnDelete, cleanupAttachmentsOnDelete, editable, pending, attachmentPending, pendingErrors?, attachmentPendingErrors? } }`; reports corrupt inventories separately; 409 when configuration cannot be saved |
| `POST` | `/api/session.backup.cleanup-retry` | `{}` | `{ results, settings }`; retries enabled categories only; 409 when both are off. Temporary files require verified session absence; uploads require a full reference check |

`sessionId` must match a plain id pattern and every client-supplied path is checked to be strictly inside its root, so no request can reach outside the store. The title comes from the `sessionQuery` service (`readTitle`), falling back to `untitled` when it cannot be read. Before copying a live session the host flushes its in-memory log through the `sessions` service — the same barrier `dsh-session-log-export` uses — and each file's size is re-verified after the copy, so a log still being appended is re-copied and finally source and copy are compared using SHA-256. A changing source, flush failure, or copy failure rejects the request, preserves the old backup, and never publishes a partial copy.

`readTitle` answers with either a bare string or the title provider's snapshot record (`{ title, source, eventSeq, … }`), depending on which query service the profile has; both are unwrapped, so backups are named after the title the Sidebar shows rather than a generic `untitled`.

## Restore also puts the session back in the Sidebar

Copying the directory back is only half of a restore. Deleting a session does two things — it removes the directory *and* drops the id from its Workspace record — and the Sidebar lists Workspace membership, not the raw directory tree.

So `restore` finishes by re-attaching the id through the harness's own API, `workspace.attachSession(sessionId)`. That call re-reads the restored session's header from persistence and refuses unless its `cwd` resolves to that Workspace's path, so the restore cannot attach a session to the wrong project.

**A successful restore consumes its backup** (restore = take back; the response reports `backupConsumed: true`). The copy is kept only when the restore is refused (the session already exists → 409). Removal is best-effort: a failed prune never fails a restore that already succeeded, and `backupConsumed: false` reports it honestly.

After a successful restore the client **refreshes the sidebar list immediately** (no manual reload) and **pins the session to the front of its group** — workspace groups and the native “Ungrouped” bucket alike, because the registry pin is global and its frame reaches the browser live. Pinning is best-effort: a refusal (e.g. an archived session) never fails a successful restore and is reported as `pinned: false`.

A session with no matching Workspace does not disappear: rc.2's Sidebar has a native “Ungrouped” bucket, and sessions that belong to no Workspace are listed there (deleting a Workspace behaves the same way — its sessions move to Ungrouped). `placement` says where this restore landed:

| `restored.placement` | meaning |
| --- | --- |
| `workspace` | re-attached; `workspaceId` names the Workspace and the session returns to its group pinned to the front (the sidebar refreshes itself — no manual reload) |
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

## Tests

```sh
npm test
```

Eleven plain-Node suites running against system temp directories — **no harness, no real session, no network**:

| suite | covers |
| --- | --- |
| `test/delete-routes.mjs` | the delete engine on both seam shapes (alpha.3 / rc.2), activity refusal and stop upgrade, write lease, idempotency |
| `test/restore-route.mjs` | restore = take back (consumes the backup), workspace re-attach, pin and pin-refused |
| `test/reuse-backup.mjs` | content-fingerprint reuse: unchanged content is never written twice |
| `test/backup-delete-regression.mjs` | “back up then delete” leaves exactly one copy: changed content, concurrency, stop-time closing events, failed backup aborts the delete |
| `test/client-delete-flow.mjs` | the browser-side request sequences of the real `createActions`: one delete call, sidebar refresh after restore |
| `test/artifacts.mjs` | durable ownership, retention of modified files and links, concurrent saves and cleanup across instances |
| `test/cleanup-routes.mjs` | default-off policy, backup before cleanup, failed cleanup retries, restore protection, configuration saves |
| `test/attachments.mjs` | upload references, compressed logs, object and alias families, fail-closed scans, use observer, durable candidates |
| `test/attachment-routes.mjs` | independent settings, final-backup reference retention, last-backup collection, restore and retry protection |
| `test/client-cleanup-flow.mjs` | independent settings saves, failure states, upload collection statistics, adjacent footer entry and disabled controls |
| `test/cleanup-concurrency.mjs` | log state rechecked after a queued restore, successful restoration despite a corrupt cleanup marker |

## Install

From npm:

```sh
dsh plugin --profile <your-profile> add dsh-session-backup
```

> ⚠️ The npm publish may lag behind this repository. Install from GitHub or a local checkout to get the latest behavior.

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

## Automated npm releases

Releases run in GitHub Actions; no local `npm publish` or OTP is needed. Tag to release:

```sh
# bump `version` in package.json first, then tag the same version
git tag v0.4.4
git push origin v0.4.4
```

`.github/workflows/publish.yml` verifies the tag matches `package.json`, runs `npm ci`, builds `client.js` and fails when the committed bundle is stale, runs the tests, publishes with `npm publish --provenance`, then triggers an npmmirror sync.

Configure a **Trusted Publisher** once on the package's npmjs.com settings page: repository `overspread/dsh-session-backup`, workflow filename `publish.yml`. CI then publishes through a short-lived OIDC credential — no long-lived npm token, no local 2FA.

A manual `npm publish` still works; it asks for the one-time password.
