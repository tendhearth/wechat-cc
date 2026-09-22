# 一个文件夹,一个活会话;一次自改,一个工作树

日期:2026-09-21(同日晚)。**这份设计是去掉前一份的补丁**,不是在它上面再加一层。前一份:`2026-09-21-workbench-lease-turns-design.md`(回合代数 + 状态转移探测器 + fail-closed 结束会话),它修好了外部评审的 #1 #6 #7,但 **#2 只是把窗口缩到「一个事件」**,而且为了维持那套隐式状态机,一轮评审里又补了五条判据(落定过的回合按没租约看、待决请求不吃掉落定、拍板后延一拍、过期权限也要落定、落笔前 alive 再查)。每加一条都说明:**模型本身是错的,不是实现不够细。**

## 错在哪

2026-09-15 那次改动写进代码的前提是:

> 「文件夹是一份租约,谁在写谁持有。回合答复后会话为续接保留,**但它不再写东西**。」(`service.ts:425-430`)

后半句是假的。Claude 的保留会话在答复之后随时可能自己动手:后台子任务的通知、`Monitor`、父会话被子任务唤醒——`claude-workbench-runtime.ts:150-182` 里 `retained` 一旦为真就是**黏性**的,`foreground` 可以从 `idle` 自己翻回 `running`,没有任何事件是「我要开始写了」的预告。外部评审的 #2 就是这件事,评审的原话也说清了:**「收到写操作事件之后再补锁已经太晚」**。

所以「已答复 = 不再写」和「文件夹空了」这两件事被画上了等号,而它们不相等。之后所有的补丁——代数、探测器、fail-closed——都是在用「事后观察」逼近一个本来就不成立的等式。

## 新的不变式

> **一个文件夹,同时只有一个还能写它的会话。占用从派发开始,到那个会话被关闭为止。**

「还能写」是能力,不是行为。一个保留着的会话**有能力**写,所以它占着。这句话是真的,不需要任何判据去维持。

会话关闭有三条路:

1. **自己收工**(Codex 那类不保留会话的执行者):流结束即结算,`releaseReservation`,和今天一样,一行不改。
2. **主人收工**:桌面 /微信 已有的「结束会话」,答复后结束记 `completed`(`service.ts:802`,已有)。
3. **空闲自动收工(新)**:会话安静下来(`retained && foreground==='idle' && backgroundCount===0 && 没有待决权限/提问)之后起一个计时器,到点关掉会话、让出文件夹。**两档**:
   - **有人在等这个文件夹** ⇒ 短让位 `handoff_grace_ms`(缺省 15 秒)。
   - **没人等** ⇒ 长空闲 `retained_idle_close_ms`(缺省 10 分钟),纯粹是别让一个闲着的原生进程占着资源。

   任何一下互动(补充输入、权限/提问出现、会话自己又开始写)都取消计时器;不再安静就不再计时。

### 为什么「关掉」不贵(已核实)

- **对话不丢**。`task.sessionId` 在 `init` / `result` 时就写进库了(`service.ts:742,763`),关闭**不清它**(只有主人明确选「重新开始」才清,`store.session(id,null)`,`service.ts:622-628`)。下一次续接走 `continuation()` → `canResume`(Claude 是看 `~/.claude/projects/.../<sid>.jsonl` 在不在,`providers.ts:218`)→ `{mode:'resume', sessionId}` → 原生 `--resume`。
- **真机早就验过**:2026-09-12 的并发验收里,服务重启(所有会话都被关掉)之后,北区 Claude `27e15c2a…` 与南区 Codex `01a0968c…` 两条都按原生会话号续上,并记得重启前算出的数(`docs/superpowers/reports/2026-09-12-cc-task-concurrency-validation.md`)。
- **丢的是该丢的**:内存里的后台子任务(关闭时按进程组 SIGKILL,`claude-workbench-process.ts:41-82`,不会变孤儿)、待决权限/提问(安静时本来就没有)、在途补充(安静时本来就没有)、差异基线(续接时重取)。成果、事件、审阅标记、执行选择、交接记录全在库里。
- 代价只有一条要写进文档:**关闭会中止仍在跑的后台子任务**——但计时器在 `backgroundCount>0` 时根本不起(那不叫安静),所以只有主人手动收工才会撞上,而那个按钮今天就已经这么说了(`workbench.js:135`)。

### 2026-09-15 那个真问题怎么办

当时的抱怨是:「主人只能取消一件**做成了的事**来疏通文件夹」。新模型的答案不是「假装文件夹空了」,而是:

- **有人等的时候,它自己会在 15 秒内让开**,并且等待方看得见倒计时;
- 等待方那一行给一个「让它现在就收工」的按钮(调已有的取消);
- 收工之后那件事还能接着说(按原会话恢复),只是要重新排队。

也就是说,原来的痛点被**自动化**解决了,而不是被**语义造假**解决。

## 删掉什么(这是重点)

`service.ts` 里今天有 236 处提到回合代数相关标识符。新不变式成立之后,下面这些整体删除:

| 删 | 为什么不再需要 |
| --- | --- |
| `Active.turn`、`reservations` 的 `{running,turn}`、`releaseTurnLease(running,turn)` / `captureCodeChanges(running,turn)` 的代数参数 | 租约在会话活着期间从不释放,不存在「过期的释放」 |
| `beginTurn` / `acquireTurnLease` / 落笔前的 `alive()` 复查(终审 C1) | 续接不再需要重新申请租约——你从来没失去过它 |
| `onAutonomousStart` + fail-closed 结束会话 + 那条 system 事件 + `autonomousTurn`(评审 #2 的补丁) | 自动续作现在天然合法:文件夹本来就是它的 |
| `settledTurn`、`settleAfterDecision` 的延一拍(终审 I4 的那半)、`markUncertain` 的代数自增(终审 I2) | 都是为了保护「释放」这个动作;没有释放就没有要保护的 |
| `waitingFor.reason: 'retained_turn'` | 等待原因回到 `same_path` / `nested_path` / `writer_not_closed` 三种,另给「持有者在不在写 + 还有几秒自动让位」两个字段 |

保留:**成果在回合安静时就登记**(评审 #6 的正确那一半,2026-09-16 起的既有行为)、**打回按会话状态分路**(评审 #7,和租约无关)、`writer_not_closed` 隔离、FIFO 与路径冲突语义。

## 设计(工作台)

### 1. 占用

`reservations: Map<identity, Active>`(去掉 turn)。写入点只剩 `pump()`(派发)和 `markUncertain()`(隔离);删除点只剩 `releaseReservation()`(结算 / 关闭)。`releaseTurnLease` / `acquireTurnLease` 两个函数删除。

### 2. 安静与计时器

`Active` 新增:

```ts
idleClose?: { timer: ReturnType<typeof setTimeout>; at: number; reason: 'handoff' | 'idle' }
```

- `quiet(running)` = 既有的 `isReplied(running)`(`service.ts:326-331`,已经正好是这个判据)。
- 转移探测器(前一份留下的 `noteTransition`)简化成两件事:**变安静** ⇒ 登记本回合成果(既有 `collectTurnArtifacts`)+ `armIdleClose(running)`;**不再安静** ⇒ `cancelIdleClose(running)`。不再有自动续作分支。
- `armIdleClose`:`wanted = queue.some(q => findPathBlocker(q, [running]) )`(有人在等这个文件夹)⇒ `handoffGraceMs`,否则 `retainedIdleMs`;已有计时器且新档位更短 ⇒ 重排。
- `pump()` 在发现候选被一个**安静的**持有者挡住时,调 `armIdleClose(holder)`——这是「有人来等了」的唯一入口。
- 计时器到点:再查一遍 `quiet && reservations.get(identity)===running && !finishing && !cancelled` ⇒ `running.closedWhileReplied = true; void cancelRun(running)`;并加一条 system 事件:「空闲 N 秒后自动收工,文件夹让给「B」;要接着说直接发下一句,会按原会话恢复。」
- 取消点:`submitInput` / `resolvePermission` / `resolveAnswer` / 任何让 `quiet` 变假的转移 / `cancelRun` / 结算。这些位置今天都已经在写 `interactionAt`(`service.ts:674,675,857,1169,1185`),照着加一行。

### 3. 续接

`submitInput` 去掉 `beginTurn`:只要 `running` 还活着且不在结算,就 `cancelIdleClose` → `await running.reviewCapture`(如果上一轮的快照还在截,等它截完;这一句保留,理由不变:别把新回合的改动截进上一轮)→ 重取 `reviewBaseline` → 投递。**不需要代数**,因为没有任何人会在这期间释放租约。

`continueTask`(会话已结算的那条路)不变:新建 run → 入队 → `pump` 按路径冲突排队。

### 4. 可见性

`waitingFor` 增补两个字段(不改既有 `reason`):

```ts
waitingFor: { taskId, title, reason, holderWriting: boolean, closeInMs: number | null }
```

桌面:`same_path`/`nested_path` 且 `holderWriting===false` ⇒ 「「A」已答复,会话还开着;<N> 秒后自动让出文件夹 —— 也可以现在就让它收工」+ 按钮(调已有的停止)。`holderWriting===true` ⇒ 今天的文案。微信 `任务 <id>` 的等待行同上(一句话)。

### 5. 配置

`agent-config.json`:`workbench_retained_idle_close_ms`(缺省 600000)、`workbench_handoff_grace_ms`(缺省 15000)。按 `unattendedAck` 的样子接线(`wire-workbench.ts:99-107,164`),用**闭包**读(`ownerChatId` 那种,`wire-workbench.ts:128`),不要 `loadAgentConfig` 快照,好让改了立刻生效。两个值都允许 `0`(=立刻关)与很大的数(=几乎不自动关);`< 0` 视作缺省。

## 设计(自改流水线):一次自改,一个工作树

今天所有运行共用一个克隆 `<workdir>/repo`,每次 `checkout -B self/<id> origin/dev` + `reset --hard`。于是 B 的 `repo` 步会在 A 的树下面把文件换掉——评审 #4 就是这个类。上一轮的修法是在部署前「把克隆钉回批准的提交」(`ensureApprovedTree`,`steps.ts:699-758`),那也是补丁。

**改成每次运行一个 git worktree**(实测本机:`git worktree add` 0.3 秒;全新工作树里 `bun install --frozen-lockfile` 306 毫秒,因为 bun 自己的缓存就是 CoW 链接;1.1 GB 的 `node_modules` 连拷都不用拷)。

- `<workdir>/repo` 降级成**只用来 fetch 的中枢克隆**,不在它里面构建、不在它里面 checkout 业务分支。
- 每次运行:`git -C <hub> worktree add <workdir>/runs/<id> -b self/<id> origin/<branch>` → 在工作树里 `bun install --frozen-lockfile` → 写交代 → 之后所有步骤(implement / guard / tests / review / ci / merge / deploy)的 cwd 都是 `<workdir>/runs/<id>`。
- **merge 不再 checkout dev**(worktree 里 checkout 一个别处已检出的分支会被 git 拒绝):`fetch origin` → `rebase origin/<branch>` → `sha = rev-parse HEAD` → **`git push origin HEAD:refs/heads/<branch>`**(普通 push 天然只许快进,语义与 `merge --ff-only` 一致)→ 删远端 `self/<id>`。
- **删掉 `ensureApprovedTree` 及其调用**:运行自己的工作树没有别人能动,HEAD 就是刚推上去的那条提交。部署前只留一条便宜的断言:`rev-parse HEAD === merge.sha`,不对就 `deploy_tree_mismatch`(保留这个失败码与恢复文案)。
- **恢复**(`--resume` 到 deploy):工作树还在 ⇒ 直接用;被删了 ⇒ 用 `merge.sha` 重建一个 detached 工作树,再断言一次。
- **清理**:`repo` 步开头做一次机会性清理——`git worktree prune`,并把**终局且超过 24 小时**的运行(`StateStore.list()` 已经能列)对应的 `<workdir>/runs/<id>` 连同 worktree 一起删。
- 锁保留(一次只跑一条仍是产品选择),但它不再是**正确性**的前提。

## 非目标

- 不给工作台的**用户项目**做每任务工作树。那会把「CC 在我的目录里干活」变成「CC 在副本里干活,回头合给你」——是产品语义的改动,要另外拍板。并行(同一文件夹两件事同时跑)因此仍然不支持,这是新不变式的**诚实代价**。
- 不动 `anchored-fs`(评审 #3,另议)。
- 不改路径冲突语义、FIFO、`writer_not_closed` 隔离。

## 验证

- **不变式测试**(`service-one-session.test.ts`,替换 `service-lease-turns.test.ts`):
  1. A 答复(保留会话)、B 建在同一文件夹 ⇒ B `queued`;A 的 runtime 自己又开始写 ⇒ **B 仍然 queued,A 没有被结束、没有 system 告警**(前一份设计里这一条是「A 被杀」)。
  2. 同上,15 秒让位到点 ⇒ A `completed`/phase `replied`、有那条 system 事件、B `running`;再对 A 发一句 ⇒ 走 `{mode:'resume'}`,原生会话号不变。
  3. 没人等 ⇒ 10 分钟才关;期间补充一句 ⇒ 计时器取消,回合正常继续。
  4. 安静期间出现待决权限 ⇒ 不关;权限解决且仍安静 ⇒ 重新计时。
  5. `backgroundCount>0` ⇒ 不算安静、不计时;等最后一个子任务结束(只发 `tool_call`)⇒ 登记成果 + 开始计时(评审 #6 的正确那一半仍成立)。
  6. 快照还在截时补充一句 ⇒ 上一轮快照不含新写的文件,且**没有任何释放发生**(旧 #1 的场景,现在是构造上不可能)。
  7. 打回(评审 #7)四条照旧。
- **既有套件的反转**:`service-lease.test.ts:48`(答复即释放)改成「答复后 B 仍等,收工后 B 起」;`service-background.test.ts:318` 的注释与断言同改。
- **探针**:外部评审的 `runtime-probe.ts` 三块在新语义下应为:`LAST_CHILD_ONLY` 成果登记 + B 起(靠自动让位);`RETURN_IDLE_REVIEW` 无错;`AUTONOMOUS_AFTER_RELEASE` 里 A 不再被结束、B 不并发。
- **自改**:整合测试用真 git(中枢克隆 + 两个工作树)验证两条运行互不影响;`--resume` 在工作树被删之后能重建并断言 HEAD。
- **真机**:桌面上同文件夹连开两件事,看等待行的倒计时与「让它收工」;跑一条 `self change --no-deploy` 确认 worktree 路径全链路。

## 修订记录

(实现后补。)
