# `core/workbench/service.ts` 按域拆模块(梳理第 7 步之三)设计

日期:2026-09-27。状态:**完成**(2026-09-28,PR #132 / #134 / #135 / #136 / #137 / #138 / #139 / #140 / #141 / #142)。`service.ts` 1965 → 179 行、内函数 68 → 3(`touched` / `bumped` / `ensureAccepting`),只剩 Options、组装、public 对象与 `actions.set`。§3 第 6/7 项对调过(admission 先于 native);最后两个模块(execute / entry)用「已建好的域对象显式注入」而非 `ctx.actions`(裁决见 `plans/2026-09-28-workbench-service-split-pr10.md`);Codex #129 加的 entry 域按 §6 直接成了 `service/entry.ts`。落地文件名与 §2 略有出入:多了 `types.ts`、`checked-text.ts`、`directory-identity.ts`(域不能 import `../service` 逼出来的共享帮手)。同批:[cli 拆分](2026-09-27-cli-split-design.md)、[bootstrap 拆分](2026-09-27-bootstrap-split-design.md)。

**目标:** `makeWorkbenchService`(201-1822,1622 行,64 个内函数,11 项共享可变状态)拆成 `src/core/workbench/service/<domain>.ts` 若干模块,共享一个**显式**的 `ServiceCtx`;`service.ts` 只剩组装与 public 对象。20 份 `service-*.test.ts` **一行不改、每步全绿**。顺手断掉 `wechat-control.ts ↔ service.ts` 的环,把 service 族的 `no-circular` 升 error(整个 workbench 目录的等 store 层环另修,见 §5)。

**做 · 不做:** 做「闭包拆模块 + 显式 ctx」· 不做「改成 class」(仓库风格是闭包,没收益)· 不做「域之间走事件总线」(会把 `execute` 必须看见的耦合藏起来)· 不做任何行为变化。

## 1. 现状:域与耦合(39cf7f5f 行号)

按 20 份测试能切出的域,和它们跨域调用的东西:

| 域 | 闭包 | public 方法 | 跨域依赖 |
|---|---|---|---|
| review(标记 / 打回) | 1213-1237 | `reviewList` `markReviewFile` `returnReviewFiles` | `isReplied`、`service.submitInput/continueTask` |
| attachments | 208-223 | `uploadAttachment` `readAttachment` `discardAttachment` | 无 |
| quota | 244-254 | `providerQuota` `quotaExhausted` `fallbackExecutor` | 无 |
| notices / wechat 投递 | 264-283, 326-345 | `deliverWechatArtifact` `setWechatWatch` `createWechat` `handleWechat` … | `fallbackExecutor`、`runsByTask`、`createTask` |
| artifacts / 代码变更快照 | 443-508, 532-566 | `artifact` `approve` | `runsByTask` |
| native 导入 / 续接 + handoff | 371-393, 216-223 | `importNativeHistory` `prepareNativeResume` `continueNativeTask` `previewHandoff` `handoff` … | `requireInput` `canResume` `start` `validateNativeDecision` |
| admission(provider / requireInput / continuation / unattended) | 347-370 | `prepareContinuation` `acknowledgeUnattended` `modelCatalog` … | 无 |
| view / phase | 398-442 | `attention` `list` `detail` | `quiet` `held` `queue` |
| live inputs | 224-239, 589-591, 1019-1058 | `submitInput` `withdrawInput` | `continuation` `requireInput` `start` `armIdleClose` |
| lifecycle(lease / idle-close / pump / cancel / shutdown) | 510-514, 569-628, 709-731, 1060-1087, 1184-1210 | `cancel` `setArchived` `shutdown` | `execute` `collect` `stageFinishedNotice` `matterSync` |
| settle / report / recollect | 294-299, 646-708 | 无 | `collectTurnArtifacts` `captureCodeChanges` `armIdleClose` `matterSync` |
| execute / start / create | 733-1017(285 行), 1089-1182 | `create` `continueTask` | **9 个域全部** |
| matter sync | 1154-1162 | 无 | 无 |

环:`pump → execute → settleQuiet → armIdleClose → closeForIdle → cancelRun → pump`。唯一 import 环:`wechat-control.ts:6` 从 `./service` 取三个类型(type-only),`service.ts:2` 从 `./wechat-control` 取 `makeWechatWorkbenchControl`(值)。

## 2. 目标形状

```
core/workbench/service.ts            # makeWorkbenchService:建 ctx → 各域工厂 → wireRef 回填 → public 对象(1239-1819 那段瘦身后留这里)
core/workbench/service/ctx.ts        # ServiceCtx 类型 + makeServiceCtx
core/workbench/service/state.ts      # WorkbenchRuntimeState:runsByTask / reservations / queue / order / stopping / collections / nativeDecisions / handoffDecisions / running text / notice wake …
core/workbench/service/review.ts
core/workbench/service/attachments.ts
core/workbench/service/quota.ts
core/workbench/service/notices.ts
core/workbench/service/artifacts.ts   # collect / captureTaskArtifacts / captureCodeChanges / retakeBaseline
core/workbench/service/native.ts      # 导入 / 续接 / handoff 的校验与决策
core/workbench/service/admission.ts
core/workbench/service/view.ts
core/workbench/service/inputs.ts
core/workbench/service/lifecycle.ts   # lease / idle-close / pump / cancelRun / shutdown
core/workbench/service/settle.ts      # settleQuiet / settleAfterDecision / reportOnce / recollectOnce
core/workbench/service/execute.ts     # execute / start / createTask(最后拆,先留在 service.ts 里瘦身)
core/workbench/wechat-types.ts        # CreateWechatTask / SendWechatArtifact / TaskWaitingFor(从 service.ts 挪出,断环)
```

- `ServiceCtx = { state, store, liveInputs, deps, hub: { touched, bumped }, log, now, actions }`。`actions` 是一个 `Ref<{ execute, pump, cancelRun, start, settleQuiet, armIdleClose, … }>`,由 `service.ts` 在所有域工厂建好后 `wireRef`;域内需要「别的域的动作」一律 `ctx.actions.get().pump()`,不互相 import。这是 daemon 接线已在用的同一套 `Ref/wireRef`(`wiring/index.ts`),**只此一种**晚绑定。
- 每个域工厂:`makeReviewDomain(ctx): ReviewDomain` 返回它的函数集;`service.ts` 的 public 对象直接引用这些函数(方法名、签名、错误码不变)。
- `state.ts` 只是把 240-265 那 11 项 `let/const` 集中成一个对象,不改它们的语义。

## 3. 顺序与提交粒度

按耦合从低到高,**一个域一个 PR**(每个 PR 都是行为不变的纯搬家,可单独评审、单独合):

1. `wechat-types.ts` + review 域(自包含,只读 `runsByTask` 与 `isReplied`)—— 顺手断环;depcruise 只对 service 族(`service.ts`、`service/`、`wechat-control.ts`)升 error(PR 1 #132 已做),整个 `src/core/workbench/` 升 error 等 §4 提到的 store 层 4 个环另修之后(与 §5 一致)。
2. attachments 域。
3. quota 域。
4. notices 域(含 wechat 投递与 `createWechat`)。
5. artifacts / 代码快照域。
6. native + handoff 域。
7. admission + view 域。
8. inputs 域。
9. lifecycle + settle 域(环在这里第一次真正经 `ctx.actions` 走)。
10. execute / start / create 抽成 `execute.ts`;`service.ts` 只剩组装。

每个 PR:先给该域写「能用最小 ctx 单独构造」的单测(红)→ 逐字搬代码与注释(注释里的安全依据尤其)→ 绿 → `service.ts` 改成调用 → 20 份既有 `service-*.test.ts` 全绿 → 行数棘轮下调。

## 4. 不做

- 改任何行为、错误码、事件文案、超时数值。
- 改 `store.ts` / `timeline-events.ts` / `attachments.ts` / `artifacts.ts` 之间的另外 4 个循环 warn(它们是 store 层的事,另立项)。
- 改 public 方法的签名或 `WorkbenchService` 类型(`internal-api/routes-workbench.ts`、`wire-workbench.ts`、桌面代理都依赖它)。
- 把 `execute` 再往下切(它跨 9 个域是事实;先让它调用清楚的模块,再看有没有自然的切口)。

## 5. 测试与守卫

- 既有 20 份 `service-*.test.ts` + `service.test.ts`(1043 行)**不改**,每个 PR 全绿;它们只走 public API,是这次拆分的验收面。
- 每个域一份 `service/<domain>.test.ts`:最小 ctx 构造、该域的分支。
- **新增** `scripts/workbench-service-ratchet.guard.test.ts`:`service.ts` 行数只降不升(初值 1823,目标 ≤ 500);`makeWorkbenchService` 内 `const .* = \(` / `function` 内函数数只降不升。
- depcruise:`.dependency-cruiser.cjs` 加一条 `workbench-no-circular`(`from/to: ^src/core/workbench/service/`,severity error)在 PR 1 生效;整个 `src/core/workbench/` 的 no-circular 升 error 留到 store 层的环另修之后。
- 真机:每个 PR 合 dev 后跑 `wechat-cc selftest workbench --executor cursor --image --resume`(维护者手册的标准自检);第 9、10 个 PR 另加「一个文件夹连开两件事,看等待行」的真机核对(roadmap「欠的真机账」第一条)。

## 6. 交接

- 触碰文件:`src/core/workbench/service.ts`、新 `service/` 目录、`wechat-types.ts`(新)、`wechat-control.ts`(只改 import 路径)、`.dependency-cruiser.cjs`、新守卫。不碰 `store.ts`、`wire-workbench.ts`、`routes-workbench.ts`。
- **与 Codex 的顺序**:它第一批要改 `service.ts`(统一创建登记、事项目录、附件归属);本 spec 等它合入后按合入后的行号重画 §1 再开工。它阶段 B/D 若要加域(比如「协作交接」),直接建 `service/<domain>.ts`,别再往闭包里加。
- 实施计划另出(writing-plans),按 §3 的 10 个 PR 各自一份或合成一份分阶段。
