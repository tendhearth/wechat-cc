# 内部 API 鉴权模型(现状)

> 2026-09-27 首版。此前散在 architecture.md §2.2、maintainer/verify.md、rules-from-real-machines.md 和三份 spec 里,没有一处写「现在是什么样」。代码是唯一事实源:`src/daemon/internal-api/{token-registry,route-tiers,index}.ts`、`src/core/user-tier.ts`。设计依据:`superpowers/specs/2026-06-21-internal-api-tier-authz-design.md`。

## 谁在调

daemon 的内部 HTTP API 只监听 127.0.0.1,地址与 token 文件路径写在 `<stateDir>/internal-api-info.json`。调用方:

- 每个 agent 会话的 stdio MCP 子进程(wechat 工具),经环境变量拿 session token;
- 桌面 app,经 Tauri 宿主代理(`workbench_api` / `customer_review_api` / `agent_converse` 等 Rust 命令),webview JS 永远拿不到凭据;
- CLI 子命令,读 file token;
- 手机页 `/set` 与 `/m`,经 daemon 自己的 `/m/api/*` 分发器 —— **不走这套鉴权**,见末节。

## 两道门

1. **tier**:`guest < trusted < admin`(`src/core/user-tier.ts`)。每条路由在 `route-tiers.ts` 的 `ROUTE_MIN_TIER` 里声明最低档;**没登记的路由 ⇒ admin**(`minTierFor`,fail-closed)。`route-tiers.test.ts` 有一条「`makeRoutes` 的每条路由都必须登记」。
2. **routeAllow**:token 上可选的路由白名单;有就只许调白名单里的 `"METHOD /path"`,不看 tier。dispatcher 在 tier 之后再查(`index.ts`)。

## token 来源(`TokenInfo.origin`)

| origin | 谁拿 | tier | routeAllow | 存哪 |
|---|---|---|---|---|
| `file` | 任何能读 `<stateDir>/internal-token` 的本机进程(CLI、trusted agent 的 shell) | 固定 `trusted`:shell 可读的凭据不能高于最不可信的读者 | 无 | 文件 0600,每次 boot 轮换 |
| `session` | 每次 spawn 的 agent 会话,经 `WECHAT_SESSION_TOKEN` 环境变量 | 该会话的真实 tier;**不带 routeAllow 的 admin 只从这里来**(operator 也是 admin,但被路由白名单框住) | 无(例外:hearth federation mint 出来的 token 带 TTL + routeAllow) | 只在子进程 env。例外 `agy-static`:agy 只有全局 `~/.gemini/config/mcp_config.json`,所以 boot 时铸一枚长期 `trusted` token 写进那个文件;补偿控制是 `/agy` 拒 guest、solo+agy 在 dispatch 时再拒一次 |
| `operator` | 桌面 app 的 Tauri 宿主(`<stateDir>/internal-operator-token`) | `admin` | **有**:converse / speak / transcribe、customer-review 八条、待办五条、pet permission resolve、federation mint、workbench 全套、matters 四条(精确集合见 `token-registry.ts` 与 `token-registry.test.ts`) | 文件 0600;能读它的人已经是本机主人 |
| `link` | 微信里要来的设置链接(`/set?t=…`,`t` + 32 hex) | `admin` | **有**:`PHONE_ROUTES`(`src/daemon/phone-routes.ts`),只对手机面板生效 | 只在内存;10 分钟过期,同一时刻只一枚 |
| `device` | 配对过的手机(`d` + 48 hex,加主屏后一直用) | `admin` | **有**:同上 | `settings-devices.json`(0600,≤ 20 台);永不过期,可按台撤销 |

## 发送类路由的 chat 范围(2026-10-03 起;2026-10-04 收紧到 admin)

第三道门,只管**往某个 chat 发 / 改消息**的路由,只管 `session` 令牌。代码:`src/daemon/internal-api/send-scope.ts`(`SEND_SCOPED_ROUTES` + `sendScopeDecision`),在 dispatcher(`index.ts`)里 schema 校验之后、handler 之前执行 —— 被拒的请求碰不到 App 回复截流口(reply sink)、打猎旁听、分片和 ilink。

| 路由 | 目标 |
|---|---|
| `wechat/reply`、`reply_voice`、`send_file`、`edit_message`、`send_sticker`、`search_online_sticker`、`send_online_sticker_candidate`、`sticker_feedback` | 请求体 `chat_id` |
| `share/page` | 请求体 `chat_id`(决定「发 PDF 到微信」推给谁;不带就不设门) |
| `conversation/set-mode` | 请求体 `chatId`(切那个 chat 的模式,并往那里发「已切换」) |
| `wechat/broadcast` | 所有 chat |
| `wechat/message`(admin 级路由,回复交付 spec §4.6) | 请求体 `to`:`broadcast` ⇒ 所有 chat;`owner` ⇒ 不设门(路由自己解析成主人聊天);其余就是那个 chat_id |

规则:

- `session` 令牌(sessionKey = `provider/alias/chatId`):**所有档**(`guest` / `trusted` / `admin`)都只能以自己的 chat 为目标;broadcast 只许 `admin` 会话。非 admin 的 session 读不出 chat ⇒ 拒(fail closed)。
- **跨 chat 只有一条路:admin 专用的 `message` 工具**(`POST /v1/wechat/message`,`CROSS_CHAT_ROUTE`)。admin 会话经它发往别的 chat ⇒ 放行,记一条 `chat_scope_admin_cross`(本会话 chat、目标、路由)作审计;`to` 等于本轮聊天 ⇒ 路由自己报 `message_to_own_chat`(本轮要说的话写在最后,daemon 会发)。`message` 只注册给 admin 会话(wechat MCP 的 `SESSION_IS_ADMIN`),daemon 执行者里 openai / Cursor / Codex / Claude / gemini 的 owner 会话都有(`integration.test.ts` 逐家核对);agy 钉死 trusted,没有。
- **admin 会话用 reply 族 / share / set-mode 发往别的 chat ⇒ 403**,message 里明说什么都没发出去、并提示「去别的聊天用 `message` 工具」(`ADMIN_CHAT_SCOPE_MESSAGE`);日志 `chat_scope_denied`(`caller=admin`)。
- **历史与收紧依据**:#199(2026-10-03)起 admin 会话跨 chat 暂时放行 + 记 `chat_scope_admin_cross`,理由是主人会直接让 CC「帮我告诉某个访客……」而那时只有 reply 能做到。2026-10-04 `message` 已在每一家给 owner 会话的 daemon 工具表里 ⇒ 按计划收紧。收紧前核对过主人机器:#199 部署之后 `channel.log` / `channel.log.jsonl` 里 `chat_scope_admin_cross` 是 **0 行**(`chat_scope_denied` 也是 0),没有正在用的路被拦断。
- 代价(写明):回滚到 legacy 的那一家(agent-config `reply_delivery`)没有 `message` 工具(只在 daemon 工具表里注册)⇒ 回滚期间那家的 owner 会话没法往别的聊天发;主人可以自己在那个聊天里说、或用桌面 / CLI。
- 代码里的其它跨 chat 发送都不经过这些路由:提醒本来就按本 chat 限(`routes-reminders.ts`,任何档);社交 / A2A / 串门 / 主动关怀走各自路由或 daemon 内部直接调 ilink;App 通道的 sink 开在主人 chat 上、会话也是主人 chat 的;主动关怀推送会话按目标 chat 起。
- guest / trusted / admin 都写不进别的 chat 开着的 App sink。
- `file` / `operator` / `device` / `link` 令牌不受这道门影响(daemon 内部、CLI、桌面宿主;operator 本来就被 routeAllow 框住,够不着这些路由)。
- `agy-static`:所有 agy 对话共用这一枚 trusted 令牌,令牌里读不出「自己的 chat」。
  - agy 走 `legacy` / `shadow`(用 reply 工具说话):照旧放行。它与 trusted 的 file 令牌同级(同样落盘、同样跨对话),补偿控制仍是 `/agy` 拒 guest。
  - agy 走 `daemon` 交付(回复交付第 2 步,2026-10-03):**豁免取消**。agy 不再需要按 chat_id 发任何东西 —— 回复由 daemon 送达,语音 / 表情 / 文件是绑在本轮上的附件。dispatcher 把共享令牌绑到「agy 此刻正在跑的那一轮」的聊天(`ReplyDeliveryRuntime.turnChatFor('agy')`,`send-scope.ts` 的 `sharedTokenTurn`):这道门按 trusted 规则只放行那个聊天;没有 agy 轮在跑、或者同时有两轮(两个聊天)⇒ 读不出 ⇒ 拒;`/v1/turn/attach` 同样绑到那一轮,两轮并发时回 `ambiguous_turn`,绝不猜。
  - 仍然存在的(写明):① 绑定只用于这道门和附件路由 —— 记忆(`memoryScopeDenied`)、提醒(`routes-reminders.ts`)照旧只看令牌里的 chat,agy-static 读不出 ⇒ 这两类对 agy 一直是拒的(和第 2 步之前一样);② 令牌本身仍是落盘的长期 trusted 令牌(trusted agent 有 shell,能读到它),和 file 令牌同级;③ 两个聊天同时在跟 agy 说话时,附件挂不上(模型会收到 `ambiguous_turn`,文字照常交付)。
- 拒绝:403 `{ error: 'chat_scope', message }`,message 明说什么都没发出去;不回显被请求的 chat_id;本地日志记 `chat_scope_denied`(含本会话 chat 与目标)。
- 诚实的边界:对 `trusted` 会话这只是纵深防御 —— trusted agent 有 shell,能读 file 令牌(trusted、不限 chat)。真正被这道门挡住的是 guest 会话(没有 shell、拿不到 file 令牌)。
- wechat MCP 侧把模型给的 chat_id 原样转发,不替换成本会话的 chat(替换会把越界尝试藏起来);`integration.test.ts` 钉住了这一点。

新加一条往某个 chat 发消息、guest / trusted 够得着的路由:登记进 `SEND_SCOPED_ROUTES`,或在 `send-scope.test.ts` 的豁免表里写明理由。新加的路由默认就是「admin 也只许本 chat」;要让会话跨 chat,只能扩 `message`,不要再开第二条路。

## 新加一条路由要登记几处

- **桌面不调**:`routes-*.ts` 写 handler → `route-tiers.ts` 声明 tier →(若有请求体校验)`schema.ts`。
- **桌面会调**:再加 `token-registry.ts` routeAllow、`apps/desktop/workbench-proxy.ts` 的 `ROUTES`、`apps/desktop/src-tauri/src/lib.rs` 的 `workbench_request_allowed`。三份必须一致 —— `scripts/route-registry.guard.test.ts` 钉住 `lib.rs ⊆ proxy ⊆ routeAllow ⊆ ROUTE_MIN_TIER`(matter 四条例外:同一个 Rust 命令放行,但 dev 代理另有一路)。漏一处的症状:只在打包版出现 403 `route_not_allowed`。

## 这套鉴权之外的门(要知道)

- **手机的链接 / 设备令牌**(2026-09-29 起进了同一个 token-registry,见上表 `link` / `device`):面板经内部 API 的 `panelTokens` 窄接口登记与撤销,只认这两种 origin(内部 API 的 session / file / operator 令牌打不开面板)。路由门是 `PHONE_ROUTES`,不在册的路径 403 `route_not_allowed`;新加手机路由要登记在 `phone-routes.ts`,`scripts/phone-routes.guard.test.ts` 对着源码双向核对。经隧道(`_via=tunnel`)一律拒的操作是 `LAN_ONLY_OPS`:`set_remote`、`revoke_device`、`forget_devices`。面板仍监听 `0.0.0.0`(手机局域网直连,有意);`runtime/http.ts` 的 `serve()` 缺省改成 `127.0.0.1`。`/m/api/*` **没有**并进内部 API dispatcher(设计稿范围 B,未做)。
  - **协议 v2(2026-09-29)**:隧道握手 `{hs, v:[1,2]}` 协商,老后台/老页面仍走 v1;v2 两方向各一把密钥、计数器 nonce、拒绝重放。v2 上可 `sub` 订阅,主题白名单是 `PHONE_TOPICS`(`src/daemon/phone-routes.ts`:`home` / `approvals` / `agents` / `matter/<id>`),`phoneTopicAllowed` 判定;不在册的主题回 `err`。订阅与 `/m/api/*` 用同一枚令牌、同一套 origin 门。协议包见 `packages/protocol/README.md`。
- **admin session token 无 routeAllow**:主人 chat 的 MCP 子进程持有能调 `daemon/restart` 等全部 admin 路由的 token,只靠 LLM 侧的工具分类拦。已知、接受、待改。
- **file token 的 trusted 档约 90 条路由**,含 `memory/write`、`plugins/install`、`a2a/send`。
- **插件工具**:未知的 `mcp__*` 一律按 `plugin_tool` ⇒ admin-only(`user-tier.ts`;wxvault 那次修复就是这条)。
- **微信侧的 y/n 权限回话**只认被问的那个 chat(`ilink-glue.ts`)。
