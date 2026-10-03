# 网络守护(守护 v2:按调用判)

> **2026-10-02 主人拍板(第一次,#191):** 不经隧道、直连模型供应商可能让账号被封。
>
> **2026-10-02 主人收窄(第二次,本版):** #191 管得太宽,把所有模型调用都停了。守护的职责改为:
> **「根据约定的网络信号,判断 CC 能不能开始一次需要保护的调用。」**

## 决定与待定

> 评审 #193(2026-10-02)指出旧版把几条没定的事也写成了「主人的决定」。这一节按出处分两档:**主人已定**,和**待定**(待定的事现在的行为只是临时缺省,不是主人的决定)。

### 已决定(主人,2026-10-02 对话中)

1. **守护只管一件事:** 根据约定的网络信号,判断 CC 能不能**开始**一次需要保护的调用。不需要保护的调用不看信号、照常走。
2. **按调用分类,看它真正连到哪、用哪个模型**(不是按 provider 家族):Anthropic(Claude API / Claude Code / Agent SDK 走官方端点)、OpenAI(API、Codex)、Google(Gemini、agy/Antigravity)、OpenRouter 这类海外聚合默认需要保护;DeepSeek、Kimi、通义/DashScope、智谱等国内平台和自建默认不需要。
3. **自定义网关由用户自己决定:** 默认不保护(包括把 `ANTHROPIC_BASE_URL` 指到别处的 Claude Code),guard.json 一个开关(`protect_custom_gateways`)或 `protect` 表可以纳入。
4. **bx 在保护 ⇒ 无条件信任**(`protection_state == "protected"` 且 `tunnel_healthy`)。
5. **没装 bx ⇒ 用 daemon 自己的 Google 探测**(daemon 进程内 fetch)。没有结果按失败算 —— 修掉 v1 开机头一拍之前一律放行的 fail-open。
6. **国内 / 自建永远不能被全局守护连累:** 只拒绝那一次需要保护的调用;国内 / 自建的失败仍是普通连接错误,**永远不贴「网络未受保护」**。
7. **控制操作永远放行:** 查看 / 状态、取消、权限 y/n 回复、换模型 / 换 provider、/set 等。入站 `mw-guard` 已删。
8. **Cursor:** 主人原话「Cursor 除了 auto，其他都要网络」。只有 `auto` 不需要保护(没选模型、`auto`、cursor-agent 的 `default[]` 都是 Auto);**其它所有 Cursor 模型都需要保护** —— Claude / GPT / Gemini、Cursor 自家的 composer-\* 等、不认识的模型名(Grok、Kimi、GLM …)。`trust` 可逐个放开(如 `cursor:composer-*`)。
9. **cheapEval 继续钉在 agy**(主人在对话里说保持现状)。
10. **`llm.youdamaster.cc` 是主人自建的 ⇒ 不需要保护**(按第 3 条,它本来就是缺省不保护的自定义网关;主人确认过不要纳入)。
11. **装了 bx、但 bx 关着 / 恢复中 / 读不出 ⇒ 暂停需要保护的调用,不回退到 Google 探测;** guard.json 里写 `signal_source: "probe"`(装着 bx、实际在用别的 VPN)可以显式改用 Google 探测。实现见 `gate.ts` / `owner-table.test.ts`。
12. **Kimi:** 主人原话「Kimi 都不需要判断」。Kimi 的所有端点(`moonshot.cn`、`moonshot.ai`、`kimi.com`、`kimi.ai` 及其子域)都不需要保护,国内版、国际版不分;`protect_custom_gateways` 也不会把它们纳入(它们不算自定义网关),要纳入只能写进 `protect`。
13. **已经在跑的任务(主人 2026-10-03,原文照录):**

    > - Signal source bx ⇒ never stop or suspend running tasks (bx is fail-closed).
    > - Signal source probe (no bx) ⇒ after TWO consecutive unsafe readings, SUSPEND (not kill) running executors whose calls are protected; unprotected ones (domestic/self-hosted/Cursor auto) keep running.
    > - Suspend = SIGSTOP the whole process tree/group (not SIGTSTP — it can be caught), resume = SIGCONT when the signal becomes safe again.
    > - While suspended, pause every daemon-side timer for that task/turn (turn watchdog, codex connect/first-event timeouts, ACP/app-server request timeouts, idle-reap, lease/one-folder bookkeeping timers) so nothing marks it failed; resume them on SIGCONT.
    > - On resume, in-flight model requests may have been dropped by the server; rely on each executor's own retry/reconnect. Verify per executor in sandbox (fake servers on 127.0.0.1 that drop the stream while the process is stopped): if an executor does NOT recover after SIGCONT, fall back to the previous graceful stop for that executor and document which.
    > - Max suspension 30 minutes (configurable in guard.json): then gracefully stop the task and notify the owner on the originating surface: 「网络一直没恢复，任务已停止，可以接着做」.
    > - Windows: no SIGSTOP ⇒ keep the existing stop behaviour (document; NtSuspendProcess later).
    > - Chat sessions of protected providers: decide consistently — prefer suspend for long-lived session processes too if they're single-turn-safe; otherwise keep current close-on-unsafe; document the choice.
    > - Visibility: workbench task state shows "已暂停(网络未受保护)" on desktop/phone/WeChat notices; `wechat-cc guard status` lists suspended tasks; /v1/health guard block includes suspended count.

    怎么落地见下面「暂停在跑的任务」一节。

### 待定(现在的行为只是临时缺省)

(目前没有。原来唯一的一条「什么时候 / 要不要停掉已经在跑的任务」2026-10-03 由主人定了,见上面第 13 条。)

### 由上面推出来的实现约束

- **判的是执行者真正连的目标,不是此刻的配置**(评审 #193 P1-1):执行者 / 会话自己报它用的端点 + 模型(构造或起会话那一刻定下的,和真正调用是同一份参数);配置后来改了,在用的会话不跟着改,守护也不跟着改。报不出来 ⇒ 按需要保护(fail closed)。
- **探测结果会过期**(评审 #193 P1-2):过期 = 不知道 ⇒ 需要保护的调用先等一次新结果,等不到按不安全。探测不依赖公网 IP 查询成功。
- **后台任务里被拒 = 这一拍跳过**(评审 #193 P2-3):不打勾、不登记、不前移时间戳,下一拍再来。
- **多人模式被筛到只剩一位 = 按单人排队**(评审 #193 P2-4);更一般地,**同一个底层会话同一时刻只有一个回合**(第二轮 #194):单模型队列和 `/chat` 抢占的每一次发送都落到按 (chat, project, provider) 的会话锁上,网络来回切换时两条路交接也不会在同一会话上撞车。
- **守护装在会话自己的发送方法里**(第二轮 #194):registry 发出去的每个会话,dispatch / steer / 工作台 start / submit 之前都先判 —— 不管是 SessionManager、工作台、selftest 还是 delegate 拿到它,都不靠调用方记得补。
- **被拒后的撤回只撤本次登记**(第二轮 #194):care 台账按登记回执定向撤(时间字段只在还是这次写的值时放回;未回复计数只在期间没被清零时减一),agenda.md 只放回本次打勾的那一行 —— 期间的新活动(主人来信、别的登记、文件里其他改动)都保留。
- 文案:拒绝需要保护的调用统一一句老实话,说清停的是哪一步,例如「网络未受保护(bx 未连上),用到 Claude 的这一步先暂停，恢复后再试。」;不重试、不退避风暴;后台任务安静跳过,只记一行日志。
- **看得见:** `/v1/health` 的 guard 块带上按调用的语义;桌面一行「bx 保护中」/「⚠ 网络未受保护：用到 Claude 等的调用暂停」/「当前没有用到需要保护的接口」(不报红);`wechat-cc guard status` 列出已配置 provider 的分类。

## 分类(`src/lib/call-classifier.ts`)

先定端点,再按端点 host / Cursor 模型判,最后套 guard.json 覆盖。纯函数,core / daemon / CLI 共用一份。

**端点从哪来 —— 问执行者,不问配置**(评审 #193 P1-1)。每个 provider 实现 `callTarget(kind, ctx)`,每个会话实现 `callTarget()`,报的是**它真正调用时用的那一份参数**(带 `exact`,daemon 不再按此刻的配置补)。报不出来 ⇒ `unresolved` ⇒ 按需要保护。

| provider | 实际目标 |
|---|---|
| `claude` | 会话:**spawn 那一刻**子进程拿到的 `ANTHROPIC_BASE_URL`(`options.env` 给了就看它,否则 daemon 的 `process.env`)+ 那一刻的模型;一次性评估每次起新子进程,看调用那一刻的环境。没设 = `api.anthropic.com` |
| `codex` | **按 codex 自己的配置,不看 `OPENAI_BASE_URL`**(2026-10-03:codex 0.153 不认这个变量,也不认 `OPENAI_API_KEY`)。见下面「Codex 的端点」。对话侧 SDK 每一轮起一个新 `codex exec`、重新读那一刻的配置 ⇒ 按调用时解析;工作台 app-server 是常驻子进程 ⇒ 起来以后问 codex 自己(`config/read`),用它报的有效配置。没配 = `api.openai.com`(ChatGPT 登录是 `chatgpt.com`,同为官方) |
| `openai`(openai-compatible,对话 / delegate / 工作台 API) | **注册那一刻**读的 `openaiBaseUrl` + 默认模型(和建模型客户端用的是同一份值);之后改 agent-config 不影响在用的 provider |
| `gemini` / `agy` | Google 官方 |
| `cursor`(ACP,对话 + 工作台) | 起会话本身(initialize + `session/new` / `session/load`)不发模型请求 ⇒ `setup`,不保护;每一轮按 **cursor-agent 自己报的当前模型**(应答里 `configOptions` 的 `currentValue`;钉模型成功就是钉的那个;续会话就是续上的那个)。没报 ⇒ 按需要保护 |
| `cursor` 一次性评估 | 构造时的 `cursorModel`(`cursorOneShotEval` 用的那个) |
| `cursor`(SDK + API key) | 会话钉的模型 ?? 构造时的 `cursorModel` |

协调器的预判:这条对话有在用的会话 ⇒ 它实际的目标;没有 ⇒ provider 按这次会用的模型报的目标。工作台:spawn 前问执行者 `spawn` 目标,**会话起来以后、发第一轮之前**再按会话报的目标判一次;补充、停执行者都按在用会话的目标。

按配置推的 `targets.ts` `makeResolveTarget` 只剩给「还没有执行者可问」的地方:CLI `guard status`、语音、终端会话 resume。

### Codex 的端点(`src/lib/codex-target.ts`,2026-10-03)

codex 只按自己的配置连:`model_provider`(缺省 `openai`)→ 自定义 id 用 `model_providers.<id>.base_url`(+ `wire_api`);内置 `openai` 用 `openai_base_url`(没写 = 官方);内置 `ollama` / `lmstudio` = 本机(`CODEX_OSS_BASE_URL` / `CODEX_OSS_PORT` 可改)。配置层按 codex 同一顺序合并(低 → 高):系统 `/etc/codex/config.toml` → 用户 `$CODEX_HOME/config.toml`(`CODEX_HOME` 取子进程拿到的环境,缺省 `~/.codex`)→ 项目 `.codex/config.toml` → daemon 传的 `-c` 覆盖 → `managed_config.toml`。

**拿不准 ⇒ `unresolved` ⇒ 需要保护:** 配置读不出 / 坏 TOML、`model_provider` 指到没定义的 id、自定义 provider 没写 `base_url`、`model_providers` 重定义内置 id(codex 会拒绝起)、老式顶层 `profile = "…"`(0.153 报错)、项目层 `.codex/config.toml` 改了端点相关的键(是否生效取决于主人有没有信任这个项目,daemon 判不了)、不认识的内置 provider(如 Bedrock)。`[profiles.x]` 表不看:新版 profile 只能靠 `--profile`,daemon 从不传。

**哪一份更准:** 工作台 app-server 会话起来以后用 codex 自己 `config/read` 报的有效配置(含 MDM / 云端托管层与项目信任,这些按文件读不到);对话侧 `codex exec` 没有这个接口,按文件解析(每次调用读,按 mtime 缓存)。只读 provider id 与 base URL,从不读、从不打印密钥。

| 场景 | 判定 |
|---|---|
| 没有 config.toml / 没写 `model_provider` | `api.openai.com`,需要保护 |
| `OPENAI_BASE_URL` 指国内网关、config 是默认 | **仍需要保护**(codex 不看这个变量 —— 2026-10-03 修掉的直连漏洞) |
| 自定义 provider 指到国内 / 自建 / 局域网 | 不需要保护 |
| 自定义 provider 指到 OpenAI / OpenRouter | 需要保护 |
| `-c model_provider=…` / `-c model_providers.x.base_url=…` | 覆盖压过文件 |
| 读不出 / 拿不准(见上) | 需要保护 |

| 出口 | 连到哪 |
|---|---|
| 语音 | 通义 TTS = `dashscope.aliyuncs.com`;`http_tts` / STT = 配置里的 `base_url`;没配置 = 什么都不出门,不判 |
| 工作台额度查询 | Claude 的 usage 接口永远是 `api.anthropic.com`(哪怕会话走网关);Codex 的额度是 ChatGPT 账号的,永远按 OpenAI 官方(哪怕 `model_provider` 指到了别处) |

**默认判定:**

| 类别 (`kind`) | 例子 | 需要保护 |
|---|---|---|
| `official` | `*.anthropic.com` `claude.ai` `*.openai.com` `chatgpt.com` `*.googleapis.com` `x.ai` `mistral.ai` `groq.com` … | 是 |
| `aggregator` | `openrouter.ai` `together.xyz` `fireworks.ai` `deepinfra.com` `poe.com` | 是 |
| `overseas_other`(拿不准、按 host 判成海外) | 通义国际版 `dashscope-intl.aliyuncs.com`、`api.deepseek.ai` | 是(`trust` 可放开) |
| `cursor_model` | Cursor + `auto` 以外的**任何**模型:Claude / GPT / Gemini、Cursor 自家的 `composer-*`、不认识的名字(`kimi-k2`、`grok-4`、`glm-*` …) | 是(`trust` 可放开) |
| `cursor_auto` | Cursor 没选模型 / `auto` / `default`。cursor-agent 的模型 id 带参数后缀(`default[]` = Auto、`claude-opus-5[thinking=true,…]`),按去掉 `[…]` 的名字判 | 否 |
| `cursor_setup` | Cursor 列模型目录、查额度、起 ACP 会话(`setup`)—— 不是模型回合 | 否 |
| `kimi` | Kimi 的所有端点:`moonshot.cn` `moonshot.ai` `kimi.com` `kimi.ai`(国内版、国际版不分) | 否(`protect_custom_gateways` 不影响) |
| `domestic` | `deepseek.com` `aliyuncs.com`(DashScope) `bigmodel.cn` `volces.com` `siliconflow.cn` `baidubce.com` `minimax(i).chat/com` `lingyiwanwu.com` `tencentcloudapi.com` `baichuan-ai.com` `stepfun.com` `xf-yun.com` `sensenova.cn` `modelscope.cn` | 否 |
| `self_hosted` | `localhost` / 回环 / `10.x` `172.16–31.x` `192.168.x` / `169.254.x` / `100.64–127.x`(tailnet)/ `.local` `.lan` `.internal` `.home.arpa` `.ts.net` / 私网 IPv6 / 不带点的主机名 | 否 |
| `custom_gateway` | 其它任何 base URL(如主人的 `llm.youdamaster.cc`、Claude Code 的 `ANTHROPIC_BASE_URL=https://gw.example.com`) | 否;`protect_custom_gateways: true` ⇒ 是 |
| `unknown_provider` | 不认识的 provider、又没给端点 | 是(fail safe) |
| `unresolved` | 执行者 / 会话报不出实际目标 | 是(fail closed;`trust` 里写裸 provider id 可放开) |

显式 base URL 指回官方端点(`ANTHROPIC_BASE_URL=https://api.anthropic.com`)仍是官方。

## guard.json

`~/.claude/channels/wechat/guard.json`。所有新字段可省;只有老三项的文件照常读(新字段取缺省);CLI `guard enable/disable` 写回时保留全部字段。

```jsonc
{
  "enabled": true,                       // 老字段:总开关。false ⇒ 什么都不判、全放行
  "probe_url": "https://www.google.com/generate_204",   // 老字段
  "ipify_url": "https://api.ipify.org",                 // 老字段
  "signal_source": "auto",               // 新:auto = 装了 bx 只认 bx,没装用探测;probe = 装着 bx 也用探测
  "protect": [],                         // 新:一定要保护的调用
  "trust": [],                           // 新:不需要保护的调用(覆盖默认)
  "protect_custom_gateways": false,      // 新:自定义网关也纳入保护
  "max_suspend_minutes": 30              // 新(2026-10-03):暂停在跑的任务的上限,到点按收工停下;1–1440,越界取 30
}
```

`protect` / `trust` 条目三种写法:

| 写法 | 例子 | 匹配 |
|---|---|---|
| `provider:模型通配`(含冒号、不含 `://`) | `cursor:kimi-*`、`cursor:composer-*`、`openai:*` | provider 相同且模型匹配(`*` / `?` 通配,不分大小写);模型通配不是 `*` 时,没有模型的调用不匹配 |
| host(含点;可 `*.` 前缀,也可写整个 URL) | `dashscope-intl.aliyuncs.com`、`*.youdamaster.cc`、`https://gw.example.com/v1` | 端点 host 等于它或是它的子域 |
| 裸 provider id(不含点也不含冒号) | `codex`、`cursor` | 这个 provider 的所有调用 |

**`protect` 压过 `trust`**(两边都命中按保护算,fail safe)。例:放开 Cursor 自家模型 `"trust": ["cursor:composer-*"]`;把主人自己的网关也纳入 `"protect": ["*.youdamaster.cc"]`;放开通义国际版 `"trust": ["dashscope-intl.aliyuncs.com"]`。

## 信号(只对需要保护的调用)

| 情形 | 判据 | 需要保护的新调用 | 国内 / 自建 |
|---|---|---|---|
| bx 在保护 | `bx status --json`:`protection_state == "protected"` **且** `tunnel_healthy == true` | 放行 | 放行 |
| 没装 bx + 探测通 | daemon 自己 HEAD `probe_url` | 放行 | 放行 |
| 没装 bx + 探测不通 | 同上 | 暂停 | 放行 |
| 没装 bx + 还没有探测结果 | 等第一次结果(缺省最多 4s,`gate.ts` `FIRST_PROBE_WAIT_MS`);等不到 ⇒ 失败 | 等一下再暂停 | 放行 |
| 装了 bx 但 off / starting / recovering / blocked / needs_attention / 读不出(进程起不来、超时 6s、非零退出、坏 JSON、缺字段) | — | 暂停(**不回落到 Google**) | 放行 |
| 同上,但 `signal_source: "probe"` | 跟着探测走 | 按探测 | 放行 |
| `enabled: false` | 不判 | 放行 | 放行 |

这张表由 `src/daemon/guard/owner-table.test.ts` 逐格钉住。

- 调度器(`scheduler.ts`)初始状态 **`safe=false, reachable=false`**(修 v1 的 fail-open)。没装 bx 时第一拍**即使 ipify 失败也探**,否则永远拿不到第一次结果。
- **探测结果有有效期**(评审 #193 P1-2;`DEFAULT_PROBE_TTL_MS` = 5 分钟):探测**不依赖** ipify 成功 —— 不通期间每拍(30s)都探;通着时结果到期就重探;查得到 IP 且 IP 变了立刻重探(只是加速)。闸门只信新鲜的结果(有效期 + 1 分钟余量),过期 = 不知道 ⇒ 先等一次新结果(同「还没有结果」的有界等待),等不到按不安全。`/v1/health` 同口径显示「探测结果已过期」。修掉的两种冻住:第一次失败后 ipify 一直失败 ⇒ 恢复了也一直挡;第一次成功后 ipify 一直失败 ⇒ 断网了也一直放。
- bx 模式每 10s 读一次 bx(本机 socket,只读,约 70ms);闸门优先用 30s 内的读数,过期就当场读(单飞 + 5s 短缓存)。探测模式的「等第一次结果」同样单飞 + 5s 缓存,不会因为并发调用刷探测。
- `protection_state` 的六个值是 bx 的对外契约(`internal/protectionstate`),只有 `protected` 算数。

## 拦在哪里

统一契约在 `src/lib/network-gate.ts`:`NetworkGate.check()`(信号)+ `classify()`(分类)、`decideCall()` / `assertCallAllowed()`(先分类、需要保护才看信号)、统一文案 `unprotectedMessage(verdict, label)`、错误 `NetworkUnprotectedError`(`code: 'network_unprotected'`,带被暂停那一步的名字)。daemon 实现在 `src/daemon/guard/gate.ts` + `runtime.ts`,`main.ts` 最先建好往下传。

| 位置 | 按什么分类 | 需要保护且不安全时 |
|---|---|---|
| 协调器 `dispatchSolo` / 多人模式参与者(`src/core/conversation-coordinator.ts` `admitProviders`) | 在用会话的实际目标;没有会话就是 provider 按这次的模型报的目标 | 单人:不 acquire,回一句统一的话(按 reply sink 落到发起的那一面),不重试。`/both` `/chat`:**只拿掉被挡的那几位**,一句话说明,其余照常发言(剩一位就降成单人,**并像单人一样排队** —— 评审 #193 P2-4:不然第二条消息会在同一会话上撞上还在跑的第一条) |
| `ProviderRegistry` → `withNetworkGate`(`src/core/provider-registry.ts`) | provider 报的实际目标(`providerCallTarget`);会话不自己报目标的,把 spawn 那一刻 provider 报的钉在会话上;`modelCatalog` 不算模型回合(Cursor 列目录不保护) | 抛 `NetworkUnprotectedError`,不起子进程、不发请求 |
| cheapEval 故障转移 | 逐个候选 | 跳过需要保护的候选(**不记冷却**),照常试不需要保护的;都被挡才抛。显式钉了 `cheap_eval_provider` 时只用它(不故障转移),它需要保护就照样暂停 |
| `SessionManager.spawn` 与 `handle.dispatch` | 这条会话的实际目标(`handle.callTarget()`:会话自报,或 spawn 那一刻 provider 报的) | 抛错(在碰 provider 之前,一个字都没发);推送 / 打猎 / 议程的 `dispatchToChat` 走这里 |
| 会话自己的发送方法(`provider-registry.ts` `guardSession`,第二轮 #194) | 同上(会话此刻的实际目标) | registry / delegate 发出去的每个会话:dispatch / steer / 工作台 submit 先判再发;工作台 `start` 是同步的,先挂住等守护答复,被拒就从不 start、事件流报 `network_unprotected`。selftest chat 与 `POST /v1/selftest/converse` 因此也过守护 |
| delegate(`src/daemon/bootstrap/delegate.ts`) | 同 registry(带 provider id 包一层) | 同上 |
| 工作台 `execute()` / `submitInput()` | spawn 前:执行者报的 `spawn` 目标;会话起来后、第一轮之前与每次补充:在用会话的实际目标(`workbench/service/call-target.ts`) | 任务以 `network_unprotected` 失败 / 补充返回 503;Cursor auto、国内网关的执行者照常起 |
| 工作台额度查询(`wire-workbench.ts`) | Claude → `api.anthropic.com`;Codex → OpenAI 官方(`chatgpt.com`) | 返回 null,不出门 |
| `cli-reply-handler` resume(微信「@码 文本」、A2A `/a2a/cli/reply`) | 终端会话来源:claude 看 `ANTHROPIC_BASE_URL`;codex 按 codex 配置层(含这个会话目录的项目层) | 不起 CLI,回统一的话 |
| 语音 `gateVoice` | 这一次连到的端点 | 不出门;通义 / 自建 / 局域网照常 |
| 后台 tick(companion push / introspect / ingest)`skipWhenUnsafe` | 已注册 provider 报的目标 + 在用会话的实际目标 | 信号不安全且**全都**需要保护 ⇒ 这一拍安静跳过;有不需要保护的 ⇒ 照跑,里面需要保护的那几次被各自的闸门拒掉。同一段不安全期同一个任务只记一行日志 |
| 后台任务内部被拒的那一次(评审 #193 P2-3) | — | **这一拍跳过,什么进度都不记**(`NetworkUnprotectedError` / `NETWORK_UNPROTECTED_REASON` 一路传上来):议程 / 打猎 / 问候定向撤回「先登记再出门」的那一次登记(agenda.md 只放回本次打勾的那一行,care 台账按回执 `unclaim`,期间的新活动保留),不写 plan-log;日程判断被拒不走老顺序兜底、不退避;串门开场被拒台账放回;反思不记 `cron_eval_failed`、`last_introspect_at` 不动;画表情 / 画室不吃掉这一期;人类做客讲述被拒那一位水位放回;社交判官被拒原样抛出(不当成「不能」去转问)。摄入抽取、线索、概览、画像、园丁本来就只在成功后提交 |
| 每晚整理记忆 | 它用的 cheapEval | 评估被守护拒 ⇒ `skipped: network_unprotected`,**不记** `failed_today` |
| **已经在跑**的工作台执行者(`lifecycle-deps.ts` `onReading` → `pause-policy.ts` → `workbench/service/lifecycle.ts`) | 在用会话的实际目标 | **主人已定(第 13 条):** bx 来源从不停、不暂停。probe 来源连续两次不安全 ⇒ **暂停**(SIGSTOP 整棵进程树)需要保护的执行者,读到安全 ⇒ 放开;暂停 30 分钟(可配)还没恢复 ⇒ 按收工停下并告诉主人。暂停不了的执行者退回原来的停法。见「暂停在跑的任务」 |
| 已经在跑的对话会话(同一时刻:probe 连续两次不安全) | 会话的实际目标 | `SessionManager.shutdownProtected()`:只关需要保护的对话会话(不暂停,理由见「暂停在跑的任务」);bx 来源从不关。网络翻转本身(`onStateChange`)不再关会话 |

**入站不再拦。** 微信入站链里原来的 `mw-guard` 已删除:管理 / 模式命令、`y`/`n` 权限回复、取消、换模型、`/set` 照常;闲聊进协调器,由上表按调用拦。

## 暂停在跑的任务(主人 2026-10-03,第 13 条)

**什么时候:** 只看 probe 来源(没装 bx,或 `signal_source: "probe"`)。调度器每读一次喂一次 `pause-policy.ts`:连续两次不安全 ⇒ 暂停;同一段不安全期只暂停一次;读到安全 ⇒ 放开;暂停期间改用了 bx(fail-closed)⇒ 也放开;暂停期间守护被关掉 ⇒ 放开(关了就什么都不判)。bx 来源从不暂停、从不停。

**暂停谁:** 工作台里在跑的、按**会话实际目标**判成需要保护的执行者(`classifyWith(gate, run.target)`);国内 / 自建 / Cursor auto 不动。排队还没起来的不动 —— 轮到它时闸门按调用拦。

**怎么暂停**(`src/lib/process-tree-freeze.ts`):SIGSTOP(不是 SIGTSTP,那个能被捕获)。执行者都是 `detached` 起的组长:先冻根组(挡住新 fork),再按 `ps` 的父子关系找全后代,后代另起的组逐个冻(Claude 的 Bash、codex 的后台终端、MCP 子进程),挂在别人组里的后代单独冻;最多十遍直到没有新面孔。放开:先放后代再放根。**冻住的树只会被放开或被杀掉,绝不为了「优雅收尾」先放开** —— 放开那一下它就会接着用不受保护的网络。

**冻住期间停表的计时器**(否则冻住期间到点,会把只是在等网络的任务判成失败):

| 计时器 | 在哪 | 冻住时 | 放开时 |
|---|---|---|---|
| 工作台回合看门狗(`timeoutMs`,缺省 10 分钟) | `service/execute.ts` `collectWorkbenchTurn` | 按「在等」算,不判超时 | `interactionAt` 记成放开那一刻,从头算 |
| codex 连接 / 首个事件超时(#197) | `codex-app-server.ts` `armWatchdog` | `lib/pausable-timers.ts` 停表 | 按剩下的时间接着走;放开后 codex 发的 `willRetry` 照常武装 connect |
| codex app-server RPC 请求超时 | `codex-app-server.ts` `request()` | 同上 | 同上 |
| 权限卡批准期限(5 分钟) | `workbench/permissions.ts` | 停表 | 期限按冻住的时长顺延 |
| 空闲自动收工 / 文件夹让位(一个文件夹一个活会话) | `service/lifecycle.ts` `armIdleClose` | 撤掉、不武装 | `settleAfterDecision` 重新评估 |
| 起会话超时(`session_start_timeout`) | `service/execute.ts` | 不涉及:会话没起来的 run 冻不了,按原来的停法 | — |
| ACP 请求超时(`acp/rpc.ts`) | — | 不涉及:Cursor ACP 不暂停(见下表),退回停 | — |

忙碌登记(`holdBusy`)在冻住期间照旧持有 ⇒ 空闲自重启不会把冻住的任务当成空闲。

**放开之后:** 冻住期间服务端可能已经把在途的流掐了,靠执行者自己的重试 / 重连接上。逐个执行者在沙盒验证(真的 CLI 连 127.0.0.1 的假模型服务;第一次流式请求吐半句挂住 → 冻住 → 服务端掐断 → 停 3 秒 → 放开;要求这一轮以 `RECOVERED` 正常结束、服务端看到第二次请求):

| 执行者 | 结果 | 守护怎么对它 |
|---|---|---|
| Claude Code(工作台保留会话,2.1.288) | **接上**:放开后自己重发请求,这一轮正常结束(另测过冻住期间 `API_TIMEOUT_MS` 已到期,同样接上) | 暂停(`claude-workbench-runtime.ts` `suspension`) |
| Codex(工作台 app-server,0.153.4) | **接上**:`Reconnecting... 1/5` 后正常结束(`codex exec` 同样) | 暂停(`codex-app-server.ts` `suspension`) |
| Cursor(ACP) | **没法在沙盒验**:cursor-agent 只连 Cursor 自己的服务,没有能指到本机的端点 | 退回原来的停法 |
| agy(Antigravity) | **没法在沙盒验**:私有二进制只连 Google;每轮一个子进程,也不在自己的进程组里 | 退回原来的停法 |
| openai 兼容(工作台 API 执行者) | 进程内循环,没有能冻的进程 | 退回原来的停法 |

验证脚本是 `src/core/workbench/suspend-resume.sandbox.test.ts`(显式打开才跑:`WECHAT_CC_SUSPEND_SANDBOX=1 bun --bun vitest run src/core/workbench/suspend-resume.sandbox.test.ts`)。流量一律不出本机:端点钉 127.0.0.1;`HTTP(S)_PROXY` 指 127.0.0.1:9(死端口);`HOME` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 全是临时目录;codex 不认 `OPENAI_BASE_URL`,端点写进沙盒 `CODEX_HOME/config.toml` 的自定义 `model_provider`。执行者升级后要重跑这一份;接不上了就把它的 `suspension` 摘掉(退回停)并改这张表。

**退回停的执行者 / 情形**(同 #191 的老行为:时间线记一句「网络未受保护：……这个执行者暂停不了，已停止本轮，恢复后可以继续。」,任务记已停止,之后可以「继续」):上表三家;会话还没起来的 run;`suspend()` 返回 false(进程已经没了)。**Windows:** 没有 SIGSTOP(`freeze()` 直接返回 false)⇒ 全部退回停;以后再上 NtSuspendProcess。

**暂停到顶**(guard.json `max_suspend_minutes`,缺省 30):冻住的树直接 SIGKILL(不放开),任务按收工停下(已停止,可以接着做 —— Claude / Codex 的原生会话在磁盘上,续接时按原会话恢复),时间线与终态微信通知说主人原话「网络一直没恢复，任务已停止，可以接着做」。冻住期间主人点「停止」/ daemon 关闭 也走同一条:先整棵杀,再按原来的取消收尾;close 不再要求进程配合(codex 不发收尾 RPC,后台终端是冻住时一起登记、一起杀掉的后代)。

**对话会话不暂停,仍然关(主人让定,本版定为):** 对话侧的常驻会话(Claude SDK 会话、Cursor ACP 会话)的回合计时、回复送达、按 (chat, project, provider) 的会话锁都在协调器里,冻住它要把这些一起停表,不是单轮安全的;codex 对话每轮一个 `codex exec`,也没有能跨轮冻的进程。所以对话会话**关**(下一条消息按原生会话续上),只关需要保护的;时刻和工作台一致(probe 连续两次不安全),bx 来源从不关 —— 和第 13 条第一句同一条规矩。以前是「网络一翻转就关」(bx 来源也会触发),这一版改掉。

**看得见:** 任务状态「已暂停(网络未受保护)」—— 桌面列表 / 详情 / 「此刻」页、手机「一件事」列表(`/v1/matters` 带 `networkSuspended`)、微信「任务」查询;时间线记「已暂停(网络未受保护)：……恢复后自动继续。」与「网络恢复，已继续。」;订了微信提醒的任务暂停时收一条提醒。`/v1/health` 的 guard 块带 `suspended`(个数)与 `suspended_tasks`;`wechat-cc guard status` 列出被暂停的任务(问在跑的 daemon,本机回环)。

## 刻意不拦

- **本地推理:** 嵌入(transformers.js / python embed-runner)、atelier 本地 sd-cli 渲染。首次下载权重(HuggingFace)不带模型账号。
- **非模型流量:** 微信 ilink、中继、A2A、邮箱轮询、ipify / google 探测本身、R2 更新源。
- **CLI 一次性命令:** `wechat-cc memory …` / `wechat-cc sessions …` 在 CLI 进程里直接调 SDK —— 主人在终端前手动发起,和直接敲 `claude` 同一个性质。`wechat-cc guard status` 会照实告诉他此刻信号和各 provider 的分类。
- **已经发出的那一个请求:** 守护只能在出发前拦。
- **收到的串门回程讲述、摄入里逐批的冲突 / 结算判断:** 被拒时这一次就丢了(串门会话清掉;冲突 / 结算由之后的全量扫描补上),不重放 —— 它们不是定时任务的进度,而是对一封已读来信 / 一批已入库事实的附带判断。

## 看得见

- `GET /v1/health` 的 `guard` 块:`{ enabled, source: 'bx'|'probe'|'off', safe, detail, ip, checked_at, signal_source, protected_in_use, paused, providers: [{ id, model, host, protected, kind, label, reason }], suspended, suspended_tasks: [{ task_id, title, provider, since }] }`(`suspended*` 2026-10-03:被暂停的在跑任务,见「暂停在跑的任务」)。`safe` 只是信号;`paused = enabled && !safe && protected_in_use` 才是「有需要保护的调用此刻被停」。新字段都可选,老 daemon 没有。
- 桌面「此刻」页连接区一行:`bx 保护中`(绿)/ `⚠ 网络未受保护：用到 Claude 等的调用暂停`(红,`Claude` 换成第一个需要保护的接口名;悬停提示可跑 `bx leakcheck`)/ `当前没有用到需要保护的接口`(中性,不报红)。守护关着不显示;老 daemon 没有 `protected_in_use` 时按「有」算,不默认绿。设置抽屉里那一行同口径。
- `wechat-cc guard status [--json]`:信号(`source` / `safe` / `detail` / `bx_path` / `signal_source`)+ 按配置推出的 provider 分类(`providers`、`protected_in_use`;只读配置,不发流量)+ 被暂停的任务(`suspended` / `suspended_tasks`,问在跑的 daemon 的 `/v1/health`;daemon 没在跑就不给,不说「没有」)。Codex 那一行按 codex 配置层判(`CODEX_HOME` 依次取 CLI 环境、`daemon.env`、`~/.claude/settings.json` 的 env)。
- 日志 tag `GUARD`:状态翻转、每个被拒的回合(带被停的接口名)、cheapEval 跳过的候选、每个被跳过的后台任务(每段一次)。

## 怎么验

```bash
bx status --json | jq '{protection_state, tunnel_healthy}'   # 只读,本机 socket
wechat-cc guard status                                        # 信号 + 各 provider 是否需要保护
```

不要为了验证去 `bx down`、`bx setup`,也不要跑任何会把流量送出隧道的检查(例如 `bx leakcheck --compare-direct`)。断网路径由单测覆盖:`src/lib/call-classifier.test.ts`(分类表)、`src/daemon/guard/owner-table.test.ts`(主人那张表逐格 + 端点 / 模型解析 + health)、`src/daemon/guard/*.test.ts`(bx JSON、超时、fail closed、第一次探测的有界等待)、`src/core/provider-registry.network-gate.test.ts`(逐候选故障转移、Claude 聊天停 + DeepSeek 后台照常)、`src/daemon/guard/effective-target.test.ts`(评审 #193:配置改了在用的执行者不跟、Cursor 一次性评估、报不出目标按保护)、`src/lib/codex-target.test.ts`(Codex 按自己的配置层判:默认 / 自定义国内 / `OPENAI_BASE_URL` 不算 / 读不出按保护 / `-c` 覆盖 / 项目层)、`src/core/codex-agent-provider.test.ts` 与 `src/core/workbench/codex-app-server.test.ts`(对话侧与工作台 `config/read`)、`src/core/acp-agent-provider.test.ts`(cursor-agent 自报的当前模型)、`src/daemon/wiring/tick-bodies.test.ts`(被拒 = 这一拍跳过)、`src/core/conversation-coordinator.test.ts`(network gate 一节)、`src/core/session-manager.test.ts`、`src/core/workbench/service-network-gate.test.ts`、`src/daemon/inbound/pipeline.integration.test.ts`(入站控制照常)、`src/daemon/ilink/voice-gate.test.ts`、`src/daemon/cli-reply-handler.test.ts`、`src/daemon/memory/nightly.test.ts`、健康路由与桌面渲染测试。暂停在跑的任务:`src/daemon/guard/pause-policy.test.ts`(bx 从不暂停 / probe 两次暂停 / 安全放开 / 30 分钟到顶停下 / 守护关掉放开,假时钟)、`src/lib/process-tree-freeze.test.ts`(真的子进程树:根、同组孩子、另起一组的孩子都停止计数、放开后接着数、冻住时直接杀)、`src/lib/pausable-timers.test.ts`(假时钟)、`src/core/workbench/service-network-suspend.test.ts`(冻住期间回合看门狗与批准期限不走、冻不住退回停、到顶 / 取消只杀不放)、`src/core/workbench/codex-app-server.test.ts`(冻住期间首个事件超时不触发、terminate 后 close 不发收尾 RPC)、`src/core/claude-workbench-process.test.ts`、`src/daemon/wiring/lifecycle-deps.test.ts`(接线);逐执行者沙盒见上。测试里永远注入执行器 / 探测,单测进程下 `findBx()` 不认真的 bx、闸门不真探 google;`vitest.setup.ts` 把 `CODEX_HOME` 指到空临时目录,测试不读主人的 `~/.codex`。
