# 更新日志 / Changelog

本文件记录 **dsh-session-backup 插件** 的版本变化。DSH 核心发行版的新增功能、Bug 修复与迁移说明由核心项目维护，本文件不代表 DSH 核心更新日志。

This file records releases of the **dsh-session-backup plugin**. It is separate from DSH core release notes and migration guides.

从本次预览版本开始维护，按插件的实际版本和发布日期保留条目，最新版本放在最前。正式版和预览版均列出新增功能、功能调整、移除功能和 Bug 修复，无对应变更时明确写“无”；发布时同步到对应的 GitHub Release。不倒推未经核实的历史版本。

Starting with this preview release, each release preserves its entries under the actual plugin version and release date, newest first. Stable and preview releases both list Added, Changed, Removed, and Fixed, explicitly stating “None” for empty categories, and publish the same notes on the corresponding GitHub Release. Do not reconstruct unverified historical releases.

## 0.4.5-preview.2 — 2026-11-27

预览测试版，通过 npm 的 `preview` 标签发布；正式版仍使用 `latest` 标签。

Preview release published under the npm `preview` tag; stable releases continue to use `latest`.

### 新增功能 / Added

- 无。
- None.

### 功能调整 / Changed

- 将上传副本的“本次运行保护”与“附件观察器在 Host 启动后才启用，需重启后重试”分开提示，明确各自的重试条件。
- Distinguish protection during the current Host run from deferral caused by activating the attachment observer after startup, with separate retry guidance.

### 移除功能 / Removed

- 无。
- None.

### Bug 修复 / Fixed

- 首次热启用附件观察器造成的正常保护不再同时计为回收失败，也不再误称所有暂缓副本都已在本次运行使用。
- 合并重复的真实失败原因，保留失败数量与警告；单删、批删、删除备份和重试共用准确的回收详情。
- Stop counting expected protection after first hot activation as a reclamation failure or claiming that every deferred copy was used during this Host run.
- Deduplicate repeated failure reasons while retaining failure counts and warnings. Share accurate reclamation details across individual deletion, batch deletion, backup removal, and retry.

### 升级说明 / Upgrade notes

- 安装或更新后重启 DSH 后端（`dsh web`），再刷新页面。仅刷新浏览器不能解除热启用保护。仍被会话或备份引用的上传副本继续保留，原件不受影响。
- Restart the DSH backend (`dsh web`) after installing or updating, then refresh the page. A browser refresh alone does not clear hot-activation protection. Copies still referenced by sessions or backups remain retained; originals are unaffected.

## 0.4.5-preview.1 — 2026-11-26

预览测试版，通过 npm 的 `preview` 标签发布；正式版仍使用 `latest` 标签。

Preview release published under the npm `preview` tag; stable releases continue to use `latest`.

### 新增功能 / Added

- 增加独立且默认关闭的 `cleanupAttachmentsOnDelete` 开关，在删除会话、删除备份及重试时回收不再被任何会话或保留备份引用的上传图片、文件副本；用户原件不受影响。
- 删除前持久登记候选，完整扫描各代原始/压缩日志、历史与全部保留备份；保留备份仍引用时不回收。候选跨重启保留，只处理明确删除产生的候选，不扫描清除历史孤儿文件。
- 使用观察器保护尚未提交到会话的新上传，以及本次附件后端运行期间读取或解析过宿主路径的对象；界面显示实际回收数量、字节数、保留/暂缓数量和失败原因。

- Add an independent, off-by-default `cleanupAttachmentsOnDelete` setting to reclaim uploaded image and file copies after session deletion, backup removal, or retry only when no session or retained backup references them. User originals are unaffected.
- Persist candidates before removal and scan all raw/compressed log generations, history, and retained backups. Referenced uploads remain protected. Candidates survive restarts; only explicit deletion candidates are collected, with no historical orphan sweep.
- Observe backend use to protect staged uploads and objects read or resolved to host paths during the backend lifetime. Display reclaimed counts and bytes, retention, deferral, and failure reasons.

### 功能调整 / Changed

- 侧栏“临时文件”入口更名为“文件清理”，分别控制登记临时文件与上传副本；已有临时文件开关不会自动授权附件回收。
- Rename the sidebar entry from “Temporary files” to “File cleanup”, with separate controls for registered artifacts and uploaded copies. Existing artifact permission never authorizes upload collection.
- 删除先尝试预备份，再停止活动、获取写租约并严格保存最终备份；仅因源持续变化无法取得一致副本时，允许已授权的停止继续，其他预检查错误立即中止。空闲删除将定时任务清理延后到最终备份成功后。缓存和工作区记录改为日志删除成功后清理，失败以警告返回，重复删除可重试。
- Attempt a preflight backup before stopping activity, then acquire the write lease and save a strict final backup. Only a changing-source consistency failure permits the authorized stop to proceed; other preflight errors abort. Idle deletion defers reminder removal until the final save succeeds. Clear caches and workspace membership after log removal; return warnings and allow idempotent cleanup retries.

### 移除功能 / Removed

- 无。
- None.

### Bug 修复 / Fixed

- 拒绝会话目录、源文件、备份存储和恢复目标路径上的符号链接，防止备份不是独立副本或清单被写入链接指向的目录。
- 持久化状态读取失败立即拒绝删除，不再误报会话已消失、清掉工作区成员关系并发出删除成功事件；目录仍存在时也不会误入残留清理。
- 损坏的归属清单逐项保留并报告，不再使设置和全部待清理重试失效；健康清单仍可清理。
- 清单已发布后，目录同步失败不会再删除已登记对象，避免留下指向已被回滚对象的清单条目。
- 恢复反馈显示清理标记警告，区分删除进行中与会话已存在，并保留恢复成功结果，即使后续列表刷新失败。
- 单删对话框切换会话时清除旧错误；批量删除中途失败保留成功统计与剩余选择，同时显示活动跳过和清理待重试信息。

- Refuse symlinks in session sources, backup stores, and restore targets to prevent linked backups and redirected manifest writes.
- Refuse deletion on persistence read errors rather than falsely reporting an absent session, removing workspace membership, and emitting success; an existing directory also prevents residual-only cleanup.
- Retain and report corrupt ownership ledgers individually while continuing settings reads and healthy pending cleanup.
- Preserve registered objects after ledger publication when directory synchronization fails, avoiding references to rolled-back objects.
- Display restore cleanup warnings, distinguish deletion in progress from an existing session, and preserve successful restore feedback if list refresh fails.
- Reset stale single-delete errors; preserve completed counts and remaining selections on batch failure while showing both active skips and pending cleanup.

### 升级说明 / Upgrade notes

- 安装或更新到此预览版后，需停止并重新启动 DSH 后端（`dsh web`），再刷新页面；仅刷新浏览器不会替换已加载的后端代码。两个文件清理开关均默认关闭，已有临时文件清理设置不会自动开启上传附件回收。
- After installing or updating to this preview, stop and restart the DSH backend (`dsh web`), then refresh the page. Refreshing the browser alone does not replace loaded backend code. Both cleanup options default to off; an existing artifact setting never enables upload collection automatically.

### 使用边界 / Limitations

- 停止事件由宿主执行且会清除活动定时行，无法回滚；若停止后最终备份才失败，日志与已有备份保留，已停止活动不会恢复。截图等生成方仍需接入登记接口，未登记产物不会自动清理。
- Host stop events also remove active reminders and cannot be rolled back. A final-backup failure after stopping preserves the log and existing backup, but does not restart stopped activity. Producers still need to adopt artifact registration; unregistered files are not imported.
- 附件回收只支持单个标准 Web Host、匹配的本地附件与会话存储，且观察器必须在 Web 监听启动前安装。首次热加载会保留附件直到 Host 重启；本次后端运行期间新上传、读取或解析过宿主路径的对象保护到后端退出。SDK/ACP、自定义启动写入方与多 Host 共用存储不在支持范围内，应保持该开关关闭。请求图片派生缓存和临时上传文件不回收。
- Upload collection supports a single standard Web Host with matching local attachment/session stores and an observer installed before listener startup. First hot activation retains objects until restart; uploads admitted, read, or resolved to host paths during this backend lifetime stay protected until it exits. SDK/ACP, custom startup writers, and multiple Hosts sharing storage are unsupported and should leave the option off. Derived request-image caches and temporary upload files are excluded.

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
