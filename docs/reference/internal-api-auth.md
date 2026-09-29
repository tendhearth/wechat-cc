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

## 新加一条路由要登记几处

- **桌面不调**:`routes-*.ts` 写 handler → `route-tiers.ts` 声明 tier →(若有请求体校验)`schema.ts`。
- **桌面会调**:再加 `token-registry.ts` routeAllow、`apps/desktop/workbench-proxy.ts` 的 `ROUTES`、`apps/desktop/src-tauri/src/lib.rs` 的 `workbench_request_allowed`。三份必须一致 —— `scripts/route-registry.guard.test.ts` 钉住 `lib.rs ⊆ proxy ⊆ routeAllow ⊆ ROUTE_MIN_TIER`(matter 四条例外:同一个 Rust 命令放行,但 dev 代理另有一路)。漏一处的症状:只在打包版出现 403 `route_not_allowed`。

## 这套鉴权之外的门(要知道)

- **手机的链接 / 设备令牌**(2026-09-29 起进了同一个 token-registry,见上表 `link` / `device`):面板经内部 API 的 `panelTokens` 窄接口登记与撤销,只认这两种 origin(内部 API 的 session / file / operator 令牌打不开面板)。路由门是 `PHONE_ROUTES`,不在册的路径 403 `route_not_allowed`;新加手机路由要登记在 `phone-routes.ts`,`scripts/phone-routes.guard.test.ts` 对着源码双向核对。经隧道(`_via=tunnel`)一律拒的操作是 `LAN_ONLY_OPS`:`set_remote`、`revoke_device`、`forget_devices`。面板仍监听 `0.0.0.0`(手机局域网直连,有意);`runtime/http.ts` 的 `serve()` 缺省改成 `127.0.0.1`。`/m/api/*` **没有**并进内部 API dispatcher(设计稿范围 B,未做)。
- **admin session token 无 routeAllow**:主人 chat 的 MCP 子进程持有能调 `daemon/restart` 等全部 admin 路由的 token,只靠 LLM 侧的工具分类拦。已知、接受、待改。
- **file token 的 trusted 档约 90 条路由**,含 `memory/write`、`plugins/install`、`a2a/send`。
- **插件工具**:未知的 `mcp__*` 一律按 `plugin_tool` ⇒ admin-only(`user-tier.ts`;wxvault 那次修复就是这条)。
- **微信侧的 y/n 权限回话**只认被问的那个 chat(`ilink-glue.ts`)。
