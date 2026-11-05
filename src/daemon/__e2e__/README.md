# `__e2e__/` — daemon 端到端测试

起**真的** daemon(`bootDaemon`,和 `main.ts` 同一条开机路),只把系统边界换成替身:微信 ilink、模型 SDK、外网。
32 个文件 / 57 条(2026-10-27),本机全量约 40 秒。

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
| 记忆页删一句 | 主人在桌面记忆页(`POST /v1/memory/view` → `/v1/memory/edit`,operator 令牌)删掉 memory.md 的一行 ⇒ `memory_facts` 那一行不再生效、磁盘上导出的 memory.md 没了它、`GET /v1/memory/retractions` 里有它;下一个新起的会话(拍板卡那条的 Codex 线程)开发者指令里没有它、别的记忆还在;再开机也没回来 |
| 拍板卡 | 主人发 `/codex` 切到 Codex,要跑 `rm -rf build` ⇒ 卡片发到主人微信,主人回 `y` ⇒ 命令放行(app-server 收到 accept) |
| 放行规则 | 开机前就有的 `permission-rules.json`:`ls` 不弹卡直接放,回复后面单独一行「按规则「列目录不用问」放行了 ls」;有规则放 git,`git push` 是红线照旧弹卡,主人回 `n` ⇒ codex 收到 decline |
| 微信里派活 | 主人发「任务 项目」⇒ 列出 projects.json 里的 git 项目;「任务 新建 <项目> 用 @codex …」⇒ 执行者在项目里写了文件、桌面看到 `phase: replied`、回报发件箱(`matter_report_outbox`)里有带答复正文的「已答复」;「任务 <编号> 改动」列出 NOTE.md(新建),`GET /v1/workbench/review` 的快照里也有它 |
| 陌生人加进来 | 不在名单里的人说话 ⇒ 对方收到中性回复、主人收到带码的请求;主人回「允许 <码>」⇒ 对方被问称呼、之后的话到了 CC;访客的会话工具全关(Bash / Write / Edit / Read / WebFetch / Task),提示词里没有主人的长期记忆和原话 |
| 卡还挂着就重启 | Codex 一张卡在等主人时关机 ⇒ 关机收尾把这条审批按「拒」答回给 codex;再开机后主人在那个对话里收到一次「重启前那张「Codex 想执行命令:rm -rf dist」的卡作废了，还要的话再说一次。」(`pending_cards` 清空,下一次开机不再说);登记处是空的,主人迟到的「y」当普通的一句话交给 CC(有回、没出新卡、没放行任何东西) |
| 关机再开机 | 正常关机没有哪一步停失败;同一个 stateDir 再开机:不重复导入、照样健康、没有模块坏、对话模式留住了、照样收发 |
| 开机时一样起不来 | 再开机时 A2A 端口被别的程序占了 ⇒ 照样开起来;`/v1/health` 里只有 `a2a-server=degraded`,其余专门开上的都 ok;主人收到一句「这次开机有几样没起来：CC 之间的往来。其它功能照常。」;照样收发 |
| 输出评测 | `POST /v1/eval/run`(operator 令牌)跑一条 reply 样本:回 200、最后的话和气泡对;起的那条会话带生产的提示词(回复交付那段在,不是自检对话)、按只读档起(Write / Edit / Bash 被禁);微信外发箱和 `messages` 表都没多东西;`memory/` 下没留 `eval-*` 目录;缺字段回 400 `eval_invalid_request` |
| 免打扰里的回报 + 重启(S2b) | 关机时把主人的免打扰写成盖住此刻、清空待发队列,「待说」那一拍 200ms;`POST /v1/self-change/notice` 回 502、那句在 `speech_pending`、没进微信;再重启(免打扰照旧)⇒ 还在;主人 `/set 免打扰 关` ⇒ 微信里收到那句,只一次,表空了 |
| 免打扰里做完一件事 + 重启(S2b,win32 不跑) | 同样的起点再配一台手机(`settings-devices.json` + `phone-push.json`);微信里派给 Codex 的活做完 ⇒「做完了」推送压在 `speech_pending`(push),中继没收到;重启以后还在;主人 `/set 免打扰 关` ⇒ 中继收到那件事的推送(collapseId = 任务编号)一次,`speech_log` 有 `matter_report / allowed / app`。win32 不跑:同「微信里派活」,Codex 当工作台执行者在 Windows 上开头就拒绝 |
| 过期的一条(S2b) | 关机时写一份旧格式的 `speech/pending-notices.json`(一条两天前、一条刚才)⇒ 开机读进表、文件改名 `.migrated`;刚才那条说了,两天前那条 `speech_log` 记 `dropped / expired`、没发 |
| 断线时的补说(S2a) | 再开机,「待说」那一拍改成 200ms(`speechFlushIntervalMs`,生产 5 分钟);微信发不出去(`failSendMessage`)时 `POST /v1/self-change/notice` ⇒ 回 502 `send_failed`、日志 `kept to say later`;之后 3 秒(约 15 拍)里这句话**一次外发尝试都不再有**(补说按共用退避等满 1 分钟,或被门判送不到) |
| 一个事件账上一行(S3a,win32 不跑) | 配一台手机、免打扰关;微信里派给 Codex 的活做完 ⇒ App 推一次,`speech_log` 里这一轮只有一行(`ref = turn:<任务>:<轮>`、`allowed / app`),一秒后还是一行;再派一件要批准的 ⇒ App 推一次、微信里一张「需要你批准」,`speech_log` 里一行(`ref = ask:<任务>:<请求>`、通道 `app+wechat`)。win32 不跑:同「微信里派活」 |
| 人在电脑前做完一件事(S3b,win32 不跑) | 配一台手机、本机 5 秒前刚有键鼠(`machineIdleS`)、升级等待 2 秒(`escalateAfterMs`,生产 10 分钟);等状态只拉 `attention`(桌面 app 开着,桌面那一级由它弹;不读详情,读详情就算看过)。没人看:做完那一刻 App 没推、账一行通道 `desktop`、`speech_pending` 里有 `later:` 那一条;2 秒后推一次,账还是那一行(`desktop+app`),表空了。在桌面打开看了(`GET /v1/matter?id=`,operator 令牌;记在内存里,不写 `matter_bindings`):到点不推,日志 `seen on desktop`,账通道只有 `desktop` |

这些场景是**一条时间线**,共用一台 daemon(中途重启九次,win32 上七次),后面的接着前面留下的状态 —— 单独 `-t` 跑某一条不保证成立。例外:S2 那几条各自在关机时写死起点(免打扰开 / 关、配没配手机、待发队列清空,`rebootForS2`),一条红了不会把后面几条拖红。

**红 / 绿实证**:把 boot-api(当时在 `daemon-modules.ts`,现在 `bootstrap/module.ts`)的 `lazy: ['wired'],` 删掉,沙盒在 `beforeAll` 就红
(`boot-api failed at init (required): modules: 'boot-api' called ctx.late('wired') but 'wired' is not in its lazy`),
而其余 31 个 e2e 文件照样全绿。加回去就绿。

后加的几条,各自故意改坏一行生产代码、看对应的场景红(引入它们的 PR 描述里 `## 红/绿` 有原文):

| 改坏的那一行 | 红的场景 |
| --- | --- |
| `features/memory/memory-export.ts` 从表拼记忆文档时连收回的行也带上(`statuses: ['active', 'retracted']`) | 拍板卡那条(新起的 Codex 线程的开发者指令里又有了那句;记忆页和磁盘上的文件看不出来) |
| `adapters/permission-rules/rules-file.ts` 读规则文件时一律当成没开(`enabled: false`) | 放行规则(`ls` 也弹卡) |
| `features/workbench/wire.ts` 工作台不读 projects.json(`registeredProjects: () => []`) | 微信里派活(「任务 项目」里没有那个项目) |
| `domain/user-tier.ts` 名单里的人都当 admin(补回注释里明说不要的 allowFrom 兜底) | 陌生人加进来(访客会话的工具没关) |
| `daemon/ilink-glue.ts` 没有待批时的「y」也当成拍板吞掉 | 卡还挂着就重启(迟到的「y」没人回) |
| `daemon/pending-cards.ts` 开机不说作废(或登记处不落 `pending_cards`) | 卡还挂着就重启(等不到那一句作废) |
| `daemon/runtime/boot-report.ts` 降级汇总不发 | 开机时一样起不来(主人没收到那一句) |
| `features/output-eval/module.ts` 不收一次性 chatId 留下的记忆目录(去掉 `forgetChat`);或 runner 的 chatId 带 `/`(`eval/<uuid>`) | 输出评测(`memory/` 下多一个 `eval-*` 空目录;带 `/` 的那版直接 `ok:false`:`memory-export: bad chat id`) |
| `daemon/speech/push-gate.ts` 停的时候把压着的推送删掉(回到「只在内存里」) | 压着时重启(`expected [] to have a length of 1`) |
| `daemon/speech/pending-notices.ts` 的 `expire` 不回过期的行 | 过期的一条(等不到 `speech_log` 那一行) |
| `daemon/speech/ledger-store.ts` 带 ref 的也一判一行(不查同一个 ref 的那一行) | 一个事件账上一行(`expected [ …(2) ] to deeply equal [ { kind: 'permission_ask', …(3) } ]`) |
| `daemon/speech/matter-proposals.ts` 不判在场(一律当场推 App) | 人在电脑前做完一件事(`expected [ 'app' ] to deeply equal [ 'desktop' ]`) |
| `daemon/speech/push-gate.ts` 升级等待到点不问「看过没有」 | 人在电脑前做完一件事(等不到 `seen on desktop`) |
| `daemon/speech/policy.ts` 补说失败不退避(`nextAt: t`) | 断线时的补说(3 秒里又撞了 4 次:`expected 10 to be 6`);去掉「一次只跑一拍」那个守卫则是 3 秒 21 次(`expected 21 to be less than or equal to 6`) |

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
| 工作台读本机的 codex 配置 | 工作台起 Codex 前按子进程的环境(`CODEX_HOME`,缺省 `~/.codex`)读开发者自己的 codex 配置,看主人配了哪些 MCP;开发机上配过的会在任务里多一行「本次未带入的本机工具：…」,CI 上没有。只读、不出网,场景不看这一行 |
| 外部 CLI 的版本探测 | `claude --version` / `codex --version` 是真的跑(本机,不出网);CI 上没装 claude 就探不到 |
| 自改流水线、桌面 app、真 iPhone | 不在 daemon 进程里;各有自己的验证(`docs/maintainer/self-change.md`、`docs/maintainer/verify.md`) |

提醒、定时任务、回报投递是开着的(模块 ok),但沙盒里没有预置的提醒 / 任务行。

**加新的可选子系统 / 配置开关时**:在 `real-shaped.ts` 的 `writeConfig` 里照真机把它开上。缺省 off 的新模块会让开机那条红
(`ALLOWED_NOT_OK` 是空的);真开不了,就在那张表里写清为什么,同时补到上面「没开的」。

## 替身

- **`fake-ilink-server.ts`** — 假 ilink(`getupdates` / `sendmessage` / `sendfile` / `getconfig` / `sendtyping`),真的线上格式;`waitForOutbound(predicate)` 等外发。
- **`fake-sdk.ts`** — Claude Agent SDK、Codex app-server(剧本,`src/test-support/executors/codex-scripted.ts`;线程应答照真 codex 报回 workspace-write 的细项,收尾的 `thread/backgroundTerminals/clean|list` 也应答 —— 工作台起线程、收会话时都要核对这些)、Cursor SDK 的替身。测试给一份 `FakeSdkScript`,`onDispatch(text)` 返回工具调用和最终文字;Codex 还能给 `codexSteps`(比如一次审批请求)。
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
