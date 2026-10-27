# `__e2e__/` — daemon 端到端测试

起**真的** daemon(`bootDaemon`,和 `main.ts` 同一条开机路),只把系统边界换成替身:微信 ilink、模型 SDK、外网。
32 个文件 / 51 条(2026-10-27),本机全量约 40 秒。

```bash
bun run test:e2e        # 全部(= bun --bun vitest run -c vitest.e2e.config.ts)
bun run test:sandbox    # 只跑真实形状沙盒(几秒;bun run verify 每次都跑它)
```

## 真实形状沙盒(real-shaped sandbox)

`harness.ts` 的缺省是一台**最小**的 daemon:知识库、社交、配对、手机中继、网络守护……这些可选子系统全是关的。
可选子系统「开着才走」的那几行代码,最小 daemon 一行都走不到 —— 2026-10-26 #729 在 boot-api 的
`if (boot.knowledge)` 里加了 `ctx.late('wired')` 却没写进 `lazy`,单测和 CI 全绿,真机开机三连败、自动回滚(#733 修)。

`real-shaped.ts` 的 `startRealShapedDaemon()` 起的是**照主人真机配置**的 daemon,`real-shaped-sandbox.e2e.test.ts`
从开机一路走到重启:

| 场景 | 断言的是看得见的什么 |
| --- | --- |
| 开机 | `/v1/health` 的每个子系统都是 ok(专门开上的那十几样一个不少);日志里没有 `[MODULES] … failed / degraded`;网络守护探到替身、判安全;手机隧道连上替身中继并登录;没有不在名单里的往外请求 |
| 主人发一句 | 回复落进假 ilink 的外发箱,只一条 |
| 记忆 | 开机把记忆文件(`memory.md` / `owner.md` / `corrections.md`)和旧的 `knowledge/facts.db` 导进主库(`memory_facts` 有行、facts 7 条、`memory_import` 记了两个对话);会话的提示词里有主人的长期记忆和原话 |
| 拍板卡 | 主人发 `/codex` 切到 Codex,要跑 `rm -rf build` ⇒ 卡片发到主人微信,主人回 `y` ⇒ 命令放行(app-server 收到 accept) |
| 关机再开机 | 正常关机没有哪一步停失败;同一个 stateDir 再开机:不重复导入、照样健康、没有模块坏、对话模式留住了、照样收发 |

**红 / 绿实证**:把 boot-api(当时在 `daemon-modules.ts`,现在 `bootstrap/module.ts`)的 `lazy: ['wired'],` 删掉,沙盒在 `beforeAll` 就红
(`boot-api failed at init (required): modules: 'boot-api' called ctx.late('wired') but 'wired' is not in its lazy`),
而其余 31 个 e2e 文件照样全绿。加回去就绿。

### 开了什么

| 配置 | 沙盒里 | 替身 |
| --- | --- | --- |
| 主人 | `access.json` 唯一 admin、`companion/config.json` 的 `default_chat_id`、bot 的 `userId`、有 context_token | — |
| 主动关心 / 信 / 每晚整理 / 工作室 | `companion.enabled`、`letters_enabled`、`memory_nightly_enabled`、`atelier_mode: private` | 模型 = fake-sdk |
| 知识库 | `knowledge_enabled`,记忆夹具(`src/test-support/fixtures/memory/`)+ 由 `facts.json` 造的 `facts.db` / `graph.db` | 嵌入子进程 = stateDir 里一份假的 python 脚本(同一个 JSONL 协议,不下模型) |
| 社交 / 笔友信箱 / 配对 | `social_enabled` + 披露策略、`mailbox_relays` | `fake-boundaries.ts` 的内存信箱中继(`/drop` `/fetch` `/ack`) |
| A2A 服务、乙 hub | `a2a_listen`、`yi_hub_listen`(本机空端口) | — |
| 出门也能用 | `remote_tunnel` + `relay_v2_url` | 手机中继 v2 的 daemon 侧(WebSocket:challenge → login_ok) |
| 网络守护 | `guard.json` 开着、`signal_source: probe` | 探测 / 出口 IP 打本机替身 |
| 语音 | `voice-config.json`(http_tts) | 本机替身 |
| 空闲自动重启 | `WECHAT_CC_SUPERVISED=1`(真机由 launchd 带上) | `process.exit` 被接住、记一行,不退测试进程 |
| CLI 自动升级 | 缺省开着(真机也是) | — |

**网络围栏**:沙盒期间 `fetch` / `WebSocket` 只放行本机地址,往外的当场失败并记下来。测试里有一张 `KNOWN_OUTBOUND`
名单(真机本来就会打、沙盒拦下的;现在是空的),名单外的往外请求 = 红。

### 没开的,以及为什么

| 没开 | 为什么 |
| --- | --- |
| 日历 | 读日历走 JXA / EventKit,在开发机上会弹系统权限框(TCC),而且只有 macOS 有 |
| wxvault / wxsearch 插件、导入本机微信历史 | 要 python venv + 「完全磁盘访问」+ 真的微信数据;知识库的源数据目录在沙盒里是空的(日志里那行 `skipping missing/unreadable contact.sqlite` 是这个) |
| hearth | 要外部 CLI(`hearth_cmd`)和一个 vault |
| bx(网络守护的主信号) | 本机工具;`findBx` 在测试进程里永远当没装(`src/daemon/guard/bx.ts`),所以守护走探测 |
| 测试进程里的代码分叉 | `UNDER_TEST_RUNNER` 时有几处和真机不一样:cheapEval 网络预检不接、守护闸门自己不探测、agy / cursor-agent 不在 PATH 上找(`src/lib/config.ts` 的 `UNDER_TEST_RUNNER`,用到它的地方 grep 得到) |
| 外部 CLI 的版本探测 | `claude --version` / `codex --version` 是真的跑(本机,不出网);CI 上没装 claude 就探不到 |
| 自改流水线、桌面 app、真 iPhone | 不在 daemon 进程里;各有自己的验证(`docs/maintainer/self-change.md`、`docs/maintainer/verify.md`) |

提醒、定时任务、回报投递是开着的(模块 ok),但沙盒里没有预置的提醒 / 任务行。

**加新的可选子系统 / 配置开关时**:在 `real-shaped.ts` 的 `writeConfig` 里照真机把它开上。缺省 off 的新模块会让开机那条红
(`ALLOWED_NOT_OK` 是空的);真开不了,就在那张表里写清为什么,同时补到上面「没开的」。

## 替身

- **`fake-ilink-server.ts`** — 假 ilink(`getupdates` / `sendmessage` / `sendfile` / `getconfig` / `sendtyping`),真的线上格式;`waitForOutbound(predicate)` 等外发。
- **`fake-sdk.ts`** — Claude Agent SDK、Codex app-server(剧本)、Cursor SDK 的替身。测试给一份 `FakeSdkScript`,`onDispatch(text)` 返回工具调用和最终文字;Codex 还能给 `codexSteps`(比如一次审批请求)。
- **`fake-media.ts`** — 图片入站落成本地 3 字节的桩文件,不碰 CDN。
- **`fake-boundaries.ts`** — 沙盒用的:外网(探测 / ipify / TTS)、信箱中继、手机中继、网络围栏、空端口。
- **`harness.ts`** — `startTestDaemon(opts)`:临时 stateDir + 上面这些替身 + `bootDaemon`。`stateDirOverride` 给「同一个目录开两次机」的重启测试用。
- **`real-shaped.ts`** — `startRealShapedDaemon(opts)`:在 harness 之上把 stateDir 播种成真机的样子,另给 `health()` / `moduleProblems()` / `log()` / `query()`。

## 现有的测试(按主题)

- 收发与派发:`inbound-reply`、`dispatch-solo-{claude,codex,cursor}`、`dispatch-parallel-both`、`dispatch-primary-tool`、`dispatch-chatroom-{text,image}`、`dispatch-image-solo`、`reply-tool-bridge`、`messages-record`、`threads-extract`
- 命令与模式:`command-routing`(路由快照)、`mode-switch`、`restart-mode-persistence`
- 权限与分档:`user-tier`、`user-tier-codex`、`user-tier-cursor`、`internal-api-tier-authz`、`codex-chat-approval`(拍板卡、放行规则、红线)
- 访客与准入:`access-gate-drop`、`guest-path`、`onboarding-restart`
- 开机 / 关机 / 自愈:`degraded-boot`、`boot-failure-lock`、`shutdown-order`(关机顺序快照)、`turn-timeout-watchdog`、`self-heal-model-switch`、`self-heal-session-release`、`outbound-health`
- 手机页:`mobile-workbench`(Playwright 驱动真页面)
- 真实形状:`real-shaped-sandbox`

## 已知的坑

- `config.ts` 的 `STATE_DIR`、`log.ts` 的 `channel.log` 路径在 import 时定死:同一个测试文件里第二个 daemon 的日志写进第一个的目录。要读日志就用沙盒的 `log()`(从 stderr 抓的),或像 `shutdown-order` 那样一个文件只起一台。
- 本机账号凭据是系统边界:`fake-credentials.ts`(harness 副作用 import)把 `src/adapters/executors/claude/claude-oauth-credential.ts` 换成「没有凭据」。以前开发机上有 Claude Code 登录时,工作台的订阅额度监视器会拿开发者自己的凭据真连 Anthropic 的 usage 接口(沙盒的围栏抓到的)。

## 调试

```bash
E2E_DEBUG_ILINK=1 bun run test:e2e     # 假 ilink 的请求日志
SANDBOX_LOG=1 bun run test:sandbox     # 沙盒 daemon 的日志照常打到终端(缺省只收进 log())
```
