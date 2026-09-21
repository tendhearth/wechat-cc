# 工作台租约按回合计代:交错缺口四条(评审 2026-09-21 #1 #2 #6 #7)

日期:2026-09-21。对象:`src/core/workbench/service.ts` 的回合租约 / 保留会话机制(2026-09-15「答复即释放」+ 09-16 评审 #9「差异边界 = 租约边界」之后的形态)。外部评审 `~/Documents/tendhearth/cc-review/2026-09-21-claude-changes-review.md` 用假 runtime 复现了四条交错缺口,探针 `runtime-probe.ts` 在 `87fc118c` 上全部复现。

## 四条缺口的共同根因

租约的持有和释放**只认 `Active` 对象,不认回合**;回合的边界**只由 `result` 事件触发**。于是:

1. **#1 旧回合的异步释放删掉新回合的租约。** A 答复 → `releaseTurnLease` 先 `await captureCodeChanges`(截快照,可能 15 秒)→ 期间主人续接 A,`submitInput` 看到自己还持有租约(`acquireTurnLease` 返回 false 但照样开始)→ 旧的释放醒来,`reservations.get(identity)===running` 仍成立 → 删掉租约、`pump()` 放 B 进来。A 的续接与 B 并写同一目录;旧快照还会把新回合的改动截进去。
2. **#2 原生会话自动续作不申请租约。** A 答复后释放,B 开始;A 保留的 Claude 会话因后台通知(task_notification / Monitor)自己又开始写。服务端只在 `result` 事件上看状态,`foreground` 从 idle 变 running 没有任何钩子。
3. **#6 最后一个后台子任务结束不发 result。** `claude-workbench-runtime` 里子任务终结只推一条 `tool_call`(`terminalTask`),`backgroundCount` 归零但没有新的 `result`;`collectTurnArtifacts` 与 `releaseTurnLease` 只挂在 `result` 上 → A 显示 replied 却没有成果,同目录 B 永远 queued。
4. **#7 打回修改走 `continueTask`。** `continueTask` 对任何还在 `runsByTask` 的任务一律 `workbench_busy`;保留会话(Claude)答复后 `status` 一直是 running,于是「打回」永远送不到。和 selftest 09-19 踩的是同一个坑(续接要走 `submitInput`)。

## 设计

### A. 回合代数(turn generation)—— 修 #1

- `Active` 加 `turn: number`(从 1 起)。`reservations` 的值改为 `{ running, turn }`;`releaseTurnLease(running, turn)` 与 `captureCodeChanges(running, turn)` 都带回合号:
  - 释放只在 `reservations.get(identity)` 是同一个 `running` **且** `turn` 相等时才删;否则视为过期,静默返回。
  - `reviewBaseline` 带 `turn`;`captureCodeChanges(running, turn)` 只截 `baseline.turn === turn` 的那份;截完不清别人的 baseline。
- **续接必须等旧回合的快照截完再开新回合**:`submitInput`(以及 D 里的打回路径)在 `acquireTurnLease` 之前 `await running.reviewCapture`(若有),然后 `running.turn += 1`,重新取 baseline。此时若自己仍持有租约(旧释放还没跑到 delete),直接保留;旧释放醒来后因 `turn` 不等而放弃。若已释放,照旧走 `findPathBlocker`。
- 结算(`execute` 的 finally)不受影响:`releaseReservation` 不看 turn。

### B. 状态转移探测器 —— 修 #6 与 #2

在 `collectWorkbenchTurn` 的 observe 回调里,**每个事件之后**比较上一份与当前 `runtimeSnapshot`(`foreground`、`backgroundCount`、`retained`),不再只看 `ev.kind === 'result'`:

- **回合落定**(`foreground === 'idle' && backgroundCount === 0`,且上一份不是)⇒ 与今天 `result` 分支同样的动作:`collectTurnArtifacts` + matter `replied` + `releaseTurnLease(running, turn)`。`result` 事件本身仍触发同一函数(幂等:同一 turn 只落定一次)。这样最后一个子任务只发 `tool_call` 也能收尾,同目录的 B 能起来。
- **无租约的自动续作**(上一份 idle、当前 `foreground === 'running'` 或 `backgroundCount` 从 0 变大,且 `reservations` 里没有自己)⇒ 立即 `acquireTurnLease`:
  - 申请到 ⇒ `turn += 1`、取新 baseline,当作一个正常的新回合(它就是)。
  - 被挡(同目录已被 B 持有)⇒ **fail-closed**:`cancelRun(running)`(等同主人点「结束后台会话」,`closedWhileReplied` ⇒ 最终状态 `completed`),并给 A 加一条 system 事件「保留会话在 B 占用目录时自己又开始干活,已结束会话;A 的答复已交付,这段自动续作没有落地」。评审说「收到写操作事件之后再补锁已经太晚」是对的 —— 我们无法在原生会话动手之前拦它,能保证的是**最多一个事件的窗口**,而不是两条任务持续并写。
- 探测器只在 `!running.cancelled && !running.finishing && !running.uncertain` 时工作。

### C. 打回修改按会话状态分路 —— 修 #7

`returnReviewFiles`:
- `runsByTask` 里有 run 且 `isReplied(running)` ⇒ 走 `submitInput(id, { runId: running.identity, requestId, text, attachments })`,`text` 仍是 `composeReturnText(...)`(字节一致,幂等靠它);`requestId` 由调用方给,缺省从 `sha256(artifactSha256 + paths(排序) + comment)` 派生成 UUID 形状(v4 位形),不再 `randomUUID()` —— 重发同一份打回落到 `liveInputs` 的幂等分支。
- 有 run 但没 replied(还在写)⇒ `workbench_busy`(正确:回合中间不能打回)。
- 没有 run ⇒ `continueTask` 照旧(含 `restart_confirmation_required` 那套)。
- 标记仍在投递成功(拿到回执)之后写,键仍是 `artifactSha256 + path`。

### D. 可见性

`waitingFor` 加 `reason: 'same_path' | 'nested_path' | 'writer_not_closed' | 'retained_turn'` 透传给桌面 / 微信(今天只有前三种;第四种是 A 正在续接);`detail.turn` 暴露回合号,便于日志与测试。

## 非目标

- 不做原生会话的「暂停」——Claude runtime 没有这个能力;fail-closed 是结束会话。
- 不改 `findPathBlocker` 的路径语义,不改 FIFO。
- 不动 anchored-fs(评审 #3 另议)。

## 验证

- 四条探针场景改写成 `src/core/workbench/service-lease-turns.test.ts`(假 runtime 与探针同构:`snapshot()` 可控、`finish(bg)`、可推 `tool_call`):
  1. RESUME_DURING_CAPTURE:A 答复、快照截取中续接 A,再建 B ⇒ B 保持 queued,A 只有一份 `代码变更-*.json` 且不含续接后的文件;快照完成后 B 仍 queued 直到 A 的新回合落定。
  2. LAST_CHILD_ONLY:父 result 时 bg=1,最后子任务只发 `tool_call` ⇒ A `replied` 且 artifacts 含 late.txt,B 从 queued 变 running。
  3. AUTONOMOUS_AFTER_RELEASE:A 释放、B 开始后 A 的 runtime 又 running ⇒ A 被结束(`completed`,有 system 事件),B 照常 working;若 B 不存在 ⇒ A 重新持有租约、turn=2。
  4. RETURN_IDLE_REVIEW:保留会话答复后打回 ⇒ 走 submitInput,收到 `sending` 回执,标记写入;重发同一 requestId 不重复投递;working 中打回 ⇒ `workbench_busy`;已结算 ⇒ continueTask。
- 既有套件不能回退:`service-lease`、`service-review-boundary`、`service-turn-artifacts`、`service-background`、`service-review`、`claude-workbench-runtime`。
- 真机:桌面「打回」一个 Claude 保留会话的任务;同目录两件事连续跑一次看排队原因。

## 修订记录

(实现后补。)
