# 一个文件夹一个活会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 2026-09-21 早些时候那套「回合代数 + 转移探测器 + fail-closed 结束会话」换成一条不变式——**文件夹的占用从派发到会话关闭**——并给保留会话加两档空闲自动收工;自改流水线改成每次运行一个 git worktree,顺带删掉 `ensureApprovedTree`。

**Architecture:** 工作台侧:`reservations` 只在派发/隔离时写、只在结算/关闭时删;`Active.idleClose` 计时器由「变安静」与「有人来等」两处武装;删除代数/再申请/自动续作 fail-closed 全套。自改侧:`<workdir>/repo` 降级为中枢克隆,每次运行 `git worktree add <workdir>/runs/<id>`,merge 用 `push HEAD:refs/heads/<branch>`。

**Tech Stack:** Bun 1.3.14 + Node 24 双跑 vitest;真 git 临时仓库;桌面是无框架 ES module。

**Spec:** `docs/superpowers/specs/2026-09-21-one-folder-one-session-design.md`(先读它的「错在哪」和「删掉什么」两节)。
**前一份(被本份取代的补丁):** `docs/superpowers/specs/2026-09-21-workbench-lease-turns-design.md`。
**地图(含行号):** `<scratchpad>/map-close-resume.md`(关闭/恢复/看门狗/谁依赖答复即释放/配置接线)、`<scratchpad>/map-worktree.md`(自改每处 clone 触点 + 本机实测数字)。两份都已复制进本计划的工作区。

## Global Constraints

- 只在 `dev` 上干活;不碰兄弟工作树(`~/Documents/tendhearth/wechat-cc`、`wechat-cc-pet-e2e`)。
- `service.ts` 是核心文件:**这一轮是净删代码**。删之前先确认没有别的调用方;不要顺手重构无关部分。
- 生产代码每个 `spawn`/`spawnSync` 带 `windowsHide: true`;测试目录用 `mkdtempSync` + `removeTempDir`;路径期望一律 `join(...)` 拼,**不准出现 `'/w/repo'` 这类 POSIX 字面量**(这条规矩今天已经踩红三次)。
- 每个任务结束前:`bun run typecheck`、`bun run depcheck`、相关测试文件在 `bun x vitest run` 与 `npx vitest run -c vitest.node.config.ts` 两边都绿。提交信息中文,说清删的是哪条补丁、换成的是哪条不变式。
- 新测试文件若依赖 Claude 保留会话夹具,加进 `vitest.config.ts` 的 win32 排除并写明理由。
- 已知 flake(不是你的锅,别去修):`routes-workbench.test.ts` 的分块上传那条在 node runner 上偶发 ECONNRESET。

---

### Task 1: 占用到会话关闭为止 + 两档空闲自动收工

**Files:**
- Modify: `src/core/workbench/service.ts`(主体)、`src/core/workbench/scheduler.ts`(只改类型注释,若 `WaitingReason` 需要去掉 `retained_turn` 的话)、`src/lib/agent-config.ts`、`src/daemon/bootstrap/wire-workbench.ts`
- Create: `src/core/workbench/service-one-session.test.ts`
- Delete: `src/core/workbench/service-lease-turns.test.ts`(场景迁进新文件,见下)
- Modify: `src/core/workbench/service-lease.test.ts`、`src/core/workbench/service-background.test.ts`、`vitest.config.ts`

**删除清单(逐项确认没有剩余引用后再删):**

1. `Active.turn`;`reservations` 的值从 `{running, turn}` 回到 `Active`;`current(running, turn)` 之类的代数辅助。
2. `releaseTurnLease(running, turn)` 与 `acquireTurnLease` / `beginTurn` 三个函数整体删除;落笔前的 `alive()` 复查(终审 C1)随之删除。
3. `onAutonomousStart` + 它的 fail-closed `cancelRun` + 那条 system 事件 + `Active.autonomousTurn`。
4. `Active.settledTurn`;`settleAfterDecision` 的 `setImmediate` 延后改成直接「重新评估安静」。
5. `markUncertain` 里的 `running.turn += 1` 与随之的基线搬运(基线搬运的**理由消失**了,因为没有代数;但要保留 `markUncertain` 重新装上 reservation 这件事本身)。
6. `captureCodeChanges(running, turn)` / `collectTurnArtifacts` 的代数参数;`detail`/`taskView` 上暴露的 `turn` 字段(检查 `routes-workbench.ts` 与桌面是否消费,一起删)。
7. `waitingFor.reason === 'retained_turn'` 的合成逻辑(reason 回到 scheduler 给的三种)。

**新增(接口,后续任务会用):**

```ts
// service.ts
interface Active { /* … */ idleClose?: { timer: ReturnType<typeof setTimeout>; at: number; reason: 'handoff' | 'idle' } }

/** 会话安静:本轮做完、没有后台子任务在写、没有待决权限/提问。等价于既有的 isReplied。 */
function quiet(running: Active): boolean            // = isReplied(running)
function armIdleClose(running: Active): void        // 见下
function cancelIdleClose(running: Active): void     // clearTimeout + 删字段
function closeForIdle(running: Active): void        // 到点回调
```

- `armIdleClose`:`if (!quiet(running) || running.finishing || running.cancelled) return`;`const wanted = queue.some(q => !!findPathBlocker(q, [running]))`;`const ms = wanted ? handoffGraceMs() : retainedIdleMs()`;已有计时器且 `at <= now+ms` ⇒ 不动(不能把已经排好的短让位推迟);否则重排。
- `closeForIdle`:再查一遍 `quiet(running) && reservations.get(running.identity) === running && !running.finishing && !running.cancelled`;通过则 `store.addEvent(taskId,'system', …)`(文案见 spec §2)、`running.closedWhileReplied = true`、`void cancelRun(running).catch(()=>{})`。
- 武装点:转移探测器的「变安静」分支;`pump()` 里发现候选被一个 `quiet` 的持有者挡住时对持有者调一次。
- 取消点:`submitInput` 入口、`resolvePermission` / `resolveAnswer`(拍板之后先取消,再重新评估安静)、转移探测器的「不再安静」分支、`cancelRun`、`execute` 的 finally(结算前)。
- `submitInput`:去掉 `beginTurn` 调用,改成 `cancelIdleClose(running)` → `await running.reviewCapture?.catch(()=>{})` → 重取 `reviewBaseline` → 原有投递流程。失败回滚里**不要**再「把租约还回去」(没有可还的)。
- 转移探测器(`noteTransition`)只剩两条:`quiet && !wasQuiet` ⇒ `collectTurnArtifacts(running)` + matter `replied` + `armIdleClose(running)`;`!quiet && wasQuiet` ⇒ `cancelIdleClose(running)`。`result` 事件走同一条路。保留 try/catch 包裹(终审 M5)。

**配置接线:**
- `src/lib/agent-config.ts`:`workbench_retained_idle_close_ms?: number`、`workbench_handoff_grace_ms?: number`,zod `z.number().int().nonnegative().optional()`(允许 0),加进 load 的白名单。
- `wire-workbench.ts`:按 `ownerChatId` 的**闭包**写法传给 `makeWorkbenchService`:`retainedIdleCloseMs: () => loadAgentConfig(stateDir).workbench_retained_idle_close_ms ?? 600_000`、`handoffGraceMs: () => … ?? 15_000`(负数视作缺省)。service 侧 `Options` 加这两个可选函数,内部 `retainedIdleMs()` / `handoffGraceMs()` 读它们。
- 测试可直接传函数或常量注入。

**Tests(`service-one-session.test.ts`,假 runtime 与外部评审探针同构:可控 `snapshot()`、`finish(bg)`、可推 `tool_call`;真 git 临时仓库用于快照那条):**

1. 「保留会话自己又开始写,不再抢文件夹也不再被杀」:A 答复 → B 建同文件夹 → A 的 runtime `foreground='running'` 并推一条 `tool_call` ⇒ **B 仍 `queued`(waitingFor 指向 A)、A 仍 `running` 且没有 system 告警事件、没有 `completed`**。(这条在旧实现里是 A 被结束。)
2. 「有人等就 15 秒让位」:A 答复(安静)→ B 建同文件夹 ⇒ A 在 `handoffGraceMs` 到点后 `status==='completed'`、`phase==='replied'`、有那条 system 事件;B 变 `running`。注入 `handoffGraceMs: () => 20` 之类的小值,用 `expect.poll`。
3. 「没人等就按长空闲」:只有 A ⇒ 短值不会触发(用 `handoffGraceMs:()=>20, retainedIdleMs:()=>10_000`,断言 100ms 后仍 `running`);随后建 B ⇒ 立刻改按短档关闭(验证 `pump` 的武装点)。
4. 「补充一句取消计时」:A 安静 → `submitInput` ⇒ 计时取消、`runtime.submitted===1`、A 不被关闭;新回合结束后重新计时。
5. 「待决权限不算安静」:安静前有待决权限 ⇒ 不计时;`resolvePermission` 之后仍安静 ⇒ 重新计时并最终关闭。
6. 「后台子任务在写不算安静」:父 `result` 时 `bg=1` ⇒ 不计时、B 排队;最后一个子任务只发 `tool_call` 且 `bg=0` ⇒ 登记成果(含 late.txt)+ 开始计时 ⇒ 关闭 ⇒ B 起。
7. 「关闭之后能按原会话恢复」:上面关闭之后 `service.detail(A).continuation` 是 `{mode:'resume', sessionId}`,`continueTask(A,'再说一句')` 不抛,且新 run 的 spawn 收到 `resumeSessionId === 原 sid`(用 registry 的假 provider 记录 spawn 参数)。
8. 「快照还在截时补充」:真 git,A 写 60 个文件后 `finish()`,立刻 `submitInput` ⇒ 上一轮快照不含续接后写的文件;全程 `reservations` 一直持有(用 `waitingFor` 或新建的 C 任务始终 queued 来证明)。

**既有套件的反转:**
- `service-lease.test.ts:48`「releases the folder once the turn is answered…」⇒ 改成「答复后 B 仍等,收工(或自动让位)后 B 起」,标题同改。
- `service-lease.test.ts:59`「refuses to continue a replied task while another task holds its folder」⇒ 这条描述的是**已结算**任务的续接被挡,仍然成立(走 `continueTask`+队列),确认它不依赖 `acquireTurnLease` 的 `workbench_busy`;若依赖,改成断言排队而不是抛错。
- `service-background.test.ts:318` 的注释与 `service.create` 断言改成「父回合已答复但会话还开着 ⇒ 同文件夹任务排队」。
- `service-lease-turns.test.ts` 整体删除(场景 1/2/3a/3b/打回/终审那几条分别由新文件的 1/2/6/7/8 与 `service-review.test.ts` 覆盖;删之前逐条核对不要漏掉打回那四条——它们在 `service-review.test.ts` 里,不在这个文件)。

- [ ] Step 1 写 `service-one-session.test.ts` 的场景 1 与 2,确认在当前代码上**失败**(场景 1 会看到 A 被结束;场景 2 会看到 B 立刻就起来了)。
- [ ] Step 2 实现计时器与武装/取消点(先不删代数),两条绿。
- [ ] Step 3 按删除清单逐项删除,每删一项跑一次相关套件。
- [ ] Step 4 补齐场景 3-8 与既有套件反转;两套 runner 全绿;typecheck + depcheck。
- [ ] Step 5 提交:`工作台:文件夹占到会话关闭为止,保留会话空闲自动收工 —— 删掉回合代数与 fail-closed 那套补丁`。

---

### Task 2: 等待行说人话(可见性)

**Files:** Modify `src/core/workbench/service.ts`(`waitingFor` 合成)、`apps/desktop/src/modules/workbench.js`、`src/core/workbench/wechat-control.ts`;Test:`service-one-session.test.ts` 加 1 条、`apps/desktop/*workbench*.test.ts`(有的话)加 1 条。

**Interfaces:**
```ts
waitingFor: { taskId: string; title: string; reason: WaitingReason; holderWriting: boolean; closeInMs: number | null }
```
- `holderWriting` = `!quiet(holder)`;`closeInMs` = `holder.idleClose ? Math.max(0, holder.idleClose.at - now) : null`(没有计时器就是 null)。
- 桌面:`holderWriting===false && closeInMs!=null` ⇒ 「「<A>」已答复,会话还开着;<N> 秒后自动让出文件夹 —— 也可以现在就让它收工」,「收工」按钮复用既有停止(`data-action="cancel"` 那条路径);`holderWriting===true` ⇒ 保持今天的文案;`writer_not_closed` 的文案**不许被覆盖**(终审 I3 的教训)。
- 微信 `任务 <id>`:等待行加一句同义的话(一行,不带按钮,告诉主人「等 N 秒它会自己让开,或者说『任务 <A的id> 停止』」)。
- [ ] Step 1 测试先红 → Step 2 实现(`node --check` 过一遍桌面 JS)→ Step 3 提交。

---

### Task 3: 自改流水线——一次运行,一个工作树

**Files:** Modify `src/cli/self-change/steps.ts`、`src/cli/self-change/index.ts`、`src/cli/self-change/state.ts`(如需记 worktree 路径)、`docs/maintainer/self-change.md`;Test:`src/cli/self-change/steps.test.ts`、`run.integration.test.ts`。

**Interfaces:**
```ts
export function hubPath(config: SelfChangeConfig): string            // join(workdir, 'repo') —— 只 fetch,不在里面构建
export function runPath(config: SelfChangeConfig, id: string): string // join(workdir, 'runs', id)
```

**改法:**
1. `repo` 步:hub 不存在 ⇒ `git clone <repoUrl> repo`;存在 ⇒ `git -C hub fetch origin --prune`。然后**机会性清理**:`git -C hub worktree prune`;把 `state.list()` 里终局且 `updatedAt` 超过 24 小时的运行对应的 `runs/<id>` 用 `git -C hub worktree remove --force` 删掉(失败只 log)。再 `git -C hub worktree add <runPath> -b self/<id> origin/<branch>`(已存在同名分支 ⇒ 先 `git -C hub branch -D self/<id>`);工作树里 `bun install --frozen-lockfile`;写交代。
2. 其余所有步骤的 cwd 从 `repoPath(config)` 换成 `runPath(config, s.id)`——`guard` / `tests` / `review` / `implement` / `ci` / `deploy`(含 `apps/desktop` 子目录)/ `run.ts` 的修复轮 cwd / `index.ts` 的 `makeGit` 默认 cwd 与 `ciTriage` cwd。`index.ts` 的 deps 现在需要知道 run id:把 `defaultPipelineDeps(stateDir, config, { repoRoot })` 改成接收 `{ repoRoot, runId }`,或者把 git 的 cwd 改成每次调用时从 state 取(**选前者**,显式)。
3. `merge` 步:`fetch origin` → `rebase origin/<branch>`(冲突照旧 abort + `merge_conflict`)→ `s.merge.sha = rev-parse HEAD` → `git push origin HEAD:refs/heads/<branch>`(**不带 --force**;被拒 ⇒ `merge_conflict`,detail 说明远端已经前进)→ `git push origin --delete self/<id>`(失败只 log)。**删掉** `checkout <branch>` / `reset --hard origin/<branch>` / `merge --ff-only` 三步。
4. `deploy` 步:**删掉 `ensureApprovedTree` 整个函数与调用**;改成一条断言:`rev-parse HEAD === s.merge.sha` 且 `status --porcelain` 干净,不满足 ⇒ `deploy_tree_mismatch`(保留失败码、通知文案里的恢复办法改成「删掉 `<workdir>/runs/<id>` 让它按批准的提交重建」)。工作树不存在 ⇒ 先 `git -C hub worktree add --detach <runPath> <merge.sha>` 重建再断言。
5. `state.ts`:无需新字段(`runPath` 由 id 推出);若实现时发现需要,加 `worktree?: string` 并给缺省。

**Tests:**
- `steps.test.ts`:`repo` 步的 git 调用序列(prune → worktree add → install);`merge` 步不再出现 `checkout`/`merge --ff-only`,出现 `push origin HEAD:refs/heads/dev`;`deploy` 的 HEAD 断言两条(相等 ⇒ 构建;不等 ⇒ `deploy_tree_mismatch`);工作树缺失 ⇒ 重建后构建。
- `run.integration.test.ts`(真 git):中枢克隆 + **两条运行并存**的工作树互不影响(A 的文件在 A 的树里,B 看不见);一条跑到 `done` 后远端 `dev` 含它的提交、远端 `self/<id>` 已删;`--resume` 在 `rm -rf runs/<id>` 之后能重建并部署。
- [ ] Step 1 测试先红 → Step 2 实现 → Step 3 两套 runner + typecheck + depcheck → Step 4 提交 `自改:一次运行一个工作树,merge 改成快进 push,删掉部署前钉回那套补丁`。

---

### Task 4: 文档

**Files:** `docs/cc-workbench.md`(「回合与会话是两件事」那一节第 23 行那段**改写**;修订记录加一条)、`docs/maintainer/self-change.md`(工作树与清理)、两份 spec 的修订记录(新的写实现偏差;旧的开头加一行「本设计已被 2026-09-21-one-folder-one-session-design.md 取代」)。
- `cc-workbench.md` 的新说法:文件夹跟着「**还能写它的会话**」走;答复之后会话还开着 ⇒ 文件夹还占着;有人等就自动让位(缺省 15 秒),没人等就闲置 10 分钟后自己收工;收工后接着说会按原会话恢复。
- [ ] Step 1 改写 → Step 2 提交。

---

## 收尾(控制器做,不派发)

1. 全量 `bun run test` / `npm run test:node` / typecheck / depcheck;推 dev;`wechat-cc ci triage --wait --rerun`。
2. 重新构建 sidecar + `self deploy`,两条 selftest。
3. 跑一遍外部评审的三个探针,把输出记进 ledger。
4. 真机:桌面同文件夹连开两件事看等待行;`self change --no-deploy` 走一条确认 worktree 全链路。
