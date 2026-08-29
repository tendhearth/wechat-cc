# Reminders 移植(六月 feat/reminders → 现 dev)— 设计

日期:2026-08-20
状态:已评审(chat_id 权限范围经用户拍板;分支考古见 §0)
背景:六月的 `feat/reminders` 孤儿分支(tip `dcbaf94b`,679 行/11 文件)
实现了多用户精确时间提醒,但从未合并;它叠在早已以别的形态进入 dev 的
乙 v2 系列之上,merge-base 远在 v0.6.3。本设计只移植 tip 提交,并适配
两个月来的架构演进(bootstrap 拆分、SubsystemSupervisor、guest path
tier 模型、internal-api routes-* 拆分、#79 迁移位置契约)。

## 0. 分支考古(2026-08-20 核实)

- `git cherry origin/dev origin/feat/reminders`:15 个提交全部 patch-id
  不在 dev;但 yi 系列文件(src/core/yi-*、src/daemon/yi-*)**内容都已
  在 dev**(经其他路径合并/重做)——真正缺的只有 tip `dcbaf94b`。
- tip 提交 import 面干净:`lib/db`、`lib/lifecycle`、自身 store——
  不依赖分支上的任何 yi 改动。
- 六月迁移编号 v15;dev 现有 **28 个迁移** ⇒ 必须重编为 **v29 追加末尾**
  (#79 契约:user_version 是 COUNT,不是 id;详见
  [[migration-position-contract]] 与 db.ts 内 v19–v28 的长注释)。
  迁移体 `CREATE TABLE IF NOT EXISTS` + STRICT,重放安全。
- 其余分支(dmg-install-window / migration-reconcile / test-runner-guard)
  经核实 0 未合并提交,已删除远端。feat/reminders 分支在移植合并后同样
  删除。

**已定决策(2026-08-20 用户拍板):**
**所有 session 来源的调用仅限本聊天**——无论 tier,`chat_id` 强制等于
调用者自己的 chatId;file token(operator CLI)不受限。理由:「提醒我」
语义;六月原版的任意 chat_id 在 guest path 时代等于给每个会话一个
"让 bot 给任何人定时发消息"的骚扰/冒充原语。

## 1. 功能本体(照搬六月,不重新设计)

- **db 表 `reminders`**:id/chat_id/due_at(ISO 全时间戳)/text/created_at/
  status(pending|sent|cancelled|failed)/attempts/last_error,
  两个索引(status+due_at、chat_id+due_at);
- **store**(`src/daemon/reminders/store.ts`):schedule/cancel/list/
  listDue/markSent/markFailed/recordAttempt;
- **sweeper**(`src/daemon/reminders/sweeper.ts`):60s tick,
  `runReminderSweep` 纯函数注入 store+send+now,可单测;
- **internal-api**:`/v1/reminders/{schedule,cancel,list}`;
  schedule 收 `delay_seconds`(相对,首选)或 `due_at`(绝对)二选一;
- **MCP 三工具**(wechat server):schedule_reminder / cancel_reminder /
  list_reminders,中文描述、passthroughErrorResult 姿势。

与 companion agenda 的分界(六月注释原文有效):agenda 是 operator-only、
天粒度;reminders 是任意聊天、分钟级、跨重启。

## 2. 移植适配(本设计的实质内容)

### 2.1 迁移 v29(位置重写 + 一列新增)

六月表结构原样,**加一列 `last_attempt_at TEXT`**(§2.2 退避用;反正
位置要重写,不额外吃一个迁移号)。`state-migration.test.ts` 的 schema
fingerprint pin 与 schema.test.ts 的计数断言同步更新。注意 fingerprint
测试的 `foreign_keys ON` gotcha(见 [[migration-position-contract]])。

### 2.2 重试策略:指数退避(改动,不照搬)

六月版失败后每 60s 重试、24h 窗口 = 断线时单条提醒最多 1440 次外发
尝试,违反 [[no-retry-storm-when-disconnected]] 红线(退避必须指数级,
微信风控)。改为:

- `recordAttempt` 同时写 `last_attempt_at = now`;
- 下次可试时间 = `last_attempt_at + min(60min, 1min × 2^(attempts-1))`;
- `listDue` 的 SQL 过滤掉未到退避时间的行(pending 且 due_at 已过且
  退避已到);
- 24h 总窗口(due_at + RETRY_WINDOW_MS)后 markFailed 不变。
- 断线一小时 ≈ 7 次尝试(1+2+4+…),而非 60 次。

### 2.3 权限收窄(caller 层,internal-api)

三条路由统一走既有 caller 缝(`{ tier, origin, chatId }`,来自
token-registry):`origin === 'session'` ⇒ 请求里的 `chat_id` 必须等于
`caller.chatId`,否则 403(响应体不回显对方 chat_id);`origin === 'file'`
(operator CLI / 长期 token)不受限。schedule/cancel/list 三条同规则——
list 不能偷看别人的提醒,cancel 不能取消别人的。

MCP 工具描述同步重写:去掉 "for ANY user" 措辞,改为「给当前聊天设
提醒」;chat_id 参数保留(内部 API 校验它,而不是信任它)。工具对
**所有 tier 开放**(guest 自提醒无害——scope 已在 caller 层锁死,
这是 authorization 在服务端、不在工具可见性的既有原则)。

### 2.4 接线:SubsystemSupervisor + bootstrap 拆分归位

六月版直插 main.ts 的 `lc.register(registerReminders(...))`。现改:

- `supervisor.start('reminders', ...)` 注册为**可选子系统**——迁移或
  启动抛错 ⇒ degraded(health.subsystems 可见 + admin 摘要),不拖垮
  boot;核心收发链不受影响;
- 落点遵守 bootstrap 拆分约定(新接线进 bootstrap/wire-*.ts 家族,
  不回填 index.ts/main.ts 直插——具体挂在哪个 wire 文件由 plan 阶段
  按现状定,原则:跟 companion push 这类"可选外发 ticker"同族);
- `send` 仍走 live ilink adapter,检查 `r.error`(sendMessage 永不
  reject 的既有契约);
- sweep tick 亚秒级,**不**持 holdBusy token(空闲自动重启打断一次
  sweep 无害:store 持久化,下次 boot 续扫,最坏晚 1 分钟)。

### 2.5 路由归位

现 internal-api 已拆 `routes-*.ts` + `route-tiers.ts` 每路由 tier 表。
新建 `src/daemon/internal-api/routes-reminders.ts`,三条路由登记
route-tiers(session 全 tier 可用——见 §2.3 的服务端 scope);zod
schema 进 schema.ts;index.ts 挂载跟随既有姿势。

## 3. 测试策略

- store 单测(六月 8 个随迁)+ 新增:last_attempt_at 落盘、listDue 的
  退避过滤(未到退避时间不出、到了出、封顶 60min);
- sweeper 单测(六月 6 个随迁,注入 now 的纯函数姿势不变)+ 新增:
  失败后按指数间隔才重试的时间线用例;
- internal-api 路由测试:session caller chat_id 不匹配 ⇒ 403(schedule/
  cancel/list 各一)、匹配 ⇒ 通过、file origin 任意 chat_id ⇒ 通过;
- 迁移:fingerprint pin 更新 + v29 重放安全(IF NOT EXISTS)断言;
- 全量回归 `bun --bun vitest run`(容忍既知 2 个 bootstrap.test.ts
  环境失败);e2e 配置照旧。

## 4. 不做(YAGNI,显式登记)

- 重复提醒 / cron 语法(一次性够 v1;要重复让模型到点再 schedule);
- 修改提醒(取消重设即可);
- 微信内斜杠命令(自然语言经 MCP 工具已覆盖「明早八点提醒我」);
- companion agenda 合并/去重(分界清晰,各活各的);
- admin 跨聊天提醒(拍板落选项;真有需求再开一档)。

## 5. 实现期批注(2026-08-20,SDD 执行完结)

- **[fix-wave 增补]** 终审唯一 Important:新外发生产者无量控(退避只治
  重试风暴,不治首发爆发)。已修入 371e3557:schedule 侧每聊天 pending
  上限 `MAX_PENDING_PER_CHAT = 20`(超限 `ok:false, too_many_pending`)+
  sweeper 侧每次扫描发送尝试预算 `MAX_SENDS_PER_SWEEP = 30`(超出者计
  deferred、下轮按 due_at ASC 优先)。退避挡下的行不消耗预算。
- **[偏差登记,plan 授权]** §2.2 说 "listDue 的 SQL 过滤退避" ——实现放在
  sweeper 的循环顶闸(June 自己的 "sweep policy lives in the sweeper"
  分界),SQL 保持简单;行为等价。§2.4 说接线放 wire-*.ts——实际落在
  main.ts step-4 的 sup.start 块(mailbox-poller 同位同姿势,那才是现行
  惯例;wire-*.ts 家族装的是 bootstrap 产物组装)。
- **[fix-wave 增补]** markSent 加 `AND status='pending'` 守卫(cancel 与
  send 的亚秒竞态不再回写成 sent)。send→markSent 之间崩溃 = 重启后至多
  重发一次(at-least-once,main.ts 注释已如实写明)。
- **[parked,终审裁决]** 理论饥饿:全系统持续超载(聚合待发 > 30/轮×多
  聊天)下,单行可能 24h 内始终未获尝试而永不 markFailed——固定预算+
  退避设计的固有边界,每聊天 20 上限压住聚合需求;登记不修。
