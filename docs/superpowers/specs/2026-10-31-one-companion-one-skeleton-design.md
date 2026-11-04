# 一个伙伴,一副骨架:一件事一条线 + 一个在场层(设计稿 2026-10-31)

> 主人 10-31:「学习先进的架构和设计理念(Claude、Codex、Paseo…),哪些地方需要好好规划,感觉有点乱。不要打补丁,而是解决问题。」
> →「(陪伴和干活)两边都是核心,我觉得不冲突,但怎么融合是一个问题,哪怕一个伙伴,也可以帮我做工作,也可以陪我。」
> →「陪伴本身就是时在时不在,但不论怎么样,统一面是不会错的,从产品角度。」
>
> 做法:两路只读调研(做事的四种模型;开口 / 在场的全部发起方),关键结论我对源码核过。数字是 dev `3fba7813` 上量的;真机数据量是只读打开主库数的。
> 这一份接在[架构终态 2026-10-25](../../architecture-end-state-2026-10-25.md)后面;U 线取代 [10-05 此刻 / 一起做层级](2026-10-05-now-together-hierarchy.md) 的「两个入口」那部分(「每样东西只有一个家」的规矩不变):那一份把**代码放在哪**收干净了(A–G 基本落地),这一份收的是**概念**——同一件事在系统里只有一种样子。

## 0. 一句话

CC 是**一个**伙伴:它帮你做事,它也陪你。所以系统里只该有

1. **一个「它」**:身份、记忆、和你的关系(已有,不动);
2. **一种「做事」**:不管是你交代的活、终端里的会话,还是它自己想写的一封信、去打的一次猎,都是「一件事」→「一轮」→「一步」,写在同一条线上;
3. **一个「在场」**:它什么时候出现、在哪儿出现(微信、App、桌宠、桌面),只有一个地方决定,干活的信号和陪伴的念头放在一起排轻重。**不在场是常态**,在场层决定的是「什么时候在」。

客户端(桌面、App、网页、微信)只讲**一套**协议:请求 + 订阅这条线。

## 1. 对标:别人怎么做的(只取结构)

| | 做事的模型 | 客户端怎么看 | 我们取什么 |
|---|---|---|---|
| Codex app-server | Thread → Turn → Item,item 有 started / delta / completed | 终端界面、IDE 插件、桌面 app 都是同一个 JSON-RPC 协议的客户端,订阅 item 通知 | 三层模型 + 事件词汇 + 「所有客户端吃同一条流」 |
| Paseo | 一个 agent 一条时间线,daemon 在本机 | 手机 / 桌面 / 网页一个 WebSocket 协议,中继端到端加密 | 本机 daemon + 中继这一形状我们已有;取「一条时间线」 |
| Claude Code | 会话 = 一串消息与工具调用(transcript);hooks / skills / plugins 挂在同一个循环上 | 终端、IDE、SDK 都是同一个循环 | 「功能 = 技能」:写信、画画、打猎是 CC 会的本事,跑在同一套循环里,不是各带定时器的子系统 |

## 2. 今天的样子(调研 + 核对)

### 2.1 做事:四套模型,五种事件词汇

| | 存在哪 | 过程(一步一步)存了吗 | 实时更新 |
|---|---|---|---|
| 对话 | `messages`(收发的话)+ `turn_records`(每轮一行摘要)+ `sessions`(续接指针) | **没存**:执行者的 `AgentEvent` 在内存里折成 `TurnSummary`,工具调用只剩名字列表 | 没有;手机轮询 `/m/api/chat` |
| 一起做 | `workbench_tasks` + `workbench_events`(按 `(task, run, event_key)` 可 upsert,接近 item)+ `workbench_run_execution` / `workbench_turn_usage`(接近 turn)+ 约 25 张子表 | 存了 | 桌面长轮询 `GET /v1/workbench/task?since&wait_ms`(每任务 `seq` + `TaskChangeHub`) |
| 终端会话 | `cli_sessions`(只有状态) | **没存**:每次读都去重新解析外部 CLI 的 transcript 文件(`features/terminal/cli-activity.ts`) | 手机展开时每几秒轮询 |
| 一件事 | `matters` + `matter_bindings` + `matter_sessions` | 不是源:`detail()` 现拼(任务读 `workbench_events`,对话读 `messages`) | App 订阅 `matter/<id>`(每 2 秒比快照 + poke) |

- 事件词汇五种:`AgentEvent`(`ports/agent-provider.ts:75`)、`TaskEvent`(`timeline-events.ts:5`)、`MatterEvent`(`app/matters/service.ts:17`,`kind: string`)、`CliActivityItem`(`cli-activity.ts:18`)、`messages.direction/kind`。
- 状态枚举四套:任务 7 个值、matter 4 个、终端 4 个、手机再推一个 `phase`。
- 「一件事」只是一层绑定:和任务 1:1 同 id、和对话按 `owner_chat_id` 1:1、**终端会话完全没接上**;`matters.status / title / project_path` 是任务那几列的手抄。
- 名字冲突:`threads` 表是「从对话里抽出来的话题」,`conversations` 是对话的模式配置,`session_state` 是微信登录状态。
- 好的底子:执行者那一侧**已经**只有一种事件 `AgentEvent`(对话和一起做共用);分歧全在落盘和读取。

### 2.2 在场:一道门,但一半的话不过门

好的:`SpeechPolicy`(`domain/speech/decide.ts` 纯函数 + `speech_log` 记账 + 持久的待发队列 + 指数退避)、`kinds.ts` 一张类别表(blocking / requested / report / initiative,调用方不能自选)、`proactive-channel` 一处选通道、`computePresence` 桌宠和手机共用、`speech-send` 守卫。

问题(都核过源码):

1. **陪伴自己的推送不过门。** 问候 / agenda / 打猎走 `tick-dispatch.ts:139` 的 `replyDelivery.begin`,不经 `speech.say`:`speech_log` 里没有它们,免打扰和关心档在 `tick-push.ts:53-59` 又判了一遍。
2. **各发起方各有定时器、各有冷却,没有人统筹。** 信(15 分钟一拍、24–38 天一封)、早报 / 定时(60 秒)、记忆整理(15 分钟)、贴纸(每天)、社交(120 秒)、提醒(60 秒)、回报(60 秒)、终端(自己的 hub 时钟)各开各的;「上次主动开口」(`lastProactiveAtIso`)只有陪伴那几样在记 —— 刚寄了一封信,问候照样来。便宜模型在挑「这次说什么」时,看不见信、早报、记忆通知这些候选。
3. **一件事,两次问门。** 任务做完:`phone-notifier` 问一次(App 推送),`wire-notifications` 再问一次(微信),靠 `silent` 标记避免重复推。
4. **会丢。** 压着的 App 推送只在内存(`push-gate.ts`,重启就没);贴纸、社交见闻被推迟 = 丢掉。
5. **退避三套**:待发队列(5 分钟起)、工作台通知 worker(60 秒复查)、回报 / 提醒(`backoffMs`)。
6. **桌宠不是一个「在场」的出口。** 它只能轮询 `/v1/permissions/pending` 和 `/v1/companion/pet`;开口那条路的通道类型只有 `wechat | app`。「主人在不在电脑前」(机器空闲时间)只有终端会话在用。

### 2.3 接口:两族路由、四种实时

`/v1`(桌面,约 240 条)与 `/m/api`(手机,61 条)同一份数据两份契约(`/v1/matter` 与 `/m/api/matter` 各自手拼);实时有工作台长轮询、手机 topic 快照比对、终端的挂起请求、App 推送四种机制。约束:**App Store 上的 App 不能强制升级**(`packages/protocol/src/routes.ts` 头注释),旧路径要留一段。

真机数据量(只读数的):`workbench_events` 1359、`workbench_tasks` 224、`messages` 774、`turn_records` 178、`cli_sessions` 167、`speech_log` 504 —— 迁移没有量的压力。

## 3. 终态

### 3.1 做事:一件事 → 一轮 → 一步

**名字**:沿用产品已经在说的「一件事」= `matter`(不叫 thread,`threads` 表已经是话题)。一轮 = `turn`,一步 = `item`。

```text
matter   一件事:谁发起(initiator)、从哪来(origin_surface)、是什么(kind)、状态、标题、项目
  └ turn    一轮:谁执行(executor + 模型 + 原生会话)、开始 / 结束、结局、用量、编译好的策略摘要
      └ item  一步:你说的话 / CC 说的话 / 工具调用 / 权限卡 / 提问 / 成果 / 送达(哪个气泡发到了哪) / 系统 / 错误
```

- `matter.kind`:`chat`(和主人的那条长对话)| `task`(一起做)| `terminal`(终端会话)| `act`(CC 自己做的事:写信、画画、打猎、早报…)。
- `matter.initiator`:`owner | cc | peer`。**陪伴和干活的区别只在这一个字段**,骨架一样。
- 状态机一套:`open → working ⇄ waiting(等你)→ done | failed | cancelled`,`archived` 正交。任务、终端、手机的 phase 都从它推,不再各存一份。
- item 有 `matter_id, turn_id, seq, kind, status(started | completed | failed), item_key(upsert 用), payload(json)`。`seq` 每件事单调,另有全库单调的 `cursor` 给订阅用。事件词汇照 Codex:`turn.started / item.started / item.delta / item.completed / turn.completed`。
- **一个写口** `MatterLog`(ports):对话的协调器、工作台服务、终端会话的 hub、CC 自己做事的那几样,都只经它写。执行者那侧不动 —— `AgentEvent` → item 的翻译只有一份。
- `messages` 留下,分工是:**「说了什么」= `messages`,「怎么做的」= item**。用户说的话 / CC 说的话这两种 item 不抄正文,只引 `messages.id`;工具调用、权限卡、成果、送达这些过程只在 item 里。读对话正文的地方(提示词上下文、每晚整理记忆、搜索、客户回顾)一个都不用改。
- 退休:`turn_records`、`workbench_events`、`workbench_run_execution`、`workbench_turn_usage`(并进 turn)、`MatterEvent` / `TaskEvent` / `CliActivityItem` 三种形状、`matter_bindings` 里手抄的状态与标题。工作台其余子表(审阅、回退、工作区、附件…)留着,只是外键从 task 改认 matter(今天本来就同 id)。
- 终端会话:hook 来一条记一条 item;外部 CLI 的 transcript 只在第一次看到某会话时导入一次(以后不再每次重新解析)。

### 3.2 在场:一个调度

```text
各发起方 ──提议(Bid)──► 在场层 ──► 通道:微信 / App 推送 / 桌面通知 / 桌宠
 一件事的状态变化(做完 / 卡住 / 等你批准 / 有问题)
 CC 自己想做的事(写信、问候、打猎、贴纸、串门见闻、记忆通知)
 你约好的(提醒、定时任务)
```

- **一个提议的形状**:`{ kind(SpeechKind), matterId?, origin(由 kind 定), expiring?, produce() }`。发起方**只提议**,不自己发、不自己判免打扰和冷却。
- **一个判定**:今天的 `decide()` 扩成三步 —— ① 硬规则(blocking 照发、免打扰、关心档、通道可用);② **主动开口的预算是全局的**:「上次主动开口」从 `speech_log` 推(所有 initiative 类别都算),一封信、一份早报都会让下一次问候往后挪;③ 同一时刻有多个 initiative 提议时,交给今天的便宜模型挑一个(候选从「陪伴那三样」扩成所有 initiative 提议;模型只能少做,`constrainPlan` 照旧)。
- **一个出口**:一件事的一次状态变化只产生**一个**提议,在场层按「主人此刻在哪」选通道:在电脑前(机器空闲时间,今天终端会话那条规则推广到全局)⇒ 桌面通知 / 桌宠;不在 ⇒ App 推送;App 没设备或推送窗口外 ⇒ 微信。`phone-notifier` 与 `wire-notifications` 的「两次问门」收成一次。
- **一个待发队列**:持久(含今天只在内存里的压着的推送),一套指数退避;被推迟的不再静默丢掉,过期的(`expiring`、`expiresAt`)明确记一行「过期作废」。
- **桌宠是一个出口**:它订阅在场层的输出与一件事的状态(见 3.3),不再轮询。「时在时不在」落在这里:没有该说的,它就安静地待着。
- 留着不动:`kinds.ts` 一张表、`speech_log`、claim-before-send 的至多一次、网络守护「被拒不记」、`computePresence` 三轴。

### 3.3 一套协议:请求 + 订阅

- 一张路由表(已有 `packages/protocol/src/routes.ts`),每条路由**一个**路径;桌面 / App / 网页的差别只在**令牌的权限范围**(operator、设备、链接令牌 read / write),不在路径族。
- 订阅只有一种:`subscribe(topic, since=cursor)` → `turn.* / item.* / matter.updated / presence.updated` 通知。topic:`home`、`matter/<id>`、`presence`、`approvals`。传输可换:本机直连(桌面,长轮询或本机 WebSocket 由实现定)、中继 v2(App / 网页,已有 `sub/unsub`)。
- 今天四种实时机制(工作台长轮询、手机快照比对、终端挂起请求、桌宠轮询)收成这一种;终端 hook 那两个挂起请求(`/v1/cli/permission`、`/v1/cli/say`)是 CLI 子进程在等答案,不是客户端订阅,留着。
- `/m/api/*` 旧路径:作为新路径的**别名**留到 App 的最低在用版本跟上为止,别名表一处、带退休日期,守卫只许少。

## 4. 切法(每步一个 PR,行为不变的先行;做完 = 旧的删掉 + 零基线守卫)

三条线,碰的文件基本不重叠,可以并行;M 是 S 的前提。

### M:做事一条线

| # | 内容 | 做完怎么算 |
|---|---|---|
| M0 | 金样:今天 `/v1/matter`、`/v1/workbench/task`、`/m/api/matter`、`/m/api/chat`、`/m/api/cli/activity`、App `matter/<id>` topic 对几份夹具的产出逐字节钉住 | 金样测试在 dev 上绿 |
| M1 | 迁移:`matter_turns`、`matter_items` 两张表 + `matters` 加 `initiator`、扩 `kind`、统一状态;`MatterLog` 写口 | 迁移测试 + 写口单测 |
| M2 | 一起做:`workbench_events` / `run_execution` / `turn_usage` 数据搬进新表,服务的写和读同一个 PR 切过去,旧表删 | 金样不变;`workbench_events` 不再出现在 src |
| M3 | 对话:协调器经 `MatterLog` 写 turn / item(工具调用第一次有了完整记录);`turn_records` 数据搬进来后删;`messages` 照旧是正文来源 | 金样不变;`turn_records` 不再出现在 src |
| M4 | 终端会话:hook 事件写 item,transcript 首见导入一次;`cli_sessions` 只留原生会话指针;终端会话第一次成为「一件事」 | `cli-activity.ts` 的重复解析删掉 |
| M5 | CC 自己做的事:信、早报、记忆整理、打猎、画室、贴纸各自起一件 `act`(initiator = cc),过程写 item | 每个发起方都有 matter;删掉各自的「做过了」标记文件里能由 item 推出的部分 |
| M6 | 读这一侧收口:`MatterEvent` / `TaskEvent` / `CliActivityItem` 删掉,`detail()` 只读 item;状态只从 matter 推 | 三种形状不在 src |

**M 线进度(11-01)**:M0 → PR #778(金样 19 份)。M1 → v92:`matters` 重建(kind = chat / task / terminal / act,从没建过的 companion 并进 act;加 `initiator`、统一状态 `state` 与正交的 `archived_at`,存量按工作台状态 / 旧状态推);新表 `matter_turns`、`matter_items`、`matter_log_cursor`;写口 `MatterLog`(`src/adapters/store/matter-log.ts`,守卫 `scripts/matter-log-single-writer.guard.test.ts`)。旧 `status` 列与它的出口到 M6 才退;working / waiting 只由 `MatterLog` 推,旧 `setStatus` 只跟上归档时间与做完 / 重开。迁移 runner 加了 `withoutForeignKeys`(重建被外键指着的表,见 `docs/maintainer/migrations.md`)。 M2 分三步:M2a-1 建任务 = 建这件事(`store.create` 同一事务建 matter,出生地在建时写);M2a-2 时间线搬进 `matter_items`(v93,事件 id 原样留着,`workbench_handoffs.request_event_id` 改指 `matter_items`;`workbench_events` 不再写但留着给回滚);M2b `run_execution` / `turn_usage` 进 `matter_turns`(v94:一行用量 = 一轮,执行设置抄进每轮的 policy;服务开始写轮 —— 接受一条 run 开第一轮,result 收轮带用量,之后有动静开下一轮,常驻会话静下来也收,run 收尾 / 排队时取消 / 开机 recover 把剩下的关掉;matters.state 从此由轮推。步还没挂到轮上(`turn_id` 仍空),留到 P1 订阅要按轮取的时候);M2c 删旧表(v95:`workbench_events` / `workbench_run_execution` / `workbench_turn_usage`,v94 部署 soak 绿之后才进;从此回不到 v93 之前的版本)。

### S:在场一个调度

| # | 内容 | 做完怎么算 |
|---|---|---|
| S1 | 陪伴的推送过门:`tick-dispatch` 改走 `speech.say`;`tick-push.ts` 里手判的免打扰 / 关心档删掉 | `speech_log` 里有问候 / 打猎 / agenda;`speech-send` 守卫把 `replyDelivery.begin` 也算发送原语 |
| S2 | 待发队列一个:压着的 App 推送进持久队列;贴纸 / 社交见闻推迟不再丢;退避只剩 `lib/delivery-backoff.ts` 一份 | 三套退避删成一套 |
| S3 | 一件事一次提议:`phone-notifier` 与 `wire-notifications` 合成「matter 状态变化 → 一个提议」;通道按「主人此刻在哪」选(桌面 / App / 微信) | 同一事件 `speech_log` 只有一行 |
| S4 | 全局预算 + 统一挑选:「上次主动开口」从 `speech_log` 推;各发起方的定时器只产提议,initiative 提议交便宜模型一起挑 | `lastProactiveAtIso` 删掉;各功能里不再有直接发送 |
| S5 | 桌宠订阅在场层与 `presence` topic,不再轮询 | `/v1/companion/pet` 轮询删掉 |

**S 线进度(11-03)**:S1 做了。伙伴的推送(日程 / 问候 / 打猎,`dispatchToChat`)改成经 `speech.say` 开那一轮,账进 `speech_log`(kind = `companion`)。`tick-push` 里手判的免打扰 / 关心档换成问门(`policy.peek`:只判不记账),判法只剩门里那一份,而且照旧在调便宜模型挑候选之前问。发言守卫加了一条:主动的那一轮(`context: 'tick'`)开回复交付必须带门开的 `outbound`。S2 设计稿 [2026-11-04-s2-one-pending-queue-design.md](2026-11-04-s2-one-pending-queue-design.md)(主人 11-04 点头):S2a 退避一套做了(三套退避里 A、B 并到 `lib/delivery-backoff.ts`);S2b 待发队列一张表做了(v101 `speech_pending`:待说 + App 推送,重启不丢、带过期);S2c 未做。S3–S5 未做。

### P:一套协议(在 M2 之后)

| # | 内容 | 做完怎么算 |
|---|---|---|
| P1 | 订阅接口吃 `matter_items` 的 cursor;桌面工作台详情从长轮询换过去 | `TaskChangeHub` 删掉 |
| P2 | App / 网页的 topic 从 item 通知推,不再 2 秒比快照 | `phone-topic-sources` 的快照比对删掉 |
| P3 | 路由一族:同一份数据一条路径,按令牌范围放行;`/m/api` 旧路径进别名表 | 新代码里没有 `/m/api` 字面量;别名表只许少 |

**P 线进度(11-05)**:P1 做完(`TaskChangeHub` 已删)。P2 两步做完:四路主题(home / approvals / agents / `matter/<id>`)都改成等信号,不再 2 秒比快照。信号有两路:MatterLog 的变化信号,加上不进游标的那几样写口发的提示(`src/lib/write-hints.ts`)。快照比对没删:它还管去重和兜底那一轮。兜底轮询 matter 每 30 秒、home 每 10 秒,home 的「在场」有几样是内存状态或随时间变的,没有写口可接。细节见 [2026-11-02-p1-change-feed-design.md](2026-11-02-p1-change-feed-design.md) §P2。P3 设计稿 [2026-11-05-p3-one-route-family-design.md](2026-11-05-p3-one-route-family-design.md)(盘点:61 条 `/m/api` 里 35 条与 `/v1` 重复;分 P3a–P3h),未做。

### U:界面一个主页(主人 11-01 定:合成一个,不看草图,直接做)

问题(核过 App 源码):同一种「一件事」在手机上有四种行 —— 此刻「等你」(`(tabs)/index.tsx`)、此刻里整段抄的「终端等你」、一起做的行(`(tabs)/together.tsx`,高度、图标映射都在页面里手写)、此刻「今天做完的」`LinkRow`;点进去三个详情页 `/approval/[id]`、`/matter/[id]`、`/terminal/[id]`;两页各算一份看法(`view/now.ts` 与 `view/together.ts`)。桌面更甚:此刻是 `now-*`,一起做是 `workbench-*` 三栏,进去像换了一个 app。这是 2.1 那四套模型在界面上的倒影 —— 10-05 定了「每样东西只有一个家」(东西放哪),没定「同一样东西长什么样」。

终态:

- **一个主页**,名字仍叫「此刻」(品牌词不丢):最上面 CC(明暗、最近一句真话、点它进对话),下面**一份**列表,分组 **等你 → 在做 → 带回来的**(做完了你还没看的),最末折叠一组「CC 最近在忙」(initiator = cc 的 `act`,M5 之后才有);列表底下「全部 →」进完整历史(做完看过的、归档的、按项目筛)。底部「说一句」不变。
- 「一起做」不再是一个标签 / 一级导航:手机去掉标签栏(只剩一个主页,设置从头像进);桌面主导航去掉「一起做」,主页列表右侧就是一件事的详情(宽屏三栏 = 导航 / 列表 / 详情,窄屏推入)。「交办」是主页右上角的 `+`。
- **一种行**:标题 + 状态词 + 一行副标题(项目 · 谁在做 · 来源),图标与状态词来自**一张表**(状态 → 词条键、图标、色调),三端共用;终端会话、等你批准、做完了都是这一行的不同状态。
- **一个详情页** `/matter/<id>`:等你批准 / 提问是详情顶部的一块(今天 `/approval` 的内容),终端会话是 `kind = terminal` 的一件事;看改动、回退、脚本这些深度工作在详情里按需展开(只对 `kind = task`)。旧链接(`/approval/<id>`、`/terminal/<id>`、推送里的深链)重定向到新详情,不断。
- 两页各自的看法函数合成一个 `homeView(matters, approvals, terminal)`(M 线做完后入参变成 matter 一种)。

| # | 内容 | 做完怎么算 |
|---|---|---|
| U1 | 状态表(协议包,纯数据)+ App 一种行 `MatterRow` + 一个看法 `homeView`;此刻 / 一起做 / 今天做完的四种行全换成它 | `(tabs)` 里没有手写的行与状态图标映射;`view/now.ts` 与 `view/together.ts` 合成一份 |
| U2 | App 合成一个主页:标签栏去掉、`together.tsx` 删、「全部」页、`+` 交办;Maestro 流程跟着改 | 只有一个主页;本机模拟器 Maestro 全绿 |
| U3 | App 一个详情页:批准内容进 `/matter/<id>` 顶部;终端详情在 M4 前先做成同一外壳(路由重定向);推送深链指向新详情 | `/approval`、`/terminal` 只剩重定向 |
| U4 | 桌面:此刻页换成主页列表 + 详情,主导航去掉一起做,`workbench-*` 退成详情里的深度区;desktop-e2e 跟着改 | 桌面没有单独的「一起做」入口;e2e 绿 |
| U5 | 手机网页 `/m` 同样收口(它和 App 共用同一张状态表) | `/m` 只有一个主页 |

**进度(11-01)**:U1–U3 → PR #776(批准做成一件事路由下的一步 `/matter/<id>/decide` 而不是详情里的一块 —— 批准页的硬要求按整屏调的;理由见 PR)。U4 + U5 → 同一个 PR(桌面:一起做退出导航,成了此刻页上的「全部 →」,打开后仍是按项目列出 + 详情;手机网页:一页、没有底部标签)。状态词与分组名也收进状态表那个文件(`STATUS_WORDS` / `HOME_GROUP_WORDS`),桌面拿生成物 `apps/desktop/src/generated/status-table.js`。

U1–U3 只动客户端、用今天的数据就能做,不等 M 线;U3 里终端那一半等 M4 再合成一个数据源。手机 App 的改动随下一个 build 到主人手里,桌面随下一版,`/m` 随 `self deploy`。

**顺序**:M0 → M1 → M2(一起做本来最接近,先拿它验证模型)→ P1 → M3 → M4 → P2 → M5 → M6 → P3;S1–S3 与 M 并行,S4 在 M5 之后(发起方变成 `act` 之后提议才有归属),S5 在 P1 之后。U1–U3 现在就做(只动 App、不等 M);U4、U5 在 U1 的状态表定了以后;U3 的终端一半在 M4 之后。

## 5. 主人看得见什么

| 变化 | 何时 | 建议 |
|---|---|---|
| 「一件事」列表里出现 CC 自己做的事(写了一封信、去打了猎) | M5 | 主人 10-31 定:不混排,「一件事」列表只放你的事,CC 自己做的放在「CC 最近在忙」 |
| 寄信、早报也算「主动开口」,问候会相应少一点 | S4 | 照建议:陪伴本来就是时在时不在,宁少勿扰 |
| 任务做完时人在电脑前 ⇒ 先只在桌面提示,10 分钟没看再推手机 | S3 | 照终端会话已有的规则推广;等你批准的照旧各处都推 |
| 对话的每一步(工具调用)在桌面 / App 看得见 | M3 | 只是多了能看的,不打扰 |
| 此刻与一起做合成一个主页;一种行、一个详情页 | U1–U5 | 主人 11-01 定:合成一个,直接做 |
| 桌宠对工作状态反应更及时 | S5 | 无 |

其余(迁移、写口、协议)行为不变。

## 6. 不做的

- 不改执行者(`AgentEvent` 与各家适配器不动)、不改权限(`authorize` 不动)、不改记忆(G 已收)。
- 除了 U 线(一个主页、一种行、一个详情页)和第 5 节列的,界面不另改;设计 token、字体、CC 明暗、文案口吻都不动。
- 不加新功能;这一轮期间新功能照 [加一个功能](../../maintainer/add-a-feature.md),碰到做事 / 开口就直接用新口。

## 7. 风险与测试

- **迁移**:每张表的搬迁带「核对不过不搬」(照 G3);真机量小,但 Windows 也要跑一遍迁移测试。
- **App 兼容**:别名表 + 协议测试钉住旧路径的形状;App 的最低在用版本由中继握手里的 `client` 版本统计,到了再删别名。
- **在场的行为**:S 线每一步都要真实形状沙盒(`real-shaped-sandbox`)里加场景:免打扰里任务做完、刚寄完信的问候、人在电脑前的任务完成、重启后压着的推送。
- **金样**:M0 的金样是 M 线每一步的门;diff 逐行讲得清才合。

## 8. 实现者读稿时问的,已定(我的判断,主人可推翻)

1. **一轮 = 执行者的一个回合**(一次输入 → 一次回应,和 Codex 的 turn 同义)。一起做的 `run` 是若干轮,`matter_turns` 带 `run_id` 分组;用量按轮记、按 run 汇总。
2. **终端会话的步骤**:不往主人机器的 Claude / Codex / Cursor 配置里加新 hook。transcript 改成**增量读**(每个会话记读到的位置),读到的步骤写成 item;不再每次从头解析。Cursor 的 transcript 本来就不记动作,照旧显示得少。
3. **哪些对话是一件事**:照今天 `mw-matter.ts` —— 每个对话一件(主人、访客、群)。A2A / 笔友的对端 `initiator = peer`。访客对话的 item 照今天 `messages` 的可见范围,只有 admin 看得到。
4. **对话正文**:见 3.1,`messages` 仍是「说了什么」的唯一来源,item 只引 id,读正文的消费方不动。
5. **金样**:M0 钉今天的产出;第 5 节里会变的那几处,在**改它的那个 PR** 里重录金样并逐行说明;搬家的 PR 金样一字不变。
6. **漏看了怎么办**:blocking(等你批准、有问题问你)照今天各处都推,不按「人在哪」收窄;report(做完了 / 没做成)才按人在哪选一个通道,10 分钟内没被看到(桌面通知没点、桌宠没被点开)就升一级到 App,再到微信。桌面通知和桌宠两个通道在 S3 里新加。
7. **全局预算**:只管 `initiative`。提醒、定时任务是 `requested`,不进预算。早报 / 周报今天是 `initiative`(`kinds.ts:43-44`),它们**按点发、不等预算,但算进预算**(发了早报,下一次问候往后挪)。每个类别自己的间隔(信 24–38 天、问候按关心档)照旧,全局只加一个「两次主动开口之间至少隔多久」。
8. **提议从哪来**:各功能自己的定时器留着,只是改成「提议」;在场层在收到提议时和自己每 20 分钟一拍时判定。同一拍里落选的 initiative 提议**丢掉**,由发起方到下次自己的时间再提(和今天陪伴「没选中就算了」一致);report / blocking 不参与挑选,不会落选。

## 9. 留给实现者的

- item `payload` 的具体字段、`cursor` 的实现(全库自增或混合时钟)。
- 桌面订阅用长轮询还是本机 WebSocket。
- 别名表的格式与退休日期怎么记。
- M5 里每个发起方怎么切成「提议 + act」的具体顺序。
