# 工作台实时事件流(桌面)设计

日期:2026-09-17。状态:已与主人口头定案,待实施计划。

## 背景与目标

桌面版要在主人坐在电脑前时也能当主工具用(替代直接开 Claude / Codex CLI 的那种用法)。对比 Codex Desktop、Claude Code 桌面版、Zed(ACP)三家:它们都不是把终端嵌进去,而是把 agent 的结构化事件流原生渲染成界面。我们的 daemon 已经站在同样的地基上(Codex 走 `codex app-server`,Claude 走 SDK,事件已进 `workbench_events`),缺的是三件:

1. daemon 没有"任务变了"的信号,桌面只能每 3 秒整页轮询;
2. Claude 执行者没开逐字流(只有整条 `assistant` 到达时 `replace`),Codex 有 `item/agentMessage/delta`;
3. 桌面每次刷新 `root.innerHTML` 整块重建,靠四十行补丁保滚动/展开/焦点。

**目标**:任务运行时,桌面上文字逐字出现(两家执行者一致),工具调用开始/结束即时可见,「停止」一按立刻有反应,页面不闪不跳。

**不做**(留给后续步骤):任务列表的长轮询、SSE / WebSocket、逐文件 diff 审阅(第二步)、ACP(第三步)。

## 架构

```
executor (codex / claude / api)
   └─ AgentEvent 流 ─▶ service.execute 的消费循环
                          └─ DeltaCoalescer(≤150ms 合并 text append)
                                └─ store.recordAgentEvent / update / permissions / artifacts
                                      └─ changes.bump(taskId) ─▶ TaskChangeHub(waiters)
                                                                       ▲
GET /v1/workbench/task?id=&since=&wait_ms= ──── 长轮询 ───────────────┘
   └─ 桌面:long-poll 循环 ─▶ 合并 events ─▶ 增量 DOM 补丁(live group)
```

## 组件

### 1. `TaskChangeHub`(`src/core/workbench/task-changes.ts`)

- `bump(taskId): number` —— 该任务 seq +1,唤醒所有等这个任务的 waiter,返回新 seq。
- `seq(taskId): number` —— 当前值(进程内存;重启从 0 开始,见"seq 的持久化")。
- `wait(taskId, since, maxMs): Promise<number>` —— `seq > since` 立即返回;否则挂起,bump 或超时后返回当前 seq。
- 实现照抄 `src/core/cli-permission-relay.ts:112-123` 的 waiters 数组 + 定时器;每任务 waiter 上限 8(超出直接返回当前 seq),防止泄漏。
- 不是通用事件总线;只服务工作台任务详情。

**seq 的持久化**:`workbench_tasks` 加列 `seq INTEGER NOT NULL DEFAULT 0`(迁移 v61);`bump` 先 `UPDATE workbench_tasks SET seq = seq + 1` 再读回,hub 内存值只是缓存。这样 daemon 重启后桌面带着旧 `since` 来也不会错判"没变"。

### 2. 事件行的 `seq`(迁移 v61)

- `workbench_events` 加列 `seq INTEGER NOT NULL DEFAULT 0` + 索引 `(task_id, seq)`。
- `timeline-events.ts` 的 upsert 在 INSERT 和 UPDATE(append 追加)时都写 `seq = 当前任务 seq`(bump 之后的值)。
- `store.detail(id, { since })`:`since` 给了就只返回 `seq > since` 的事件行(新增或被追加过的),并返回 `version = 当前 seq`。不给 `since` 行为不变。
- 存量行 seq = 0:第一次带 `since=0` 会拿到全部,正确。

### 3. bump 的落点

单一入口是 `store`:以下每个写点结束后调用 `changes.bump(taskId)`:

- `recordAgentEvent`(含 text append 的 UPDATE)、`addEvent`、`finishRunActivities`
- `update(status)`(queued / running / cancelling / completed / failed / cancelled / interrupted)
- 权限、提问的登记与解决(`permissions.*`、`questions.*`,由 service 在写完后 bump)
- 成果登记(`artifacts`)、执行者切换(`reportExecution`)、live inputs 变化

原则:**任务详情里能看见的任何变化都 bump**;bump 多了只是多一次空返回,漏了才是 bug。测试用"改动 → 详情 → version 必增"的表格覆盖。

### 4. `DeltaCoalescer`(`src/core/workbench/delta-coalescer.ts`)

- 位于 `service.execute` 消费循环和 `store.recordAgentEvent` 之间。
- `text` 且 `textMode:'append'` 的事件按 `(runId, itemId)` 在内存里拼接;定时器 150ms 到期、或收到任何非 append 事件、或流结束时 flush 成一次 `recordAgentEvent(append)`。
- `replace` 事件到达时先 flush 同 itemId 的挂起增量,再原样写入(整条为准)。
- 两家执行者共用;Codex 现有的逐 delta 一次 UPDATE 的写放大由此收敛。

### 5. Claude 逐字流(`src/core/claude-workbench-runtime.ts`)

- SDK 选项加 `includePartialMessages: true`。
- `receive()` 新增分支:`stream_event` 且 `event.type === 'content_block_delta'` 且 `delta.type === 'text_delta'` ⇒ 发 `{kind:'text', itemId:'claude:<uuid>:text:<index>', textMode:'append', text: delta.text}`。`content_block_start` 记录 index → itemId 映射;`uuid` 取自 stream_event 的 `uuid`/`parent_tool_use_id` 之外的消息 id(与整条 `assistant` 的 itemId 规则一致,保证 replace 能对上同一行)。
- 整条 `assistant` 到达仍发 `replace`(权威文本),覆盖增量拼出来的内容。
- `narrow()`(`claude-agent-provider.ts:285`)不再丢 `stream_event`,但只在工作台 runtime 里消费;微信对话那条路照旧忽略。
- 版本钉死:runtime 目前钉 `claude_code_version === '2.1.267'`;开 partial messages 不改这条。

### 6. 内部 API(`routes-workbench.ts`)

- `GET /v1/workbench/task?id=<id>&since=<n>&wait_ms=<ms>`
  - `since` 缺省 ⇒ 现行为(全量,不等待)。
  - `since` 给了:先 `detail(id,{since})` 探一次(不存在 ⇒ 立刻 404;`version > since` ⇒ 直接返回,不等);否则 `await changes.wait(id, since, min(wait_ms, 20000))` 再取一次 `detail(id,{since})`,body 里带 `version`;没变化时也返回 200 但 `events: []`、`version` 不变(桌面据此空转)。
  - 找不到任务 ⇒ 404 照旧;`since`/`wait_ms` 非数字 ⇒ 400。
- tier 不变(admin,operator 放行)。
- 长轮询上限 20 秒 < Rust 代理的请求超时(改为 35 秒)。

### 7. Tauri 代理(`apps/desktop/src-tauri/src/lib.rs`)

- 放行清单按路径不看 query,**不用改**。
- `workbench_api` 的 `reqwest` 超时从 30 秒改 35 秒(只此一处)。
- 仍是缓冲式 JSON;不引入流式命令。

### 8. 桌面(`apps/desktop/src/modules/workbench*.js`)

- **选中任务**:从 3 秒 `setInterval` 改为长轮询循环:`since = state.version`,请求返回后按事件 id 合并 `events`(新 id 追加;已有 id 替换整条,append 过的行服务端已合并成整段),更新 `version`,立即发起下一轮。切换任务 / 离开页面 / 隐藏时中止(`AbortController`)。请求失败退避 1s→2s→…→10s。
- **任务列表**:仍 3 秒轮询(本步不改)。
- **增量 DOM**:
  - 正在跑的一组(`renderGroup` 的 live 分支,`data-timeline-group`)改为按 `data-event-id` 打补丁:文字事件更新 `.wb-message-body` 的文本(保留 markdown 渲染,但只重渲那一条);活动事件只换 `data-status` / class 与状态文案;新事件 append 到组尾。
  - 结构性变化(status / phase / permissions / questions / artifacts / runtime.retained 变化)仍走整页 `renderWorkbench`。判定用一个小的 `structuralSignature(state)`,取代现在对整个 state 的 `JSON.stringify` 比较。
  - "跟到底部 vs 停在阅读处"的逻辑保留,但只在增量路径下用 `atEnd()` 决定是否滚动,不再需要 anchor 捕获/恢复。
- **停止**:`POST /v1/workbench/cancel` 带 `expectedRunId`(路由端也解析它,传给 `service.cancel`);cancel 落库时 `update('cancelling')` 会 bump,长轮询立刻返回,按钮切到「正在停止…」。

## 数据流(一次 Claude 回合)

1. SDK `stream_event` text_delta ×N → runtime 发 N 条 append。
2. Coalescer 每 150ms 合并成一条 append → `recordAgentEvent`(UPDATE 行,写 seq=k)→ `bump` → seq=k+1 … 
3. 桌面挂着的 `wait(id, since=k-1)` 被唤醒 → 返回 `events:[那一行]`、`version=k+1`。
4. 桌面按 id 找到节点,替换文本;不重建页面。
5. 整条 `assistant` 到达 → replace → 同一行 UPDATE → bump → 桌面替换为权威文本。
6. `result` → `update('completed'|'replied')` → bump → 桌面整页重渲(结构变化),live 组折叠成 details。

## 错误处理

- hub waiter 超时返回当前 seq,路由返回空 events;桌面空转不报错。
- 桌面长轮询网络错误:退避重试,页面显示已有内容不清空;`doctor` 的重连诊断不变。
- daemon 重启:seq 持久化在 `workbench_tasks`,桌面的 `since` 仍有效;若任务被判 `interrupted`,状态 bump 后桌面整页刷新。
- Coalescer 在 execute 异常退出时 `flush()` 于 `finally`,不丢尾巴。
- Claude `stream_event` 解析失败(字段缺)⇒ 忽略该条,不影响整条 `assistant` 的 replace。

## 测试

- `task-changes.test.ts`:立即返回 / 挂起被 bump 唤醒 / 超时 / waiter 上限 / 多任务互不干扰。
- `store` / `timeline-events`:v61 迁移(`db.test.ts` 计数 61 + 指纹锁,`state-migration.test.ts` 表列表);INSERT/UPDATE 都写 seq;`detail({since})` 只返回变过的行;表格测试"每种写点 → version 必增"。
- `delta-coalescer.test.ts`:150ms 合并、非 append 事件触发 flush、replace 先 flush 后写、结束 flush。
- `claude-workbench-runtime.test.ts`:假 SDK 消息序列(content_block_start → text_delta ×3 → assistant)⇒ 事件序列(append ×3 + replace 同 itemId);字段缺失被忽略。
- `routes-workbench.test.ts`:`since`+`wait_ms` 的等待与立即返回、上限 20s、参数校验、`expectedRunId` 透传。
- 桌面单元(vitest,`apps/desktop/src/modules/*.test.js`):`mergeEvents`、`structuralSignature`、live 组补丁函数(用 jsdom 片段)。
- Playwright:fixtures 的假 daemon 支持 `since` 长轮询;新 spec:推三段文字 ⇒ 依次出现且 `data-timeline-group` 节点身份不变(同一个 DOM 引用);停止 ⇒ 1 秒内出现「正在停止…」。
- 真机:一个 Claude 任务、一个 Codex 任务,目测逐字出现;日志看 bump 频率。

## 修订记录

- 2026-09-17:初稿(与主人口头定案:不嵌终端,走"原生渲染事件流"一派;先流、再 diff、再评估 ACP)。
- 2026-09-17:按实施计划落地(任务 1–8);实施中的偏离:store 的 detail 先读 version 再读 events;hub 只在 seq 前进时唤醒;liveInputs 也 bump;桌面"拿不准就整页重画"(错组 / 提升行 / 展开中的详情)。
- 2026-09-17:终审修复:合并器 flush 抛错不再逃到进程级;`start()` 事务内不再发布;hub 以持久化 seq 为准可自愈(发布更小的值只降缓存不唤醒);路由先探 detail 再等(未知任务立刻 404,已有新数据不等)。
