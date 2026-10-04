# 回复交付:开关、回滚与排查

设计见 [`superpowers/specs/2026-10-03-reply-delivery-design.md`](../superpowers/specs/2026-10-03-reply-delivery-design.md),闸门数据见 [`reference/reply-once-experiment.md`](../reference/reply-once-experiment.md)。

## 每家 provider 一个开关

| 值 | 行为 |
|---|---|
| `legacy` | 今天的样子:模型调 `reply` 工具说话,没调就 FALLBACK_REPLY |
| `shadow` | 照旧 legacy;每轮另外算「按新路会发什么」,只记 `[REPLY_SHADOW] … match=…`,什么都不多发 |
| `daemon` | 一轮写下的文字由 daemon 送达(聊天型:全部文字段按顺序;编码型:最后一段);没有 reply 族工具,只有附件工具 + admin 的 `message` |

默认值写在代码里(各 provider 的 `ProviderCapabilities.replyDelivery`,读法 `capability-matrix.replyDeliveryFor`)。

现在(2026-10-03,以代码为准):openai `daemon`;agy `daemon`(第 2 步闸门两臂打平,合入时维护者按结构收益翻了,见下面「agy」一节);Cursor `daemon`(第 3 步,见下面「Cursor」一节);Codex `daemon`(第 4 步,见下面「Codex」一节);Claude `daemon`(第 5 步,见下面「Claude」一节)。**迁移序列的五家全部是 daemon**;只剩已 deprecated 的 gemini(API key 版)是 `legacy`。legacy 路径保留到收尾(spec §5.7 的观察期 + 删除清单)之前,回滚照下面一节。

## 不重新部署就回滚

在 `~/.claude/channels/wechat/agent-config.json` 里加(或改):

```json
{ "reply_delivery": { "openai": "legacy" } }
```

然后**重启 daemon**(不需要重新构建或 `self deploy`,只要重启进程):

```bash
launchctl kickstart -k gui/$(id -u)/com.wechat-cc.daemon
```

(macOS;同 [deploy.md](deploy.md) 的 restart 一步。)

- 覆盖优先于代码里的默认值;没写的 provider 照旧用默认值。
- 值只认 `legacy` / `shadow` / `daemon`,写错的那一项会被丢掉(其余照常生效)。
- **为什么要重启**:开关决定 wechat MCP 子进程注册哪套工具(`WECHAT_REPLY_DELIVERY=daemon`),这在开机时就定了;提示词、协调器、伙伴推送读的是同一个值,所以统一开机装一次,不做热加载(避免一半会话新、一半旧)。
- 生效确认:`channel.log` 开机有一行 `[BOOT] reply_delivery override (agent-config): openai=legacy`;之后 openai 的 `[TURN]` 行回到 `reply=…`(daemon 模式是 `delivery=… bubbles=…`)。

撤掉回滚:删掉这个键(或整个 `reply_delivery`),再重启。

## 排查

| 现象 | 看哪里 |
|---|---|
| 这家 provider 现在走哪条路 | 开机 `[BOOT] reply_delivery override` 行(没有 = 用代码默认值);`[TURN]` 行的 `delivery=`(daemon)或 `reply=`(legacy / shadow) |
| 主人收到了什么 | `[REPLY] … target= delivery= bubbles= attachments=`;`turn_records` 表的 delivery / bubbles / attachments 列 |
| 模型写了 NO_REPLY | `[REPLY_SILENT] kind=tick`(推送,正常);`[REPLY_SILENT_IN_DM]`(私聊,异常,计入连击) |
| 连着几轮什么都没交付 | `[PROVIDER_ANOMALY] … empty-reply streak=` |
| 第一条就发失败 | `[REPLY_DELIVERY_FAIL] sent=n/m`(不会再调模型) |
| shadow 的分布 | `[REPLY_SHADOW] … match=same / contains / differs / legacy_empty / shadow_empty` |

## 桌面 / 手机怎么显示(2026-10-04)

app 那一轮(桌面「跟 CC 说」、手机「跟 CC 说」)的接收器收下的是整个 `TurnReply`。显示链:

1. **投影**(`src/daemon/app-reply.ts`,`companionConverse` 里做一次):语音 `{kind:'voice', text}`;表情 `{kind:'sticker', label, file?}` —— 标签当场经表情库 `resolve` 成一张、只记文件名(桌面与手机看到同一张),联网表情(情绪 + 网址 / 搜索词)只有 label,daemon 不替 app 去外网取图;文件 `{kind:'file', name, path}`。旁白去空段、只留最后 20 段、每段 ≤ 4000 字。
2. **落库**:回复那一行的 `messages.extras`(v72,JSON,可空)。只有附件没文字的一轮也写这一行(text 为空)。旁白不另起行 —— 消息库的其它读者(线索抽取、交接、夜间记忆、搜索)只读 text,不会把旁白当成 CC 说的话。
3. **桌面**:`POST /v1/companion/converse` 回 `{ok, reply, attachments, narration}`,两个数组总在;本地表情多一个 `image`(data URI,≤ 1 MiB;桌面 CSP 只许 data: / blob: 图)。Rust `agent_converse` 把文件的 `path` 换成进程内一次性 `ref`(至多记 200 个),网页只能拿 ref 调 `reveal_reply_file`(`open -R`,只在访达里显示,不打开)。app 重开之后旧 ref 失效 ⇒ 提示去微信或文件夹里找。
4. **手机**:`GET /m/api/chat` 的回复消息多两个可选字段 `attachments` / `narration`(协议 `ChatMessage`;认不得的附件逐条丢);文件只给 `name`。语音 `GET /m/api/chat/voice?id=<消息 id>&i=<下标>`:只合成库里那一行第 i 个附件、且必须是语音;一帧装不下 ⇒ 413 `too_large`,没配朗读 ⇒ 422 `no_voice_config`。表情图走已有的 `GET /m/api/sticker/<file>?b64=1`。文件**没有**取文件的路由(有意不开)。

| 现象 | 看哪里 |
|---|---|
| 桌面 / 手机没显示附件 | 这一轮的 provider 是不是 daemon(legacy 的附件仍直接发微信);库里 `SELECT extras FROM messages WHERE id LIKE 'app:%:out' ORDER BY ts DESC LIMIT 1` |
| 表情只显示「表情 · xx」 | 联网表情(正常);或本地表情的文件被删了 / 超过 1 MiB(桌面)/ 取图失败(手机) |
| 手机点语音说「到电脑上听」 | 413 `too_large`:合成出来的声音装不进中继一帧 |
| 桌面点「在访达中显示」说找不到 | 文件被挪走(`reply_file_missing`),或 app 重开过(`reply_file_unknown`) |

## agy(第 2 步,2026-10-03)

agy 是外部 CLI,**只读一份静态的全局 MCP 配置** `~/.gemini/config/mcp_config.json`(条目 `wechat-cc-wechat`,所有 agy 对话共用一枚 trusted 令牌 `agy-static`)。所以它的工具表不是每轮按 provider 传进去的,而是 daemon 开机时写进那个文件的:

- 开机 `wirePlugins` 先装 `reply_delivery` 覆盖,再造 `wechatStdioMcpSpec(…, 'agy')`;agy 是 `daemon` ⇒ 条目的 `env` 里带 `WECHAT_REPLY_DELIVERY=daemon`,`setupAgyGlobalMcp` 把它写进文件(内容变了才写)。agy 每一轮都是新进程、启动时读这个文件 ⇒ **重启 daemon 之后的下一轮**就是新工具表。翻回 `legacy` 同理,条目里这个变量被去掉。
- 核对 agy 真的看到了什么:`grep WECHAT_REPLY_DELIVERY ~/.gemini/config/mcp_config.json`(daemon 模式有、legacy 没有);agy 自己的工具缓存 `~/.gemini/antigravity-cli/mcp/wechat-cc-wechat/` 里应当有 `voice.json` / `sticker.json` / `attach_file.json`(看 mtime:旧的 `reply.json` 可能还留着,agy 不一定清)。`src/mcp-servers/wechat/integration.test.ts` 用文件里写出的 env 起子进程核对过工具表;沙盒 harness 用真 agy 列过一遍(见 `reference/reply-once-experiment.md`)。
- **附件绑到本轮**:`agy-static` 令牌里没有 chat。daemon 模式下 dispatcher 把它绑到「agy 此刻正在跑的那一轮」的聊天(`ReplyDeliveryRuntime.turnChatFor('agy')`):`/v1/turn/attach` 挂到那一轮;发送类路由按 trusted 规则只许那个聊天(#199 的共享令牌豁免在 daemon 模式下取消)。没有 agy 轮在跑 ⇒ `no_turn_in_progress` / 403 `chat_scope`;两个聊天同时在跑 agy ⇒ `ambiguous_turn`(不猜,文字照常交付)。规则全文见 `reference/internal-api-auth.md`。
- 代码默认是 `shadow`(照旧 reply 工具 + `[REPLY_SHADOW]` 比对)。试 daemon:`{ "reply_delivery": { "agy": "daemon" } }` + 重启 daemon;回滚:删掉这一项(或写 `legacy`)再重启 —— 开机会把全局配置里的条目改回 reply 工具表。

| 现象 | 看哪里 |
|---|---|
| agy 想发语音却没发出去 | 工具回执 `ambiguous_turn`(两个聊天同时在跟 agy 说话)或 `no_turn_in_progress`;`[REPLY] … provider=agy … attachments=` |
| agy 的共享令牌被拒 | `[INTERNAL_API] 403 … chat_scope own=-(agy-static turn=none|ambiguous)` |

## Cursor(第 3 步,2026-10-03)

Cursor 走 ACP:每个会话一个常驻 `cursor-agent acp`,wechat MCP 是**逐会话**注入的(`session/new` / `session/load` 的 `mcpServers`,带会话令牌与 tier,`acpMcpServersFor`)。所以它和 agy 不一样,没有静态配置要改写:

- **工具表**:`wechatStdioMcpSpec(…, 'cursor')` 按开关带 `WECHAT_REPLY_DELIVERY=daemon`,`acpMcpServersFor` 原样放进会话的 env ⇒ 子进程不注册 reply 族,只有 `voice` / `sticker` / `attach_file`,owner(admin)会话另有 `message`。`src/mcp-servers/wechat/integration.test.ts` 用会话 env 起子进程核对过;翻回 legacy,reply 工具回来。开关开机定 ⇒ **重启 daemon 之后新起的会话**才是新工具表(常驻进程随重启一起换)。
- **附件**:会话令牌里有 chat,`/v1/turn/attach` 直接挂到本轮,不需要 agy 那种「按本轮绑定」。
- **最后的话**:编码型,`replyText: 'last_segment'` —— 最后一段非空文字是回复,之前的段是旁白(不进微信;一轮超过 120 秒 daemon 发一句进度;桌面 / 手机显示全部旁白)。messages 模式下 ACP 翻译器每遇到 tool_call 冲一段,`end_turn` 冲最后一段;被取消的轮不冲(不产回复);额度用完那句当错误收尾,只发通知。
- **Cursor SDK 兜底**(没装 cursor-agent、有 `CURSOR_API_KEY` 时的 `cursor-agent-provider.ts`)注册在同一个 `cursor` id 下,吃同一个开关、同一份 wechat MCP spec。
- 回滚:`{ "reply_delivery": { "cursor": "legacy" } }` + 重启 daemon。

| 现象 | 看哪里 |
|---|---|
| 主人只收到过程话、没收到结论 | 模型把结论写在了中间、最后又补了一句 —— `[TURN]` 的 `delivery= bubbles=` 与 `turn_records.narration_segments`;桌面那一轮的旁白里能看到结论。真模型闸门还欠着(额度),见 `reference/reply-once-experiment.md`「第 3 步」残留 |
| 一轮很长、主人收到一句进度 | `[REPLY_PROGRESS] … provider=cursor`(一轮最多一次,用最近一段旁白) |
| 收到一句 Cursor 自己的报错(「Agent Looping Detected」之类) | 2026-10-03 起 ACP 边界认 cursor-agent 的固定写法(本轮最后一整块 `\n\n…`),带码当错误收尾,只发通知;TurnRecord 看 `error` / `error_code`。还收到原文 ⇒ cursor-agent 换了句式,按 `reference/provider-error-shapes.md` §8 的位置重新核对 |
| 语音没发出去 | strict 权限下 ACP 的权限卡全拒 ⇒ 附件工具调不成(文字照常交付);`[REPLY] … attachments=0/0` |

## Codex(第 4 步,2026-10-03)

Codex 对话侧每一轮是一次 `codex exec`(`@openai/codex-sdk` 的 `runStreamed`;工作台的 app-server 不归这里管)。wechat MCP 是 provider 构造时的 spec,**每次 spawn** 把会话 env(令牌 + tier)合进去,经 SDK 的 config(`--config mcp_servers.wechat.*`)交给 codex:

- **工具表**:`wechatStdioMcpSpec(…, 'codex')` 按开关带 `WECHAT_REPLY_DELIVERY=daemon` ⇒ 没有 reply 族,只有 `voice` / `sticker` / `attach_file`,owner(admin)会话另有 `message`。`src/mcp-servers/wechat/integration.test.ts` 走完整链(spec → spawn 的 config → 起子进程 → tools/list)。开关开机定,codex 每轮新起 exec ⇒ **重启 daemon 之后的下一轮**就是新工具表。
- **附件**:会话令牌里有 chat,`/v1/turn/attach` 直接挂到本轮。
- **最后的话**:编码型 `last_segment` —— 一轮最后一条非空 agent_message 是回复;之前的(codex 调工具前总会先写一句开场,「我查一下当前登记的项目。」)是旁白,不进微信;一轮超过 120 秒 daemon 发一句进度。分段边界:不是消息 / 思考 / 非致命 error 的 item 都算一次工具调用(shell、改文件、搜索、计划、SDK 不认识的新 item 类型都算);每条 agent_message 自成一段。
- **出错**:`turn.failed` / 流级 error / 边界超时只发通知(#197 的码),不交付残文;`turn.completed` 之后 exec 才非零退出不算出错;非致命 error item 只记 `CODEX_ITEM_ERROR`。
- 回滚:`{ "reply_delivery": { "codex": "legacy" } }` + 重启 daemon。

| 现象 | 看哪里 |
|---|---|
| 主人只收到一句「我查一下…」 | 不该发生(那是旁白)。看 `[TURN]` 的 `tools=` 有没有工具把它和结论隔开、`turn_records.narration_segments`;以前 shell 不产 tool_call 时就是这个形状 |
| 语音 / 表情没发出去 | daemon 不是 `--dangerously`(strict)时 codex 拒掉所有 MCP 调用(「MCP tool call requires approval, but approval policy is never」),附件挂不上,文字照常交付;`[REPLY] … attachments=0/0` |
| 私聊里一轮什么都没发 | codex 对「不用回」常写一条**空**消息 ⇒ `delivery=empty`,计入 `[PROVIDER_ANOMALY] … empty-reply streak=` |
| 每轮都 400「model is not supported when using Codex with a ChatGPT account」 | 版本耦合,不是回复交付:CLI 太旧、拿不到配置的模型(2026-10-03 沙盒里 CLI 0.153.4 + `gpt-6.1-sol` 就是这样) |

## Claude(第 5 步,2026-10-03)

Claude 对话侧是一个常驻的 Agent SDK `query()`(流式输入,一轮一条 user 消息)。wechat MCP 是开机造的 `wechatStdioMcpSpec('claude')`,每次 spawn 由 `sdkOptionsForProject` 把会话 env(令牌 + tier)合进 SDK 的 `mcpServers.wechat`:

- **工具表**:按开关带 `WECHAT_REPLY_DELIVERY=daemon` ⇒ 没有 reply 族,只有 `voice` / `sticker` / `attach_file`,owner(admin)会话另有 `message`(`integration.test.ts` 走 `wireModelOptions` 的完整链核对过)。开关开机定 ⇒ **重启 daemon 之后新起的会话**才是新工具表。续接的旧会话第一轮模型可能照旧去调 reply(「No such tool available」),然后把话写在最后 —— 剧本臂场景 b 演过。
- **附件**:会话令牌里有 chat,`/v1/turn/attach` 直接挂本轮。扇出(/chat、/both)里 `canUseTool` 拒 `message`(以前拒 reply 族),附件工具不拦。
- **最后的话**:编码型 `last_segment`。provider 两处修正:① 事件**按内容块的顺序**发(以前同一条消息里先发 tool_call 再发拼起来的文字,「我先看看」被算进工具之后的段);② 子 agent(Task,`parent_tool_use_id`)的文字不进任何一段,只记 `CLAUDE_SUBAGENT_TEXT`。真 Claude Code(2.1.289)每个内容块单独一条 assistant 消息,22/22 轮核对过。
- **SDK 的 `result.result`**:只在成功轮作为 `result.finalText` 带出来,**只用来核对**(真跑 22/22 与分段一字不差);交付永远用分段。对不上记 `[REPLY_FINAL_CHECK] … match=differs`。出错轮(`is_error` / SDK `error` 标注)的 `result.result` 是错误原文,从不带出;只有 `is_error` 没有标注的那种,provider 补一个 `provider_error` 码的 error,只发通知。
- 回滚:`{ "reply_delivery": { "claude": "legacy" } }` + 重启 daemon(`reply-tool-bridge.e2e.test.ts` 钉着回滚后的两条旧契约)。

| 现象 | 看哪里 |
|---|---|
| 主人只收到「我先看看…」,没收到结论 | 不该发生。看 `[TURN]` 的 `tools=` 有没有把它和结论隔开、`turn_records.narration_segments`;有 `[REPLY_FINAL_CHECK] match=differs` ⇒ 分段和 SDK 自己的定义对不上,按 `reference/reply-once-experiment.md`「第 5 步」重新核对 SDK 的消息形状 |
| 收到子 agent 的过程话 | 不该发生(`parent_tool_use_id` 的文字不进回复)。`channel.log` 的 `CLAUDE_SUBAGENT_TEXT` 说明子 agent 说过话、被挡住了 |
| 收到一句 API 报错原文 | 不该发生(#190 红线)。`CLAUDE_API_ERROR` 行;`turn_records.error_code` |
| 私聊里一轮什么都没发 | Claude 很少写 `NO_REPLY`(真跑「不用回」2/2 回了一句轻的);若写了 ⇒ `[REPLY_SILENT_IN_DM]`,计入连击 |
