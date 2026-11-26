# dsh-session-backup

中文 | [English](./README.en.md) · [更新日志](./CHANGELOG.md)

在 DeepSeek Harness Web 里**彻底删除会话前自动备份**，为会话列表加上多选批量删除/批量备份，并支持一键恢复备份 —— 全部以用户插件实现，不改动任何已安装的 harness 文件。

**彻底删除能力本身也由本插件提供**（行菜单删除入口、确认对话框、级联引擎全在插件内），因此升级 harness 不会丢失删除：上游 ≥ 0.2.1-alpha.5 没有内核删除，本地 alpha.3 的内核删除行会被本插件遮蔽，两个版本都只渲染本插件这一行。

## 功能速览

| 功能 | 在哪里看到 |
| --- | --- |
| 删除前自动备份 | 无需操作 —— 确认 **彻底删除…** 时静默保存最新备份，保存成功才删日志 |
| 多选 + 批量备份/删除 | 侧边栏底部的 **多选**、每一行的复选框，以及每个会话「…」菜单里的 **选择/加入选择** |
| 备份管理器 + 一键恢复 | 侧边栏底部的 **备份**。恢复成功后备份被取走（恢复 = 取回），会话置顶出现在其分组最前；原工作区已不存在的会话会出现在侧栏「未分组」下 |

空白占位行（临时的「新建会话」行）和已归档的行没有复选框：harness 不为它们渲染状态槽位也不渲染自己的操作，因此无法被选中。它们没有需要保留的对话，下一次「新建会话」会领养那个空白行。

## 备份保证

- **先备份、后删除**：单个与批量删除先尝试预备份，在停止收尾并取得写租约后再校验、保存**最终备份**，成功后才删日志。预备份的路径、读写等错误不会停止活动、清除定时任务或移除工作区记录；仅因源持续写入而无法取得一致副本时，已明确授权的「停止并删除」可以继续停止，再严格保存最终备份。最终备份失败保留已有备份与会话日志。只有持久化查询与目录检查都确认日志不存在时，才进入残留清理。
- **同一份内容只留一份**：以内容指纹（逐文件「相对路径:sha256」）比对，完全一致 → 直接复用已有备份（`reused: true`），不新增目录；内容有变化 → 更新最新备份的**同一路径**（`updated: true`），所以「先手动备份、再点删除」始终只有一份。新副本先完整写入并校验成功才替换旧副本，失败则保留旧备份并中止删除。重复的备份请求一律按更新处理，已有的历史备份不会被批量清理。
- **并发安全**：同一会话的备份 / 恢复 / 删除备份请求串行执行，手动备份和删除同时点也不会各写一份。

## 可选的会话文件清理

侧栏底部 **备份** 旁的 **文件清理** 提供两个独立开关，**均默认关闭**，对单个和批量删除生效：

- `cleanupOnDelete`：删除会话时清理已登记临时文件。
- `cleanupAttachmentsOnDelete`：删除会话或备份后，回收不再被任何会话或保留备份引用的上传图片、文件副本。

开关分别保存；已有临时文件清理授权不会自动开启上传附件回收。配置不可编辑时会说明原因，不会假报保存成功。

### 已登记临时文件

只清理由生成方通过 `ctx.get('sessionArtifacts').save(sessionId, filename, bytes)` 新建并登记的文件，存放在 `$DSH_HOME/session-artifacts/objects/<sessionId>/`；归属清单独立保存在 `session-artifacts/registry/`。接口接收内容字节，不接受已有文件路径。**已有截图、任意 shell 生成文件和旧会话未登记文件不会自动纳入清理**，生成方需要主动接入接口。

最终备份成功后记录待清理标记，确认会话日志删除成功后才清理临时文件。失败记录跨重启保留，可在 **文件清理 → 重试待清理文件** 重试；重试会再次确认会话不存在。个别归属清单损坏时保留原文件并显示原因，不阻塞健康清单的读取与重试。恢复会话会取消临时文件的待清理标记，取消失败时仍完成恢复并在界面显示 `cleanupWarning`；列表刷新失败也不会把已成功的恢复显示成失败。

工作区文件、上传附件和备份不属于此开关的清理范围。文件被修改、替换、改成链接或权限不安全时会保留。临时产物**不包含在会话备份中，清理后无法通过恢复会话取回**。登记操作只支持单个 Host 进程写入同一存储。

### 上传的图片和文件副本

上传副本与用户原件独立。回收仅处理本次明确删除的会话或备份日志中登记的候选，清单保存在 `$DSH_HOME/attachment-cleanup/registry/`，不扫描清除历史孤儿对象。扫描会覆盖全部物理日志代次（含 zstd 压缩）、历史、分叉与压缩前记录，以及所有保留备份；无法完整读取或引用发生变化时保留候选并报告原因。

**删除会话通常不会立即回收附件**，因为自动保存的最终备份仍引用它们。删除最后一份引用备份后才可能回收；其他会话仍引用或恢复了会话时也会保留。普通文件的内容对象与内部同内容命名硬链接一并校验、回收；不符内容、替换文件、符号链接及额外硬链接会保留。用户原件、工作区文件、请求图片派生缓存和临时上传文件不会删除。界面分别显示实际回收数量与字节数、保留/暂缓数量和失败原因；候选跨重启保留并可重试。

安全回收要求单个标准 Web Host、匹配的本地附件和会话存储，并在 Web 监听启动前安装使用观察器。首次热加载此功能会保留附件，需下次重启 Host 后重试。当前 Host 运行期间新上传、读取或解析过宿主路径的附件会保护到该附件后端退出，避免尚未提交到会话的上传被误删。SDK/ACP、自定义启动写入方及多个 Host 共用存储不在支持范围内；不要在这些部署中开启此选项。

本插件的逐版变更见 [更新日志](./CHANGELOG.md)；截图生成方的接入与 DSH 核心逐版更新日志仍需核心源码工程，本插件没有代替它们。

## 快速开始

1. 安装见下方 [安装](#安装)，装完重启一次 `dsh web`。
2. **备份**：单个会话「…」菜单 → **立即备份**；勾选多个 → 侧栏底部 **备份选中**。
3. **删除**：**彻底删除…**（会话正在运行时，对话框会原地升级为「停止并删除」）；勾选多个 → **删除选中**。
4. **查看 / 恢复**：侧栏底部 **备份** → **恢复**。会话置顶出现在其分组最前，侧栏自动刷新，无需手动刷新页面。

## 备份存放位置

```
$DSH_HOME/backups/sessions/<sessionId>/<timestamp>-<title>/
├── session.v4.jsonl.zstd        # 会话自身的目录，原样复制
├── …
└── backup.json                  # 清单：sessionId、title、createdAt、sourcePath、size、inventory（内容指纹）
```

目录名是本地时间戳（`20261017-184533`）加上会话的**当前标题**，并针对文件系统做了净化（`/ \ : * ? " < > |` 和控制字符替换为空格，最长 48 个字符，若无可用内容则为 `untitled`）。同一秒内的两次备份会得到 `-1`、`-2` … 后缀。`session.lock` 和 `.DS_Store` 永远不会进入备份；清单文件 `backup.json` 在恢复时也不会被复制回去。

备份复制会话日志，附件仍位于同一 `$DSH_HOME` 的内容寻址存储中，不嵌入备份目录。关闭附件回收时保持原有存储；开启后保留备份中的引用同样会保护附件。备份目录不是可脱离原附件存储的独立迁移包。

## 删除引擎的工作原理

删除的整条链路都在本插件内，不经过任何内核方法 —— 上游 rc.2 没有 `ctx.remote.session.deleteSession`，本插件也不依赖它：

1. **菜单行**：注册到官方插槽 `sidebar.workspaces.session.menu.item`，同时用**双注册**保证任何内核只出现一行删除 —— `id: 'delete'` 以 `priority: -1` 注册一个渲染 `null` 的遮蔽行（把本地 alpha.3 自带的内核删除行挡掉，与注册先后无关）；`id: 'session-delete'`、`order: 460` 注册本插件真正的删除行（紧挨「归档会话」之后）。上游 rc.2 没有内核删除行，遮蔽行是惰性的，菜单顺序与 alpha.3 完全一致。
2. **确认对话框**：注入 `shell.overlay`，空闲态直接打开 danger 确认（文案逐字对齐内核：永久删除日志与缓存、工作区文件不受影响）。
3. **活动闸门（409 升级）**：宿主问 `workspace/session-activity` 瀑布（与内核归档同一组 provider）。有活动时返回 `409 workspace/session-active` 并携带活动清单 —— 客户端把**同一个对话框**原地升级为「停止并彻底删除此会话？」+ 活动列表 + 「停止并删除」按钮，与内核的 busy 升级行为逐字节一致。
4. **预备份与停止**：先读取持久化状态并检查目录，读取异常立即拒绝。日志存在时先保存预备份；`stopActivity: true` 才发 `workspace/session-stop`（停止 agent/jobs/subagent 回合，宿主的 schedule provider 同时清掉活动定时行），再 quiesce 裸 agent、detach store 条目并等活动闸门转空。空闲删除不调用停止事件。停止操作本身不可回滚：如果停止后的最终备份才失败，会话日志和已有备份保留，但已停止的活动、已清除的定时行不会恢复。
5. **级联**：取得独占写租约 → 保存含收尾事件的最终备份 → 可选登记清理意图 → 清除 schedule 定时行（失败即中止）→ 删除日志并复检 → 尽力清理 spill / 投影缓存 / 工作区记账 → 发出 `api-session/removed`。文件系统删除全程持有租约；调用自带租约的原生 `remove()` 前释放插件租约。日志已删后的缓存清理失败通过 `deleted.warnings` 报告，可重复删除以重试，不会把已完成的日志删除报告为失败。按独立开关回收无引用的候选上传副本；保留备份仍会保护附件，工作区目录与用户原件不动。
6. **备份先行**：预备份与最终备份共用内容指纹与原路径，未变化时复用，不产生重复副本；备份失败不会发布不完整副本。备份、恢复目标及其存储目录的符号链接被拒绝，防止链接把复制或清单写入重定向到其他位置。

同 id 会话的并发删除共享第一次的结果。重复删除返回成功，并重试缓存清理；开启临时文件清理时也会重试该会话的待清理文件。

备份失败时的语义：

| 失败情形 | 结果 |
| --- | --- |
| 备份路由返回真实错误（磁盘满、冲突……） | 删除**被拒绝**，错误对话框显示原因 |
| 日志删除后缓存清理某一步失败 | 删除成功，响应含 `deleted.warnings`；保留最终备份，重复删除可重试缓存清理 |
| 会话已无目录可供备份 | 无可复制内容；不存在的会话仍按原语义返回 404 |
| 活动闸门拒绝（会话正在运行） | 409 升级到「停止并彻底删除」对话框，等用户二次确认 |
| schedule 定时行清理失败 | 删除中止（`gateway/internal`），防止日志被定时投递复活 |

## HTTP 路由

七个路由路径都注册在 Host 连接的 `/api` 之下，由浏览器按文档相对路径访问（`.slice(1)`），并返回 JSON：

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| `GET` | `/api/session.backup.list` | — | `{ backups: [...] }`，最新的在前 |
| `POST` | `/api/session.backup.create` | `{ sessionId, beforeDelete? }` | `{ backup }`，含 `path`、`title`、`dirName`、`bytes`、`consistent`、`reused`（完全相同则复用）、`updated`（内容变化则更新原目录）；默认更新最新备份，显式 `beforeDelete: false` 才保留为独立历史快照 |
| `POST` | `/api/session.backup.delete` | `{ sessionId, stopActivity? }` | `{ deleted }`；活动闸门拒绝时 409 + `details.activity`，未知 id 404，schedule 清理失败 500 `gateway/internal` |
| `POST` | `/api/session.backup.restore` | `{ path }` | `{ restored }`，含 `attached`、`placement`、`workspaceId` / `reason`、`backupConsumed`、`pinned`（已置顶到分组最前，置顶被拒时为 `false`）；若会话已再次存在则返回 409（备份原样保留） |
| `POST` | `/api/session.backup.remove` | `{ path }` | `{ removed }`；清理空分组；开启附件回收时含 `removed.attachments` |
| `GET` / `POST` | `/api/session.backup.cleanup-settings` | 读取无请求体；保存为 `{ cleanupOnDelete?: boolean, cleanupAttachmentsOnDelete?: boolean }`，至少一项 | `{ settings: { cleanupOnDelete, cleanupAttachmentsOnDelete, editable, pending, attachmentPending, pendingErrors?, attachmentPendingErrors? } }`；分别报告两类清单损坏，设置不可保存时返回 409 |
| `POST` | `/api/session.backup.cleanup-retry` | `{}` | `{ results, settings }`；仅重试已开启类别，两个开关均关闭时返回 409；临时文件须确认会话不存在，附件按全部引用判断 |

`sessionId` 必须匹配普通的 id 模式，且每一条客户端提供的路径都会被校验必须严格位于其根目录之内，因此任何请求都无法触及备份库之外。标题来自 `sessionQuery` 服务（`readTitle`），读不到时回退为 `untitled`。在复制一个正在运行的会话之前，host 会通过 `sessions` 服务把内存中的日志落盘 —— 与 `dsh-session-log-export` 使用的是同一道屏障 —— 并在复制后重新校验每个文件的大小，因此仍在追加的日志会被重新复制，最终还会按 SHA-256 比较源与副本。若源持续变化、刷新或复制失败，请求报错且保留旧备份，不发布不完整副本。

`readTitle` 的返回既可能是裸字符串，也可能是标题提供方的快照记录（`{ title, source, eventSeq, … }`），具体取决于该 profile 拥有哪种查询服务；两种形式都会被解包，所以备份会以侧边栏显示的标题命名，而不是一个笼统的 `untitled`。

## 恢复还会把会话放回侧边栏

把目录复制回去只是恢复的一半。删除会话会做两件事 —— 移除目录*以及*从其 Workspace 记录中丢掉该 id —— 而侧边栏列出的是 Workspace 成员关系，不是原始的目录树。

所以 `restore` 最后会通过 harness 自己的 API 重新附加该 id：`workspace.attachSession(sessionId)`。该调用会从持久化层重新读取恢复后会话的头部，并且除非其 `cwd` 解析到该 Workspace 的路径，否则拒绝附加，因此恢复不会把会话挂到错误的项目上。

**恢复成功后会删除该备份**（恢复 = 取回，响应里 `backupConsumed: true`）。只有恢复被拒绝时（会话已存在 → 409）备份才原样保留。删除是 best-effort：清理失败不会让一次已经成功的恢复失败，此时 `backupConsumed: false` 如实上报。

恢复成功后，客户端会**立即刷新侧栏列表**（不需要手动刷新页面），并把该会话**置顶到其分组最前**——工作区组和「未分组」组都生效（registry pin 是全局的，置顶帧实时推给浏览器）。置顶是 best-effort：会话已归档等拒绝不影响恢复结果，此时响应里 `pinned: false`。

没有匹配工作区的会话也不会消失：rc.2 的侧栏有原生的「未分组」分组，不属于任何工作区的会话显示在那里（删除一个工作区时也是同样行为 —— 它的会话进入「未分组」）。`placement` 说明这次恢复的落位：

| `restored.placement` | 含义 |
| --- | --- |
| `workspace` | 已重新附加；`workspaceId` 指明是哪个 Workspace，会话回到原分组并置顶到最前（侧栏自动刷新，无需手动刷新页面） |
| `ungrouped` | 文件已恢复，会话显示在侧栏「未分组」下 —— 没有 Workspace 匹配日志的 `cwd`（例如原工作区已被删除），或该 profile 没有 `workspaceRegistry` |
| `unknown` | 罕见：恢复后的日志头部不可读，或 `attachSession` 拒绝 —— 文件已恢复，`reason` 说明原因 |

附加失败绝不会让整个请求失败：数据字节已经恢复。

## 两个面：`index.js` 与 `client.js`

Harness 会用两套不同的模块系统加载本包两次：

| 面 | 文件 | 消费方 |
| --- | --- | --- |
| host（Node） | `index.js` | `dsh`，通过 `exports["."]` 导入 |
| 浏览器 | `client.js` | web host，通过 `exports["./client"]` |

Web host 会把每个 `dsh.client.platform: "web"` 包的客户端文件拼接成一批**经典脚本**，从 `/plugins/...` 提供服务，因此 `client.js` 必须用 `window.__ModuleLoader__.load({ id, factory })` 注册自身。若直接交给它原生 ESM，整批脚本都会以 `SyntaxError: Unexpected token 'export'` 失败，启动画面会报告 `import failed (see console for the import error)`。

`client.js` 由 `src/client.mjs` 生成 —— 永远不要直接编辑它：

```sh
node scripts/build-client.mjs   # 编辑 src/client.mjs 后重新生成 client.js
```

构建脚本会把每条 ESM import 改写为同一标识符的 `require()`（`react` 和 `@deepseek-ai/dsh-client-ui-primitives` 是种子词），去掉 `export` 同时记录导出的名称，遇到 Node 内建模块、`export default` 或任何它无法承载的形式都会立即报错。

## 测试

```sh
npm test
```

十一个纯 Node 测试套件，跑在系统临时目录上，**不需要启动 harness、真实会话或网络**：

| 套件 | 覆盖 |
| --- | --- |
| `test/delete-routes.mjs` | 删除引擎两版 seam（alpha.3 / rc.2）、活动拒绝与停止升级、写租约、幂等 |
| `test/restore-route.mjs` | 恢复 = 取回（消费备份）、工作区重挂载、置顶与置顶被拒 |
| `test/reuse-backup.mjs` | 内容指纹复用：不变内容不重复写入 |
| `test/backup-delete-regression.mjs` | 「先备份再删除」只留一份：内容变化、并发、停止时收尾事件、备份失败中止删除 |
| `test/client-delete-flow.mjs` | 浏览器侧真实 `createActions` 的请求序列：删除只调一次、恢复后刷新侧栏 |
| `test/artifacts.mjs` | 登记持久化、修改和链接保留、跨实例并发登记与清理 |
| `test/cleanup-routes.mjs` | 默认关闭、先备份后清理、失败重试、恢复保护与配置保存 |
| `test/attachments.mjs` | 上传引用、压缩日志、对象和命名链接、损坏保留、使用观察器与持久候选 |
| `test/attachment-routes.mjs` | 独立开关、最终备份保留引用、删除最后备份回收、恢复与重试保护 |
| `test/client-cleanup-flow.mjs` | 两个开关独立保存、失败状态、附件回收统计、备份旁入口及禁用条件 |
| `test/cleanup-concurrency.mjs` | 恢复先于删除时重新核验日志、待清理标记损坏时仍完成恢复 |

## 安装

从 npm：

```sh
dsh plugin --profile <你的 profile> add dsh-session-backup
```

> ⚠️ npm 上的发布可能滞后于本仓库。要确保拿到最新行为，请从 GitHub 或本地检出安装。

从 GitHub（固定 tag 或 commit 可获得可复现的安装）：

```sh
dsh plugin --profile <你的 profile> add github:overspread/dsh-session-backup
```

从本地检出：

```sh
dsh plugin --profile <你的 profile> add /path/to/session-backup
dsh --profile <你的 profile> --dump-config   # 应能看到 "# == dsh-session-backup" 这一层
```

然后重启 `dsh web` 服务 —— host 会在内存中缓存每个包解析出的客户端包路径，因此新增、移除或重新指向 `exports["./client"]` 只有在全新启动时才会生效。

## 可经受 harness 升级

插件位于你的 profile（`~/.dsh/profiles/<name>`）中，而不是已安装的 harness 内部，所以升级 `dsh` 不会移除它。卸载用 `dsh plugin --profile <name> remove dsh-session-backup`。

## 发布

发布新版本：

```sh
node scripts/build-client.mjs
npm version patch
npm publish                # 需要 npm 登录；tarball 会带上构建出的 client.js
git push --follow-tags
```

本包没有运行时依赖；打包前请先运行构建，以便 tarball 中的 `client.js` 与当前的 `src/client.mjs` 一致。`package.json` 中的 `files` 列表会把 `node_modules` 和 `src/` 排除在 tarball 之外。

## 许可证

[MIT](./LICENSE) © overspread。

这是一个个人的社区插件。它不由 DeepSeek 开发、背书或支持，也不是 DeepSeek Harness 发行版的一部分。它只在你自己的 `$DSH_HOME` 内读写；像任何会在你机器上运行的第三方插件一样，安装前请审阅源码。

## 自动发布到 npm

发布由 GitHub Actions 完成，本地不需要 `npm publish` 或验证码。打 tag 即发布：

```sh
# 先改 package.json 的 version，再打同名 tag
git tag v0.4.4
git push origin v0.4.4
```

工作流 `.github/workflows/publish.yml` 会依次：校验 tag 与 `package.json` 版本一致 → `npm ci` → 构建 `client.js` 并检查它未过期 → 跑测试 → 以 `npm publish --provenance` 发布 → 触发 npmmirror 同步。

需要先在 npmjs.com 该包设置里添加 **Trusted Publisher**：仓库 `overspread/dsh-session-backup`，工作流文件名 `publish.yml`。之后 CI 用 OIDC 短期凭据发布，无需任何长期 npm token，也无需本机 2FA。

手动发布仍然可用（`npm publish`），会要求输入验证码。
