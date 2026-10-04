# Provider 失败的真实形状(arch backlog #4 · 第 1 步)

> 2026-10-02 · 采集 + 沙箱诱发 · 第 1 步只记录,不改判定。
> **第 2 步第一片(只 Claude 会话)2026-10-02 已落地**:§4.1 修掉,owner 决定与码闭集见 §6。
> **第 2 步余下部分 2026-10-02 已落地**(owner 当天批准):每家 provider 边界都产码,下游只读码,文本判定只剩「码缺失」时的回退 —— 见 §7。§3 的表按新形状重生成;§4 每一条都标了修掉了没有、没修的为什么。
> **2026-10-03 补一块**:Cursor ACP 把自己的报错**写进助理消息**、照常 `end_turn`(#206 发现的「Agent Looping Detected」)—— ACP 边界按 cursor-agent 的固定写法认出来,带码收尾,见 §8。
> 方向(owner 已定):每个 provider 边界产出结构化错误码,下游不再对错误文本跑正则。动手之前,先把每家**真实**失败长什么样、今天各判定处怎么判它们摸清楚。这一份就是那张底。
> 样本(已脱敏)在 `src/daemon/diagnostics/__fixtures__/provider-errors/*.json`,`provider-error-shapes.test.ts` 把今天每一处判定对每条样本的回答钉住。第 2 步改判定时它会红,这是有意的:改 fixture 里那条的 `current`,再回这里划掉对应的错判。

两条 owner 红线今天仍然有效,下文凡涉及处都标出来:

- **红线 A**:Claude 只在两句哨兵(`Please run /login` / `Not logged in`)上报「登录过期」。2026-10-02 owner 细化:SDK 标了 `authentication_failed` 但哨兵没中 ⇒ **仍判认证失败**,但给人看的话不说「登录过期 / 重新登录」(见 §6)。
- **红线 B**:agy 的歧义句(`authentication failed or timed out`)按瞬时处理。2026-09-02 起推广为通则:**像 auth 又像瞬时的,一律判瞬时**(`lib/auth-failure.ts` 顶部注释)。

## 1. 怎么采的

### 1.1 采集(真机历史,只读)

| 来源 | 里面有什么 |
|---|---|
| `~/.claude/channels/wechat/launchd.err.log`(41 MB,2026-06 起) | 一次性评估(ingest / gardener / threads / visit)的失败行,`[SESSION_ERROR]`/`[SESSION_RESULT]`,AI SDK 的整段错误对象打印 |
| `channel.log` + 两份轮转(`.1` `.2`) | `[TURN] outcome=…`、`[FALLBACK_REPLY]`(哪些错误文本被当成回复发出去了) |
| `failure-shapes.jsonl`(7 条,2026-09-06/07) | `diagnostics/failure-shapes.ts` 的采集器,带当时四处判定的分歧 |
| `wechat-cc.db`(`mode=ro`)`turn_records` / `workbench_events` | 会话轮次的 `error` 列;工作台的 `error` 事件(额度、模型不支持、ACP) |
| `health-incidents.json` | 全部是 `dependency=wechat` 的网络事故 —— **LLM 依赖一次事故都没记过** |

没有找到任何一条 `AUTH_FAILED` 日志行(`LLM_HEALTH` 只有两条,都不是失败):这段时间里 claude 的双哨兵与 codex 的登录失效在真机上一次都没触发过。所以登录失效类样本几乎全部来自诱发。

### 1.2 诱发(沙箱,走 daemon 同一份 provider 代码)

一个一次性 harness(不入库)按 case 起子进程,**环境从零构造**(不继承主人 shell 的任何变量):每个 case 一个全新的临时 `HOME`,外加 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_*` 全部指进去;key 一律是写明 `SANDBOXBOGUS` 的假值;网络故障用 `http://127.0.0.1:9`(拒连)、`*.invalid`(解析失败)、`10.255.255.1`(黑洞,超时)。主人的钥匙串、`~/.claude`、`~/.codex`、`~/.cursor`、`~/.gemini`、`daemon.env` 一样没碰。先用 `cursor-agent status` 在临时 HOME 下确认返回 `Not logged in`,证明钥匙串隔离生效,再开始诱发。

每个 case 走的是 daemon 生产用的那一层,不是裸 CLI:

| provider | 一次性评估(`cheap_eval`) | 会话(`session`) | 另抓的原始层 |
|---|---|---|---|
| claude | `createClaudeAgentProvider(...).cheapEval` | 同一 provider 的 `spawn` + `dispatch` | Agent SDK `query()` 原始消息(provider 拍平之前) |
| codex | `createCodexAgentProvider(...).cheapEval` | `spawn` + `dispatch`(`runStreamed`) | — |
| cursor | `createAcpCursorChatProvider(...).cheapEval`(print 模式) | 同一 provider 的 `spawn`(ACP) | `cursor-agent acp` 的 JSON-RPC 错误对象(`setupError` 映射之前) |
| openai 兼容 | `createOpenAiAgentProvider` + `createAiSdkChatModel` 的 `cheapEval` | `spawn` + `dispatch`(自有循环) | 用假 key 打真 DeepSeek / Moonshot 端点,拿真 401 |
| gemini | `createGeminiAgentProvider(...).cheapEval`(真 `GoogleGenAI`,假 key) | — | — |

**agy 没有诱发,只采集**:它的登录态在主人真实 HOME 下(Google OAuth),临时 HOME 下没登录会弹浏览器登录页(就是 `agy-oauth-popup` 那个坑);拿主人真实 HOME 去断网又不算隔离。按安全规则只用历史样本 —— 好在 agy 是日志里样本最多的一家(150+ 行)。

### 1.3 覆盖面

| | 无效 / 缺失凭证 | 网络不可达 | 超时 | 额度 / 限流 | 其它 |
|---|---|---|---|---|---|
| claude | 诱发(未登录、假 key)+ 采集(403) | 诱发(拒连、DNS)+ 采集(TLS、睡眠) | 诱发 | 无样本(从没撞过) | 采集:daemon 回合看门狗 |
| codex | 诱发(未登录、假 key) | 诱发 · 见 §4.3(内部重试,长时间无输出) | 诱发 · 同左 | 采集(会话 + 工作台) | 采集:模型太新 / ChatGPT 账号不支持、裸 exit 1、空错误 |
| cursor | 诱发(print + ACP,未登录、假 key) | 诱发(死代理)+ 采集(ENOTFOUND、TLS) | 诱发(黑洞代理) | 采集(ACP 正文「Upgrade your plan」) | — |
| agy | **不可**(见上);采集到的只有歧义句 | 采集(DNS、EOF、TLS 超时、「network issue」) | 采集(歧义句、TLS 超时) | 无样本 | 采集:500 |
| openai 兼容 | 诱发(DeepSeek、Kimi 真 401) | 诱发(拒连、DNS)+ 采集(socket closed) | 诱发 · 见 §4.4(**无请求超时,一直挂着**)+ 采集(网关 524) | 无样本 | 采集:网关 503、步数预算 |
| gemini | 诱发(真 400) | 诱发(拒连) | 未做(deprecated) | — | — |

本机 DNS 走代理的 fake-ip,所以「解析失败」在 claude 身上长成 `ECONNRESET`,在 openai 兼容那条路上长成证书错误。真 `ENOTFOUND` / `no such host` 的样本取自采集(cursor、agy)。

## 2. 今天的判定处

每条样本都喂给下面全部判定(`provider-error-verdicts.ts` 的 `currentVerdicts`)。「下游看到的文本」与 `failure-shapes.classifyAll` 同一约定:有码的路径把码拼在前面(`auth_failed: …`)。

| 列名 | 判定 | 在哪 | 谁靠它做决定 |
|---|---|---|---|
| claudeSentinel | `isAuthFail('claude-sentinel')` 双哨兵 | `core/auth-fail.ts` | claude 会话里发 `code: auth_failed`(红线 A) |
| assistantText | `isAuthFail('assistant-text')` 窄集 | 同上 | `assertNotAuthFailed`:一次性评估的**返回正文** |
| sdkError | `isAuthFail('sdk-error')` 宽集 | 同上 | turn-emitter 给 codex / ACP 的错误盖 `auth_failed` |
| authFailError | `isAuthFailError`:`status === 401` 或宽集 | 同上 | openai 兼容 / turn-emitter |
| llmHealthAuth | **第 2 步起**:provider 码优先,无码回退到 health/classify 的网络优先文本判定(以前是裸的 `looksLikeAuthFailure` 宽档) | `daemon/llm-health.ts` | 面板「测试连接」报 AUTH FAILED + 登录提示(`auth_rejected` 不给登录提示) |
| registryAuthCode | `isAuthError`:**第 2 步起**先看 provider 码(`auth_failed` / `auth_rejected`),无码才认 `auth_failed:` 前缀 | `core/provider-registry.ts` | cheapEval 冷却 60 分钟 vs 短冷却 |
| health/classify | `classifyFailure`:`errcode=-14` → **provider 码(有就只看码,第 2 步起)** → 网络优先 → auth → unknown | `daemon/health/classify.ts` | 要不要通知主人、多快通知 |
| 三档 | `classifyProviderFailure`(纯文本;瞬时判定借 health/classify 的网络判定) | `lib/auth-failure.ts` | **今天没有调用方**(所以它不读码,表里这一栏可能与码不一致,无害) |
| quota / quotaRefusalText | `classifyProviderError` / `isQuotaRefusalText` | `core/provider-quota.ts` | 额度登记、工作台「交给另一位」 |
| connectFailure | `isConnectFailure` | `lib/net-errors.ts` | health/classify 的网络判定、admin 命令 |

`text_event` 通道的样本要特别读:今天**没有任何判定看到它们** —— 它们是当成正文流过去的。表里给的是「假如它们进了判定会怎样」。

## 3. 样本与今天的判定

「边界产的码」一栏是第 2 步起 provider 边界挂上的码(`AgentEvent.error.code` 或抛出物的 `providerErrorCode`);各判定处有码就只看码。「health/classify」一栏的 **✗** 表示按 owner 已定的规则它判错了(真相 auth → 应为 `llm_auth`;歧义 / 网络 / 超时 → 应为 `network`;其余 → 至少不能是 `llm_auth`)。

### Claude(Agent SDK → claude 二进制)

| 样本 id | 真相 | 来源 | 路径 · 通道 | 原文(脱敏、截断) | 边界产的码 / 读的结构 | health/classify | 三档 | 其余判为真的 |
|---|---|---|---|---|---|---|---|---|
| `claude.not_logged_in.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `Claude Code returned an error result: Not logged in · Please run /login` | **`auth_failed`** 读:`assistant.error="authentication_failed"` `result.api_error_status=null` | llm_auth | auth_failed | claudeSentinel, assistantText, sdkError, authFailError, llmHealthAuth, registryAuthCode |
| `claude.not_logged_in.session` | auth | 诱发 | session · error_event | `claude reports not logged in: Not logged in · Please run /login` | **`auth_failed`** 读:`assistant.error="authentication_failed"` `result.api_error_status=null` | llm_auth | auth_failed | claudeSentinel, assistantText, sdkError, authFailError, llmHealthAuth, registryAuthCode |
| `claude.bad_key.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `Claude Code returned an error result: Failed to authenticate. API Error: 401 API key is invalid.` | **`auth_rejected`** 读:`assistant.error="authentication_failed"` `result.api_error_status=401` | llm_auth | auth_failed | llmHealthAuth, registryAuthCode |
| `claude.bad_key.session` | auth | 诱发 | session · error_event | `Failed to authenticate. API Error: 401 API key is invalid.` | **`auth_rejected`** 读:`assistant.error="authentication_failed"` `result.is_error=true` `result.api_error_status=401` | llm_auth | auth_failed | llmHealthAuth, registryAuthCode |
| `claude.forbidden_403.cheap_eval` | auth | 采集 | cheap_eval · thrown | `Claude Code returned an error result: Failed to authenticate. API Error: 403 Request not allowed` | **`auth_rejected`** 读:`assistant.error="authentication_failed"` `result.api_error_status=403`(推定) | llm_auth | auth_failed | llmHealthAuth, registryAuthCode |
| `claude.forbidden_403.session` | auth | 采集 | session · error_event | `Failed to authenticate. API Error: 403 Request not allowed` | **`auth_rejected`** 读:`assistant.error="authentication_failed"` `result.is_error=true` `result.api_error_status=403`(推定) | llm_auth | auth_failed | llmHealthAuth, registryAuthCode |
| `claude.net_refused.cheap_eval` | network | 诱发 | cheap_eval · thrown | `Claude Code returned an error result: API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)` | **`network`** 读:`assistant.error="server_error"` `result.api_error_status=null` | network | transient | connectFailure |
| `claude.net_refused.session` | network | 诱发 | session · error_event | `API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)` | **`network`** 读:`assistant.error="server_error"` `result.is_error=true` `result.api_error_status=null` | network | transient | connectFailure |
| `claude.net_dns.cheap_eval` | network | 诱发 | cheap_eval · thrown | `Claude Code returned an error result: API Error: Connection dropped (ECONNRESET)` | **`network`** 读:`assistant.error="server_error"` `result.api_error_status=null`(推定) | network | transient | connectFailure |
| `claude.timeout.cheap_eval` | timeout | 诱发 | cheap_eval · thrown | `Claude Code returned an error result: Request timed out` | **`network`** 读:`assistant.error="server_error"` `result.api_error_status=null` | network | transient | — |
| `claude.timeout.session` | timeout | 诱发 | session · error_event | `Request timed out` | **`network`** 读:`assistant.error="server_error"` `result.is_error=true` `result.api_error_status=null`(推定) | network | transient | — |
| `claude.tls.cheap_eval` | network | 采集 | cheap_eval · thrown | `Claude Code returned an error result: API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)` | **`network`** 读:`assistant.error="server_error"` `result.api_error_status=null`(推定) | network | transient | connectFailure |
| `claude.sleep.cheap_eval` | network | 采集 | cheap_eval · thrown | `Claude Code returned an error result: API Error: Your computer went to sleep mid-response. The response above may be incomplete.` | **`network`** 读:`assistant.error="server_error"` `result.api_error_status=null`(推定) | network | unknown | — |
| `claude.turn_watchdog.session` | not_provider | 采集 | session · error_event | `turn timed out after 600000ms with no activity` | — | network | transient | — |

### Codex(codex-sdk → codex exec;工作台走 app-server)

| 样本 id | 真相 | 来源 | 路径 · 通道 | 原文(脱敏、截断) | 边界产的码 / 读的结构 | health/classify | 三档 | 其余判为真的 |
|---|---|---|---|---|---|---|---|---|
| `codex.not_logged_in.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: «cf-ray», request id: «r…` | **`auth_failed`** | llm_auth | auth_failed | assistantText, sdkError, authFailError, llmHealthAuth, registryAuthCode |
| `codex.not_logged_in.session` | auth | 诱发 | session · error_event | `Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: «cf-r…` | **`auth_failed`** | llm_auth | auth_failed | assistantText, sdkError, authFailError, llmHealthAuth, registryAuthCode |
| `codex.bad_key.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `unexpected status 401 Unauthorized: Incorrect API key provided: «masked-key». You can find your API key at https://platform.openai.com/account/api-keys., url: h…` | **`auth_rejected`** | llm_auth | auth_failed | assistantText, sdkError, authFailError, llmHealthAuth, registryAuthCode |
| `codex.bad_key.session_exit` | auth | 诱发 | session · error_event | `Codex Exec exited with code 1: Reading prompt from stdin...⏎«ts» ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401…` | **`auth_rejected`** | llm_auth | transient | assistantText, sdkError, authFailError, llmHealthAuth, registryAuthCode, connectFailure |
| `codex.exec_exit_bare.session` | unknown | 采集 | session · error_event | `Codex Exec exited with code 1: Reading prompt from stdin...⏎` | — | unknown | unknown | — |
| `codex.empty_error.session` | unknown | 采集 | session · error_event | `(空)` | — | unknown | unknown | — |
| `codex.quota.session` | quota | 采集 | session · error_event | `You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try ag…` | **`quota`** | unknown | unknown | quota=quota |
| `codex.quota.workbench` | quota | 采集 | workbench · error_event | `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 20th, 2026 6:52 AM.` | **`quota`** | unknown | unknown | quota=quota |
| `codex.model_too_new.session` | model_unsupported | 采集 | session · error_event | `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.6-terra' model requires a newer version of Codex. Please upgrade to t…` | **`invalid_request`** | unknown | unknown | — |
| `codex.model_unsupported.workbench` | model_unsupported | 采集 | workbench · error_event | `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account…` | **`invalid_request`** | unknown | unknown | — |

### Cursor(一次性评估 = print 模式;会话 = ACP)

| 样本 id | 真相 | 来源 | 路径 · 通道 | 原文(脱敏、截断) | 边界产的码 / 读的结构 | health/classify | 三档 | 其余判为真的 |
|---|---|---|---|---|---|---|---|---|
| `cursor.not_logged_in.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `cursor-agent exited 1: Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.⏎` | **`auth_failed`** | llm_auth | auth_failed | llmHealthAuth, registryAuthCode |
| `cursor.not_logged_in.acp_raw` | auth | 诱发 | acp_setup · acp_error | `Authentication required` | **`auth_failed`** status=-32000 结构:`error.code=-32000` `error.data.message="Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'."` | llm_auth | auth_failed | llmHealthAuth, registryAuthCode |
| `cursor.not_logged_in.acp` | auth | 诱发 | acp_setup · thrown | `acp_auth_required` | **`auth_failed`** | llm_auth | auth_failed | llmHealthAuth, registryAuthCode |
| `cursor.bad_key.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `cursor-agent exited 1: ⚠ Warning: The provided API key is invalid.⏎The API key was loaded from the CURSOR_API_KEY environment variable.⏎Please check yo…` | **`auth_rejected`** | llm_auth | unknown | llmHealthAuth, registryAuthCode |
| `cursor.bad_key.acp` | auth | 诱发 | acp_setup · thrown | `acp_session_failed: Internal error` | **`provider_error`** 结构:`error.code=-32603` `error.data.message="Failed to initialize session services"` | unknown **✗** | unknown | — |
| `cursor.net_proxy.cheap_eval` | network | 诱发 | cheap_eval · thrown | `cursor-agent exited 1: ✗ Failed to reach the Cursor API. Check that your proxy (http://127.0.0.1:9/) is reachable.⏎` | **`network`** | network | unknown | — |
| `cursor.net_proxy.acp` | network | 诱发 | acp_setup · thrown | `acp_session_failed: Internal error` | **`provider_error`** 结构:`error.code=-32603` `error.data.message="Failed to initialize session services"` | unknown **✗** | unknown | — |
| `cursor.timeout_proxy.cheap_eval` | timeout | 诱发 | cheap_eval · thrown | `cursor-agent exited 1: ✗ Failed to reach the Cursor API. Check that your proxy (http://10.255.255.1:9/) is reachable.⏎` | **`network`** | network | unknown | — |
| `cursor.dns.cheap_eval` | network | 采集 | cheap_eval · thrown | `cursor-agent exited 1: Error: [unavailable] getaddrinfo ENOTFOUND api2.cursor.sh` | **`network`** | network | transient | connectFailure |
| `cursor.tls.cheap_eval` | network | 采集 | cheap_eval · thrown | `cursor-agent exited 1: Error: [aborted] Client network socket disconnected before secure TLS connection was established` | **`network`** | network | transient | — |
| `cursor.quota.acp_text` | quota | 采集 | workbench · text_event | `Upgrade your plan to continue` | **`quota`** | unknown | unknown | quotaRefusalText, quota=quota |

### agy(Antigravity CLI)

| 样本 id | 真相 | 来源 | 路径 · 通道 | 原文(脱敏、截断) | 边界产的码 / 读的结构 | health/classify | 三档 | 其余判为真的 |
|---|---|---|---|---|---|---|---|---|
| `agy.ambiguous.cheap_eval` | auth_ambiguous | 采集 | cheap_eval · thrown | `agy result status=ERROR: authentication failed or timed out` | **`network`** | network | transient | assistantText |
| `agy.tls_timeout.cheap_eval` | network | 采集 | cheap_eval · thrown | `agy result status=ERROR: Eligibility check failed: failed to get profile picture: Get "https://lh3.googleusercontent.com/a/«opaque»=s96-c": net/http: TLS handsh…` | **`network`** | network | transient | — |
| `agy.server_500.cheap_eval` | server | 采集 | cheap_eval · thrown | `agy result status=ERROR: Eligibility check failed: failed to fetch user info: 500 Internal Server Error` | **`server_error`** | network | unknown | — |
| `agy.dns.cheap_eval` | network | 采集 | cheap_eval · thrown | `agy result status=ERROR: Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": dial tcp: lookup daily-cloudcode-…` | **`network`** | network | transient | connectFailure |
| `agy.eof.cheap_eval` | network | 采集 | cheap_eval · thrown | `agy result status=ERROR: Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": EOF` | **`network`** | network | transient | connectFailure |
| `agy.userinfo_eof.cheap_eval` | network | 采集 | cheap_eval · thrown | `agy result status=ERROR: Eligibility check failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": EOF` | **`network`** | network | transient | connectFailure |
| `agy.network_issue.cheap_eval` | network | 采集 | cheap_eval · thrown | `agy result status=ERROR: There was a network issue connecting to the server, please try again.` | **`network`** | network | unknown | — |

### openai 兼容(自有循环 + AI SDK;DeepSeek / Kimi / 自建 litellm 网关)

| 样本 id | 真相 | 来源 | 路径 · 通道 | 原文(脱敏、截断) | 边界产的码 / 读的结构 | health/classify | 三档 | 其余判为真的 |
|---|---|---|---|---|---|---|---|---|
| `openai.bad_key_deepseek.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `Authentication Fails, Your api key: «masked-key» is invalid (request_id: «req-id»)` | **`auth_rejected`** status=401 | llm_auth | auth_failed | authFailError, llmHealthAuth, registryAuthCode |
| `openai.bad_key_deepseek.session` | auth | 诱发 | session · error_event | `Authentication Fails, Your api key: «masked-key» is invalid (request_id: «req-id»)` | **`auth_rejected`** status=401 | llm_auth | auth_failed | authFailError, llmHealthAuth, registryAuthCode |
| `openai.bad_key_moonshot.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `Invalid Authentication` | **`auth_rejected`** status=401 | llm_auth | auth_failed | authFailError, llmHealthAuth, registryAuthCode |
| `openai.bad_key_moonshot.session` | auth | 诱发 | session · error_event | `Invalid Authentication` | **`auth_rejected`** status=401 | llm_auth | auth_failed | authFailError, llmHealthAuth, registryAuthCode |
| `openai.bad_key_moonshot.status_lost` | auth | 诱发 | session · error_event | `Invalid Authentication` | — | llm_auth | auth_failed | llmHealthAuth |
| `openai.net_refused.cheap_eval` | network | 诱发 | cheap_eval · thrown | `Unable to connect. Is the computer able to access the url?` | **`network`** 结构:`err.code="ConnectionRefused"` | network | transient | connectFailure |
| `openai.net_refused.session` | network | 诱发 | session · error_event | `Unable to connect. Is the computer able to access the url?` | **`network`** | network | transient | connectFailure |
| `openai.net_dns.cheap_eval` | network | 诱发 | cheap_eval · thrown | `unknown certificate verification error` | **`network`** 结构:`err.code="UNKNOWN_CERTIFICATE_VERIFICATION_ERROR"` | network | transient | — |
| `openai.gateway_503.session` | server | 采集 | session · error_event | `Failed after 3 attempts. Last error: litellm.ServiceUnavailableError: ServiceUnavailableError: OpenAIException - <html>
⏎<head><title>503 Service Temporarily Un…` | **`server_error`** | network | unknown | — |
| `openai.gateway_524.session` | timeout | 采集 | session · error_event | `Failed after 3 attempts. Last error: <none>` | **`server_error`** 结构:`RetryError.errors[].statusCode=524` `RetryError.reason="maxRetriesExceeded"` `APICallError.isRetryable=true` | network | unknown | — |
| `openai.socket_closed.session` | network | 采集 | session · error_event | `The socket connection was closed unexpectedly. For more information, pass 'verbose: true' in the second argument to fetch()` | **`network`** | network | transient | connectFailure |
| `openai.step_budget.session` | not_provider | 采集 | session · error_event | `step budget 25 exhausted` | — | unknown | unknown | — |

### Gemini API-key 路(deprecated)

| 样本 id | 真相 | 来源 | 路径 · 通道 | 原文(脱敏、截断) | 边界产的码 / 读的结构 | health/classify | 三档 | 其余判为真的 |
|---|---|---|---|---|---|---|---|---|
| `gemini.bad_key.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc…` | **`auth_rejected`** status=400 | llm_auth | unknown | llmHealthAuth, registryAuthCode |
| `gemini.net_refused.cheap_eval` | network | 诱发 | cheap_eval · thrown | `Unable to connect. Is the computer able to access the url?` | **`network`** | network | transient | connectFailure |
## 4. 错判与分歧(按代价排)

### 4.1 ~~Claude 会话路径:API 错误被当成正文,原样发给主人~~ —— 2026-10-02 已修(第 2 步第一片,见 §6)

诱发结果:未登录以外的所有 API 失败(401 假 key、拒连、超时),在会话路径上都是 **一个 `text` 事件 + 一个正常的 `result` 事件**。回合记成 `completed`,没有任何判定看到它;主人没调 reply 工具时,coordinator 的 fallback 把这句原文当成回复发到微信。真机上发生过:`channel.log` 2026-07-28 `[FALLBACK_REPLY] provider=claude chunks=1 preview="Failed to authenticate. API Error: 403 Request not allowed"`。

而 SDK 其实**给了**结构:助理消息上 `error: "authentication_failed" | "server_error"`、`is_api_error_message: true`,结果消息上 `is_error: true`、`terminal_reason: "api_error"`、`api_error_status: 401 | null`。`claude-agent-provider.ts` 把它们全丢了,只留正文给双哨兵去扫。一次性评估路径同理:SDK 抛的是 `Claude Code returned an error result: <正文>`,结构也没了。

**红线 A 在这里的位置**:红线防的是「把模型正文里引用的 401 当成登录失效」。SDK 的 `error: "authentication_failed"` 不是正文,是 SDK 对一次 API 失败的标注 —— 用它不会误伤正文。但它会让 401 假 key / 403 `Request not allowed` 也报成 auth,这超出了「只在双哨兵上报登录过期」的字面。~~第 2 步要 owner 定~~ **owner 2026-10-02 已定**:可以报 auth,但文案不说「登录过期」—— 见 §6。

**修复后(会话路径)**:SDK 标了 `error` 的助理消息不再发 text 事件;provider 等到同一轮的 result(拿 `api_error_status`)再发一个带码的 `error` 事件。回合不再是 `completed`,fallback 不外发,coordinator 按码走:认证码 ⇒ 释放会话 + 节流的认证提示;其余 ⇒ 按码说原因(第 2 步余下部分起:网络 / 服务端 / 限流 / 额度各一句,其余仍是「脑子卡了一下」)。

**一次性评估与工作台运行时(第 2 步余下部分,已修)**:`cheapEval` / `strongEval` 读同样的标注,SDK 抛出时把码挂在抛出物上(原文不变;标注了而 SDK 没抛时,错误原文不再被当成评估答案返回);工作台 Claude 运行时里带标注的主回合消息不进时间线、不推 result,带码收掉这一轮。

### 4.2 ~~agy 歧义句:决定通知的那处守住了红线 B,「测试连接」没守住~~ —— 已修(§7)

**修复**:agy 边界(`core/agy-errors.ts`)把这句**固定**映射成 `network`;`llm-health` 改成码优先、无码回退到网络优先的文本判定 —— 「测试连接」不再报 AUTH FAILED、不给重新登录提示。codex 那条顺序依赖也修了:codex 边界先看 HTTP status 再看「连不上」措辞,websocket 401 ⇒ `auth_rejected`。


`agy result status=ERROR: authentication failed or timed out`:health/classify 判 `network` ✓,三档判 `transient` ✓,registry 不当 auth ✓ —— 红线 B 今天守住了,**但只靠 health/classify 里「网络优先」这一个顺序**。同一句在 `llm-health` 的 `AUTH_RE`(`looksLikeAuthFailure`)上是 auth,面板「测试连接」会报 AUTH FAILED 外加「去重新登录」提示;`assistant-text` 窄集也命中(今天只扫返回正文,碰不到它)。顺序依赖反过来也会伤人:`codex.bad_key.session_exit` 的 stderr 是 `failed to connect to websocket: HTTP error: 401 Unauthorized`,真 401 先撞上 `failed to connect` 被判成网络。

### 4.3 Cursor:唯一的结构化码没人认;ACP 上 key 无效与断网逐字相同 —— 前一半已修,后一半**修不了**(§7)

**修复**:ACP `-32000` ⇒ `auth_failed`(挂在 `acp_auth_required` 抛出物上,coordinator 走认证分支,健康判 `llm_auth`);print 模式剥 ANSI 后认三句固定输出(key 无效 ⇒ `auth_rejected`、连不上 ⇒ `network`、催升级 ⇒ `quota`)。**没修、也不该猜**:ACP 上假 key 与死代理都是 `-32603` + `Failed to initialize session services`,一律 `provider_error`(owner 2026-10-02:不猜)。`data` 里真说了原因(连不上 / key 无效)才用它。


- ACP 未登录时 `session/new` 回 `{code: -32000, message: "Authentication required"}`,`setupError` 收成裸码 `acp_auth_required` —— 这正是第 2 步要的形状,但 health/classify、llm-health、三档**都判 unknown**(没人认这个码)。
- 假 key 和死代理在 ACP 上**都是** `{code: -32603, message: "Internal error", data: {message: "Failed to initialize session services"}}` → `acp_session_failed: Internal error`。光凭 ACP 这一面区分不了,只能靠 print 模式或 `cursor-agent status` 旁证。
- print 模式:`The provided API key is invalid.`(宽集只认 `invalid api key` 词序)、`Failed to reach the Cursor API. Check that your proxy … is reachable.`(网络词表里没有 `failed to reach`)都判 unknown;原文还带 ANSI 颜色码。

### 4.4 没有错误,只有沉默 —— codex 与 openai 兼容已修;Claude 的重试等待没动(§7)

**修复**:codex 有了两个边界超时(连不上 60s / 一个进展事件都没有 180s,对话、一次性评估、工作台 app-server 三条路都有),openai 兼容有了 connect(110s)/ idle(120s)请求超时,到点都以 `network` 码收尾。2026-10-02 重跑(codex-cli 0.153.4):拒连时 codex 并不是完全沉默,而是每 4s→43s 发一条 `Reconnecting... waiting for network`,永不结束 —— 这些通知以前当 error 事件下发,collectTurn 的看门狗按事件重置,于是**连 600s 看门狗都不会触发**。现在它们只记日志。**没动**:Claude 假 key 默认重试 90s 才出错 —— 那是 claude 二进制自己的重试,出来的错误已经带码;要不要压低 `CLAUDE_CODE_MAX_RETRIES` 是另一个决定。


| 场景 | 实测 | 下游看到的 |
|---|---|---|
| codex 一次性评估 / 会话,base URL 拒连或黑洞 | 一次性评估与会话各跑 400 秒,**都没有任何输出**(既无事件也不抛;推测是 codex 内部重连,未深究)| 设了预算的调用方(披露闸门)拿到自己的超时;**没设的(ingest、gardener 等)一直挂着** |
| openai 兼容,黑洞地址 | 40 秒内无任何输出:AI SDK 没有请求超时 | 会话只能等 600 秒回合看门狗:`turn timed out after 600000ms with no activity` |
| claude,假 key,默认重试 | 90 秒内无输出(401 也在重试);`CLAUDE_CODE_MAX_RETRIES=0` 时 2 秒 | 同上 |

这一类不是判定问题,是边界没有超时 —— 结构化错误码救不了一个永远不来的错误。第 2 步要顺手给每个边界一个 `timeout` 码的产生点。

### 4.5 ~~状态码被吃掉~~ —— 已修(§7)

**修复**:openai 兼容边界从 `RetryError.errors[]` 取最后一次的 status(524 ⇒ `server_error`,给人看的话是 `HTTP 524 (after 3 attempts): …`);一次性评估不再重抛成 `auth_failed: …`,原错误原样抛出、status 保留、挂码 `auth_rejected`;400 + `API_KEY_INVALID` ⇒ `auth_rejected`(openai 兼容与 gemini 共用 `codeForHttpStatus`)。


- 自建 litellm 网关 Cloudflare 524:AI SDK 重试三次后抛 `Failed after 3 attempts. Last error: <none>`,524 只在 `RetryError.errors[]` 里 → unknown。
- openai 兼容 `cheapEval` 把 401 重抛成 `auth_failed: …` 时新 Error **不带 status**。今天靠前缀还能认,但 Kimi 那句 `Invalid Authentication` 若丢了前缀与 status,就只剩散文词 `authentication` 撑着(样本 `openai.bad_key_moonshot.status_lost`)。
- Gemini 对无效 key 回 **400** `INVALID_ARGUMENT` / `reason: API_KEY_INVALID`,`isAuthFailError` 只认 401 → unknown。

### 4.6 ~~网络词表只认 Node 与 Bun,不认 Go 与各家 CLI 的说法~~ —— 已修(§7)

**修复**:各家边界自己认自己的说法(agy 的 Go 措辞、Claude 的睡眠断线走 SDK 标注 ⇒ `network`、Bun 的 socket closed 走 openai 边界);`lib/net-errors` 的文本回退也补上了 `no such host`、`<url>": EOF`、`socket connection was closed`。


agy(Go)`dial tcp: lookup …: no such host`、`…: EOF`、`There was a network issue connecting to the server`;openai 兼容(Bun)`The socket connection was closed unexpectedly`;claude `Your computer went to sleep mid-response` —— 全判 unknown(按规则应是 network:不通知、按瞬时)。今天的结果偏安全(unknown 也不打扰),但主人在「为什么没回」时拿不到「网络问题」这句解释。

### 4.7 信息在边界就丢光了 —— 一半已修

**修复**:codex 的 `Codex Exec exited with code 1` 不再原样抛出(以前 coordinator 拿不到 summary,回合 `error` 为空),变成 error 事件,stderr 里认得出原因就带码;spawn 失败的回合也记下 `error` 与 `errorCode`。**修不了**:stderr 本身只剩 `Reading prompt from stdin...` 的那种,信息确实没有,仍无码。


`Codex Exec exited with code 1: Reading prompt from stdin...⏎`(stderr 只剩第一行)、`turn_records` 里 5 行 `outcome=error` 而 `error` 为 NULL。这两类无论下游怎么判都只能是 unknown。

### 4.8 其它

- ~~codex 一轮里冒出 11 个 `error` 事件(`Reconnecting... 2/5 (…401…)` 是**非终止**的重连通知),每个都被盖上 `auth_failed`。~~ 已修:重连通知不再作为 error 事件下发(只记 `CODEX_RECONNECT` 日志),「error 事件 = 这一轮失败」的契约成立了。
- 额度类现在两条路都读码:边界产 `quota` / `rate_limited`,`provider-quota.note` 与工作台失败映射码优先,health/classify 仍判 unknown(额度不是坏链路,有意)。
- `classifyProviderFailure`(三档闭集)写好了但没有调用方;它与 health/classify 在全部样本上答案一致(瞬时 ⇔ network,auth ⇔ llm_auth)。

## 5. 第 2 步提议:边界产码

**原则**:错误在 provider 边界被**分类一次**,带着码往下走;下游(health/classify、llm-health、registry 冷却、coordinator 通知、工作台额度交接)只 `switch` 码,不再碰文本。文本只用于给人看。

**码的闭集**(在 `lib/auth-failure.ts` 现有三档上细化,下游仍可按三档聚合):

| 码 | 三档 | 谁会产出(依据本次样本) |
|---|---|---|
| `auth_missing` / `auth_invalid` | auth_failed | claude SDK `error=authentication_failed`;codex `auth error code: invalid_api_key` 与 401;ACP `-32000`;HTTP 401;Gemini `API_KEY_INVALID` |
| `quota` / `rate_limit` | (另一条路,保留 provider-quota 的 TTL 登记) | codex `usage limit`;cursor 拒绝正文;HTTP 429 |
| `network` | transient | ECONNREFUSED / ENOTFOUND / TLS / socket closed / Go 的 `no such host` `EOF` / cursor `Failed to reach` |
| `timeout` | transient | SDK `server_error` + `Request timed out`;**边界自己的超时**(§4.4) |
| `server` | transient | HTTP 5xx / 524 |
| `model_unsupported` | unknown(要主人换模型) | codex 400 `invalid_request_error` |
| `ambiguous` | transient | agy 那句;cursor ACP `-32603` |
| `unknown` | unknown | 其余,原文照留 |

**每家怎么产**(从结构最多的开始):

1. **claude**(会话路径 2026-10-02 已做,§6;一次性评估 / 工作台待做):读 SDK 助理消息的 `error` 字段与结果消息的 `is_error` / `api_error_status`,不再扫正文。会话路径上 `is_api_error_message: true` 的那条**不再作为 text 事件发出**,改发 `error` 事件(修掉 §4.1 的 fallback 外发)。**红线 A**:双哨兵仍是「登录过期」文案的唯一来源;`authentication_failed` 而非哨兵 → `auth_invalid`,文案不说登录过期 —— 这一条要 owner 拍板。
2. **openai 兼容 / gemini**:按 HTTP status 产码(401/403 → auth,400 + `API_KEY_INVALID` → auth,429 → rate_limit,5xx/524 → server),并从 `RetryError.errors[]` 取最后一个 status。给 AI SDK 调用加请求超时。
3. **cursor**:ACP 按 JSON-RPC code(`-32000` → `auth_missing`,`-32603` → `ambiguous`);print 模式剥 ANSI 后匹配它自己的三句(这是**边界内**的正则,只认这一家 CLI 的固定输出,不外溢)。
4. **codex**:codex 的错误文本里已有 `unexpected status <N>` 与 `auth error code: <code>` 这两个稳定的结构尾巴,在边界解析成码;非终止的 `Reconnecting…` 降成日志,不发 `error` 事件;给 `runStreamed` / 一次性评估一个边界超时。
5. **agy**:只有 `result status=ERROR: <文本>`。在边界把已知几句映射成码,**红线 B**:`authentication failed or timed out` 固定映射到 `ambiguous`(→ transient),不进 auth;其余未知句 → `unknown`。

**下游怎么收**:`health/classify` 与 `llm-health` 改为先看码,码缺失时才回退到今天的文本判定(过渡期两条路并存,用本次 fixture 对拍:回退路径在全部样本上的答案不得变);`provider-registry` 冷却与 coordinator 的 `auth_failed` 分支只认码。迁移完成后删掉回退与 `AUTH_FAIL_SDK_ERROR` 宽集。

**验证**:本 PR 的 fixture 就是第 2 步的回归语料 —— 每条样本加一个 `expectedCode`,测试同时钉「边界产的码」与「下游据码的结论」;§4 里每一条 ✗ 都应翻成 ✓,两条红线的断言(`provider-error-shapes.test.ts` 末尾那组)必须一直绿。

## 6. 第 2 步第一片:Claude 会话(2026-10-02)

**owner 决定(2026-10-02)**

1. Claude 的 API 错误(401/403、拒连、超时……)**不许**再作为回复文本发给主人;回合是失败,走已有的错误通知路径。
2. 红线 A 细化:「登录过期 / 请重新登录」的措辞**仍然只**属于两句哨兵。SDK 说 `authentication_failed` 而哨兵没中 ⇒ 归为认证失败,但措辞是「认证没通过(API 返回 401/403),请检查账号或密钥」。
3. 红线 B 不动(agy 歧义句按瞬时)。
4. 只做 Claude;其余 provider 不在这一片里重构,文本判定作为它们的回退保留。

**码闭集**(`src/lib/provider-error-code.ts`;§5 的提议按这一片实际需要收窄过,命名对齐既有的 `auth_failed` 与 provider-quota 的 `quota`)

| SDK 标注(助理消息 `error`) | `api_error_status` | 码 | coordinator | health/classify |
|---|---|---|---|---|
| 正文命中双哨兵(不论标注) | — | `auth_failed` | 回合 `auth_failed`;释放会话;节流提示「登录已过期 + `claude login`」 | `llm_auth` ·「模型登录已失效」 |
| `authentication_failed`(哨兵没中) | 401 / 403 | `auth_rejected` | 回合 `auth_failed`;释放会话;节流提示「认证没通过(API 返回 401/403),检查账号或密钥」 | `llm_auth` ·「模型认证没通过」(不说登录) |
| `server_error` | null / 缺 | `network` | 回合 `error`;「脑子卡了一下」 | `network` |
| `server_error` | 有(5xx / 529) | `server_error` | 同上 | `network` |
| `rate_limit` | — | `rate_limited` | 同上 | `unknown`(不判坏链路) |
| `billing_error` | — | `quota` | 同上 | `unknown` |
| `invalid_request` | — | `invalid_request` | 同上 | `unknown` |
| `unknown` / 新标注 | — | `provider_error` | 同上 | `unknown` |
| `max_output_tokens` | — | (不是失败) | 正文照常 | — |

- 没有标注的正文**一律是正文**,哪怕它在复述 401 —— 这一片没有新增任何文本正则。
- 码的流向:`AgentEvent.error.code` → `TurnSummary.errorCode` → `TurnRecord.errorCode`(新字段)→ `reportLlmTurnOutcome` 把码挂在抛出物的 `providerErrorCode` 上 → `classifyFailure` 有码只看码,没码才走旧的文本判定(其余 provider 全走这条回退,答案不变)。
- `network` 与 `server_error` 的区分用的是 SDK 自己的约定(`api_error_status` 为 null = 没拿到 HTTP 响应),不是正文。
- fixture:5 条 Claude 会话样本从 `text_event` 改成 `error_event` 并写上码与 `sdkStructure`(403 与超时两条的结构是按同模板诱发样本推定的,标了 `inferred`);今天各判定处的钉住答案一条没变 —— 变的是通道与给人看的话。
- 测试:`src/core/claude-api-error.test.ts` 把这 5 条样本按真实 SDK 形状重放进真的 Claude provider 与真的 coordinator(含 07-28 那句 403:微信只收到认证提示,不收到原文);`provider-error-shapes.test.ts` 红线组新增 4 条断言。

**还没做(下一片)**:~~Claude 的一次性评估与工作台运行时;§4.2–§4.8~~ —— 都在 §7 做了。

## 7. 第 2 步余下部分:每家边界产码(2026-10-02)

**owner 决定(2026-10-02)**:做完 #4 第 2 步 —— 每个 provider 边界产固定的码,下游读码,文本正则只作最后回退。两条红线不变:「登录过期」只属于 Claude 的两句哨兵(其余家的 `auth_failed` 只在「根本没有凭证、修法就是该家的登录命令」时产);agy 歧义句 = 瞬时。守护拒绝(`network_unprotected`,见 [network-guard.md](network-guard.md))**不是** provider 错误,永远不进这个闭集、不被归成 `network`。

**码闭集不变**(`lib/provider-error-code.ts`),新增两个帮手:`withProviderCode`(给已有抛出物挂码,保留 message / status)与 `codeForHttpStatus`(401/403 ⇒ `auth_rejected`;400 + `API_KEY_INVALID` ⇒ `auth_rejected`;402 ⇒ `quota`;429 ⇒ `rate_limited`;408 ⇒ `network`;5xx / 524 / 529 ⇒ `server_error`;其余 4xx ⇒ `invalid_request`)。

**每家怎么产**

| provider | 边界(文件) | 读什么 | 码 |
|---|---|---|---|
| codex 对话 / 一次性评估 | `core/codex-errors.ts` | codex 自己的固定尾巴:`unexpected status N` / `HTTP error: N`(**先于**「连不上」措辞)、`auth error code:`、`Missing bearer`、usage limit、`waiting for network` | `auth_failed`(Missing bearer)/ `auth_rejected` / `quota` / `invalid_request` / `network` |
| codex 工作台 | `core/workbench/codex-app-server.ts` | app-server 的 `TurnError.codexErrorInfo`(结构化;`httpStatusCode: null` = 没拿到响应) | 同上 + `rate_limited` / `server_error` |
| openai 兼容 / 工作台 API / gemini | `core/openai-error-code.ts` | `APICallError.statusCode` + `responseBody`、`RetryError.errors[]` 最后一次的 status、fetch 系统码、`lib/timeout-fetch` 自己的码 | 按 `codeForHttpStatus`;连不上 / 证书 / socket closed / 超时 ⇒ `network` |
| cursor ACP(对话 + 工作台) | `core/cursor-errors.ts` `acpErrorCode` | JSON-RPC `code` / `data` | `-32000` ⇒ `auth_failed`;`data` 说清原因才用它;`-32603` 无可用 data ⇒ `provider_error`(**不猜**) |
| cursor ACP 带内错误(对话 + 工作台,§8) | `core/cursor-errors.ts` `cursorAcpInbandError` + `acp/events` 翻译器 | 本轮**最后一个可见 update** 是一整块 `\n\n` + cursor-agent 的固定句 / `Error: ${String(e)}` 模板,stopReason `end_turn` | 见 §8 的表 |
| cursor print(一次性评估) | `core/cursor-errors.ts` `cursorPrintErrorCode` | 剥 ANSI 后 cursor-agent 的固定输出 | key 无效 ⇒ `auth_rejected`;`Failed to reach the Cursor API` ⇒ `network`;`Upgrade your plan` ⇒ `quota`;`Authentication required` ⇒ `auth_failed` |
| agy | `core/agy-errors.ts` | `result status=ERROR:` 后的 Go 固定措辞 | 歧义句 ⇒ **`network`**(红线 B);`no such host` / `": EOF` / TLS 超时 / network issue ⇒ `network`;5xx ⇒ `server_error`;**不产认证码** |
| claude 一次性评估 / 工作台 | `core/claude-agent-provider.ts` oneShot、`core/claude-workbench-runtime.ts`(码表在 `core/claude-api-error-code.ts`) | 与会话同一套 SDK 标注 | 同 §6 |

**边界超时**(结构化码救不了一个永远不来的错误 —— §4.4)

| provider | 超时 | 缺省 | 改 |
|---|---|---|---|
| codex(三条路) | connect:开始重连后再无进展 | 60s | `WECHAT_CODEX_CONNECT_TIMEOUT_MS` |
| codex(三条路) | first_event:一个进展事件(item / 回合结束)都没有 | 180s | `WECHAT_CODEX_FIRST_EVENT_TIMEOUT_MS` |
| openai 兼容(对话 / 评估 / 工作台 API / delegate) | connect:到响应头 | 110s(比 Cloudflare 的 100s 524 稍长,让真 524 先到) | `WECHAT_OPENAI_CONNECT_TIMEOUT_MS` |
| openai 兼容 | idle:流式正文相邻两块之间 | 120s | `WECHAT_OPENAI_IDLE_TIMEOUT_MS` |

到点都以 `network` 码收尾(codex 若最后一条重连通知里认得出别的码,比如 401,就用那个)。用户自己 /stop 不是超时,不挂码。

**下游怎么收**

- `health/classify`(要不要通知主人):有码只看码(§6 起就是)。
- `provider-registry.isAuthError`(cheapEval 冷却):码优先;有码但非认证 ⇒ 短冷却。
- `llm-health`(桌面「测试连接」):码优先;无码回退到 health/classify 的网络优先判定;`auth_rejected` 不给重新登录提示;结果带 `code`。
- coordinator(微信 / App 回话):认证两码 ⇒ 认证分支(措辞按码分);其余按码说老实的原因(`network`「连不上 … 网络问题」、`server_error`、`rate_limited`、`quota`),无码仍是「脑子卡了一下」。spawn 失败(比如 Cursor ACP 未登录)也读抛出物上的码,回合记下 `error` 与 `errorCode`。
- 工作台:失败时码优先映射成稳定错误码 `provider_auth_expired` / `provider_auth_rejected` / `provider_network` / `provider_server_error` / `provider_invalid_request` / `provider_quota_exhausted` / `provider_rate_limited`(原始码已有更具体的话就保留,例如 `acp_auth_required`);事件里是一句人话 + 原文摘要;微信完成通知说原因;桌面 `task.error` 横幅同一组文案;额度登记读码。

**沙箱验证**(与 #188 同一规矩:临时 HOME / `CODEX_HOME` / `CLAUDE_CONFIG_DIR`、假 key、本地拒连 / 黑洞 / 本地假服务;主人凭据零接触)

| 情形 | 之前 | 之后 |
|---|---|---|
| codex 对话,拒连 | 无限期每 4s→43s 一条 `Reconnecting... waiting for network`,回合永不结束 | 20s(测试里调小的 connect)后一条 `network` 码错误,回合结束 |
| codex 一次性评估,拒连 | 一直挂着 | 带 `network` 码抛出 |
| codex 工作台,拒连 | 只能等 10 分钟空闲上限 | connect 上限后 `network` 码收尾 |
| codex,本地假服务回 401 | 每条重连都盖 `auth_failed`,最后 exit 1 原样抛出 | 重连不下发,终态一条 `auth_rejected` |
| openai 兼容,拒连 / 黑洞 / 401 / 524 | 拒连认得;黑洞挂到 600s 看门狗;401 ⇒ `auth_failed:` 前缀丢 status;524 ⇒ `Last error: <none>` | `network` / `network`(8s 上限)/ `auth_rejected`(status 保留)/ `server_error` + `HTTP 524 (after 3 attempts)` |
| cursor,未登录 ACP / 死代理 print | `acp_auth_required` 没人认;print 判 unknown | `auth_failed` / `network` |
| claude 一次性评估,拒连 / 本地 401 | 结构丢失,只剩正文 | `network` / `auth_rejected` |

一次 harness 事故要记下:codex-cli 0.153 **不认** `OPENAI_BASE_URL` / `OPENAI_API_KEY` 环境变量 —— 第一次跑时请求去了真的 `api.openai.com`(没有任何凭证,回 `Missing bearer` 401)。之后改用沙箱 `config.toml` 里的自定义 `model_provider` 把 base URL 钉在 127.0.0.1,所有请求都落在本地。这也意味着 `network-guard` 里 codex 按 `OPENAI_BASE_URL` 判目标的那条假设要复核(不在本 PR 范围)。

**修不了 / 有意没做**

- Cursor ACP 上假 key 与死代理逐字相同 ⇒ `provider_error`,不猜。
- `Codex Exec exited with code 1: Reading prompt from stdin...` 这种 stderr 只剩一行的,信息在 codex 那边就没了,无码。
- Claude 假 key 默认重试约 90s 才出错:那是 claude 二进制自己的重试,出来的错已经带码;要不要压 `CLAUDE_CODE_MAX_RETRIES` 另议。
- agy 不产认证码(真机没见过明确的「凭证无效」句);agy 不能沙箱诱发,测试只用采集原文。
- `turn_timeout`(daemon 自己的回合看门狗)不是 provider 码,照旧。
- 文本回退(`AUTH_FAIL_SDK_ERROR` 宽集、`looksLikeAuthFailure`)还在:码缺失时(认不出的新措辞、旧路径)仍要用。等真机跑一段确认码覆盖够了再删。

## 8. Cursor ACP 的带内错误(2026-10-03)

**现象**(#206 回放真机 c4both 时发现):cursor-agent acp 一轮里出错时**不回 JSON-RPC 错误**,而是把报错写成一块 `agent_message_chunk`,然后照常回 `{"stopReason":"end_turn"}`。于是两条交付路(legacy 的 FALLBACK、daemon 的「最后一段」)都把这句报错当 CC 的回复发给主人 —— #190「错误不许当回复发」的同一类。

**协议 / CLI 实际给了什么**(cursor-agent `2026.09.02-c22c1a3`,ACP 服务端 `processPrompt` 的 catch,对照 c4both 录到的报文):

- **协议字段没有任何错误信号**:stopReason 只有 `end_turn` / `cancelled` 两种(`handlePrompt` 写死);没有 `_meta`、没有 error 字段、没有专门的 `session/update` 种类;进程不退出(没有退出码可读)。
- 唯一的结构信号是**写法本身**:catch 里**恰好一次** `sendAgentMessageChunk`(一整块,不是 token 流),前面固定两个换行,之后这一轮什么都不再发。
- 三种写法:

| 写法(一整块) | cursor 内部 | 码 |
|---|---|---|
| `\n\nPlease sign in to continue` | `ActionRequiredError` action=login(NOT_LOGGED_IN / AUTH_TOKEN_EXPIRED / UNAUTHORIZED …) | `auth_failed`(修法就是 `cursor-agent login`,合红线 A 对别家的约束) |
| `\n\nUpgrade your plan to continue` | action=upgrade(FREE/PRO 用量上限 **与** 各种 RATE_LIMIT 并在一句里) | `quota`(分不开,沿用已有判定) |
| `\n\nAdd a payment method to continue` | action=payment(USAGE_PRICING_REQUIRED) | `quota` |
| `\n\nCheck your settings to continue` | action=config(BAD_API_KEY / BAD_USER_API_KEY / OUTDATED_CLIENT 混在一起) | `provider_error`(不猜是 key 还是版本) |
| `\n\nError: [unauthenticated] Backend rejected authentication. Verify this is a User API Key …`(整句固定) | 未包装的 ConnectError,code Unauthenticated | `auth_rejected` |
| `\n\nError: ${String(e)}` —— `<Name>Error: ` 和 / 或 `[connect code] ` 开头 | `RetriableError` / `NonRetriableError`(`name: message`,ConnectError 的 message 以 `[code] ` 开头);真机的 `Error: NonRetriableError: Agent Looping Detected The model got stuck …` 就是这一种 | connect code:`unauthenticated` / `permission_denied` ⇒ `auth_rejected`;`resource_exhausted` ⇒ `rate_limited`;`unavailable` / `deadline_exceeded` / `aborted` ⇒ `network`;`internal` ⇒ `server_error`;`invalid_argument` / `failed_precondition` / `out_of_range` ⇒ `invalid_request`;没有 code 但正文是连不上(`isConnectFailure`)⇒ `network`;其余(含 Agent Looping Detected、Conversation data missing)⇒ `provider_error` |

`CancelledError` 不写(静默结束);action 不在表里时写的是服务端给的任意 message —— **认不出,照旧当正文**(没有固定句就不猜)。`No prompt content provided.` 只在空 prompt 时出现,我们不发空 prompt,不认。

**判定**(`core/cursor-errors.ts` `cursorAcpInbandError` + `core/acp/events.ts` 翻译器的 `inbandError` 选项):

1. 只看**一整块** chunk:必须以 `\n\n` 开头,余下部分**整句等于**上表的固定句,或匹配 `Error: ` + String(e) 模板(至少有错误类名或 connect code 之一,且后面还有正文)。正文里提到这些词、不是整块、没有 `\n\n` 前缀、模板对不上 ⇒ 一律不算。
2. 结构条件:认得出的那一块**先扣住**(工作台不流出、对话侧不进攒着的消息);它之后又来了文字或工具调用 ⇒ 它是正文,按原顺序放行;**直到 `end_turn` 都没人接** ⇒ 它就是本轮的错误。
3. 回合以 `{kind:'error', code, message: 原文}` 收尾(不是 `result`)。它**之前**的文字照常吐(与进程死掉 / prompt 报错同一条规矩);报错原文永远不作为 text 事件出去。
4. 老规则保留:整轮(无工具调用)输出就是催升级话 ⇒ `quota`(`provider-quota.isQuotaRefusalText`)。

**下游**(没有新代码,全是 §7 的既有收法):对话侧 daemon 交付 ⇒ 出错只发通知(`turnErrorNotice` 按码说原因;`auth_failed` 走认证分支 + `cursor-agent login` 提示),TurnRecord 记 `error` + `errorCode`;legacy(回滚开关)⇒ 报错原文不再被 FALLBACK,但它**之前**的文字照旧 FALLBACK 出去、且不发通知(legacy 对「出错但有文字」的轮本来就这样,与 Cursor 无关,不在本片改)。工作台 ⇒ `taskErrorForProviderCode` 映射成稳定错误码(`provider_quota_exhausted` / `provider_rate_limited` / `provider_network` …);`provider_error` 保留原文当 task.error。

**测试**(全用照真机形状演的假 `cursor-agent acp`,没有一次真 Cursor 调用):`cursor-errors.test.ts`(每种写法的码 + 「正文提到 looping」等反例)、`acp/events.test.ts`(扣住 / 放行 / 跨轮清空)、`acp-agent-provider.test.ts` 与 `acp-workbench-provider.test.ts`(对话 messages 模式与工作台 append 模式)、`conversation-coordinator.cursor-delivery.test.ts`(生产的 ACP 客户端 + 协调器 + 交付运行时:两臂都不把报错当回复;原样回放真机 c4both;`acp/scripted-agent.ts` 新增 `{ cliError }` 步骤照 catch 的写法发一整块)。

**残留**:cursor-agent 换版本可能改句式 —— 认不出就退回今天的行为(当正文发出去),不会误伤正文;换版本时按上面的位置(`processPrompt` 的 catch)重新核对一遍。
