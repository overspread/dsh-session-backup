# 更新日志 / Changelog

本文件记录 **dsh-session-backup 插件** 的版本变化。DSH 核心发行版的新增功能、Bug 修复与迁移说明由核心项目维护，本文件不代表 DSH 核心更新日志。

This file records releases of the **dsh-session-backup plugin**. It is separate from DSH core release notes and migration guides.

从本次预览版本开始维护，按插件的实际版本和发布日期保留条目，最新版本放在最前。正式版和预览版均列出新增功能、功能调整、移除功能和 Bug 修复，无对应变更时明确写“无”；发布时同步到对应的 GitHub Release。不倒推未经核实的历史版本。

Starting with this preview release, each release preserves its entries under the actual plugin version and release date, newest first. Stable and preview releases both list Added, Changed, Removed, and Fixed, explicitly stating “None” for empty categories, and publish the same notes on the corresponding GitHub Release. Do not reconstruct unverified historical releases.

## 0.4.5-preview.0 — 2026-11-26

预览测试版，通过 npm 的 `preview` 标签发布；正式版仍使用 `latest` 标签。

Preview release published under the npm `preview` tag; stable releases continue to use `latest`.

### 新增功能 / Added

- 在侧栏“备份”旁增加“临时文件”入口。可选择删除会话时清理已登记临时产物，默认关闭；保存后的设置对单删和批量删除均生效。
- 提供 `ctx.get('sessionArtifacts').save(sessionId, filename, bytes)`，在插件管理的独立目录创建文件并登记会话归属；生成方必须主动接入此接口。已有截图、shell 输出、Office 产物和共享附件不会被自动导入。
- 在 npm 包中包含本更新日志，并从中英文说明链接访问。

- Add “Temporary files” beside “Backups” in the sidebar, with an off-by-default option to clean registered temporary artifacts on individual or batch session deletion.
- Add `ctx.get('sessionArtifacts').save(sessionId, filename, bytes)` to allocate files in a managed directory and record ownership. Producers must opt in; existing screenshots, shell outputs, Office outputs, and shared attachments are not imported automatically.
- Include this changelog in the npm package and link it from both language versions of the README.

### 功能调整 / Changed

- 开启临时文件清理后，单个和批量删除按“最终备份成功 → 记录清理意图 → 删除会话日志成功 → 清理登记文件”的顺序执行；未开启时不执行产物清理。
- 清理失败记录保留在会话日志之外，重启后仍可在“临时文件”中重试；恢复会话时取消它的待清理标记。

- When artifact cleanup is enabled, individual and batch deletion follow this order: successful final backup → persisted cleanup intent → successful session-log deletion → registered artifact cleanup. Artifact cleanup stays disabled otherwise.
- Failed cleanup inventories survive outside session logs and remain available for retry after a restart. Restoring a session cancels its pending marker.

### 移除功能 / Removed

- 无。
- None.

### Bug 修复 / Fixed

- 修复恢复与删除并发时，等待中的删除可能误走“无日志”清理分支的问题：同一会话的恢复、删除和清理共用串行锁，并在恢复后重新检查日志。
- 修复取消待清理标记失败会打断恢复后续步骤的问题：继续完成工作区挂载与置顶，并通过 `cleanupWarning` 返回原因。
- 修复异步路径检查可能让清理越过先提交的文件登记的问题：登记队列按调用顺序入队。

- Fix queued deletion taking the no-log cleanup path after a concurrent restore: serialize restoration, deletion, and cleanup for each session and recheck log state after restoration.
- Fix cleanup-marker reset failures interrupting restoration: complete workspace attachment and pinning, returning `cleanupWarning` with the reason.
- Fix asynchronous path checks allowing cleanup to overtake an earlier file save: admit registry operations in call order.

### 升级说明 / Upgrade notes

- 安装或更新到此版本后，需停止并重新启动 DSH 后端（`dsh web`），再刷新页面。仅刷新浏览器不会替换后端已加载的插件代码，可能出现 `api/session.backup.cleanup-settings failed (404)`。
- After installing or updating this version, stop and restart the DSH backend (`dsh web`), then refresh the page. A browser refresh alone does not replace plugin code already loaded by the backend and may leave `api/session.backup.cleanup-settings failed (404)` errors.

### 使用边界 / Limitations

- 只清理登记文件，并核对路径、文件身份和内容；修改、替换、符号链接、硬链接及权限不安全的文件保留。用户工作区文件、共享附件、未登记文件和备份不在清理范围内。
- 临时产物不复制进会话备份，清理后无法通过恢复会话取回；界面开启选项前说明此行为。
- 登记存储在单个 Host 进程内串行化；不支持多个 Host 同时写入同一登记存储。
- 截图生成方接入和 DSH 核心逐版更新日志尚待核心源码工程，此插件版本不宣称它们已完成。

- Cleanup checks registered paths, file identity, and content. Modified or replaced files, symlinks, hardlinks, and unsafe permissions are retained. Workspace files, shared attachments, unregistered files, and backups stay outside its scope.
- Temporary artifacts are not copied into session backups and cannot be recovered by restoring a session after cleanup. The option explains this before it is enabled.
- Registry writes serialize within one Host process; concurrent writers from multiple Hosts are unsupported.
- Screenshot producer integration and DSH core per-version release notes still require the core source project; this plugin change does not claim to provide them.
