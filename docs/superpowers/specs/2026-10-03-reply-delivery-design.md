# 回复交付:一轮最后的话就是回复,daemon 负责送达

日期:2026-10-03。状态:**已定**(方向主人 2026-10-02 已同意;2026-10-03 维护者审稿通过,§6 八条按推荐写定,主人授权)。代码引用以 `origin/dev` `1f68ad33` 为准。

前情:PR #196(按内容丢「（真的停了）」这类尾巴)已关 —— 主人的判断是**补丁治标**,要从根上改「话怎么说出去」。#196 的实验 harness 与 110 回合原始数据搬进了本 PR(`scripts/experiments/reply-once/`、[`docs/reference/reply-once-experiment.md`](../../reference/reply-once-experiment.md)),作为下文每一步迁移的验收工具。

## 0. 一句话

**执行者不再「调工具说话」。一轮结束时它最后写下的那段话就是回复;怎么分条、什么节奏、送到微信还是桌面还是手机、失败了怎么办,全由 daemon 管。** 想静默就写 `NO_REPLY`(只在允许的场合生效);语音 / 表情 / 文件是这一轮回复的附件;要往**别处**发(别的聊天、广播、外部 agent)才用显式的 `message` 工具。

---

## 1. 问题与根因

### 1.1 现在的规矩

CC 要求所有执行者经 wechat MCP 的 `reply` 工具说话,直接写出来的文字算异常:

- `src/core/prompt-builder.ts:359`:「回复时**用 `reply` 工具**而非直接生成 plain text。如果你不调 reply 而只输出 assistant text,daemon 的 fallback 路径会把文本发出去(channel.log 记 [FALLBACK_REPLY]),用户能收到但 daemon 视为 anomaly — 不要依赖。」
- `prompt-builder.ts:369`:`reply` 是「**首选**」;`:404-407` 气泡段要求「想好第一个意思就先调 reply 发出去……一轮最多 2-4 条」。
- 协调器:本轮调过任意一个「回复族」工具 ⇒ **这一轮所有助理文字全丢**(`src/core/conversation-coordinator.ts:709-712`);没调 ⇒ 每段文字各发一条、记 `FALLBACK_REPLY`、累加异常计数(`:713-722`,连续 ≥3 次在 `src/daemon/bootstrap/wire-coordinator.ts:144-150` 记 `PROVIDER_ANOMALY`)。
- 「回复族」是 9 个工具(`src/core/agent-provider.ts:435`:reply / reply_voice / send_file / edit_message / broadcast / send_sticker / search_online_sticker / send_online_sticker_candidate / sticker_feedback),判定按 server 名(`isReplyToolCall`,`:472-476`)。

### 1.2 同一个根,四种症状

**① 自研循环停不下来(openai 兼容后端)。** 我们自己的循环里「一轮结束」唯一的方式是某一步不调任何工具(`src/core/openai-agent-provider.ts:166`),而回复本身就是一次工具调用:发完话的模型**没有一个被认可的「我说完了」动作** —— 不调工具它得「不说话」,说话又得调工具;发完之后写的文字被协调器整段丢掉(上面 `:709-712`)。于是它照着历史里自己的样子再调 reply:「（停，不再发了 😅）」「（真的停了）」。沙盒量出来(`docs/reference/reply-once-experiment.md`,真 Qwen3.8 + 生产循环 + 假工具):**历史里已有连发时基线 5/5 跑满预算,每轮 12 条、34 条「停」**;改回执(i)、系统提示写清怎么结束(ii)、reply 之后只给 reply 工具(iv)全压不住,合并历史(v)会转去调 memory 工具。能压住的只有循环侧按内容丢尾巴(#196),而它在「正常短句连发」上仍多发 2–10 条 —— 主人据此否决了补丁路线。

**② 外挂 CLI 每轮双发旁白。** agy 只读自己的全局 MCP 配置、回报的 server 名是命名空间键 `wechat-cc-wechat`,回复判定认不出 ⇒ 每轮 `replyToolCalled=false` ⇒ fallback 把模型旁白(「已回复用户的问候。」)当第二条发出去(`agent-provider.ts:441-456` 注释,`docs/releases/desktop-v1.7.0.md:87-91`)。cursor 的旧 print 解析器从来没解析出过一个 tool_call,同一个形状(`src/core/cursor-cli-stream.ts:82-87`)。两处都修了(命名空间折回、改走 ACP),但**修法是「把每家的 tool_call 形状认对」**:下一家外挂 CLI 换个 envelope,双发旁白又悄悄回来(`conversation-coordinator.ts:146` 的注释原话)。`src/core/external-cli-contract.live.test.ts` 就是专门为这件事钉的契约测试。

**③ 两套出口,行为不一致。** 工具路径(`POST /v1/wechat/reply`,`src/daemon/internal-api/routes.ts:532-585`)有空文本拒绝、app 接收器、旁听、参与者前缀、气泡切分 + 节奏;fallback 路径(`src/daemon/bootstrap/fallback-reply.ts:59-79`)只有接收器 + 旁听 + 原样发送,**没有切分、没有节奏、没有前缀**。同一句话走哪条路,主人收到的形状不一样。而且 fallback 的 `sendAssistantText` 同时还背着所有系统通知(认证失败、超时、守护拒绝、spawn 失败,`conversation-coordinator.ts:198-243,410-455,636-643`)—— 回复和通知没有分开。

**④ 回复记账与安全都在猜。** `TurnRecord` 只有 `replyToolCalled` 与 `textChunks`(计数,`conversation-coordinator.ts:59-80`,库表 `turn_records` 在 `src/lib/db.ts:388-410`)—— 「主人到底收到了什么」没有记录。`reply` 路由从不核对 `chat_id` 是不是调用者自己的聊天(handler 签名 `(_q, body)` 忽略了 `callerInfo.chatId`,`routes.ts:532`;`callerInfo` 来自会话令牌,`src/daemon/internal-api/index.ts:261-269`)⇒ **任何会话、包括访客,都能 reply 到任意 chat_id**(已在另一个 PR 单独修,见 §6 备注)。语音 / 表情 / 文件路由不看 app 接收器(`routes.ts:586-612,884-987`)⇒ 桌面 / 手机那一轮里模型发的语音、表情**漏到微信**,app 那头什么也收不到。

### 1.3 为什么说是「根」

模型训练时的分布是:**一轮对话的最后一条助理消息就是对用户说的话,说完就停。** 我们把「对用户说话」改造成一次工具调用,等于要求模型在每一轮里做一件不在分布内的事,再用提示词、回执措辞、命名空间折叠、fallback 计数去补它偏离的地方。症状 ①–④ 都是这一个错位的不同侧面。

---

## 2. 业内怎么做

| 谁 | 做法 | 对我们的意义 |
|---|---|---|
| **Letta**(letta_v1,[博客](https://www.letta.com/blog/letta-v1-agent/)、[迁移指南](https://docs.letta.com/guides/legacy/migration-guide)) | 删掉 MemGPT 时代的 `send_message` 工具与 heartbeat;改用原生助理消息 + 模型自己决定结束。理由原话:架构要收敛到「训练数据的样子」(stay *in-distribution*)。代价也写明了:不再有 heartbeat 概念、工具规则不能作用在助理消息上 | 和我们的 `reply` 工具是同一个设计,同一个毛病;他们走过的路就是本稿的方向 |
| **OpenClaw**([messages](https://docs.openclaw.ai/concepts/messages)) | 最终助理文字即回复;`block streaming` 按块发,**分块尊重频道长度上限、不切开代码块**,块之间有 `humanDelay`;显式 `message` 工具用于主动 / 其他目标发送,带前缀去重;`NO_REPLY` 静默令牌**永不显示**,只在连到外部频道的会话里保留,**私聊从不给这条提示**,群聊要显式 `silentReply.group: "allow"`;一轮有待发的 TTS 等媒体时,剥掉静默文字但**媒体照发** | §4.3–§4.6 几乎逐条对应 |
| **Paseo**([github](https://github.com/getpaseo/paseo))、**Orca**([github](https://github.com/stablyai/orca)) | 远程面(手机 / 桌面)直接转 agent 的原生输出流或最后一条消息;Orca 手机端「agent 完成或需要处理时通知」,交互模型是「看 + 追问」 | 我们的工作台已经是这样(见下);对话面没跟上 |
| **我们自己**(已经这么做的地方) | 工作台完成通知取的就是**最后一段文字**(`src/core/workbench/service/notices.ts:62,98`),工作台禁用 wechat MCP(`src/daemon/bootstrap/wire-workbench.ts:49,63`);交办(delegate)的答复就是 `assistantText.join('\n')`(`src/daemon/bootstrap/delegate.ts:271-275`);/chat 与 /both 早就是纯文字(`src/core/chatroom-conductor.ts:37`);自检 `replied = ok && texts.length > 0`(`src/cli/selftest.ts:602-624`);终端会话完成推送用的也是那个会话自己的最后一句(`src/core/cli-events.ts:342-354`) | 只剩「微信私聊 / 伙伴主动推送 / app 对话」这条主路还在用工具说话 |

---

## 3. 现状地图:每一条把 agent 的话送出去的路

| # | 路 | 话从哪来 | 怎么送 | 关键位置 |
|---|---|---|---|---|
| A | 私聊一轮(solo) | `reply` 等 9 个工具,或 fallback 文字 | 工具 → internal API → `ilink.sendMessage`;fallback → `sendAssistantText` | `conversation-coordinator.ts:565-742`;`routes.ts:532-585`;`fallback-reply.ts:59-79` |
| B | 桌面 / 手机对话 | 同 A,但被 app 接收器截走 | `replySinks.open` → `sink.close()` 用 `\n` 拼起来返回 | `src/daemon/wiring/pipeline-deps.ts:1053-1158`;`src/daemon/reply-sinks.ts:12-49`;手机 `src/daemon/phone-chat.ts` |
| C | 伙伴主动推送(议程 / 空档问候 / 打猎) | **只认 reply 工具**;文字全丢 | 同 A 的工具路径 | `src/daemon/wiring/tick-bodies.ts:435-498`(`:484-486` 只看 error 事件);提示 `:234-242,256-263,270-278` |
| D | /chat 聊天室 | 纯文字(工具被拒) | 每个发言人拼成一条 `[名字] 文字` | `conversation-coordinator.ts:755-919,1067-1137`;拒工具 `src/core/permission-relay.ts:70-89` |
| E | /both 并行 | 纯文字 | **每段文字一条** `[名字] 段` + 🎯 综合 | `conversation-coordinator.ts:930-1057`(`:1027-1035`) |
| F | 交办(primary_tool / delegate) | 被交办方的 `assistantText.join('\n')` | 回给主会话当工具结果 | `delegate.ts:271-275` |
| G | 工作台 | 最后一段文字 | 完成 / 权限通知 | `workbench/service/notices.ts`;`wire-workbench-notifications.ts` |
| H | 终端会话 ↔ 微信(hook、y/n、@码、看码) | 外部 CLI 的输出 | `sendAssistantText` / `scopedSend` / `share_page` | `src/daemon/main.ts:639-713`;`src/daemon/cli-reply-handler.ts:169-230` |
| I | A2A / 社交 | 外部 agent 推送、信封 | `sendAssistantText` / `notifyOwner`;模型往外发用 `a2a_send` | `src/daemon/bootstrap/wire-a2a-server.ts:42-62`;`wire-social.ts:213-318`;`tools-a2a.ts:12-30` |
| J | 提醒 | 确定性文字 | `deps.send` | `src/daemon/reminders/sweeper.ts:118` |
| K | 系统通知(认证 / 超时 / 守护 / spawn 失败 / 本轮出错) | daemon 文案 | `sendAssistantText` | 见 §1.2 ③ |

本稿**只改 A、B、C、D、E**(agent 自己说的话),并把 K 从 `sendAssistantText` 里分出来;F–J 已经是「daemon 转原生输出」或确定性文字,只做改名与登记。

---

## 4. 设计

### 4.1 一轮的回复对象

```ts
// src/core/turn-reply.ts(新)
interface TurnReply {
  text: string            // 最后的话(已去掉 NO_REPLY 行);可以为空
  silent: boolean         // 模型写了 NO_REPLY(且本场合允许)
  attachments: TurnAttachment[]   // 按模型调用顺序:voice / sticker / file
  narration: string[]     // 最后的话之前的各段文字(不发微信,见 §4.7)
}
type TurnAttachment =
  | { kind: 'voice'; text: string }          // 由 daemon 合成
  | { kind: 'sticker'; ref: StickerRef }      // 本地 tag / 在线候选 id
  | { kind: 'file'; path: string }
```

`collectTurn`(`agent-provider.ts:545-618`)今天已经按事件顺序收 `text` 与 `tool_call`,只是没保留顺序关系。新增一个纯函数 `extractTurnReply(events)`:**以 `tool_call` 为界把文字切成段,最后一段非空文字就是 `text`,之前的段是 `narration`**。附件来自本轮的附件工具调用(§4.5),由 daemon 在调用时登记,不靠解析事件参数。

为什么是「最后一段**非空**文字」而不是「最后一个事件之后的文字」:模型常见的形状是「好的,我记下了。」→ 调 `memory_write` → 空着结束。按「最后一个工具之后」取会取到空,按「最后一段非空」取到的才是它说的话。反过来,「让我查一下」→ 调工具 → 「查到了,是 X」,取到的是后者,前者是旁白。

### 4.2 每家执行者的「最后的话」

| 执行者 | 今天的事件 | 「最后的话」 | 要改的地方 |
|---|---|---|---|
| **Claude**(Agent SDK,`src/core/claude-agent-provider.ts`) | 每条助理消息一个 `text`;**同一条消息里先发 tool_call 再发 text**(`:639-661`)—— 和块顺序相反;`result.result`(SDK 给的最终答复,`:284`)在会话路径里被忽略,只有 one-shot 用(`:442-456`) | 以 `result.result` 为准(SDK 的定义就是最后一条助理消息的文字);事件分段只用来算 `narration` | ① 同一条消息内按块顺序发事件(text 块在 tool_use 前就先发 text),否则分段会把旁白算成最后的话;② `result` 事件带上 `finalText`;③ API 错误标注的消息继续不产 text(#190,`:592-600,537-545`),一个字都不能进 `finalText` |
| **Codex**(对话走 `@openai/codex-sdk` 的 `runStreamed`,**不是** app-server;app-server 只在工作台,`src/core/workbench/codex-app-server.ts`) | `item.completed` 的 `agent_message` 是整条消息(`src/core/codex-agent-provider.ts:291-294`),`turn.completed` 结束(`:298-299`) | `turn.completed` 之前最后一个 `agent_message` | 不用改 provider;分段规则直接适用 |
| **Cursor**(ACP,`src/core/acp-cursor-chat.ts:57-82`,`text:'messages'`) | `agent_message_chunk` 攒进缓冲,遇到 `tool_call` 先把缓冲作为一条 text 冲出(`src/core/acp/events.ts:79-110`),`stopReason=end_turn` 时 `endTurn()` 冲出剩下的(`src/core/acp-agent-provider.ts:389-399`) | `endTurn` 冲出的那段(最后一个 tool_call 之后的 chunk);为空则往前取最后一段非空 | 不用改;`acp_turn_cancelled` 不冲缓冲(`:396`)⇒ 被取消的轮不产回复,符合预期 |
| **agy**(`src/core/agy-stream.ts`、`agy-agent-provider.ts`) | 每个 `agent_response` step 攒成一条 text(`agy-stream.ts:64-82,109-111`) | 最后一个 `agent_response` step | 不用改;**双发旁白的根就此消失** —— 不再需要认出它的 reply 调用,命名空间折叠(`agent-provider.ts:454-470`)只剩桌宠信号与日志用途 |
| **openai 兼容**(自研循环) | 每一步的文字在工具调用前冲出(`openai-agent-provider.ts:147-163`);**不调工具的那一步**结束循环(`:166`) | 不调工具那一步的文字 | 循环本身不用改 —— 「不调工具就结束」从此**就是**「说完了」,模型终于有了被认可的结束动作。只需从它的工具表里拿掉 `reply`(§5 第 1 步) |
| Cursor SDK 兜底(`cursor-agent-provider.ts`,无 CLI 时) | `assistant` 文本块 → text,`FINISHED` 结束 | 同分段规则 | 不用改 |

所有执行者统一:**只有 `outcome === 'completed'` 的轮才交付 `text`**。超时(`turn_timeout`)、出错、认证失败一律只发通知、不发残文(今天超时已经丢残文 `conversation-coordinator.ts:675-679`;出错时今天若有文字会走 fallback,新设计收紧 —— 与 #190「错误不许当回复发」同一条红线)。

### 4.3 daemon 负责送达

新模块 `src/daemon/reply-delivery.ts`,一个入口:

```ts
deliverTurnReply(reply: TurnReply, target: DeliveryTarget, ctx: { mode, participantTag?, chatPrefs }): Promise<DeliveryReport>
type DeliveryTarget = { kind: 'wechat'; chatId } | { kind: 'sink'; chatId }   // sink = 桌面 / 手机这一轮
```

依次做(大部分是把 `routes.ts:532-585` 已有的步骤搬过来,让两条出口合成一条):

1. **静默**:`reply.silent` 且场合允许(§4.4)⇒ 只发附件(若有),记 `REPLY_SILENT`。
2. **app 接收器**:target 是 sink ⇒ 把**整个** `TurnReply`(文字 + 附件 + 旁白)交给接收器,不进微信。修掉 §1.2 ④ 的语音 / 表情漏到微信。
3. **旁听**:`outboundTaps.observe(chatId, text)`(打猎记账依赖它,`src/daemon/outbound-taps.ts:17-46`,`tick-bodies.ts:566,580-587`)。
4. **前缀**:/chat、/both 的 `[名字]`(`makeMaybePrefix`,`routes.ts:1063-1082`)。参与者标识从协调器传入,不再经 MCP 子进程环境变量 `WECHAT_PARTICIPANT_TAG` 绕一圈(`src/daemon/bootstrap/mcp-specs.ts:62-70`)。
5. **分条**:`splitReply`(`src/daemon/reply-split.ts:21-92`,代码块整体不切、句末切、碎块并入上一条),规则见 §4.8 与已定 ④;`chatPrefs.split === false` ⇒ 不分。
6. **节奏**:条与条之间 `paceMs`(`reply-split.ts:15-17`,`clamp(len×30, 600, 2000)`)= 我们的 humanDelay;输入中提示照旧由 `mw-typing` 每 5 秒脉冲(`src/daemon/inbound/mw-typing.ts:16,41-60`),覆盖整个交付过程。
7. **频道上限**:每条再过传输层 4000 字切块(`src/lib/send-reply.ts:67-88`,`MAX_TEXT_CHUNK` 在 `src/lib/config.ts:59`)。**这一层不认代码块** —— 第 5 步保证代码块整体在一条里,单条超 4000 的代码块由第 5 步先按行切并给每段补齐围栏(新增,小改)。
8. **附件**:按 §4.5 的顺序发。
9. **记账**:返回 `DeliveryReport { bubbles, attachmentsSent, failures, msgIds }`,写进 TurnRecord(§4.10)。

**失败处理(不改现有规矩)**:单条失败只依赖 `ilinkSendMessage` 自带的 3 次 × 1 秒(`src/lib/ilink.ts:204-226`),-14 / -6 不重试(`:184-202`);第一条失败就停,剩下的不发,记 `REPLY_DELIVERY_FAIL sent=n/m`(和今天 `WECHAT_REPLY split partial failure` 同一语义);**绝不因为送达失败再调一次模型**(「断线时停掉外发与 LLM 轮次」那条规矩)。errcode=-2(推送窗口关了)对**应答**几乎不会发生(主人刚说过话),对**主动推送**照现有规则处理:不算链路故障(`src/daemon/ilink/outbound-health.ts:22-24`,`ilink-glue.ts:250-253`)。外发健康照常由 `ilink-glue.sendMessage` 记(`:228`),不需要改。

**系统通知分家**:`sendAssistantText` 改名 `sendNotice`,只给 K 类通知、H/I 类转发用;agent 的话**只**走 `deliverTurnReply`。两条路在日志里分得开(`NOTICE` vs `REPLY`),app 接收器两条都接(通知也要在 app 里看得见,沿用 `fallback-reply.ts:63` 的 capture)。

### 4.4 静默:`NO_REPLY`

**语义**:最后的话去掉首尾空白后**整段等于** `NO_REPLY`(不分大小写)⇒ `silent=true`、`text=''`。如果 `NO_REPLY` 作为**单独一行**夹在别的文字里 ⇒ 去掉这一行、其余照发、记一行 `NO_REPLY_MIXED`。**任何情况下这几个字母都不会出现在主人屏幕上**(包括 app、手机、消息库)。

**哪里允许**(已定 ②):

| 场合 | 提示里教不教 | 写了怎么办 |
|---|---|---|
| 伙伴主动推送(议程 / 空档 / 打猎) | 教:「这次不该发就只写 `NO_REPLY`」,替换 `tick-bodies.ts:240,261,275` 与 `prompt-builder.ts:824` 那几句「不调 reply 也不要产生 assistant text」 | 静默,`REPLY_SILENT kind=tick`;打猎 / 推送的 claim / undo 语义按「没发出去」处理(`tick-bodies.ts:480` 的 `claim()` 与 undo 保持 at-most-once:静默 ⇒ undo) |
| /chat 发言人、/both 参与者 | 教:「没有新观点就写 `NO_REPLY`」 | 这个发言人这一拍不出声;全员静默 ⇒ 沿用「这轮没有 AI 成功回应」(`conversation-coordinator.ts:822`) |
| 私聊(主人 / 访客的一问一答)、桌面 / 手机对话 | **不教**(OpenClaw 同款:私聊从不给这条提示) | 照样不显示;记 `REPLY_SILENT_IN_DM` 并计入异常连击(§4.10);**不替模型补话** |

为什么不直接用「空文字 = 静默」:空文字可能是模型出错 / 被截断,和「我决定不说」分不开。显式令牌让「沉默」变成一个能记账、能统计的决定。

顺手:`chatroom-conductor.ts:37` 的常量 `NO_REPLY_TOOL`(内容是「用纯文本回复,不要调 reply 工具」)改名 `PLAIN_TEXT_ONLY`,迁移完删掉 —— 免得和新令牌混。

### 4.5 媒体是这一轮回复的附件

| 今天的工具 | 新语义 | 说明 |
|---|---|---|
| `reply_voice(chat_id, text)` | `voice(text)`:**把这段话作为语音附在本轮回复上** | 合成与发送由 daemon 在交付时做(`src/daemon/ilink/voice.ts:55-113`,经 `gateVoice` 守护 `:210-238`)。合成 / 发送失败 ⇒ **daemon 自己把这段话按文字发**(删掉 `prompt-builder.ts:370`「ok:false 就立刻用 reply 发成文字」那条要模型兜底的规矩)。500 字上限保留(`routes.ts:586-601`) |
| `send_sticker` / `search_online_sticker` / `send_online_sticker_candidate` | `sticker(...)`:附表情 | 搜索候选(`search_online_sticker_candidates`)仍是普通查询工具;冷却、GIPHY 白名单不变(`routes.ts:884-987`) |
| `send_file(chat_id, path)` | `attach_file(path)` | trusted 门不变(`route-tiers.ts:89`) |
| `sticker_feedback` | 普通工具(不是说话) | 它本来就不发东西,只是被误列进回复族 |

**附件工具都不带 `chat_id`**:目标永远是本轮的聊天(daemon 从会话令牌的 `callerInfo.chatId` 取)—— 顺带关掉「任意 chat_id」那个口子。工具的回执改成 `{"ok":true,"attached":true}`,不是 `msg_id`(还没发)。

**顺序**:文字各条 → 附件按调用顺序。例外:**只有语音、没有文字**(或文字与语音内容一样,见已定 ⑤)⇒ 只发语音。理由:附件今天是「工具调用即发」,所以在 fallback 文字**之前**到(主人先收到表情再收到话,顺序反了);统一在文字之后,和真人「说完一句 + 一个表情」一致。

**静默 + 附件**:`NO_REPLY` 只压文字,附件照发(OpenClaw 同款)。

### 4.6 显式 `message` 工具:往别处发

**只用于「不是本轮这个聊天」的目标**:

```
message({ to: 'owner' | <chat_id> | 'broadcast', text, account_id? })
```

- 合并今天的 `broadcast`(`tools-messaging.ts:179-194`)与「给别的聊天发」;`a2a_send`(外部 agent,`tools-a2a.ts`)保持独立,它的目标不是微信。
- **`to` 等于本轮聊天 ⇒ 工具报错**:「本轮要说的话直接写在最后,daemon 会发。」这是故意的:不给模型留一条「在本轮里用工具说话」的旧路,否则 ① 的连发会换个工具名回来。
- **谁能用**:只有 admin 会话(`SESSION_IS_ADMIN`,`src/mcp-servers/wechat/main.ts:68,190-225`);trusted / guest 根本不注册。provider 侧沿用 `adminMcpTools` / `guestSafe`(`src/core/provider-policy.ts:32-46`)—— agy 拿的是全局静态 `trusted` 令牌(`src/daemon/bootstrap/agy-mcp-config.ts:88-166`),所以 agy 没有 `message`。
- **去重**:同一轮里 `message` 发出去的文字(规范化后:去空白标点)与本轮最后的话**相同或互相包含**,且目标是主人自己的聊天(主人在别的入口跟 CC 说话、让它「也在微信上告诉我」)⇒ 最后的话里那段不再重复交付,记 `REPLY_DEDUPED`。
- **`edit_message`**:ilink 没有编辑接口,今天是重发一条「(编辑后) …」(`ilink-glue.ts:283-285`)。删掉;要更正就在下一句话里说。见已定 ⑥。

### 4.7 长任务的过程旁白

今天气泡段让模型「先发结论再继续查」(`prompt-builder.ts:404-407`)—— 这其实是唯一的过程消息通道。新设计里最后一段之前的文字是 `narration`,**默认不进微信**。

定案(已定 ①):

1. **微信**:不转旁白。输入中提示本来就在整轮脉冲(`mw-typing.ts`),主人看得到「对方正在输入」。一轮超过 **120 秒**还没结束 ⇒ daemon 发**一次**进度:有旁白就发最近一段旁白(模型写的、有信息量),没有就发固定文案「还在弄,有点久,好了告诉你」。一轮最多一次,不随时长重复。
2. **桌面 / 手机**:旁白作为灰色的过程行显示在这一轮下面(app 是不受限的面,主人自己定过「桌面 app = 不受限的面,微信是入口」);最后的话照常是回复气泡。
3. **工作台**:不变(本来就是原生事件流)。

备选:(a)每段旁白都转(最像今天 Claude 开气泡时的体验,但正是双发旁白的形状);(b)只转第一段旁白(「好的我去查」式确认),不转后面的;(c)全部不转、连 120 秒进度也没有(最安静,长任务主人会以为断了)。

### 4.8 分条规则

模型不再「一条一个 reply」,而是写一段话;**分条是 daemon 的事**。定案(已定 ④):

- 提示改成:「像发微信那样说:每个意思一段,段与段之间空一行;短回答就一段;代码完整放在一段里。」
- 切分:空行分隔的段就是候选气泡;< 10 个可见字的碎段并入上一条(沿用 `MIN_CHUNK_VISIBLE`);**最多 4 条**,多出来的从后往前合并;代码块永远整块;单段超过约 300 字再按句末切。
- 去掉今天「总长 < 100 字不切」的门槛(`splitReply` 的 `minLen`)—— 模型自己空了行,就是想分开说;今天这个门槛只是为了防机械切分把短句切碎,现在边界由模型给出,不再需要。
- `split=false`(主人用 `/set` 关了气泡,`tools-companion.ts:97-122`)⇒ 一整条。

### 4.9 /chat 与 /both 合进同一条路

两个模式今天已经是纯文字,只是各有一套收集方式:

- /chat `runBeat`:拼全部文字、剥 `#RANK` 行、一条发(`conversation-coordinator.ts:1119-1133`);调了回复工具 ⇒ 整个发言人作废(`:1122-1125`)。
- /both:**每段文字一条**(`:1027-1035`)—— 旁白也发出去了,就是 ② 的形状。

统一为:每个发言人 / 参与者取 `extractTurnReply` 的 `text`(旁白丢弃),经 `deliverTurnReply`(前缀 `[名字]`,/chat 一人一条不分条,/both 按 §4.8 分条)。`#RANK` 剥离仍在 conductor 里先做。`permission-relay.ts:70-89` 拒回复族工具的那段在回复工具删掉后只需拒 `message`。`prompt-builder.ts:814-816` 那段过时描述(`<chatroom_round>` 信封与 @ 路由,代码里已无人产生;「/both 自动加前缀」那条路已死)一并重写。

### 4.10 现有机制的去向

| 机制 | 去向 |
|---|---|
| `FALLBACK_REPLY` 逻辑(`conversation-coordinator.ts:704-722`)、`makeSendAssistantText` 的回复用途 | **删除**。「没调 reply 却有文字」不再是异常,而是正常路径 |
| fallback 连击 / `PROVIDER_ANOMALY`(`:143-149`,`wire-coordinator.ts:144-150`) | 改为「**应答轮交付为空**」连击:私聊 / app 一轮 `completed` 但 `text` 空、没附件、或写了 `NO_REPLY` ⇒ 计一次;≥3 次记 `PROVIDER_ANOMALY` 并附 `/mode` 提示,语义仍是「这家执行者在这条路上不正常」 |
| `TurnRecord.replyToolCalled` / `textChunks` | 新增 `delivery: 'text' \| 'silent' \| 'empty' \| 'notice' \| 'attachments_only'`、`bubbles`、`attachments`、`narrationSegments`;库表加列(新迁移;按「user_version 是计数」那条规矩,新迁移要同时改三处测试)。旧列保留以读历史,新写入 `reply_tool_called=0`。`[TURN]` 日志 `reply=` 换成 `delivery=… bubbles=…`(`wire-coordinator.ts:106`) |
| 外发健康(`outbound-health.ts`) | 不变 —— 所有文字仍经 `ilink-glue.sendMessage` 记账 |
| 不重试风暴 / 退避 | 不变;§4.3 已写明交付失败不触发新的模型轮次。伙伴推送在连接降级时仍在**问模型之前**就停(`tick-bodies.ts:120-124,385-400`) |
| 网络守护(`src/daemon/guard/`、`src/lib/network-gate.ts`) | 不变:守的是模型调用与 TTS,不是 ilink。守护拒绝的那句话属于通知(`sendNotice`)。语音附件被 `gateVoice` 拒 ⇒ 按 §4.5 由 daemon 改发文字 |
| 结构化错误码(#190,`src/lib/provider-error-code.ts`) | 红线收紧:`error` 事件永远只变通知;`outcome !== 'completed'` 的轮不交付 `text`;Claude provider 继续不把带 SDK `error` 标注的消息产成 text(`claude-agent-provider.ts:592-600`),并新增测试钉住「`finalText` 里永远没有错误文案」(用 `src/daemon/diagnostics/__fixtures__/provider-errors/` 的 56 条真实样本跑一遍) |
| 终端会话 hook / y-n / @码 / 看码 | 不变(本来就是 daemon 转 CLI 的原生输出)。只把它们用的 `sendAssistantText` 改名 `sendNotice` |
| A2A / 社交 | 不变;`a2a_send` 保持独立工具。注意今天只调 `a2a_send` 的一轮会触发 fallback(它不在回复族里)—— 新设计下这一轮的最后的话就是给主人的回话,行为反而对了 |
| 提醒 | 不变(确定性文字) |
| 伙伴主动推送(`dispatchToChat`) | **改**:今天只认 reply 工具、文字全丢(`tick-bodies.ts:484-486`);改为收 `TurnReply` → `deliverTurnReply`,`NO_REPLY` 按 §4.4。与 app 轮共用的每聊天互斥(`:453-464`)保持 |
| app 接收器(`reply-sinks.ts`) | 从「收字符串、用 `\n` 拼」改为收 `TurnReply`;`companionConverse` 返回 `{ reply, bubbles, attachments, narration }`,桌面 / 手机按 §4.7 显示 |
| 访客 | `GUEST_ALLOW`(`src/core/user-tier.ts:88`)去掉 `reply`(不再需要);访客的话照样是最后的话。表情附件仍对访客开放(今天表情工具就按 `reply` 类放行,`:275-278`) |
| `sessions/searcher.ts` 的 `"mcp__wechat__reply"` 标记(`:34,91,108`) | 改认入站信封 `<wechat chat_id=`(每条入站消息都带,`prompt-builder.ts:353`),否则迁移后的新会话不再被认成微信会话 |
| 自检 `/v1/selftest/converse`(`src/daemon/selftest.ts:56-141`) | 返回值加 `reply`(`extractTurnReply` 的结果);`cli/selftest.ts` 的 `replied` 改看它;新增「旁白没进回复」一项 |
| `reply-tool-bridge.e2e.test.ts`(`src/daemon/__e2e__/`,钉「用了 reply 工具就只有一次 sendmessage」) | 按执行者迁移逐步改写成「最后的话 → 恰好 N 条 sendmessage」 |
| 命名空间折叠(`normalizeWechatMcpServer`) | 保留(桌宠信号、`[TURN] tools=` 日志仍用),但它不再承担「判定这轮说没说话」 |

### 4.11 提示词要改的地方(全部)

- `prompt-builder.ts:359` 基础段:改为「你最后写下的那段话就是发给对方的回复;说完就结束这一轮。」删掉 fallback / anomaly 一句。
- `:366-374` 工具段:去掉 `reply` / `reply_voice` / `edit_message` / `broadcast` 的「回复」小节,换成附件工具与(admin)`message`;`:382`「reply 引导用户」改成「直接告诉用户」。
- `:404-407` 气泡段:按 §4.8 重写。
- `:814-816` 多模式段:按 §4.9 重写。
- `:821-827` 伙伴段,`tick-bodies.ts:234-242,256-263,270-278` 三个推送提示:「调 reply 写一句」→「写一句」;静默 → `NO_REPLY`。
- `chatroom-conductor.ts:37`:按 §4.4 改名后删除。
- `permission-relay.ts:87` 拒绝文案。
- codex 没有系统提示位,指令前置在第一条消息(`codex-agent-provider.ts:276-280`),agy / ACP 同理(`agy-agent-provider.ts:379-380`,`acp-agent-provider.ts:373-374`)—— 同一份 `buildSystemPrompt` 输出,不用分别改。

**过渡期**:迁移是一家一家来的(§5),所以提示词要按 provider 的交付方式出两个版本,`buildSystemPrompt` 加参数 `replyDelivery: 'tool' | 'final_text'`,随最后一家迁完删掉 `'tool'` 分支。

---

## 5. 迁移计划:一家一家来,每步一道闸

### 5.0 开关放哪

`ProviderCapabilities` 加 `replyDelivery: 'tool' | 'final_text'`(按「provider 配置进 capabilities」的约定,`agent-provider.ts:339-357` 那组字段旁边)。协调器 / 推送 / app 轮按**当轮 provider** 的这个值走新旧路径;提示词、工具表跟着它。每一步只翻一家的值,出问题翻回去就是回滚(纯代码,不涉及数据)。

### 5.1 第 0 步:地基(不改任何人的行为)

1. harness:provider 加回实验专用的 `makeBuiltins` 注入口(PR #196 的那一个,不带尾巴守卫)。今天 dev 上的 harness 发现没有这个口会拒跑(否则模型调的 Bash 会被真执行)。
2. `extractTurnReply` + 单测(各家的真事件形状:沿用 `src/core/acp/events.test.ts`、`agy-agent-provider.test.ts`、`external-cli-contract` 的 fixture)。
3. **影子记账**:所有执行者照旧走工具,但每轮额外算一次 `extractTurnReply`,`[TURN]` 日志加 `final_len= narration=`,和本轮 reply 工具实际发出的文字比对(`SHADOW_DIFF`)。跑几天真机,得到「如果当时按最后的话发,会差多少」的真实分布 —— 这是后面每一步的基线。
4. `reply-delivery.ts` + `sendNotice` 分家;Claude provider 的事件顺序修正(§4.2)。
5. 新迁移(`turn_records` 加列)。

### 5.2 第 1 步:openai 兼容

**为什么第一个**:症状最重(沙盒 12 条 / 轮)、循环是我们自己的、harness 现成、只影响用 DeepSeek / Kimi / Qwen 的会话。
改动:翻开关;从它的 MCP 工具表里滤掉 `reply` / `reply_voice` / `edit_message` / `broadcast`(`src/core/openai-mcp-bridge.ts` 按 `replyDelivery` 过滤),换上附件工具。

### 5.3 第 2 步:agy

**为什么第二**:双发旁白的事故源头;它拿不到 admin 工具,没有 `message`,改动面最小。agy 无法完全隔离(只读全局配置、私有二进制),harness 只能在临时项目目录里跑、并且不给它 `--dangerously-skip-permissions`;回合数从严。

落地(2026-10-03):接线完成,闸门两臂打平,agy 先 `shadow`;沙盒做法与「不给 dangerously」那条的偏离见修订记录。

### 5.4 第 3 步:Cursor(ACP)

`messages` 模式的冲缓冲语义已经天然分段(§4.2)。Windows 不注册(`providers.ts:402-403`),不涉及。

落地(2026-10-03):接线完成、不连模型的闸门 daemon 无回归且结构上更好 ⇒ Cursor 翻 `daemon`;闸门做法(Cursor 真 API 没法沙盒、额度用完 ⇒ 照真机报文演的假 `cursor-agent acp` + 生产全链)见修订记录。

### 5.5 第 4 步:Codex

注意 `dangerouslyBypassApprovalsAndSandbox` 存在的理由之一就是「否则 codex 会取消 `mcp__wechat__reply`」(`codex-agent-provider.ts:120-129`)—— 不再调 reply 后可以重新评估这个开关(本稿不改,记一笔)。

落地(2026-10-03):接线完成;剧本臂(照 codex exec 事件形状演的假 Codex + 生产全链)daemon 无回归且结构上更好,真模型小批(沙盒 CODEX_HOME,35 次调用)适用场景全过 ⇒ Codex 翻 `daemon`;provider 其实要改(§4.2 这一行原写「不用改」),见修订记录。

### 5.6 第 5 步:Claude

主人的主力,最后迁,前面四家的经验都用上。要特别验:SDK `result.result` 与分段结果一致;子 agent / 后台任务的文字不混进最后的话。

落地(2026-10-03):接线完成;剧本臂(照 Agent SDK 消息形状演的假 `query()` + 生产全链,四种外部条件)daemon 无回归且结构上更好,真模型小批(沙盒 HOME,25 回合)适用场景全过、`result.result` 与分段 22/22 一字不差 ⇒ Claude 翻 `daemon`。**迁移序列的五家至此全部是 daemon。** `result.result` 改为只核对、不作交付依据,见修订记录。

### 5.7 第 6 步:收尾

删回复族工具与 `isReplyToolCall` 的判定用途、`FALLBACK_REPLY`、`'tool'` 版提示词、`NO_REPLY_TOOL` 常量、`WECHAT_PARTICIPANT_TAG`;改写 `reply-tool-bridge.e2e.test.ts`;docs(`reference/features.md`、`architecture.md`)同步。

**观察期(2026-10-03 定,第 5 步合入之后)**。legacy 路径是回滚开关(agent-config `reply_delivery`)唯一的去处,删它之前先确认没人需要回滚:

1. **起点**:第 5 步部署到主人机器、`[BOOT]` 行没有 `reply_delivery override`(即五家都在用代码默认的 daemon)的那一天。
2. **时长**:至少 **14 天**,且其中每家执行者至少有 **20 个完成的应答轮**(`turn_records` 按 provider 数 `outcome='completed'`;某一家用得少就延长到够数,或主人明确说「这家不用了」)。
3. **每天看的东西**(都在 `channel.log` / `turn_records`,`maintainer/reply-delivery.md` 的排查表):
   - 回滚开关没被用过(没有 `[BOOT] reply_delivery override`);
   - `[PROVIDER_ANOMALY] … empty-reply streak` 没有比迁移前的 FALLBACK 连击更多;
   - `[REPLY_FINAL_CHECK] match=differs` 为 0(有就说明 Claude 的分段和 SDK 自己的定义对不上,先查清);
   - `[REPLY_DELIVERY_FAIL]` 只出现在外发健康本来就红的时段;
   - `turn_records.delivery` 的分布:`empty` / `silent` 在私聊里的占比不高于 5%;
   - 主人没有报「只收到过程话」「收到两遍」「没回」这三类问题。
4. **过关 ⇒ 开第 6 步的 PR**;不过 ⇒ 那一家先回滚(agent-config),修好后观察期对那一家重新计。
5. 观察期内允许改 daemon 路径本身(修 bug、调分条),但不改 legacy 路径(它只是回滚的去处)。

**第 6 步的删除清单**(2026-10-03 按代码核对;一个 PR,先删再跑全套 + e2e):

| 删什么 | 在哪 |
|---|---|
| 开关本身:`ProviderCapabilities.replyDelivery` / `replyDeliveryFor` / `setReplyDeliveryOverrides`、agent-config `reply_delivery`、`reply-delivery-config.ts`;`shadow` 档与 `[REPLY_SHADOW]`(`observeLegacy`) | `core/agent-provider.ts`、`core/capability-matrix.ts`、`lib/agent-config`、`daemon/bootstrap/reply-delivery-config.ts`、`daemon/reply-delivery.ts` |
| 协调器的 legacy / shadow 分支、`FALLBACK_REPLY` 与 fallback 连击、`sendAssistantText` 的回复用途(H / I 类转发改名 `sendNotice`) | `core/conversation-coordinator.ts`(solo / parallel / chatroom 三处)、`daemon/bootstrap/fallback-reply.ts`、`wire-coordinator.ts` |
| 回复族工具与路由:`reply` / `reply_voice` / `send_file` / `edit_message` / `broadcast` / `send_sticker` / `search_online_sticker` / `send_online_sticker_candidate` 的注册与 `/v1/wechat/*` 路由;`WECHAT_REPLY_DELIVERY`(只剩一套工具表) | `mcp-servers/wechat/tools-messaging.ts`、`daemon/internal-api/routes.ts` / `types.ts`、`bootstrap/mcp-specs.ts` |
| `isReplyToolCall` / `isReplyToolName` / `REPLY_TOOLS` 的判定用途、`TurnSummary.replyToolCalled`(库表列保留读历史,新写 0);扇出拒 `message` 那一条改成只看 `message` | `core/agent-provider.ts`、`core/permission-relay.ts` |
| `'tool'` 版提示词:`buildSystemPrompt` 的 `replyDelivery` 参数、`LEGACY_SPEAKING_BLOCK`、各段 legacy 文案;推送提示的 `'tool'` 版 | `core/prompt-builder.ts`、`daemon/wiring/tick-bodies.ts` |
| `NO_REPLY_TOOL` 常量、`WECHAT_PARTICIPANT_TAG`(前缀早由协调器传) | `core/chatroom-conductor.ts`、`bootstrap/mcp-specs.ts`、`mcp-servers/wechat/tools-daemon.ts` |
| 访客 `GUEST_ALLOW` 里的 `reply` 类(附件仍归它) | `core/user-tier.ts` |
| gemini(API key 版,2026-09-27 起 deprecated,唯一还在 legacy 的 provider):**连 provider 一起删**,或先按第 1 步的做法迁到 daemon —— 删 legacy 之前必须二选一 | `core/gemini-agent-provider.ts`、`bootstrap/providers.ts` |
| 测试:`reply-tool-bridge.e2e.test.ts` 里回滚那组、fake-sdk 的 reply 桥、`*-delivery.test.ts` 的 legacy 对照组、reply-once harness 的 legacy 臂(数据文件留作记录) | `daemon/__e2e__/`、`core/*-delivery.test.ts`、`scripts/experiments/reply-once/` |
| docs:`reference/features.md`、`architecture.md`、`maintainer/reply-delivery.md`(回滚一节改成「已无回滚」)、`internal-api-auth.md` 的回复路由 | `docs/` |

另外两件不删但收尾时做:`cli/selftest.ts` 的 `replied` 改看交付报告、加「旁白没进回复」一项(§4.10);`external-cli-contract.live.test.ts` 加「最后一段」的契约断言(§7)。

伙伴推送、/chat、/both、app 轮不单独成步:它们按「当轮 provider 的开关」走,随每一家一起切。

### 5.8 每一步的闸门

**(1)沙盒 harness**(扩展 `scripts/experiments/reply-once/harness.ts`):真模型、假工具、临时状态目录,**不碰主人的对话、记忆、项目**。非 openai 的执行者是外部进程,所以要加一个**假 wechat MCP 的 stdio 入口**(同一份工具注册代码 + 只记账的 `InternalApiClient`,和今天进程内那个一样),内置工具:Claude 用 `canUseTool` 只记账全拒、codex 只读沙盒、Cursor ACP 权限卡全拒、agy 见上。每次真模型调用前过一次网络守护(`assertCallAllowed`)—— 直连供应商会封号。

场景(沿用 a–e,新增 f–i):

| 场景 | 内容 | 过关线 |
|---|---|---|
| a | 「回我一句简短的话」 | 5/5:1 条气泡,0 旁白外泄 |
| b | 历史里有连发 + 「停」(迁移后历史里是助理文字形状的连发) | 5/5 干净结束;0 条「停」类;0 次跑满预算;均值 ≤ 1.5 条 |
| c | 「分三条发三个建议」 | ≥4/5 恰好 3 条气泡(按 §4.8 空行分段) |
| d | 「我有哪些项目?」 | 5/5:先 list_projects 再 1 条;非回复工具数不高于基线 |
| e | 新会话连跑四轮 | 每轮 1 条,不升级 |
| f | 「用语音跟我说晚安」 | 语音附件 1 个,文字 0 或 1 条(按已定 ⑤) |
| g | 伙伴推送提示 + 「议程已过期」 | 5/5 `NO_REPLY`,0 条外发,令牌 0 次出现在任何外发里 |
| h | 需要 3–4 次工具调用的查询 | 旁白 0 条进微信;最后的话含结论 |
| i | 私聊里诱导「不用回」 | 令牌 0 次外泄;记 `REPLY_SILENT_IN_DM` |

记的指标:每轮气泡数、双发(旁白或重复文字进了外发)、非回复工具调用、干净结束、跑满预算、令牌外泄。报告进 `docs/reference/reply-once-experiment.md` 追加一节。

**(2)真机**:`bun run e2e:device`(真 iPhone 上「跟 CC 说一句等回复」,`scripts/device-e2e.ts:303-308`)全绿;`wechat-cc selftest chat --provider <这一家> --resume`;再由主人在微信里用这一家正常聊几句(含一次要工具的问题、一次要语音的)。前一步的影子记账 `SHADOW_DIFF` 里这一家没有未解释的差异。

---

## 6. 已定(2026-10-03,维护者按推荐定,主人授权)

主人授权由维护者审稿并拍板原先的「待主人定」各项;2026-10-03 审稿通过,8 条全部按推荐写定:

| # | 问题 | 定案 | 理由 |
|---|---|---|---|
| ① | 长任务过程旁白 | **旁白不转发到微信**;一轮超过 120 秒,由 daemon 发**一句**进度(有旁白就用最近一段,否则固定文案),一轮最多一次;桌面和手机显示全部旁白 | 逐段转发就是双发旁白的形状;一概不发,长任务主人会以为断了 |
| ② | `NO_REPLY` 生效范围 | **只用于主动推送和 /chat、/both 的发言者**;私聊不教,私聊里出现就吞掉(不显示)并记一条异常(`REPLY_SILENT_IN_DM`,计入应答轮交付为空的连击) | 私聊里 CC 不回话,主人会以为坏了;OpenClaw 同款 |
| ③ | 主动陪伴推送 | **走 `NO_REPLY`,不用 `message` 工具**:推送也是一轮,最后的话就是推送 | 和应答轮同一条交付路;`message` 只留给「别的目标」,而且 trusted / agy 没有它 |
| ④ | 分条规则 | **按空行分条,最多 4 条,碎片并进前一条,代码块不拆,去掉原来 100 字的分条门槛**;单段过长再按句末切;`split=false` ⇒ 一整条 | 边界由模型给(像今天的多次 reply),但不用工具 |
| ⑤ | 纯语音 | **正文为空或者和语音内容相同 ⇒ 只发语音;否则先发文字再发语音**;语音失败由 daemon 改发文字 | 不重复,也保证主人至少收到一份 |
| ⑥ | `edit_message` / `broadcast` | **删除 `edit_message`;`broadcast` 并进 `message({to:'broadcast'})`** | ilink 没有编辑接口,今天的「编辑」只是再发一条 |
| ⑦ | 「最后的话」取哪段 | **最后一段非空文字**;之前的段是旁白 | 拼整轮会把「让我查一下」也发出去,等于把双发旁白合法化 |
| ⑧ | 迁移顺序 | **openai → agy → Cursor → Codex → Claude** | openai 症状最重、循环是我们的、harness 现成;Claude 是主力,最后迁,吃前四家的经验 |

**备注**:§1.2 ④ 提到的「`reply` 路由不核对 `chat_id`」越权问题**已在另一个 PR 单独修**,不等本设计迁移;迁移时「附件工具不带 `chat_id`、目标永远取本轮聊天」(§4.5)的设计照旧。

---|---|---|---|
| ① | **长任务过程旁白怎么处理** | (a)每段都转微信;(b)只转第一段;(c)一概不转;(d)不转,但超过 120 秒 daemon 发一次进度(有旁白就用最近一段,否则固定文案),桌面 / 手机显示全部旁白 | **(d)**。(a)就是今天双发的形状;(c)长任务主人会以为断了;(d)的进度一轮最多一次,不会刷屏 |
| ② | **`NO_REPLY` 在哪里生效** | (a)只在伙伴推送;(b)推送 + /chat / /both 发言人;(c)到处都行,包括私聊 | **(b)**。私聊不教、写了也压掉但记异常(OpenClaw 同款)。私聊里 CC 不回话主人会以为坏了 |
| ③ | **伙伴主动推送用 `NO_REPLY` 还是 `message` 工具** | (a)推送也是一轮,最后的话就是推送、不想发写 `NO_REPLY`;(b)推送轮默认不发,想发就调 `message` | **(a)**。和应答轮同一个模型、同一条交付路;(b)会把「用工具说话」原样留在推送里,而且 trusted / agy 没有 `message`。`message` 只留给「别的目标」 |
| ④ | **分条规则** | (a)模型空行分段、daemon 照段分条(最多 4 条、碎段并入、代码整块、长段按句切、去掉 100 字门槛);(b)沿用今天的机械切分(≥100 字才切、最多 3 条);(c)显式分隔符(如单独一行 `---`) | **(a)**。边界由模型给(像今天的多次 reply),但不用工具;(c)多一个要教的约定,模型会把它写进代码块或 Markdown 里 |
| ⑤ | **只有语音的回复** | (a)最后的话为空或与语音内容相同 ⇒ 只发语音;不同 ⇒ 文字 + 语音;(b)语音永远另附,文字照发(会重复);(c)有语音附件就不发文字 | **(a)**。语音失败 daemon 改发文字,主人至少收到一份 |
| ⑥ | **`edit_message` 与 `broadcast`** | (a)`edit_message` 删掉、`broadcast` 并进 admin 的 `message({to:'broadcast'})`;(b)都保留原样 | **(a)**。ilink 没有编辑,今天的「编辑」是再发一条「(编辑后)」 |
| ⑦ | **「最后的话」取哪一段** | (a)最后一段非空文字(之前的算旁白);(b)整轮所有文字拼起来 | **(a)**。(b)会把「让我查一下」也发出去,等于把双发旁白合法化 |
| ⑧ | **迁移顺序** | openai → agy → Cursor → Codex → Claude;或按使用量倒过来 | **openai 先**(最重、循环是我们的、harness 现成),Claude 最后(主人主力,吃前四家的经验) |

---

## 7. 风险

- **Claude 多步任务里的「最后一段」不是总结**:模型最后一步可能只写一句「完成。」,而真正的内容在前面的旁白里。缓解:影子记账先量;提示词明确「最后一段要把结论说全」;实在不行对 Claude 用 `result.result`(SDK 自己的定义)。
- **气泡体验退化**:今天开气泡时模型会「先发结论、再查、再补充」,主人在等的过程中就收到第一条;新设计里查完才一起发。§4.7(d)的 120 秒进度与输入中提示只能部分补偿。这是用「不双发、不连发」换的,写明在这里。
- **外挂 CLI 的文字形状变化**:agy / Cursor 换版本后分段方式可能变(比如把旁白和结论合成一个 step)。缓解:`external-cli-contract.live.test.ts` 加「最后一段」的契约断言。
- **静默被滥用**:推送里模型过多写 `NO_REPLY` ⇒ 伙伴变哑。`REPLY_SILENT kind=tick` 有记账,和今天的计划判断 `none` 一样可以统计。
- **迁移期两套路径并存**:同一个聊天换 provider 时,历史里一半是工具调用、一半是文字。交接块(`src/core/provider-handoff.ts`)给的是入站 / 出站文字,不受影响;原生会话续接时模型能看到自己以前调 reply —— 第一轮可能照旧调,而工具已不存在 ⇒ 报「工具不存在」,下一步自然写文字。harness 场景 b 就是测这个。
- **主人聊天的直接影响**:每一步都会改变主人日常收到的消息形状。所以每步之后都有主人真机试聊,而不只是自动化。

## 8. 非目标

- 不做 token 级流式到微信(ilink 一条消息发出就不能改;OpenClaw 的 block streaming 我们只取「按块 + humanDelay」的部分)。
- 不改工作台、终端会话 hook、提醒、社交信封的送达。
- 不改网络守护的判定、不改外发健康的状态机。
- 不做群聊支持(今天也不支持,`src/core/knowledge/source-adapter.ts:21,371` 之外没有群聊处理)。
- 不在本稿里重新评估 codex 的 `dangerouslyBypassApprovalsAndSandbox`。

## 9. 测试计划

- **单测**:`extractTurnReply`(各家真实事件序列 fixture;空最后段、只有工具、错误轮、取消轮);`deliverTurnReply`(静默 / 混合令牌行 / 前缀 / 分条 / 4000 字代码块切分补围栏 / 第一条失败即停 / 接收器拿到整个对象 / 旁听被调);`splitReply` 新规则;`NO_REPLY` 在三类场合的处理;去重;附件顺序与「只有语音」;Claude 事件顺序修正;错误样本 56 条 ⇒ `finalText` 恒不含错误文案。
- **协调器 / 推送 / app 轮**:沿用 `src/daemon/wiring/pipeline-deps-*.test.ts`、`tick-bodies.test.ts`、`reply-sinks.test.ts` 的结构,各加 `replyDelivery='final_text'` 的一组。
- **e2e**:`src/daemon/__e2e__/` 的 `reply-tool-bridge`、`dispatch-chatroom-*`、`dispatch-parallel-both`、`dispatch-primary-tool` 按迁移逐步改写;fake SDK(`fake-sdk.ts:181-190,447-449`)加「只写文字」的剧本。
- **沙盒 + 真机**:见 §5.8,每家一次。
- **回路**:每步 `bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`、`wechat-cc ci triage --wait`。

## 修订记录

- 2026-10-03:第 5 步(Claude)接线完成,**Claude 翻 `daemon`;迁移序列的五家全部是 daemon**(编码型 `last_segment`;数据见 `reference/reply-once-experiment.md`「第 5 步」)。落地时与稿子不一样 / 稿子没写到的几处:① **§4.2 Claude 行「以 `result.result` 为准」改为只核对**:正常轮里它和分段的最后一段按构造相同(真跑 22/22 一字不差),不同的只有出错轮(`is_error` 时它就是错误原文,#190 红线)和分段本身要处理的情况(子 agent、多文字块)⇒ 交付统一用分段(五家同一条路),`result.result` 只在成功轮作为 `result.finalText` 带出,对不上记 `[REPLY_FINAL_CHECK]`。② **事件顺序**按稿子修了(按块的顺序发);但真 Claude Code 2.1.289 每个内容块本来就单独一条 assistant 消息,这个 bug 在今天的 CLI 上碰不到,剧本臂的 `bundled` 条件钉住它。③ **子 agent**:带 `parent_tool_use_id` 的消息文字不进任何一段(legacy 也受益)。④ **只有 `is_error` 没有 SDK 标注的结果**补一个 `provider_error` 码,只发通知。⑤ 扇出里 `canUseTool` 也拒 `message`(§4.9)。⑥ `sessions/searcher.ts` 改认入站信封 `<wechat chat_id=`(旧会话的 reply 标记一并认)。⑦ **闸门**:Claude 的 `canUseTool` 在所有 tier 下都放行 reply,Codex / Cursor 那种 strict 吞话碰不到 —— 剧本臂的四种外部条件换成 recorded / bundled / drift(插件 MCP 名)/ tool_error(reply 调用失败 ⇒ legacy 吞话);场景 b 改成「会话续接跨过开关」(§7 的风险)。真模型小批的沙盒:临时 HOME,登录只读、只经 `CLAUDE_CODE_OAUTH_TOKEN` 给 access token(不给 refresh token),每次运行核对钥匙串没被改。⑧ **决定**:legacy 在名字照 `mcp__wechat__reply`、调用成功时没坏;真 Claude 在 reply 之后每轮再写一句自述(6/6),认不出 reply 就是第二条(剧本 drift 双发 6、旁白外泄 4);reply 失败 ⇒ 3/3 轮吞话;私聊 `NO_REPLY` 原样外发。daemon 四种条件全 0,真模型适用场景全过、非回复工具 10.0 vs 13.0(legacy 每轮要先 ToolSearch 才找得到 reply),纯说话的轮快一半 ⇒ 翻默认。⑨ §5.7 补了观察期与删除清单(本步**不删** legacy,保留回滚)。
- 2026-10-03:第 4 步(Codex)接线完成,**Codex 翻 `daemon`**(编码型 `last_segment`;数据见 `reference/reply-once-experiment.md`「第 4 步」)。落地时与稿子不一样 / 稿子没写到的几处:① **§4.2 的 Codex 行「不用改 provider」不成立**:只有 `mcp_tool_call` 产 tool_call,shell / 改文件 / 搜索 / 计划都不产 ⇒「顺便看下仓库状态。」→ 跑命令 →「结论」粘成一段,旁白跟着交付。改为不是消息 / 思考 / 非致命 error 的 item 都是一次工具调用(`codexItemToolCall`,含 SDK 不认识的新 item 类型),每个 item 只产一次;另给 text 事件加 `ownSegment`,Codex 每条 agent_message 自成一段,对上本节「turn.completed 之前最后一个 agent_message」的定义(两条之间只隔思考也不粘)。顺手:`turn.completed` 之后 exec 才非零退出不再补 error 事件(否则完成的回复被当出错丢掉);非致命 error item 只记日志。② **工具表**:Codex 的 wechat MCP 是构造时的 spec + 每次 spawn 合进会话 env,经 SDK config 交给 `codex exec`;`wechatStdioMcpSpec('codex')` 按开关带 `WECHAT_REPLY_DELIVERY=daemon`,不用改写任何静态配置;会话令牌里有 chat,附件不带 chat_id。③ **闸门两部分**:剧本臂(`src/core/codex-scripted.ts` 注入 `codexFactory`,三种外部条件:形状照 SDK / CLI 比 SDK 新、MCP 换了 item 类型 / strict 没有 bypass ⇒ codex 拒 MCP)+ 真模型小批(沙盒 CODEX_HOME 只复制登录、read-only、MCP 用 codex 自己的 `default_tools_approval_mode = "approve"` 放行、每轮查 bx;35 次调用)。真模型上看到:codex 调工具前总先写一句开场(daemon 12/12),legacy 下 reply 之后再收一条空消息 ⇒ legacy 认不出 reply 时漏的是开场;**strict 吞话真机复现**(reply 被拒「MCP tool call requires approval, but approval policy is never」,模型改用文字说,legacy 一个字都不发)。④ **决定**:legacy 在形状照 SDK 时没坏;CLI 比 SDK 新 ⇒ 旁白外泄 7、strict ⇒ 3/3 轮主人什么都没收到、私聊 `NO_REPLY` 原样外发;daemon 三种条件全 0,真模型适用场景全过、非回复工具 11.0 vs 14.0(g 两臂都静默,只差相对条件)⇒ 无回归且结构上更好,翻默认。⑤ 残留:strict 下 codex 拒所有 MCP ⇒ daemon 的附件调不成(文字照发),要修得给 wechat MCP 配 approve —— 属于重评 bypass,§8 写明不在本稿;主人默认模型 `gpt-6.1-sol` 在 CLI 0.153.4 + ChatGPT 账号下被服务端拒(版本耦合,与本步无关,另记)。
- 2026-10-03:第 3 步(Cursor)接线完成,**Cursor 翻 `daemon`**(数据见 `reference/reply-once-experiment.md`「第 3 步」)。落地时与稿子不一样 / 稿子没写到的几处:① **工具表**:Cursor 的 wechat MCP 是逐会话注入的(`acpMcpServersFor` 把 `wechatStdioMcpSpec('cursor')` 的 env 原样放进 `session/new` 的 `mcpServers`),所以翻开关不用改写任何静态配置,重启后新会话即是新工具表;会话令牌里有 chat,附件直接挂本轮,不需要 agy 的按轮绑定。② **闸门不连模型**:Cursor 的真 API 没法沙盒化(连 Cursor 的服务、用主人的登录与额度),而主人额度用完了 —— §5.8(1)「真模型、假工具」改成「同一个模型行为的剧本 + 照 2026-09-17 真机报文形状演的假 `cursor-agent acp`(`src/core/acp/scripted-agent.ts`)+ 生产的 ACP 客户端 / 协调器 / 交付运行时」,每个场景跑三种外部条件(身份照真机 / CLI 不带身份 / strict 权限)。场景 b 不适用(量的是自研循环接历史,剧本演不出)。这一臂衡量的是交付管道,不是模型 —— 「Cursor 会不会把结论写在最后一段」留到额度回来用真模型补。③ **决定**:legacy 在身份照真机时没坏;CLI 不带身份 ⇒ 双发 5 次、旁白外泄 3 次;strict 下 reply 调用被拒仍算「回过了」⇒ 3/3 轮主人什么都没收到(稿子没写到的又一种症状);私聊 `NO_REPLY` 被 FALLBACK 原样发出。daemon 在三种条件下都 0 双发 / 0 外泄 / 0 吞话,适用场景全过(g 只差相对基线那条,与 agy 同)⇒ 无回归且结构上更好,翻默认;双发的结构性消失由 `conversation-coordinator.cursor-delivery.test.ts` 用生产 ACP 客户端证明(含回放真机 c1)。④ 两臂共有、不是本步引入的:Cursor 把自己的报错(「Agent Looping Detected」)写进助理消息、stopReason 仍是 end_turn ⇒ 会被当回复发出,另做。
- 2026-10-03:第 2 步(agy)接线完成、闸门两臂打平 ⇒ agy 先 `shadow`(数据见 `reference/reply-once-experiment.md`「第 2 步」)。落地时与稿子不一样 / 稿子没写到的几处:① **静态 MCP 配置跟着开关走**:agy 的工具表是 daemon 开机写进全局 `mcp_config.json` 的,`wechatStdioMcpSpec('agy')` 在 daemon 模式带 `WECHAT_REPLY_DELIVERY=daemon`,`setupAgyGlobalMcp` 按内容变化改写条目;agy 每轮新进程、启动时读 ⇒ 翻开关 = 改能力表或 agent-config + 重启 daemon(集成测试用文件里写出的 env 起子进程核对工具表)。② **共享令牌的附件绑到本轮**:`agy-static` 令牌里没有 chat,daemon 模式下 dispatcher 按「agy 此刻正在跑的那一轮」认聊天(`ReplyDeliveryRuntime.turnChatFor`):`/v1/turn/attach` 挂到那一轮;发送类路由的 #199 豁免取消,只许那个聊天;没有轮 / 两个聊天并发 ⇒ 拒(`ambiguous_turn`,不猜)。记忆、提醒的范围门不在这一步改(agy-static 在那里一直是拒的),写进 `internal-api-auth.md`。③ **双发旁白**:daemon 模式下交付不再看 tool_call 认不认得出来,结构性消失;`conversation-coordinator.agy-delivery.test.ts` 用没登记过的命名空间证明(legacy 复现双发,daemon 只交付一次)。④ §5.3「不给 `--dangerously-skip-permissions`」在沙盒里做不到:agy 1.2.16 的 print 模式不带它就软拒每一次 MCP 调用,两臂都量不到生产;改为保留它 + `--sandbox` + 临时工作区 + 不继承任何全局定制的工作区 agent + 全假工具。⑤ **决定**:闸门 a–i 两臂都过(g 只差「比基线高 40pp」的相对条件 —— agy 的 legacy 推送本来就 3/3 不发),daemon 无回归、非回复工具更少(10.3 vs 15.0),但 harness 能量到的故障点上两臂打平(legacy 的双发早被命名空间折叠修住),按「daemon 在故障点上明显好于 legacy 才翻」的约定不翻,先 shadow 攒 `[REPLY_SHADOW]`;翻的理由(结构性去掉双发的依赖、关掉共享令牌的跨 chat 豁免)由测试证明,留给维护者定,翻只改一行。
- 2026-10-03(审稿第二轮,维护者定):**openai 切到 daemon 的决定与理由**:三轮数据里新路径在真正的故障点上明显好于 legacy —— b(历史里有连发)15/15 正常结束,legacy 8.4 条 / 轮、3/5 跑满步数;g 从 0/5 到 3/5;剩下的都是「多发一句、没收住」这类小毛病,而 legacy 才是那条真会失控的路。§5.8 里过严的几条(a 的「1 条」、f 的「文字 ≤1」、d 的「非回复工具严格不多于基线」、b 的「0 条『停』」对一次复述历史零容忍)不作为切换的阻断条件。切换的前置条件:运行时回滚开关(agent-config `reply_delivery`,覆盖能力表,重启生效,见 `maintainer/reply-delivery.md`)、聊天型提示词的结构性约束(一轮只在最后说话、工具前不先说一句除非明显很慢、发了语音不补收尾)、推送 compose 提示改成「已决定要推送,请写出这条推送」(NO_REPLY 只是写不出值得发的内容时的兜底;/chat、/both 的发言者照旧可以 NO_REPLY)、a / f / g 复测「不比第 3 轮差」。**复测结果 f 从 3/5 降到 2/5(a 5/5、g 4/5 都更好),按约定没有切换,openai 仍是 `shadow`,等维护者定**。
- 2026-10-03(审稿后修订,维护者定):**「最后的话」按执行者类型分两种策略**(`ProviderCapabilities.replyText`)。编码型执行者(Claude Code / Codex / Cursor)仍取最后一段,之前的段是长任务旁白,不进微信,长任务 120 秒发一句进度 —— 「最后一段」的规则本来就是为编码 agent 的长旁白设计的。聊天型模型(openai 兼容,以后也包括 agy 这类)**本轮所有文字段按顺序全部交付**,每段按 ④ 各自分条,不发进度:工具调用前说的「我查一下」也是正常的聊天内容,用「最后一段」会丢内容(第 1 步闸门里场景 c 有一次「第一项被当成旁白吞掉」)。这是结构性的区分,不按内容猜。聊天型的静默:最后一段是 `NO_REPLY` ⇒ 允许静默的场合整轮不发(前面的「我先看看」也不发);私聊不认静默,令牌吞掉、记异常,前面真说过的话照发。提示词与推送提示按策略各出一版(聊天型说清「这一轮写的都会发出去,不写过程独白;不发就只写 NO_REPLY,别解释」)。§5.8 过关线同时修订:d =「先 list_projects、≤2 条、列表完整」(按 ④「列表 + 一句收尾」两条是正常的);c =「三项都完整送达、没有丢段、气泡 ≤3」,恰好 3 条只单独记;g =「≥4/5 静默,且明显好于基线(静默率至少高 40 个百分点)」。推送「推不推」在调用模型之前由 shouldSpeak / 日程判断决定(daemon 模式下仍然先于生成,有测试钉住),`NO_REPLY` 是第二道闸。
- 2026-10-03:第 1 步(openai)接线完成、闸门没过 ⇒ openai 先 `shadow`(见 `reference/reply-once-experiment.md`)。落地时与稿子不一样的几处:① reply 族工具不是在 `openai-mcp-bridge` 里过滤,而是 daemon 给 wechat MCP 子进程设 `WECHAT_REPLY_DELIVERY=daemon`、注册时就换工具表(任何走 `wechatStdioMcpSpec` 的 provider 翻开关即生效;agy / cursor 的静态 MCP 配置翻的时候要各自加);② `search_online_sticker`(搜 + 发一步)并进 `sticker(mood, query)`;③ §5.8 场景 d「1 条」与已定 ④ 冲突 —— 去掉 100 字门槛后,「列表 + 一句收尾」按空行就是 2 条;分条另加了两条规则(冒号引导段并入下一段、同一列表不拆);④ `sendAssistantText` 没有整体改名:协调器里的系统通知改走新的 `sendNotice`,H / I 类转发仍用原名;⑤ /both 的 daemon 参与者的 TurnRecord 还没记交付列;桌面 / 手机还不显示 converse 返回的附件与旁白。
- 2026-10-03:第 0 步落地时的两处对齐:① 开关做成三值 `replyDelivery: 'legacy' | 'shadow' | 'daemon'`(§5.0 原写 `'tool' | 'final_text'`):shadow 就是 §5.1 第 3 项的影子记账,单独一档才能一家一家先影子、再翻;提示词参数仍是 `'tool' | 'final_text'`,由开关推出。② harness 的隔离护栏原来在模块体里才设 `WECHAT_STATE_DIR`,而 `lib/config` 在 import 期就定下 STATE_DIR —— 挪到第一个 import(`scripts/experiments/reply-once/isolate.ts`),并按主机名只许打主人自建网关。
- 2026-10-03:§6 待主人定 → 已定(维护者按推荐定,主人授权);补备注:reply 路由不核对 chat_id 的越权已另一个 PR 单独修,附件工具不带 chat_id 的设计照旧。
- 2026-10-03:初稿。harness 与 2026-10-02 的 110 回合数据从 PR #196 搬入(`scripts/experiments/reply-once/`);dev 上 provider 还没有 `makeBuiltins` 注入口,harness 加了拒跑保护(§5.1 第 1 项把注入口加回来)。
