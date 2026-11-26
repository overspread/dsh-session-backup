# 更新日志 / Changelog

本文件记录 **dsh-session-backup 插件** 的版本变化。DSH 核心发行版的新增功能、Bug 修复与迁移说明由核心项目维护，本文件不代表 DSH 核心更新日志。

This file records releases of the **dsh-session-backup plugin**. It is separate from DSH core release notes and migration guides.

从本次预览版本开始维护，按插件的实际版本和发布日期保留条目，最新版本放在最前。没有对应变更的分类省略，不倒推未经核实的历史版本。

Starting with this preview release, each release preserves its entries under the actual plugin version and release date, newest first. Omit empty categories and do not reconstruct unverified historical releases.

## 0.4.5-preview.0 — 2026-11-26

预览测试版，通过 npm 的 `preview` 标签发布；正式版仍使用 `latest` 标签。

Preview release published under the npm `preview` tag; stable releases continue to use `latest`.

### 新增功能 / Added

- 在侧栏“备份”旁增加“临时文件”入口。可选择删除会话时清理已登记临时产物，默认关闭；保存后的设置对单删和批量删除均生效。
- 提供 `ctx.get('sessionArtifacts').save(sessionId, filename, bytes)`，在插件管理的独立目录创建文件并登记会话归属；生成方必须主动接入此接口。已有截图、shell 输出、Office 产物和共享附件不会被自动导入。
- 在最终备份成功后记录清理意图，删除会话日志成功后才清理文件；失败记录保留在会话日志之外，可在“临时文件”中重试。恢复会话会取消它的待清理标记。
- 在 npm 包中包含本更新日志，并从中英文说明链接访问。

- Add “Temporary files” beside “Backups” in the sidebar, with an off-by-default option to clean registered temporary artifacts on individual or batch session deletion.
- Add `ctx.get('sessionArtifacts').save(sessionId, filename, bytes)` to allocate files in a managed directory and record ownership. Producers must opt in; existing screenshots, shell outputs, Office outputs, and shared attachments are not imported automatically.
- Persist cleanup intent after the final backup succeeds, then clean files only after successful log deletion. Failed inventories survive outside session logs for manual retry; restoring a session cancels its pending marker.
- Include this changelog in the npm package and link it from both language versions of the README.

### Bug 修复 / Fixed

- 同一会话的恢复、删除和清理共用串行锁，等待中的删除会在恢复后重新检查日志，避免误走无日志清理分支。
- 恢复日志后若取消待清理标记失败，继续完成工作区挂载与置顶，并通过 `cleanupWarning` 返回原因。
- 按调用顺序完成登记队列入队，防止异步路径检查让清理越过先提交的文件登记。

- Serialize restoration, deletion, and cleanup for each session, rechecking log state after a queued restore.
- Complete attachment and pinning after a cleanup-marker reset failure, returning `cleanupWarning` with the reason.
- Admit registry operations in call order so asynchronous path checks cannot let cleanup overtake an earlier save.

### 其他重要变更 / Other changes

- 只清理登记文件，并核对路径、文件身份和内容；修改、替换、符号链接、硬链接及权限不安全的文件保留。用户工作区文件、共享附件、未登记文件和备份不在清理范围内。
- 临时产物不复制进会话备份，清理后无法通过恢复会话取回；界面开启选项前说明此行为。
- 登记存储在单个 Host 进程内串行化；不支持多个 Host 同时写入同一登记存储。
- 截图生成方接入和 DSH 核心逐版更新日志尚待核心源码工程，此插件版本不宣称它们已完成。

- Cleanup checks registered paths, file identity, and content. Modified or replaced files, symlinks, hardlinks, and unsafe permissions are retained. Workspace files, shared attachments, unregistered files, and backups stay outside its scope.
- Temporary artifacts are not copied into session backups and cannot be recovered by restoring a session after cleanup. The option explains this before it is enabled.
- Registry writes serialize within one Host process; concurrent writers from multiple Hosts are unsupported.
- Screenshot producer integration and DSH core per-version release notes still require the core source project; this plugin change does not claim to provide them.
