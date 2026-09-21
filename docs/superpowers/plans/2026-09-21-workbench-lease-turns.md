# 工作台租约按回合计代 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修评审 2026-09-21 的 #1 #2 #6 #7:租约按回合计代、回合落定按状态转移而不是只按 `result`、无租约自动续作 fail-closed、打回修改按会话状态分路。

**Architecture:** 全部改动在 `src/core/workbench/service.ts`(`Active.turn`、`reservations` 值带 turn、observe 回调里的转移探测器、`returnReviewFiles` 分路)+ `scheduler.ts` 的 `waitingFor.reason` 透传;新测试文件用与评审探针同构的假 runtime。

**Tech Stack:** Bun 1.3.14 / Node 24 双跑 vitest;真 git 临时仓库(review boundary 那套夹具)。

**Spec:** `docs/superpowers/specs/2026-09-21-workbench-lease-turns-design.md`。地图:`~/.../scratchpad/map-lease.md`(控制器给的,含每个函数的行号)。

## Global Constraints

- 只在 `dev` 上干活;不碰兄弟工作树。
- `service.ts` 是 1400 行的核心文件:每个任务只改自己那几处,不重排、不顺手重构;新逻辑尽量抽成小函数放在相邻位置。
- 既有套件一条不能回退:`service-lease.test.ts`、`service-review-boundary.test.ts`、`service-turn-artifacts.test.ts`、`service-background.test.ts`、`service-review.test.ts`、`claude-workbench-runtime.test.ts`、`scheduler.test.ts`、`routes-workbench.test.ts`;`vitest.config.ts` 的 win32 排除列表要覆盖新套件(它依赖 Claude 保留会话夹具 ⇒ 加进去)。
- 每个任务结束前:`bun run typecheck`、`bun run depcheck`、相关测试文件两套 runner 都绿;提交信息中文,写清修的是评审哪一条。
- 探针 `~/Documents/tendhearth/cc-review/runtime-probe.ts` 是验收的第二把尺:任务 4 结束时四个场景的输出要变成 spec §验证 写的样子(控制器跑)。

---

### Task 1: 租约按回合计代(评审 #1)

**Files:** Modify `src/core/workbench/service.ts`(`Active`、`reservations`、`releaseTurnLease`、`acquireTurnLease`、`captureCodeChanges`、`submitInput`、`pump`、`markUncertain`、`releaseReservation`、`waitingFor`);Test `src/core/workbench/service-lease-turns.test.ts`(新建,本任务先放场景 1)。

**Interfaces (Produces):**
```ts
interface Active { …; turn: number }                                    // 1 起;每次 acquireTurnLease 成功 / 续接开新回合 +1
type Reservation = { running: Active; turn: number }                     // reservations: Map<string, Reservation>
function releaseTurnLease(running: Active, turn: number): Promise<void>  // 只在 reservations.get(identity) 是同一 running 且 turn 相等时删
function captureCodeChanges(running: Active, turn: number): Promise<void> // 只截 running.reviewBaseline?.turn === turn 的 baseline
interface GitBaselineWithTurn extends GitBaseline { turn: number }       // running.reviewBaseline 的类型
async function beginTurn(running: Active): Promise<boolean>              // await running.reviewCapture;acquire(或已持有则保留);turn += 1;取新 baseline;返回是否新申请到
```
- `pump` 设置租约时 `{ running, turn: running.turn }`;`markUncertain` 同理;`releaseReservation` 不看 turn。
- `findPathBlocker` 的入参从 `[...reservations.values()]` 变成 `.map(r => r.running)`。
- `submitInput` 的 `:988` 那段改为 `await beginTurn(running)`(保留原来的失败回滚:存储写入失败 ⇒ `releaseTurnLease(running, running.turn)`)。
- 每个既有 `releaseTurnLease(running)` / `captureCodeChanges(running)` 调用点传当时的 `running.turn`(`:601` 在 result 分支里取 `const turn = running.turn` 再异步释放)。

**Test(场景 1 RESUME_DURING_CAPTURE,真 git 仓库,60 个文件让快照慢一点;用可控的 `finishGitReview` 延迟更稳:给 `makeWorkbenchService` 注入 `captureDelay`?——不加注入口:用 `reviewCapture` 的 promise 本身,测试里在 `submitInput` 之前不 await,之后断言):**
- A 答复 → 立刻 `submitInput(A, 'resume immediately')` → `create(B)`;等 A 的 `reviewList` 出现第一份快照;断言 B `status==='queued'`、`waitingFor.taskId===A`;快照文件列表不含续接后写的文件;A 的 `runtime.submitted===1`;`detail(A).turn===2`。
- 反例(既有行为不变):A 答复且**没有**续接 ⇒ 快照截完后 B 变 running(`service-lease.test.ts:48` 已覆盖,跑一遍确认)。

- [ ] Step 1 写场景 1 测试,确认在当前代码上失败(B 变 running)。
- [ ] Step 2 实现 turn / Reservation / beginTurn;既有套件全绿。
- [ ] Step 3 typecheck + depcheck;提交 `工作台租约按回合计代:旧回合的异步释放不再删掉续接后的新租约(评审 2026-09-21 #1)`。

---

### Task 2: 状态转移探测器(评审 #6 与 #2)

**Files:** Modify `src/core/workbench/service.ts`(observe 回调 `:587-602`、`collectTurnArtifacts`、`cancelRun` 复用);Test `service-lease-turns.test.ts` 加场景 2、3。

**Interfaces (Produces):**
```ts
interface TurnObserver { note(ev: WorkbenchEventLike): void }   // 持有 prev snapshot;每个事件后调用
function settleTurn(running: Active): void        // = 今天 result 分支的动作(collectTurnArtifacts + matter replied + releaseTurnLease(running, running.turn));同一 turn 只执行一次(running.settledTurn === running.turn ⇒ 跳过)
function onAutonomousStart(running: Active): void // 无租约时 idle→running 或 bg 0→>0:void beginTurn(running) —— 申请不到 ⇒ cancelRun(running) + system 事件「保留会话在 <B 标题> 占用目录时自己又开始干活,已结束会话;答复已交付,这段自动续作没有落地」
```
- 探测条件(每个事件后,`!cancelled && !finishing && !uncertain`):
  - 落定:`cur.foreground==='idle' && cur.backgroundCount===0 && permissions/questions 空` 且 `(prev.foreground!=='idle' || prev.backgroundCount>0)` ⇒ `settleTurn`。`result` 事件分支改为也调 `settleTurn`(幂等)。
  - 自动续作:`reservations` 里没有 `running.identity` 且 `(prev.foreground==='idle' && cur.foreground==='running') || (prev.backgroundCount===0 && cur.backgroundCount>0)` ⇒ `onAutonomousStart`。
- `cancelRun` 已有 `closedWhileReplied` 语义 ⇒ 最终状态 `completed`;事件文案里带 B 的标题(从 `findPathBlocker` 的 blocker 取)。

**Tests:**
- 场景 2 LAST_CHILD_ONLY:父 result 时 bg=1 → 写 late.txt 到 `.cc-workbench/<A>/` → `create(B)` → runtime `backgroundCount=0` 并推 `tool_call{activity.status:'completed'}` ⇒ A `phase==='replied'`、`artifacts` 含 `late.txt`、B `status==='running'`。
- 场景 3a AUTONOMOUS_AFTER_RELEASE(有 B):A 答复释放、B 起来后,A 的 runtime `foreground='running'` + 推一条 `tool_call{Write}` ⇒ A `status==='completed'`(被结束)、A 的事件里有那条 system 事件、B `phase==='working'`。
- 场景 3b(没 B):同样触发 ⇒ A 仍 running、`detail(A).turn===2`、reservations 里有 A。
- `service-background.test.ts:68` 那条(带两个后续 result)仍绿 —— settleTurn 幂等。

- [ ] Step 1 两条测试先红 → Step 2 实现 → Step 3 全绿 + 提交 `工作台回合落定按状态转移:最后一个后台子任务结束也收尾;无租约的自动续作申请不到就结束会话(评审 #6 #2)`。

---

### Task 3: 打回修改分路 + 排队原因(评审 #7 + spec §D)

**Files:** Modify `service.ts`(`returnReviewFiles`、`waitingFor`)、`src/core/workbench/scheduler.ts`(`PathBlocker.reason` 已有;新增 `'retained_turn'` 由 service 判定)、`src/core/workbench/review.ts`(`derivedReturnRequestId(artifactSha256, paths, comment): string`);桌面 `apps/desktop/src/modules/workbench.js` 的 waitingFor 文案加一句(reason==='retained_turn' ⇒ 「A 正在续接」);Test `service-review.test.ts` 加 4 条、`review.test.ts` 加 1 条。

**Interfaces:**
```ts
export function derivedReturnRequestId(artifactSha256: string, paths: readonly string[], comment: string): string   // sha256(artifactSha256 + '\0' + [...paths].sort().join('\n') + '\0' + comment) 取前 16 字节,套成 UUID(第 13 位 '4',第 17 位 '8')
returnReviewFiles(id, input): WorkbenchTaskView | LiveInput   // 保留会话 ⇒ 返回 submitInput 的回执;其余照旧
```
- 分路:`const running = runsByTask.get(id)`;`running && isReplied(running)` ⇒ `submitInput(id, { runId: running.identity, requestId: input.inputRequestId ?? derivedReturnRequestId(...), text: composeReturnText(...), ...attachments })`,成功后写标记;`running && !isReplied` ⇒ `throw Error('workbench_busy')`;没有 running ⇒ 现状。
- 路由 `POST /v1/workbench/review-return` 的返回体:保留会话时 `{ input: LiveInput }`,否则 `{ task }`(`routes-workbench.ts` 与 `routes-workbench.test.ts` 同步;桌面 `workbench-execution.js` / 审阅面板按返回体里有 `input` 还是 `task` 处理 —— 只做最小适配:两种都刷新详情)。
- `waitingFor.reason`:blocker 的 run 若 `isReplied` 且 `turn>1`(在续接)⇒ `'retained_turn'`,否则沿用 scheduler 的 reason。

**Tests:** 保留会话答复后打回 ⇒ `POST /v1/workbench/input` 语义(回执 `sending`,runtime `submitted===1`,标记写入);同一 derived requestId 重发 ⇒ 不重复投递(`liveInputs` 幂等);working 中打回 ⇒ `workbench_busy` 且无标记;已结算 ⇒ 原路 `continueTask`(既有 4 条不变)。`derivedReturnRequestId` 顺序无关、UUID 形状。

- [ ] Step 1 测试先红 → Step 2 实现(service / review / routes / 桌面最小适配)→ Step 3 全绿 + 提交 `打回修改按会话状态分路:保留会话走 input,已结算走 continue(评审 #7);排队原因透传`。

---

### Task 4: 探针回归 + 文档

**Files:** `service-lease-turns.test.ts` 补齐场景 4(打回,已在 T3 覆盖则只做交叉引用)、`vitest.config.ts` win32 排除、`docs/cc-workbench.md` 修订记录一条、spec 修订记录。
- 控制器跑 `bun ~/Documents/tendhearth/cc-review/runtime-probe.ts`,四个场景应为:LAST_CHILD_ONLY `phaseA replied, artifacts [late.txt], statusB running`;RETURN_IDLE_REVIEW `error ''`;AUTONOMOUS_AFTER_RELEASE `phaseA completed(或 status completed), phaseB working`;RESUME_DURING_CAPTURE `statusB queued, submitted 1`。
- [ ] Step 1 win32 排除 + 文档 → Step 2 提交 `工作台租约回合:文档与探针回归`。
