# 手机长期记忆纠正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 普通用户在手机 CC 页面逐条改正、标过时或移除长期记忆，保存立即可见，旧素材和迟到夜间整理不能覆盖程序明确保护的结果。

**Architecture:** memory.md是唯一正文，隐藏编号与侧文件提供CAS、幂等和恢复。手机、桌面与nightly共用daemon提交门；旧素材按来源版本屏蔽，不做语义删除证明。

**Tech Stack:** TypeScript、Node fs/crypto、Bun/Node 双运行时、Vitest、原生手机 JavaScript/CSS、现有 daemon/token/加密隧道；不增加数据库或第三方依赖。

**Spec:** [04-记忆纠正设计.md](../specs/2026-09-26-memory-review.md)。执行者必须先读设计与 `docs/maintainer/README.md`、`docs/INDEX.md`。

## Global Constraints

- 基线 `origin/dev`（`39cf7f5f`）；本计划未执行，所有复选框保持未勾选。计划已归档到本任务独立工作区。
- 本任务只在已分配工作区和codex/cc-task-entry开发；dev由整合者集成，master仅squash PR。他人工作区不可修改；共享部署/推dev前必须确认整合者。
- 五栏、隐藏 m:id、每条200个 JS UTF-16 code units、全文3000字；保留未知栏目与手写内容，不建第二知识库。
- 动作固定 correct/outdated/remove；不做撤销、全局语义遗忘或删除全部历史；用户可见范围说明按设计原文。
- request_id UUID；回执上限1000条/7天，取较早边界；素材版本对与退役记录各10000上限；控制文件4MiB上限。超限拒绝，不静默丢保护。
- 当前单 daemon 串行同步 CAS 是保证边界；外部文件变更必须检测、显式采用，不承诺任意进程间事务。
- 手机路由沿用 settings-panel 鉴权；素材只读当前 owner 与既有本机导入 opt-in；测试不碰真实主人数据。
- 所有新增符号均为拟定义接口，既有文件以基线核实。

## Review Focus

- LAN 已提交但响应丢失，隧道重发：只能返回一次成功记录，不能重复修改（任务1、4）。
- 文档替换后进程退出、控制状态仍旧：重启恢复同一操作，外部新内容不能被恢复覆盖（任务1）。
- 桌面整文编辑移除编号或重加旧句：主人明确保存胜出、不能绕开 CAS 或静默解除其它保护（任务3）。
- 移除最后一条后记忆为空：不会把旧 profile 草稿作为新记忆重新注入（任务6）。
- 手机保留草稿时后台刷新、401或迟到响应：草稿不丢、不假装保存成功（任务5）。

---

## 文件地图与实施次序

新增：`src/daemon/memory/curated-commit.ts`、`curated-review.ts`、`nightly-material.ts`、`curated-prompt.ts` 及各自 `.test.ts`；`src/cli/curated-memory.ts` 及测试；`scripts/memory-curated-browser-smoke.ts`（临时数据集成夹具）。新运行时文件仅 `.memory-review-state.json` 和 `.memory-review-journal.json`，位于 owner 记忆目录。

已有改动分工：任务1持有文档/提交门；任务2持有 nightly；任务3持有 internal-api、CLI和桌面；任务4持有 settings-panel/接线；任务5持有手机；任务6持有 prompt 接线与总体验证。共享 main.ts、wiring 和 settings-panel 的改动顺序合入；不允许两个实现者同时写一份工作区。

顺序1→2→3→4→5→6。每任务红测→实现→绿测→审阅→提交；本轮仅交计划。

## 公共契约（拟新增，任务1拥有）

- `ReviewAction = 'correct' | 'outdated' | 'remove'`。
- `ReviewInput = {request_id:string; revision:string; id:string; action:ReviewAction; text?:string}`。
- `ReviewResult = {ok:true; request_id:string; revision:string}`；错误为带 status/code 的 `CuratedReviewError`。
- `MaterialVersion = {sourceKey:string; versionHash:string; text:string}`；`MaterialRef` 为去掉 text 的同一类型。
- `ReviewSnapshot = {content:string|null; revision:string|null; state:ReviewState; requiresAdoption:boolean}`；`ReviewState` 结构、上限与磁盘名字按设计§4，另存最近已提交正文 hash 用于外部变更检测。
- `CuratedCommitter.read():ReviewSnapshot`；`recover():void`；`commit({expectedRevision, requestId, payloadHash, content, nextState, event, adoptExternal?}):ReviewResult`。requestId也是event_id；nightly另生成UUID。
- `CuratedReviewService.snapshot():ReviewSnapshot`；`review(input:ReviewInput):Promise<ReviewResult>`；`replace({request_id,revision,content,adopt_external?}):Promise<ReviewResult>`。replace仅桌面/CLI调用。
- `CuratedReviewService` 构造依赖 owner resolver、committer、`materials():Promise<MaterialVersion[]>`、now/newId；导出类型集中在 `curated-review.ts`，committer 的磁盘状态类型在 `curated-commit.ts`。跨层用type import，避免循环。

### Task 1: 可恢复的逐条更正与统一提交门

**Files:** Create `src/daemon/memory/curated-commit.ts`、`curated-review.ts` 及两个测试；Modify `src/daemon/memory/curated-doc.ts`；Test `src/daemon/memory/curated-doc.test.ts`。Reuse `src/lib/memory-derived-state.ts`、既有安全路径规则。

**Interfaces:** Consumes 既有 parseMemoryDoc/serializeMemoryDoc/assignMissingIds、invalidateDerivedMemory。Produces 上述公共契约及 `makeCuratedCommitter({root,owner,now})`、`makeCuratedReviewService({ownerChatId,committer,materials,now,newId})`。

- [ ] **Step 1 — 写失败测试。** 同ID/栏目与extra保留；非法动作、多行、空白、201字、注释标记400；重复ID409、无ID不猜、未知ID404。旧revision不覆盖；同UUID同负载eventCount=1、异负载409；路径/符号链接不越界。第1001条/第8天淘汰回执后重放409；容量超限不落journal。
- [ ] **Step 2 — 运行新测试看红。** `bun --bun vitest run src/daemon/memory/curated`；预期新接口/行为断言FAIL，不接受环境错误。
- [ ] **Step 3 — 实现状态与恢复。** 实现设计§4的侧文件、0600/wx、双哈希和无await提交。给journal创建、文档rename、控制rename、审计append、journal删除设故障注入。四种组合恢复到after；未知现值/损坏状态503保留。审计event_id去重；末尾半行/中部损坏按设计处理。
- [ ] **Step 4 — 实现更正服务。** 新增committer.replay(requestId:string,payloadHash:string):ReviewResult|null；在异步收集材料前先查回执，无回执才采集并同步CAS，最终commit再次先receipt后revision。成功换epoch；保存保护/退役hash与素材refs，正文仅memory.md、审计和短命journal；提交前检查容量/清理，不改lastRunIso。补测试：已成功后materials抛错，相同请求仍直接返回原回执。
- [ ] **Step 5 — 补故障测试并转绿。** 每个故障点重建service，文档/控制/receipt一致、审计一次；未知内容不覆盖；派生失效失败不写journal；NFKC/空白/保留标点有断言。重跑Step2全PASS。
- [ ] **Step 6 — 审阅并提交。** 确认故障点齐全、侧文件不进素材。仅暂存本任务文件；`git commit -m "feat: add recoverable curated memory review"`。记录提交和结果。

### Task 2: 主人更正优先与版本化夜间素材

**Files:** Create `src/daemon/memory/nightly-material.ts`、`.test.ts`；Modify `nightly.ts`、`nightly-sources.ts`、`nightly-ops.ts`、`nightly-runtime.ts`；Test 同目录已有 `nightly.test.ts`、`nightly-sources.test.ts`、`nightly-ops.test.ts`、`nightly-runtime.test.ts`。

**Interfaces:** Consumes Task1 committer、ReviewState、MaterialVersion。Produces `collectMaterialVersions(root,sources,sinceIso,firstRun):Promise<MaterialVersion[]>`、`selectNightlyMaterial(versions,state):{text:string;fingerprint:string;truncated:boolean}`。NightlySources 三种异步记录来源改返 `MaterialVersion[]`，projectMemory改返同类数组；文件键在collector生成，hash必须先于截断。

- [ ] **Step 1 — 写失败测试。** 旧sourceKey/hash不入prompt，新记录/版本可入；不同ID不误去重；hash不随预算变动；opt-in关不读；读取异常拒绝完整快照。protected不可update/remove/expire，退役ID不复用，旧规范化文本拒整批。换说法的新来源可入，不以此证明语义遗忘。
- [ ] **Step 2 — 运行定向红测。** `bun --bun vitest run src/daemon/memory/nightly`；预期保护/版本断言FAIL。
- [ ] **Step 3 — 实现素材与确定性保护。** 按身份过滤后预算，fingerprint包含epoch；沿用since/数量范围。protected只允许confirm。拒绝返回skipped/review_protected、不增failures；保存本日material fingerprint+epoch拒绝标记，同输入不再调模型，变化可重算。
- [ ] **Step 4 — 接入统一提交与通知。** 模型前留revision、后走Task1门；tick/runNow链保留，review不排队。日志actor缺省nightly，lastLog只取nightly；通知带review_epoch，不匹配丢弃，旧通知视initial。提示保护规则。
- [ ] **Step 5 — 验证竞态。** Deferred模型等待时完成review再释放：主人正文保留、skipped/owner_edited、failures不增；桌面改动同样胜出。旧通知不发，白天操作不成“昨晚”，lastRunIso不变。重跑Step2全PASS。
- [ ] **Step 6 — 审阅并提交。** 检查nightly无旁路写入。`git commit -m "feat: honor owner reviews during memory nightly"`，仅提交本任务文件。

### Task 3: 桌面整文编辑与CLI兼容的CAS接入

**Files:** Create `src/cli/curated-memory.ts`、`.test.ts`；Modify `cli.ts`、`src/cli/schema.ts`、`src/lib/memory.ts`、`src/daemon/internal-api/{routes-memory-review.ts,routes.ts,types.ts,index.ts}`、`apps/desktop/src/modules/{memory.js,memory-evidence.js}`。Test 已有 `src/cli/schema.test.ts`、`src/lib/memory.test.ts`、`src/daemon/internal-api.test.ts`、`src/daemon/internal-api/routes-memory-review.test.ts`、`apps/desktop/src/modules/{memory.test.ts,memory-evidence.test.ts}`。

**Interfaces:** Consumes Task1 replace/snapshot。Produces internal-api deps `curatedReview?:CuratedReviewService` 与 setter `setCuratedReview(service):void`；现有source GET的curated响应增加 `requiresAdoption`，使用统一revision；source POST的curated输入追加request_id与可选adopt_external。CLI helper `readCuratedMemory({chatId},deps)`、`writeCuratedMemory({chatId,content,revision,request_id,adopt_external?},deps)` 只通过现有FILE token API调用，禁止导入daemon实现。

- [ ] **Step 1 — 写失败测试。** 手机更正后桌面旧revision409保草稿；重读后改同ID成为新保护；删ID退役，新条补ID，去编号删旧加新；重加旧句允许、其它保护保留。curated允许整文清空（其它source仍拒空）；通用write/delete/lib/session均不能旁路。notes行为不变。
- [ ] **Step 2 — 运行红测。** `bun --bun vitest run src/cli/curated-memory.test.ts src/cli/schema.test.ts src/lib/memory.test.ts src/daemon/internal-api.test.ts src/daemon/internal-api/routes-memory-review.test.ts apps/desktop/src/modules/memory.test.ts apps/desktop/src/modules/memory-evidence.test.ts`；预期新CAS/兼容断言失败。
- [ ] **Step 3 — 实现CLI薄适配及兼容。** 仅根memory.md走daemon；read JSON加revision/requiresAdoption，write加--revision/--request-id/--adopt-external。旧调用报curated_revision_required，提示“先 memory read <user-id> memory.md --json，再带 --revision 和 --request-id 提交”。JSON仍ok:false/退出0，普通模式stderr/非零；离线不直写。notes保持兼容。
- [ ] **Step 4 — 实现桌面与source审阅。** 桌面curated保存带revision/UUID，409保稿、重读后明确采用新基线。source review的curated交Task1；无pending journal的外部变化可GET当前原文/组合revision/requiresAdoption，明确采用才POST adopt_external；未知journal冲突留维护者，普通采用不能解除。
- [ ] **Step 5 — 真实路径转绿。** CLI→临时真实HTTP→committer；桌面invoke带revision/UUID、成功后重读。外部变更明确采用成功，采用期间再变409。重跑Step2全PASS，notes旧测试仍绿。
- [ ] **Step 6 — 审阅并提交。** 审查路径别名/写入口，无权限扩张。`git commit -m "fix: route curated desktop edits through revision checks"`。

### Task 4: 手机授权写接口与接线

**Files:** Modify `src/daemon/settings-panel.ts`、`src/daemon/wiring/{pipeline-deps.ts,index.ts}`、`src/daemon/main.ts`、`src/daemon/memory/nightly-runtime.ts`；Test `src/daemon/settings-panel.test.ts`、`src/daemon/tunnel-client.test.ts`、`src/daemon/memory/nightly-runtime.test.ts`。

**Interfaces:** Consumes Task1 service与Task3 setter。Produces SettingsPanelDeps `reviewCuratedMemory?:(input:ReviewInput)=>Promise<ReviewResult>`；CuratedView增加revision、items.editable；同一service注入nightly、手机与internal-api，main在现有接线生命周期调用setter。

- [ ] **Step 1 — 写失败测试。** GET缺文件null/空文件有效revision/无ID不可编辑；POST成功及401/400/404/409/503；chat_id/path/整文400；过期/撤销token401；异常500不悬挂。
- [ ] **Step 2 — 看红。** `bun --bun vitest run src/daemon/settings-panel.test.ts src/daemon/tunnel-client.test.ts src/daemon/memory/nightly-runtime.test.ts`；预期新路由/结构断言FAIL。
- [ ] **Step 3 — 实现路由和依赖。** POST在validToken门后，owner由服务端绑定，只接契约字段；错误不含路径/原文。复用setter，不加路由权限、端口。
- [ ] **Step 4 — 验证传输。** 假WS+真实panel/service测token加密往返；LAN提交后丢响应，隧道同UUID返回原revision、审计一次；未认证不到review。重跑Step2全PASS。
- [ ] **Step 5 — 审阅并提交。** 共享文件串行合入复验。`git commit -m "feat: expose authenticated phone memory review"`。

### Task 5: 手机逐条操作、预览和冲突草稿

**Files:** Modify `apps/mobile/src/{you.js,you.css,phone.html,globals.d.ts}`；Test `apps/mobile/you.test.ts`、`apps/mobile/build.test.ts`、`apps/mobile/assemble.test.ts`；生成物只由 `bun run build:mobile` 更新。

**Interfaces:** Consumes Task4 GET/POST契约；沿用api(path,opts)、esc、youItem/youHtml/loadYou。Produces用户可操作编辑状态，不增加底栏或独立设置中心。

- [ ] **Step 1 — 写失败测试。** 三动作预览原句，correct保留期限，保存后GET；200字限制一致；双击一次、重试同UUID。晚回GET不覆盖draft，409保留原revision/稿、明确重读后再保存；401/离线不显示成功；HTML安全；无ID不展示操作。
- [ ] **Step 2 — 看红。** `bun --bun vitest run apps/mobile/you.test.ts`；预期新控件/状态断言FAIL。
- [ ] **Step 3 — 实现交互。** 每条操作入口、文案按设计§1；draft驻内存，关闭/导航脏稿可继续或放弃。401提示重连；结果未知时GET只刷新视图，不能凭文本相同判断成功；原POST以同UUID和同负载重发取得服务端回执才确认，不后台持续重试。序列号隔离晚回；esc/textarea.value处理文本。测试视图碰巧相同但无回执仍显示待确认。
- [ ] **Step 4 — 构建与转绿。** `bun run build:mobile`；`bun --bun vitest run apps/mobile/you.test.ts apps/mobile/build.test.ts apps/mobile/assemble.test.ts`；全PASS、生成同步、512KB帧与眨眼/reduced-motion仍过。
- [ ] **Step 5 — 审阅并提交。** 390px检查键盘/滚动/错误不遮保存，留截图。`git commit -m "feat: let phone users review individual memories"`。

### Task 6: 空记忆对话契约与完整验收

**Files:** Create `src/daemon/memory/curated-prompt.ts`、`.test.ts`、`scripts/memory-curated-browser-smoke.ts`；Modify `src/daemon/main.ts`、`src/daemon/bootstrap/{types.ts,index.ts}`、`src/core/prompt-builder.ts`；Test `src/core/prompt-builder.test.ts`。更新现有 `docs/{cc-memory-evidence.md,architecture.md,INDEX.md}` 和 `docs/maintainer/mobile-presence.md` 的现状说明（实施时才写仓库）。

**Interfaces:** Produces `readCuratedPrompt(root:string):string|null`：复用committer恢复，null仅缺文件；空活动记忆返回''；冲突抛可辨错误，main记录后使用''避免旧profile回退。`curatedMemoryFor`、PromptBuilder参数改为可表达string|null|undefined，null/undefined才允许旧profile回退。

- [ ] **Step 1 — 写失败测试。** 缺文件回退profile；空文件/空栏目/删最后一条不回退；正常读取去编号；半提交恢复后再读；冲突不使用profile。knowledge仍独立注入，名称明确未删除。
- [ ] **Step 2 — 看红并实现。** `bun --bun vitest run src/daemon/memory/curated-prompt.test.ts src/core/prompt-builder.test.ts`；先FAIL，再实现读取/参数传递，重跑PASS；不填假记忆。
- [ ] **Step 3 — 做可重复浏览器闭环。** smoke用真实手机产物/CSS、panel、临时owner与Deferred模型。覆盖改正→prompt、过时/移除→重读、模型晚回、桌面→手机、LAN丢响应→隧道幂等；390px截图落临时报告，关闭服务/清理数据。
- [ ] **Step 4 — 完成本地闸门。** 运行 `bun scripts/memory-curated-browser-smoke.ts`、`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`；全退出0；失败定位不削弱断言，记录环境和真机缺口。
- [ ] **Step 5 — 文档、审阅、提交。** 更新范围/保留/CLI迁移/恢复冲突/语义限制，在指定dev落地计划链接。全差异审阅后 `git commit -m "fix: keep empty curated memory from reviving profile"`，列全部提交/验证。
- [ ] **Step 6 — 由整合者真实验收。** 已验证dev构建：`cd apps/desktop && bun run build-sidecar`；`wechat-cc self deploy`；跑手册workbench/chat自检，独立验收owner数据实例测LAN/远程/断线；不试删真实记忆。获准推送时 `git push origin dev`，`wechat-cc ci triage --wait --rerun`；master仅squash PR，缺真机验收不算全部完成。

## 交付证据与未执行声明

交付含每任务提交/测试/审阅、四闸门、smoke、真机与CI。保留整版素材屏蔽的学习代价与换说法限制，不能改称“彻底忘记”。

本次仅做研究与文档；上述测试/实现/提交/构建/部署/推送全部未执行。既有测试路径已用 `git cat-file -e origin/dev:<path>` 逐一核实；新增路径在本计划明确标Create。整合前重新核对dev是否前移及接口冲突，不把基线研究当成最新运行验证。
