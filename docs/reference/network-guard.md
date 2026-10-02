# 网络守护(守护 v2:按调用判)

> **2026-10-02 主人拍板(第一次,#191):** 不经隧道、直连模型供应商可能让账号被封。
>
> **2026-10-02 主人收窄(第二次,本版):** #191 管得太宽,把所有模型调用都停了。守护的职责改为:
> **「根据约定的网络信号,判断 CC 能不能开始一次需要保护的调用。」**

## 主人的决定(原话整理,逐条照做)

**一、按调用分类(不是按 provider 家族),看它真正连到哪、用哪个模型:**

- **默认需要保护:** Anthropic(Claude API / Claude Code / Agent SDK 走官方端点)、OpenAI(API、Codex)、Google(Gemini、agy/Antigravity)、OpenRouter 这类海外模型聚合;**Cursor 只有选了明确的 Claude / GPT / o 系列 / Gemini 模型时才算。**
- **默认不需要保护:** DeepSeek、Kimi 国内版(moonshot.cn)、通义/DashScope、智谱等国内平台;自建(localhost / 局域网 / 私网 IP / 主人自己的服务器);**Cursor 的 auto 和 Cursor 自家模型(如 composer-\*)**;**自定义网关(任何非官方 base URL,包括把 ANTHROPIC_BASE_URL 指到别处的 Claude Code)** —— 自定义网关默认不保护,给一个开关让用户自己纳入。
- **Kimi 国际版(api.moonshot.ai)等拿不准的端点:** 按端点 host 判,默认值写进文档(见下表)。
- **不认识的 Cursor 模型名 ⇒ 默认保护,可覆盖。**
- 覆盖写在 guard.json(`protect` / `trust` 两张表,按 host 和/或 `provider:模型` 通配);老字段 `enabled`、`probe_url`、`ipify_url` 保持兼容。
- 用 daemon 已经在记的每会话 / 每任务钉住的模型(`Mode.solo.model`、工作台任务模型、ACP 会话模型)在**调用那一刻**分类;换了模型,下一次调用就按新模型判。

**二、网络信号(只对需要保护的调用):**

- **装了 bx ⇒ bx 是唯一权威:** `protection_state == "protected"` 且 `tunnel_healthy` 才安全。关着 / 恢复中 / 读不出 ⇒ 需要保护的新调用暂停(**不回落到 Google 探测**)。例外:guard.json 明确把信号来源设成 Google 探测(给「装着 bx、实际在用别的 VPN」的情形),那就用探测。
- **没装 bx ⇒ daemon 自己的 Google 探测**(daemon 进程内 fetch,不是浏览器)。还没有第一次探测结果时:等一小会儿(几秒,有上限);还是没有 ⇒ 按失败算。**修掉原来的 fail-open**(调度器初始状态 `reachable: true`,第一次探测之前一律放行)。

**三、拦的范围:**

- 只拒绝那一次需要保护的调用;不需要保护的调用照常,哪怕此刻不安全(Claude 聊天暂停,不能连累 DeepSeek 的后台判断)。国内 / 自建的失败仍是普通连接错误 —— **永远不贴「网络未受保护」**。
- 故障转移链(cheapEval 等)逐个候选判:不安全时跳过需要保护的候选,照常试不需要保护的;一个能用的都没有才拒。
- 控制操作在不安全时必须照常:查看 / 状态、取消、权限 y/n 回复、换模型 / 换 provider、/set 等。微信入站原来的 `mw-guard` 在命令解析之前把**所有**入站都丢了 —— 改成命令和控制回复放行,只在这一轮真要调需要保护的 provider 的地方拦。
- 文案:拒绝需要保护的调用统一一句老实话,说清停的是哪一步,例如「网络未受保护(bx 未连上),用到 Claude 的这一步先暂停，恢复后再试。」;不重试、不退避风暴;后台任务安静跳过,只记一行日志。

**四、已经在跑的任务:** #191 的行为不变(bx 来源:从不停在跑的执行者;probe 来源:连续两次不安全才停),**但只对调用需要保护的执行者**;不需要保护的永远不停。

**五、看得见:** `/v1/health` 的 guard 块带上按调用的语义(信号 + 此刻配置 / 在用的 provider 里有没有需要保护的);桌面一行显示「bx 保护中」/「⚠ 网络未受保护：用到 Claude 等的调用暂停」/ 没用到需要保护的接口时「当前没有用到需要保护的接口」(不报红)。`wechat-cc guard status` 列出已配置 provider 的分类。

## 分类(`src/lib/call-classifier.ts`)

先定端点,再按端点 host / Cursor 模型判,最后套 guard.json 覆盖。纯函数,core / daemon / CLI 共用一份。

**端点从哪来**(`src/daemon/guard/targets.ts`):

| provider | 连到哪 |
|---|---|
| `claude` | `ANTHROPIC_BASE_URL`(daemon.env 或 `~/.claude/settings.json` 的 env 灌进来的);没设 = `api.anthropic.com` |
| `codex` | `OPENAI_BASE_URL`;没设 = `api.openai.com` |
| `openai`(openai-compatible) | agent-config `openaiBaseUrl`(DeepSeek / Kimi / 自建网关都走它);没设 = `api.openai.com` |
| `gemini` / `agy` | Google 官方 |
| `cursor` | Cursor 服务器;按**这一次的模型**判:会话的 `Mode.solo.model` → 工作台 `execution.model` → agent-config `cursorModel` → `auto` |
| 语音 | 通义 TTS = `dashscope.aliyuncs.com`;`http_tts` / STT = 配置里的 `base_url`;没配置 = 什么都不出门,不判 |
| 工作台额度查询 | Claude 的 usage 接口永远是 `api.anthropic.com`(哪怕会话走网关);Codex 同 codex |

**默认判定:**

| 类别 (`kind`) | 例子 | 需要保护 |
|---|---|---|
| `official` | `*.anthropic.com` `claude.ai` `*.openai.com` `chatgpt.com` `*.googleapis.com` `x.ai` `mistral.ai` `groq.com` … | 是 |
| `aggregator` | `openrouter.ai` `together.xyz` `fireworks.ai` `deepinfra.com` `poe.com` | 是 |
| `overseas_other`(拿不准、按 host 判成海外) | **Kimi 国际版 `api.moonshot.ai` / `moonshot.ai`**、通义国际版 `dashscope-intl.aliyuncs.com` | 是(`trust` 可放开) |
| `cursor_overseas` | Cursor + `claude*` `*sonnet*` `*opus*` `*haiku*` `gpt*` `o<数字>*` `*gemini*` `*codex*` | 是 |
| `cursor_unknown` | Cursor + 不认识的模型名(如 `kimi-k2`、`grok-4`) | 是(`trust` 可放开) |
| `cursor_own` | Cursor `auto` / `default` / `composer-*` / `cursor-*`;列模型目录 | 否 |
| `domestic` | `deepseek.com` `moonshot.cn` `aliyuncs.com`(DashScope) `bigmodel.cn` `volces.com` `siliconflow.cn` `baidubce.com` `minimax(i).chat/com` `lingyiwanwu.com` `tencentcloudapi.com` `baichuan-ai.com` `stepfun.com` `xf-yun.com` `sensenova.cn` `modelscope.cn` | 否 |
| `self_hosted` | `localhost` / 回环 / `10.x` `172.16–31.x` `192.168.x` / `169.254.x` / `100.64–127.x`(tailnet)/ `.local` `.lan` `.internal` `.home.arpa` `.ts.net` / 私网 IPv6 / 不带点的主机名 | 否 |
| `custom_gateway` | 其它任何 base URL(如主人的 `llm.youdamaster.cc`、Claude Code 的 `ANTHROPIC_BASE_URL=https://gw.example.com`) | 否;`protect_custom_gateways: true` ⇒ 是 |
| `unknown_provider` | 不认识的 provider、又没给端点 | 是(fail safe) |

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
  "protect_custom_gateways": false       // 新:自定义网关也纳入保护
}
```

`protect` / `trust` 条目三种写法:

| 写法 | 例子 | 匹配 |
|---|---|---|
| `provider:模型通配`(含冒号、不含 `://`) | `cursor:kimi-*`、`cursor:composer-*`、`openai:*` | provider 相同且模型匹配(`*` / `?` 通配,不分大小写);模型通配不是 `*` 时,没有模型的调用不匹配 |
| host(含点;可 `*.` 前缀,也可写整个 URL) | `api.moonshot.ai`、`*.youdamaster.cc`、`https://gw.example.com/v1` | 端点 host 等于它或是它的子域 |
| 裸 provider id(不含点也不含冒号) | `codex`、`cursor` | 这个 provider 的所有调用 |

**`protect` 压过 `trust`**(两边都命中按保护算,fail safe)。例:放开一个不认识的 Cursor 模型 `"trust": ["cursor:kimi-k2"]`;把主人自己的网关也纳入 `"protect": ["*.youdamaster.cc"]`;放开 Kimi 国际版 `"trust": ["api.moonshot.ai"]`。

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
- bx 模式每 10s 读一次 bx(本机 socket,只读,约 70ms);闸门优先用 30s 内的读数,过期就当场读(单飞 + 5s 短缓存)。探测模式的「等第一次结果」同样单飞 + 5s 缓存,不会因为并发调用刷探测。
- `protection_state` 的六个值是 bx 的对外契约(`internal/protectionstate`),只有 `protected` 算数。

## 拦在哪里

统一契约在 `src/lib/network-gate.ts`:`NetworkGate.check()`(信号)+ `classify()`(分类)、`decideCall()` / `assertCallAllowed()`(先分类、需要保护才看信号)、统一文案 `unprotectedMessage(verdict, label)`、错误 `NetworkUnprotectedError`(`code: 'network_unprotected'`,带被暂停那一步的名字)。daemon 实现在 `src/daemon/guard/gate.ts` + `runtime.ts`,`main.ts` 最先建好往下传。

| 位置 | 按什么分类 | 需要保护且不安全时 |
|---|---|---|
| 协调器 `dispatchSolo` / 多人模式参与者(`src/core/conversation-coordinator.ts` `admitProviders`) | 这一轮的 provider + 这条对话钉的模型 | 单人:不 acquire,回一句统一的话(按 reply sink 落到发起的那一面),不重试。`/both` `/chat`:**只拿掉被挡的那几位**,一句话说明,其余照常发言(剩一位就降成单人) |
| `ProviderRegistry` → `withNetworkGate`(`src/core/provider-registry.ts`) | `spawn` 用 `ctx.model` / `ctx.execution.model`;`cheapEval` / `strongEval` 用 provider 的配置模型;`modelCatalog` 不算模型回合(Cursor 列目录不保护) | 抛 `NetworkUnprotectedError`,不起子进程、不发请求 |
| cheapEval 故障转移 | 逐个候选 | 跳过需要保护的候选(**不记冷却**),照常试不需要保护的;都被挡才抛。显式钉了 `cheap_eval_provider` 时只用它(不故障转移),它需要保护就照样暂停 |
| `SessionManager.spawn` 与 `handle.dispatch` | provider + 这条会话 spawn 时的模型(`handle.model`) | 抛错;推送 / 打猎 / 议程的 `dispatchToChat` 走这里 |
| delegate(`src/daemon/bootstrap/delegate.ts`) | 同 registry(带 provider id 包一层) | 同上 |
| 工作台 `execute()` / `submitInput()` | 执行者 + 这一轮的 `execution.model` | 任务以 `network_unprotected` 失败 / 补充返回 503;Cursor auto、国内网关的执行者照常起 |
| 工作台额度查询(`wire-workbench.ts`) | Claude → `api.anthropic.com`;Codex → codex | 返回 null,不出门 |
| `cli-reply-handler` resume(微信「@码 文本」、A2A `/a2a/cli/reply`) | 终端会话来源(claude / codex,各自的 base URL) | 不起 CLI,回统一的话 |
| 语音 `gateVoice` | 这一次连到的端点 | 不出门;通义 / 自建 / 局域网照常 |
| 后台 tick(companion push / introspect / ingest)`skipWhenUnsafe` | 此刻配置 / 在用的 provider | 信号不安全且**全都**需要保护 ⇒ 这一拍安静跳过;有不需要保护的 ⇒ 照跑,里面需要保护的那几次被各自的闸门拒掉,冒上来的「网络未受保护」不算失败。同一段不安全期同一个任务只记一行日志 |
| 每晚整理记忆 | 它用的 cheapEval | 评估被守护拒 ⇒ `skipped: network_unprotected`,**不记** `failed_today` |
| **已经在跑**的工作台执行者(`lifecycle-deps.ts` `onReading` + `pause-policy.ts`) | 执行者 + 这一轮的模型 | bx 来源:不停(bx fail-closed,出不去也就漏不了)。probe 来源:连续两次不安全才停,**只停需要保护的执行者**,不需要保护的永远不停 |
| 网络翻成不安全的那一刻(`onStateChange`) | 会话的 provider + 模型 | `SessionManager.shutdownProtected()`:只关需要保护的对话会话 |

**入站不再拦。** 微信入站链里原来的 `mw-guard` 已删除:管理 / 模式命令、`y`/`n` 权限回复、取消、换模型、`/set` 照常;闲聊进协调器,由上表按调用拦。

## 刻意不拦

- **本地推理:** 嵌入(transformers.js / python embed-runner)、atelier 本地 sd-cli 渲染。首次下载权重(HuggingFace)不带模型账号。
- **非模型流量:** 微信 ilink、中继、A2A、邮箱轮询、ipify / google 探测本身、R2 更新源。
- **CLI 一次性命令:** `wechat-cc memory …` / `wechat-cc sessions …` 在 CLI 进程里直接调 SDK —— 主人在终端前手动发起,和直接敲 `claude` 同一个性质。`wechat-cc guard status` 会照实告诉他此刻信号和各 provider 的分类。
- **已经发出的那一个请求:** 守护只能在出发前拦。

## 看得见

- `GET /v1/health` 的 `guard` 块:`{ enabled, source: 'bx'|'probe'|'off', safe, detail, ip, checked_at, signal_source, protected_in_use, paused, providers: [{ id, model, host, protected, kind, label, reason }] }`。`safe` 只是信号;`paused = enabled && !safe && protected_in_use` 才是「有需要保护的调用此刻被停」。新字段都可选,老 daemon 没有。
- 桌面「此刻」页连接区一行:`bx 保护中`(绿)/ `⚠ 网络未受保护：用到 Claude 等的调用暂停`(红,`Claude` 换成第一个需要保护的接口名;悬停提示可跑 `bx leakcheck`)/ `当前没有用到需要保护的接口`(中性,不报红)。守护关着不显示;老 daemon 没有 `protected_in_use` 时按「有」算,不默认绿。设置抽屉里那一行同口径。
- `wechat-cc guard status [--json]`:信号(`source` / `safe` / `detail` / `bx_path` / `signal_source`)+ 按配置推出的 provider 分类(`providers`、`protected_in_use`;只读配置,不发流量)。
- 日志 tag `GUARD`:状态翻转、每个被拒的回合(带被停的接口名)、cheapEval 跳过的候选、每个被跳过的后台任务(每段一次)。

## 怎么验

```bash
bx status --json | jq '{protection_state, tunnel_healthy}'   # 只读,本机 socket
wechat-cc guard status                                        # 信号 + 各 provider 是否需要保护
```

不要为了验证去 `bx down`、`bx setup`,也不要跑任何会把流量送出隧道的检查(例如 `bx leakcheck --compare-direct`)。断网路径由单测覆盖:`src/lib/call-classifier.test.ts`(分类表)、`src/daemon/guard/owner-table.test.ts`(主人那张表逐格 + 端点 / 模型解析 + health)、`src/daemon/guard/*.test.ts`(bx JSON、超时、fail closed、第一次探测的有界等待)、`src/core/provider-registry.network-gate.test.ts`(逐候选故障转移、Claude 聊天停 + DeepSeek 后台照常)、`src/core/conversation-coordinator.test.ts`(network gate 一节)、`src/core/session-manager.test.ts`、`src/core/workbench/service-network-gate.test.ts`、`src/daemon/inbound/pipeline.integration.test.ts`(入站控制照常)、`src/daemon/ilink/voice-gate.test.ts`、`src/daemon/cli-reply-handler.test.ts`、`src/daemon/memory/nightly.test.ts`、健康路由与桌面渲染测试。测试里永远注入执行器 / 探测,单测进程下 `findBx()` 不认真的 bx、闸门不真探 google。
