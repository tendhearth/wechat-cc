# M3:对话的每一轮进 MatterLog(设计稿)

2026-11-02 · 承接 [一个伙伴一副骨架](2026-10-31-one-companion-one-skeleton-design.md) §4 M3,P1 之后(变化信号已经只认 MatterLog 的游标)。

## 现在的样子(origin/dev 9a444802)
- **一轮对话的路**:
  - 微信 `mw-dispatch` → `coordinator.dispatch` → `submitTurn`。
  - 桌面 / 手机 `wire-converse` → `submitTurn`。
  - solo 的路径在 `src/app/coordinator/solo.ts`:`acquire` → `replyDelivery.begin` → `runner.run`(`collectTurn`)→ 各种结局 → `finally` 里 `runner.record`。
  - parallel / chatroom 每个参与者各一次 `begin` + `record`。
- **记了什么**:`turn_records`(v15 起,每个 chat 留最新 200 行),一轮一行:结局、模式、耗时、tool_calls(去重后的**名字**)、delivery / bubbles / attachments / narration。
  - 执行者报的**用量在 `collectTurn` 里被丢了**。
  - 工具调用的 `AgentActivity`(参数摘要、状态)也被丢了。
- **谁读 `turn_records`**:
  - `GET /v1/turns`(MCP 工具 `diagnostic_turns`)读整行。
  - 手机首页 feed 的「聊天日」只读 chatId / endedAt / outcome / mode / startedAt。
  - 别的地方没人读。
- **缺的 id**:
  - 协调器手里没有这件事的 id:`mw-matter` 在上游 `ensureChat` 了,但没往下传。
  - 也没有 `messages` 那一行的 id:微信入站的 id 能算出来;App 的入站 / 出站是轮**结束后**才写;微信出站的 id 没回给调用方。
- **不经协调器的**:伙伴主动开口(tick-dispatch / tick-job)、提醒、交办(delegate)都自己 `collectTurn`,一行记录都没有。
- **读出口**:对话详情(`/v1/matter`、`/m/api/chat`、topic)全部从 `messages` 读。M0 金样钉着五份。

## 定案
**协调器每跑一轮,就经 MatterLog 在这件对话里写一轮;这一轮里的每一步(主人那句、每个工具调用、CC 的回复、送达)写成步。正文照旧在 `messages`,步只引 `message_id`。** 出口这一步不变。

### M3a 写(和 `turn_records` 并行写)
- `InboundMsg` 带上 `matterId`:`mw-matter` 已经算出来了,往下传;`wire-converse` 同样 `ensureChat`。
- `collectTurn` 的汇总里补上 `usage`(result 上本来就有),每个工具调用的 `activity` 也回调给协调器(`onTurnEvent` 已有)。
- runner 在 `acquire` 之后 `startTurn`:
  - executor = provider,model = 实际模型。
  - policy 记 `{mode, alias, recordMode?}`。
  - parallel / chatroom 每个参与者一轮:一件事里可以同时有几轮在跑,MatterLog 本来就支持。
- 步:
  - 主人那句:`user_message`,带 `message_id`。微信入站的 id 能算;App 入站改成**轮开始前**落 `messages`,出站照旧在结束后。
  - 每个工具调用:`tool_call`。key = 执行者给的 activity id;started → completed / failed 合成一行。payload 跟一起做同一个形状(`activity`)。
  - CC 的回复:`agent_message`。送达以后写,带出站那条的 `message_id`(`ilink-glue` 把 id 回给调用方)。
  - 送达结果:`delivery`。
  - 出错:`error`。
- `finishTurn`:
  - 结局:ok → completed;timeout / error / auth_failed → failed,带 errorCode;cancelled → cancelled。
  - 带用量和原生会话 id。
  - 这件事的状态落 open:对话做完了就是回到主人手里。
- 写不上不挡回复:和一起做一样,一律 try,只少一轮记录。
- 做完怎么算:
  - 一轮对话在 `matter_turns` / `matter_items` 有完整一轮。
  - `turn_records` 照写,新旧对得上:真机副本上比一天的轮数、结局、工具名。
  - M0 金样不变。

### M3b 读切过去 + 搬存量
- 迁移:`turn_records` 每行搬成 chat 那件事的一轮。
  - 状态按 outcome;工具名搬成没有 activity 的 `tool_call` 步。
  - delivery / bubbles / attachments / narration 进这一轮的 policy 摘要。读的人不多,只有诊断要它们。
  - 找不到 chat matter 的,先按 v60 的推法补一件。
- `/v1/turns` 和手机 feed 的「聊天日」改读 `matter_turns`,`/v1/turns` 的出口形状不变。
- 停写 `turn_records`(表留着给回滚)。

### M3c 删 `turn_records`(soak 之后)

## 不做 / 推后
- **对话详情从 `messages` 改读 item**:M6 做。这一步出口不变,金样不变。
- **桌面 / App 显示对话里每一步做了什么**:设计稿 §6 定的「只是多了能看的」,等 P2 推步以后在界面上做,不在 M3。
- **伙伴主动开口、提醒、交办写轮**:M5(它们是 CC 自己做的事,起 `act`,不混进主人的对话)。
- **「1 条入站 = 1 轮」的严格对应**:不做。合并入站(连发几句并成一轮)按协调器实际跑的轮记,user_message 步可以有几条。

## 风险
- **App 入站改到轮前落库**:要是轮起不来(spawn 失败),`messages` 里会留一条没有回复的入站。微信本来就是这样,对齐即可。M0 金样里 App 那几条的顺序要核。
- **每轮多写十几行**(工具调用多的轮):对话量远小于一起做。
- **parallel / chatroom 的状态**:一件事里几轮同时跑,最后一轮结束才落 open。MatterLog 的 settle 本来就这么推。

## 进度
- M3a(11-02):runner 开 / 收这一轮,工具调用、送达、出错写成步,用量和原生会话记在轮上,开机把没收的对话轮记中断。和设计的两处差别:
  - 这件对话的 id 由实现按 `findChat(chatId)` 自己找,没有经 `InboundMsg` 往下传。runner 手里本来就有 chatId,这样少改一条链。
  - 主人那句 / CC 的回复这两步要引 `messages` 的 id,这个 id 还没传到协调器,挪到 M3b 和读切换一起做。

## 顺序
M3a → (真机跑一天,新旧对账)→ M3b → soak → M3c。每步只动 daemon,`self deploy` 就生效。
