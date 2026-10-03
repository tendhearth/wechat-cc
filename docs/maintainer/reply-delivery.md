# 回复交付:开关、回滚与排查

设计见 [`superpowers/specs/2026-10-03-reply-delivery-design.md`](../superpowers/specs/2026-10-03-reply-delivery-design.md),闸门数据见 [`reference/reply-once-experiment.md`](../reference/reply-once-experiment.md)。

## 每家 provider 一个开关

| 值 | 行为 |
|---|---|
| `legacy` | 今天的样子:模型调 `reply` 工具说话,没调就 FALLBACK_REPLY |
| `shadow` | 照旧 legacy;每轮另外算「按新路会发什么」,只记 `[REPLY_SHADOW] … match=…`,什么都不多发 |
| `daemon` | 一轮写下的文字由 daemon 送达(聊天型:全部文字段按顺序;编码型:最后一段);没有 reply 族工具,只有附件工具 + admin 的 `message` |

默认值写在代码里(各 provider 的 `ProviderCapabilities.replyDelivery`,读法 `capability-matrix.replyDeliveryFor`)。

现在(2026-10-03):openai `daemon`;agy `shadow`(第 2 步接线完成,闸门两臂打平,见下面「agy」一节);其余 `legacy`。

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
