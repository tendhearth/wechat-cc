# 网络守护(bx 优先)

> 2026-10-02 主人拍板:**不经隧道、直连模型供应商可能让账号被封。** 网络守护的职责是:网络没受保护时,CC 不发出任何一次模型调用。

## 防什么,不防什么

**防:** 隧道没起来 / 掉了 / bx 被关掉的那段时间里,CC 自己**主动**直连模型供应商(Anthropic / OpenAI / Google / Cursor / Kimi 这类网关,以及带账号的语音服务)。

**不防:**

- **泄漏取证。** 「之前有没有漏过」「WebRTC / IPv6 / DNS 有没有绕开隧道」归 bx 管:在终端跑 `bx leakcheck`。守护不重做这件事。
- **已经在跑的外部进程。** 主人自己在终端开的 `claude` / `codex`、`wechat-cc memory …` 这类一次性 CLI 命令不经 daemon,守护拦不到(见下文「刻意不拦」)。
- **bx 本身的 fail-closed。** 隧道不健康时 bx 自己会把流量堵住;守护是在它之上再加一道:**bx 没在保护,CC 就不出门**,而不是指望流量撞墙。

## 信号:装了 bx 就以 bx 为准

| 情形 | 判据 | 安全吗 |
|---|---|---|
| 装了 bx(`/usr/local/bin/bx` 或 `/opt/homebrew/bin/bx`) | `bx status --json` 里 `protection_state == "protected"` **且** `tunnel_healthy == true` | 两项都满足才安全 |
| 装了 bx,但读不出来 | 进程起不来 / 超时(6s,bx 自己的观测封顶是 5s)/ 非零退出(bx 没在跑时 `--json` 直接报错)/ 不是 JSON / 缺字段 / 类型不对 | **不安全**(fail closed) |
| 没装 bx | 旧逻辑:每 30s 查公网 IP(ipify),IP 变了 HEAD 一次 google `generate_204`;**不通期间每拍再探一次**(恢复不必等换 IP,也给下面停执行者的防抖第二次读数) | 探得通才安全 |
| `guard.json` 里 `enabled: false` | 不判 | 放行(开关语义不变) |

`protection_state` 的六个值是 bx 的对外契约(`internal/protectionstate`):`off / starting / recovering / protected / blocked / needs_attention`,只有 `protected` 算数。

调度器(`src/daemon/guard/scheduler.ts`)在 bx 模式下每 10s 读一次 bx(本机 socket,只读,实测约 70ms,不发任何外网流量);公网 IP 仍按 30s 查,换 IP 的那一拍紧接着读 bx,等于立即复判。闸门(`gate.ts`)优先用调度器 30s 内的读数;调度器还没跑第一拍、或读数过期,就当场读一次(单飞 + 5s 短缓存,不会因为并发调用把 bx 刷爆)。

## 拦在哪里(choke points)

所有拦截共用一个契约 `src/lib/network-gate.ts`:`NetworkGate.check()`、统一文案 `unprotectedMessage()`、错误 `NetworkUnprotectedError`(`code: 'network_unprotected'`)。daemon 侧在 `src/daemon/guard/runtime.ts` 建一份,`main.ts` 一开始就建好,往下传。

| 位置 | 覆盖的表面 | 不安全时 |
|---|---|---|
| `ConversationCoordinator.dispatchInner`(`src/core/conversation-coordinator.ts`) | 微信入站、桌面「跟 CC 说」、手机 `/m/api/chat/say`、`/both` `/chat` 全部模式 | 不 acquire 会话,用 `sendAssistantText` 回一句统一的话(按 reply sink 落到发起的那一面),不重试 |
| 微信入站中间件 `mw-guard`(`src/daemon/inbound/mw-guard.ts`) | 微信入站(比协调器更早,连 y/n 权限回话也一并挡住) | 回「🛑 网络未受保护(…),CC 先暂停，恢复后再试。」 |
| `ProviderRegistry.register` → `withNetworkGate`(`src/core/provider-registry.ts`) | **所有**从 registry 拿 provider 的调用:`spawn` / `cheapEval` / `strongEval` / `modelCatalog`。包括 SessionManager、自检、llm-health 拨测、所有后台便宜模型判断(社交判官、心愿、披露闸门、计划、内省、摄取、回忆、手机解释/进度、管家指称) | 抛 `NetworkUnprotectedError`;cheapEval 故障转移在挑候选之前先问,**不给任何候选记冷却** |
| `SessionManager.spawn` 与 `handle.dispatch`(`src/core/session-manager.ts`) | 绕开协调器的会话调用(陪伴推送 / 打猎 / 议程的 `dispatchToChat`) | 抛错,不起子进程 / 不发请求 |
| delegate(`src/daemon/bootstrap/delegate.ts`) | `primary_tool` 的 peer、A2A 委派 —— 它们自建 provider、不进 registry | 同上,单独套 `withNetworkGate` |
| 工作台 `execute()` / `submitInput()`(`src/core/workbench/service/*`)+ 工作台自己的 registry | claude / codex / cursor ACP / agy / openai API 执行者的起步、续接、补充 | 任务以 `network_unprotected` 失败,事件里一句人话;补充返回 503 `network_unprotected` |
| **已经在跑**的工作台执行者(`lifecycle-deps.ts` 的 `onReading` + `guard/pause-policy.ts`) | 起来以后自己调模型的执行者进程,闸门拦不到 | **信号来自 bx:不停。** bx 是 fail-closed,隧道一断在跑的进程本来就出不去,不会漏;停掉不会更安全,bx 自动恢复那十来秒的波动反而会杀掉跑了很久的任务 —— 只拦新的启动 / 续接 / 补充。**信号来自老的 probe**(没装 bx,不保证 fail-closed):**连续两次**读到不安全才停在跑 / 排队的任务(每段不安全期只停一次,之后可「继续」) |
| 网络翻成不安全的那一刻(`onStateChange`) | 对话会话 | 关闭所有对话会话(原有行为;下一条消息会续接,代价小) |
| 工作台额度查询(`wire-workbench.ts`) | `api.anthropic.com/api/oauth/usage`、codex app-server 限额 —— 带账号凭据直连供应商 | 返回 null,不出门 |
| `cli-reply-handler.ts` 的 `resume` | 微信「@码 文本」、手侧 A2A `/a2a/cli/reply` 起的 `claude -p --resume` / `codex exec resume` | 不起 CLI,回「没跑起来(网络未受保护…)」 |
| 语音 `gateVoice`(`src/daemon/ilink/voice.ts`) | TTS(自建网关 / 通义 dashscope)、STT、两个配置探测 | 不出门;`replyVoice` 返回 `ok:false` 带统一文案 |
| 后台定时任务 `skipWhenUnsafe` | companion push / introspect / ingest 三个调度器;每晚整理记忆 | **安静跳过**这一拍,同一段不安全期只记一行日志,下一拍再看;记忆整理返回 `skipped: network_unprotected`,**不记** `failed_today` |

## 刻意不拦

- **本地推理:** 嵌入(transformers.js / python embed-runner,本机算,不出门)、atelier 本地 sd-cli 渲染。首次下载权重(HuggingFace)不带模型账号,不算。
- **非模型流量:** 微信 ilink、中继、A2A、邮箱轮询、ipify / google 探测本身、R2 更新源。这些不是模型供应商账号;微信走 bx 的直连规则本来就是设计内的。
- **CLI 一次性命令:** `wechat-cc memory …` / `wechat-cc sessions …` 在 CLI 进程里直接调 SDK —— 那是主人在终端前手动发起的,和他直接敲 `claude` 同一个性质。`wechat-cc guard status` 会照实告诉他此刻是否受保护。
- **已经起来的进程中途:** 守护只能在出发前拦。bx 来源下在跑的工作台执行者不停 —— 它们的流量由 bx 的 fail-closed 兜住;probe 来源下连续两次不安全才停。对话会话翻到不安全时照旧关闭。已经发出的那一个请求拦不回来。

## 看得见

- `GET /v1/health` 多一个 `guard` 块:`{ enabled, source: 'bx'|'probe'|'off', safe, detail, ip, checked_at }`。
- 桌面「此刻」页连接区一行:`bx 保护中`(绿)或 `⚠ 网络未受保护，CC 暂停(原因)`(红,悬停提示可跑 `bx leakcheck`);守护关着不显示。设置抽屉里「网络守护」那一行同样以 bx 为准。
- `wechat-cc guard status [--json]`:装了 bx 且守护开着时输出 `source: bx`、`safe`、`detail`、`bx_path`,不再探 google。
- 日志 tag `GUARD`:状态翻转、每个被拒的回合、每个被跳过的后台任务(每段一次)。

## 怎么验

```bash
bx status --json | jq '{protection_state, tunnel_healthy}'   # 只读,本机 socket
wechat-cc guard status                                        # 应显示 bx: protected — bx 保护中
# /v1/health 的 guard 块:用 file token 读(端口与 token 文件见 ~/.claude/channels/wechat/internal-api-info.json,
# 口径同 maintainer/deploy.md 的健康门);或者直接看桌面此刻页那一行。
```

不要为了验证去 `bx down`、`bx setup`,也不要跑任何会把流量送出隧道的检查(例如 `bx leakcheck --compare-direct`)。断网路径由单测覆盖:`src/daemon/guard/*.test.ts`(bx JSON 各种形状、超时、fail closed、没装回退)、`src/core/provider-registry.network-gate.test.ts`、`src/core/conversation-coordinator.test.ts`(network gate 一节)、`src/core/session-manager.test.ts`、`src/core/workbench/service-network-gate.test.ts`、`src/daemon/ilink/voice-gate.test.ts`、`src/daemon/cli-reply-handler.test.ts`、`src/daemon/memory/nightly.test.ts`、健康路由与桌面渲染测试。测试里永远注入执行器,单测进程下 `findBx()` 不认真的 bx。
