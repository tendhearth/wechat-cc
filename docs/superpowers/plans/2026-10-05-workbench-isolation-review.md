# 项目隔离与逐文件撤回实施计划

设计：`docs/superpowers/specs/2026-10-05-workbench-isolation-review-design.md`，主人以「go」确认继续实施。起点 `07c50c6a`，产品基线 `b2ef0c71`。整合者为本轮 Codex。

## 全局约束

- 各实现者使用独立 worktree/分支；仅整合者串行合入、部署及推送。本项目维护者规则优先于技能中共享目录的示例。
- 新建 Git 任务默认独立副本；干净且有 HEAD 的项目才准入。配置无法安全重现、子模块、merge/rebase 等明确拒绝，绝不自动回原目录。
- `Task.path` 始终是执行目录，来源项目另存；旧任务/历史不迁移，复核与额度接手继承副本。
- 可靠恢复覆盖无 writer 开始到确认 close 的会话，普通逐回合审阅不提供虚假的恢复点。
- 真实撤回仅在新隔离副本执行；完整原始字节、存在性证据、身份链、generation、HEAD/index、退出证据和独占操作占用缺一不可。
- 单文件 256 KiB，每个 before/after 阶段最多 16 MiB 原始内容与 50,000 存在性项；未知覆盖不能推断 absent。
- 未完成操作持久阻挡 workspace；恢复及人工保留当前现场不凭字节相同猜测新 writer 的归属。
- 补丁导出使用私有 index，覆盖项目范围内的提交、暂存、未暂存与非忽略新文件，排除内部/忽略材料；不修改真实 index、refs 或原项目，不交付截断/部分补丁。
- 普通任务归档保留副本。首版不自动合并原项目、不删除副本、不扩 API 工作台工具权限、不开放 Windows Codex。
- 先有能暴露缺口的行为测试与失败记录，再实现；各模块报告真实验证和限制。禁止调用用户项目、微信发送或改默认 provider 作实验。

## Review Focus

1. ignored 文件转成 unignored 不能误判新增后删除，扫描覆盖不足须不可撤回（Task 2、5）。
2. retained 自主唤醒、close 不确定与重启不能虚构恢复边界（Task 2、5）。
3. 未决 journal 阻挡新 writer，原 requestId 重试不能重新覆盖文件（Task 2、5）。
4. 原项目/副本投影及复核接手必须正确，否则丢配置、脏改动或重复注册项目（Task 1、4）。
5. 导出不能漏 untracked 或暴露 `.cc-workbench*`，真实 index/refs 必须保持（Task 1、5、6）。

---

### Task 1: Git 副本分配与完整补丁底层

**负责人范围：** 独立实现者 A；只新增本节文件和测试，不改主库迁移、任务服务、前端或 self-change。

**文件：**
- `src/core/workbench/git-runner.ts`、`git-workspaces.ts`、`git-workspace-store.ts`
- 相应 `.test.ts`，测试工具仅在测试目录/文件

**接口：**
- 导出 `GIT_WORKSPACE_SCHEMA_SQL`，表名 `workbench_git_workspaces`。完整 DDL 由模块测试使用；Task 4 在主库追加等价迁移，不能引入 lib→core 模块边界倒置。
- `createGitWorkspaces({db, root, stateDir, timeoutMs?, validateConfiguration?})` 返回 manager；校验回调参数为 `{sourcePath, executionPath, providerId}`，异步返回无凭据的配置指纹或抛准入错误。无校验回调时仅底层 fixture 可分配，生产必须传回调。
- `manager.prepare({workspaceId, ownerKey, requestId, canonicalRequestHash, sourcePath, providerId}): Promise<GitWorkspaceRecord>`；UUID、owner、请求 hash 均为冻结输入，不允许覆盖旧对象。
- `manager.get(id): GitWorkspaceRecord | null`、`manager.verify(record): Promise<void>`。
- `manager.readGitState(executionPath): Promise<{head: string; index: Record<string,string>}>`；index 指纹来自完整 stage/mode/object 条目，absence 为缺 key。
- `manager.exportPatch(record): Promise<{bytes: Buffer; sha256: string; excluded: string[]}>`；调用者 Task 5 先验证全部 writer closed 并取得 mutation reservation，底层仍核对源与结果版本。
- 记录包含设计中的来源、Git/common-dir、子目录、baseCommit、任务分支、worktreeRoot、executionPath、身份及分配状态；完整公开类型由实现者交付供后续任务消费。

**步骤：**
- [ ] 用真实临时 Git 仓库写测试：同一源项目两个 UUID 产生不同目录/分支，执行目录可改文件而源文件、源分支与 index 不变；同 UUID 请求重试同目录。
- [ ] 观察失败；实现异步安全 Git runner 和预留/分配/核对，不 `-B`、fetch、stash、force remove 或同步堵塞 daemon。
- [ ] 测试并实现脏树、无 HEAD、子模块、rebase、分支冲突、陌生目录、身份变更、超时、config 回调拒绝和创建后回执中断恢复。
- [ ] 测试项目子目录的 executionPath，hooks/fsmonitor/filter 不执行，继承 `GIT_*` 不劫持目标。
- [ ] 导出行为测试：修改、删除、已提交/暂存与未跟踪新增均在补丁；应用补丁到另一个干净 fixture 后内容相同。真实 index/HEAD/refs 和源文件不变，内部目录不出现。超限/不一致拒绝部分输出。
- [ ] Bun 与 Node 跑本节测试；类型检查并报告基线或未整合接口造成的失败。提交并写报告，精确列出导出接口。

### Task 2: 私有恢复快照、版本与撤回 journal

**负责人范围：** 独立实现者 B；只新增本节文件和测试，不修改主库迁移、任务服务、scheduler 或前端。

**文件：**
- `src/core/workbench/restore-store.ts`、`restore-snapshots.ts`、`restore-manager.ts`，必要时拆 `restore-mutation.ts`
- 相应 `.test.ts`

**接口：**
- 导出 `RESTORE_SCHEMA_SQL`，命名表均 `workbench_restore_*`，避免撞现有 run_execution。
- `createRestoreManager({db, blobRoot, readGitState, withMutation, assertWriterClosed})`；`readGitState(path)` 消费 Task 1 的结构但通过回调注入，不直接依赖未完成模块；`withMutation(workspaceId, operation)` 返回 operation 的 Promise，`assertWriterClosed(workspaceId)` 为生产闭锁检查，允许同步或异步。
- `begin({workspaceId, taskId, runId, path, directoryIdentity}): Promise<RestoreRun>`：调用者已经取得该次执行占用，writer 尚未启动；先检查持久阻挡，递增 generation，冻结 before。restoreRunId 独立且不可变。
- `markClosing(restoreRunId): void`、`markUncertain(restoreRunId): void`、`close(restoreRunId): Promise<RestoreReview>`；仅 Task 5 在确认 session.close 后调用 close；after 采集失败不虚报可撤回。
- `bindArtifact(restoreRunId, artifactId, artifactSha256): void`：绑定 Task 5 存下的公开恢复审阅摘要。原始 blob/身份链不公开。
- `list(workspaceId): RestoreReview[]`、`blocked(workspaceId): boolean`、`recover(workspaceId): Promise<void>`。
- `revert({workspaceId, taskId, artifactId, path, changeId, requestId}): Promise<RestoreOperation>`；仅从已存 manifest 定位恢复对象。
- `resolveKeepCurrent({workspaceId, taskId, operationId, observedFingerprint}): Promise<RestoreOperation>`，观察变化拒绝；不修改文件。
- `RestoreReview` 至少返回 `restoreRunId/taskId/artifactId/generation/startedAt/finishedAt/status/files` 及可存成现有 GitReview JSON 的 `review`。文件资格 DTO：`{changeId, state:'available'|'blocked'|'reverted'|'needs_recovery'|'resolved_keep_current', reason?, operationId?, observedFingerprint?}`。

**步骤：**
- [ ] 用真实临时文件和 SQLite 写恢复测试，观察失败；保存不可变 before/after 原始字节、覆盖清单、路径身份链、HEAD/index、generation。
- [ ] 修改、新增和删除 exact bytes 测试：CRLF/BOM、空文件、mode；before=absent 有明确证据。ignored→unignored、缺覆盖、超限、非 UTF-8、链接/junction/硬链接均拒绝或资格不可用。
- [ ] 用真实 Git 状态读取 fixture 覆盖 HEAD/index/staged 变化、旧 changeId/generation、另一 task/artifact、路径目录换成另一真实目录。所有拒绝后文件哈希不变。
- [ ] session 生命周期模拟只驱动真实 manager：retained 不 close 无恢复点，uncertain 不允许撤回；begin 新 writer 使旧恢复计划失效。
- [ ] 先存 journal，再文件效果；测试重复 requestId、异内容请求、blob 损坏、磁盘故障、效果后回执前中断。prepared/applying/needs_recovery 持久阻挡 begin/replay；恢复重新核对版本/身份/退出/Git。
- [ ] 人工保留现场只写回执并解除可解除的阻挡，观察指纹过期零写入拒绝，根身份失效不解锁执行。
- [ ] Bun/Node 模块测试与类型检查，提交并写接口/测试报告。测试注入仅为依赖边界，不在生产增加专用故障开关。

### Task 3: 桌面与跨端客户端的执行位置和撤回交互

**负责人范围：** 独立实现者 C；只改 apps 内客户端、desktop proxy/allowlist 和相应测试。不要改 core、daemon 或主库；避免原生 Rust allowlist 拓展漏掉对应 JS proxy。

**文件：**
- desktop task-entry/workbench-entry/review-panel/workbench.js 及 shared task-entry-contract、workbench proxy、Tauri lib.rs 相关 allowlist
- mobile 创建客户端、原生 app backend/types/live 的 EntryInput 与说明
- 对应 unit 与 desktop Playwright（使用独立 DRY_RUN fixture，禁止碰共享 daemon）

**接口：**
- 新 EntryInput 字段 `executionMode?: 'auto'|'isolated'|'project'`，创建 requestId 仍原 UUID；字段进入真实提交与重试持久草稿。位置改变用新编号，重连保留原编号核对。
- 列表任务新增可选 `sourcePath` 用于原项目分组；详情新增 `workspace?: {id, mode:'isolated', sourcePath, executionPath, branch, baseCommit}`；旧任务不含字段，按 path 兼容。
- 恢复审阅是现有 ReviewTurn 加 `restore?: {runId, scope:'closed_session', startedAt, finishedAt}`；文件增加 Task 2 的 `revert` DTO。
- 调用 `POST /v1/workbench/review-revert {id, artifactId, path, changeId, requestId}`、`POST /v1/workbench/review-revert-resolve {id, operationId, observedFingerprint}`、`POST /v1/workbench/workspace-export {id}`。
- resolve 只代表保留当前现场，reverted 才代表已撤回。导出返回 `{artifact}`，复用已有成果下载。

**步骤：**
- [ ] 客户端测试证明位置字段真的提交、原请求重试不换编号，旧任务和非 Git 显示兼容；观察失败再加最小 UI。
- [ ] Git 项目位置用已有表单样式提供「独立副本 / 原目录」，只保留交办一个主要动作；错误保留正文与附件。
- [ ] 任务按来源项目分组，说明在副本做，可打开执行目录及导出；归档说明副本保留。
- [ ] 恢复审阅明确整段会话范围，普通回合没有撤回按钮；writer 未关闭先用现有结束会话动作。确认文件影响后提交稳定 requestId。
- [ ] 模块/Playwright 验证成功、版本冲突、needs_recovery、resolve 过期、迟到响应、不切走别的任务、不丢阅读/草稿；只有真实 success receipt 显示已撤回。
- [ ] 手机/PWA/原生 Backend 传递同一位置策略并显示失败原因；不宣称手机已有逐文件撤回面板。
- [ ] 跑客户端目标测试与独立 desktop fixture，提交并写报告。

### Task 4: 持久任务绑定、异步创建与来源项目投影

**依赖：** Task 1；消费 Task 2 的 schema，可在两模块整合后开始。backend 实现者用新的独立工作区，不写 Task 3 客户端工作区。

**文件：** 主库追加迁移、workbench store/task-entry/entry-store、service entry/execute/native/view/quota、HTTP/phone/微信创建接口与 selftest；仅必要的 shared 类型协调。

**接口：**
- Task 可空 git_workspace_id；Task.path 不变，公开旧对象省略空的新增元数据，列表 sourcePath 与详情 workspace 投影由绑定记录派生。
- createEntry/create/createWechat 的有编号路径返回 Promise，所有调用点 await；低层同步 createTask 继续只负责已分配目录的短事务，禁止 await 塞事务。
- `executionMode` canonical raw auto + 首次 resolvedMode 冻结；旧无编号 create 维持原目录，有编号复用 entry 回执。managed 非 Git 维持原逻辑。
- 生产 `validateConfiguration` 将 source 和 execution 分开解析，不安全/无法重现的项目配置返回明确隔离准入错误，不静默漏工具。

**步骤：**
- [ ] 创建行为测试 red：同项目两个新有编号 entry 产生不同 path、相同 sourcePath；同编号重试同 task/workspace，异内容冲突。
- [ ] 追加 Task 1/2 等价 DDL 与 task FK 迁移，更新维护手册要求的三处迁移测试，既有 task 为 NULL 不迁移。
- [ ] 接入 prepare→verify→短事务 accepted；来源项目注册/搜索/provider 偏好/matter 使用 sourcePath，不注册每棵副本。
- [ ] 复核、修订、额度接手传播 workspaceId 与实际 path；native history 不迁移。测试用户原有未提交副本改动保留在复核里。
- [ ] 更新所有服务/HTTP/mobile/微信/selftest 调用点和协议 validators，保留未知结果时的原编号；旧无编号协议不虚报去重。
- [ ] 配置准入测试覆盖 ignored settings、按 source cwd 授权、相对/绝对 MCP 路径、模型设置遗漏；原目录明确选择仍可用。
- [ ] 目标 suite Bun/Node、typecheck、depcheck；提交并报告，根整合者 cherry-pick 后复验。

### Task 5: 关闭证明、持久操作占用、恢复审阅与管理员路由

**依赖：** Task 1/2/4 和 Task 3 的客户端协议。以已整合提交为基线；与 Task 4 串行，避免 service/state/ctx 共享编辑。

**文件：** service/state/ctx/execute/lifecycle/scheduler/review/artifacts/actions、内部 routes/tier/token 注册及恢复启动接线，相关测试。

**接口：**
- Active 保存 restoreRunId，仅 writer 启动前 begin 一次；retained 续接不 begin。确认 close 成功才 close；超时 uncertain 持久标记。
- mutation reservation 与运行 reservation 使用同一个路径冲突检查，含父子路径；prepared/applying/needs_recovery 在 start/continue/input/pump/恢复启动各门生效。
- ReviewDomain 新增 revoke/resolve/export 服务方法；revert/resolve 的 route payload 与 Task 3 一致；admin，完整 route/token/proxy 登记。
- writer close 后将 Task 2 的 `review` 保存为公开 GitReview 摘要，bindArtifact；reviewList 用真实恢复记录附 scope、资格与状态，不公开 blobs。
- workspace-export 在所有相关 writer closed 的窗口内调用 Task 1 导出并保存普通补丁成果。

**步骤：**
- [ ] 实际 WorkbenchService/SQLite/临时 Git fixture 红测试：retained 回复不能撤回，明确 close 后形成恢复快照；restore review diff 覆盖整段 session，不伪称最后回合。
- [ ] writer before/close hooks 与持久恢复记录接线；任务取消但未确认退出仍 blocked，晚到退出能正确结算。
- [ ] 扩展占用与启动恢复协调，测试撤回/continue/input/start/pump 竞争，以及同副本接手 writer 和 daemon 重启未决 journal。
- [ ] 接 route 严格验证归属、requestId、artifact/path/changeId 和 resolve 观察指纹；未知或缺恢复版本的旧成果零写入拒绝。
- [ ] 完整补丁导出经过同一闭锁窗口，公开成果注册与 receipt/seq 正确；包含 untracked，排除原始材料。
- [ ] UI成功/失败契约与前端实现一致，成功撤回下一次续接明示当前文件事实。
- [ ] 跑相关 full service、router、token/Tauri proxy 与客户端测试；提交并报告。

### Task 6: 整合验收、文档与交付

**负责人：** 根整合者；只在分配给自己的集成工作区串行操作。

**步骤：**
- [ ] 每个模块先独立审阅再整合；共享契约差异以已批准设计为准记录裁决，不能默默降级数据保护边界。
- [ ] 使用实际 HTTP+持久 SQLite+临时 Git+可控制关闭的执行者 fixture 走新建→并行→接手→close→查看→撤回→导出→重启恢复；断言源工作树/branch/index 未变。
- [ ] Bun 全套、Node 全套、typecheck、depcheck、完整 desktop Playwright；Rust allowlist 改动跑相关完整 Cargo 测试。
- [ ] 独立整支评审，修复必须覆盖失败回归；没有恢复证据或仍存在覆盖风险不发布。
- [ ] 更新 cc-workbench/roadmap/全景图中的真实交付与边界；HTML 通过 build:map 生成。纯计划和文档不伪装已实现能力。
- [ ] 推特性分支并创建 dev PR，附加本聊天，核对准确 SHA 的 CI，保留原始失败和已知额度限制。
- [ ] 按本项目既有整合授权和维护标准回路完成 dev 整合、本机部署与真执行者验收；公开 master/商店/版本发布不属于这批。
- [ ] 真验收只用自建 Git 项目与测试文件。关闭/归档测试任务，收尾仅清理本批确认归属的夹具；保留可恢复成果和代码工作树。

## 执行方式与进度记录

采用独立模块在不同工作树并行、后端共享服务串行整合的方式。A/B/C 互不写同一工作区；每项有行为测试与独立审阅，整支评审一次。根记录 baseline、任务提交、接口裁决和验证证据，避免压缩上下文后重复派发。

主人已经明确要求按这份设计继续实施；计划作为执行记录，不再次请求同一实施授权。界面、默认策略或数据保护边界需要超出设计时才请求新的决定。

## 10 月 8 日上游对齐

恢复实施时 dev 已到 `b92b46cd`，加入独立工作区、按回合 diff 撤销、写入者退出处理及自定义 ACP。根整合树已合入该基线；Task 4 和 5 以这些现有入口为基础补齐批准的安全契约。保留已存在的显式提交和删除动作、旧工作区显示及 accepted 回执，不再实现平行入口。旧 `target.isolation` 保留兼容，新编号协议采用本设计的执行位置策略；旧 hash 按原归一化验证，不制造历史恢复点。当前 diff 倒推不满足私有原始字节、存在性覆盖、代际、journal 和整段关闭会话证明，需要由可靠恢复流程接替。各实现者仍仅写自己的独立工作树。
