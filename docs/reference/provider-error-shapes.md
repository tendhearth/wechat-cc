# Provider 失败的真实形状(arch backlog #4 · 第 1 步)

> 2026-10-02 · 采集 + 沙箱诱发 · **只记录,不改判定**。
> 方向(owner 已定):每个 provider 边界产出结构化错误码,下游不再对错误文本跑正则。动手之前,先把每家**真实**失败长什么样、今天各判定处怎么判它们摸清楚。这一份就是那张底。
> 样本(已脱敏)在 `src/daemon/diagnostics/__fixtures__/provider-errors/*.json`,`provider-error-shapes.test.ts` 把今天每一处判定对每条样本的回答钉住。第 2 步改判定时它会红,这是有意的:改 fixture 里那条的 `current`,再回这里划掉对应的错判。

两条 owner 红线今天仍然有效,下文凡涉及处都标出来:

- **红线 A**:Claude 只在两句哨兵(`Please run /login` / `Not logged in`)上报「登录过期」。
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
| llmHealthAuth | `looksLikeAuthFailure`:码 + 厂商散文 | `lib/auth-failure.ts`(`llm-health` 的 `AUTH_RE` 就是它) | 面板「测试连接」报 AUTH FAILED + 登录提示 |
| registryAuthCode | `isAuthError`:只认 `auth_failed` 码 | `core/provider-registry.ts` | cheapEval 冷却 60 分钟 vs 短冷却 |
| health/classify | `classifyFailure`:`errcode=-14` → **网络优先** → auth → unknown | `daemon/health/classify.ts` | 要不要通知主人、多快通知 |
| 三档 | `classifyProviderFailure`(瞬时判定借 health/classify 的网络判定) | `lib/auth-failure.ts` | **今天没有调用方** |
| quota / quotaRefusalText | `classifyProviderError` / `isQuotaRefusalText` | `core/provider-quota.ts` | 额度登记、工作台「交给另一位」 |
| connectFailure | `isConnectFailure` | `lib/net-errors.ts` | health/classify 的网络判定、admin 命令 |

`text_event` 通道的样本要特别读:今天**没有任何判定看到它们** —— 它们是当成正文流过去的。表里给的是「假如它们进了判定会怎样」。

## 3. 样本与今天的判定

「health/classify」一栏的 **✗** 表示按 owner 已定的规则它判错了(真相 auth → 应为 `llm_auth`;歧义 / 网络 / 超时 → 应为 `network`;其余 → 至少不能是 `llm_auth`)。

### Claude(Agent SDK → claude 二进制)

| 样本 id | 真相 | 来源 | 路径 · 通道 | 原文(脱敏、截断) | provider 已给的码 / 被丢掉的结构 | health/classify | 三档 | 其余判为真的 |
|---|---|---|---|---|---|---|---|---|
| `claude.not_logged_in.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `Claude Code returned an error result: Not logged in · Please run /login` | 丢:`assistant.error="authentication_failed"` `assistant.is_api_error_message=true` `result.is_error=true` `result.terminal_reason="api_error"` `result.api_error_status=null` | llm_auth | auth_failed | claudeSentinel, assistantText, sdkError, authFailError, llmHealthAuth |
| `claude.not_logged_in.session` | auth | 诱发 | session · error_event | `claude reports not logged in: Not logged in · Please run /login` | code=`auth_failed` | llm_auth | auth_failed | claudeSentinel, assistantText, sdkError, authFailError, llmHealthAuth, registryAuthCode |
| `claude.bad_key.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `Claude Code returned an error result: Failed to authenticate. API Error: 401 API key is invalid.` | 丢:`assistant.error="authentication_failed"` `result.is_error=true` `result.terminal_reason="api_error"` `result.api_error_status=401` | llm_auth | auth_failed | llmHealthAuth |
| `claude.bad_key.session` | auth | 诱发 | session · text_event | `Failed to authenticate. API Error: 401 API key is invalid.` | 丢:`assistant.error="authentication_failed"` `result.is_error=true` `result.api_error_status=401` | llm_auth | auth_failed | llmHealthAuth |
| `claude.forbidden_403.cheap_eval` | auth | 采集 | cheap_eval · thrown | `Claude Code returned an error result: Failed to authenticate. API Error: 403 Request not allowed` | — | llm_auth | auth_failed | llmHealthAuth |
| `claude.forbidden_403.session` | auth | 采集 | session · text_event | `Failed to authenticate. API Error: 403 Request not allowed` | — | llm_auth | auth_failed | llmHealthAuth |
| `claude.net_refused.cheap_eval` | network | 诱发 | cheap_eval · thrown | `Claude Code returned an error result: API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)` | 丢:`assistant.error="server_error"` `result.is_error=true` `result.terminal_reason="api_error"` | network | transient | connectFailure |
| `claude.net_refused.session` | network | 诱发 | session · text_event | `API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)` | 丢:`assistant.error="server_error"` `result.is_error=true` | network | transient | connectFailure |
| `claude.net_dns.cheap_eval` | network | 诱发 | cheap_eval · thrown | `Claude Code returned an error result: API Error: Connection dropped (ECONNRESET)` | — | network | transient | connectFailure |
| `claude.timeout.cheap_eval` | timeout | 诱发 | cheap_eval · thrown | `Claude Code returned an error result: Request timed out` | 丢:`assistant.error="server_error"` `result.is_error=true` `result.terminal_reason="api_error"` | network | transient | — |
| `claude.timeout.session` | timeout | 诱发 | session · text_event | `Request timed out` | — | network | transient | — |
| `claude.tls.cheap_eval` | network | 采集 | cheap_eval · thrown | `Claude Code returned an error result: API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)` | — | network | transient | connectFailure |
| `claude.sleep.cheap_eval` | network | 采集 | cheap_eval · thrown | `Claude Code returned an error result: API Error: Your computer went to sleep mid-response. The response above may be incomplete.` | — | unknown **✗** | unknown | — |
| `claude.turn_watchdog.session` | not_provider | 采集 | session · error_event | `turn timed out after 600000ms with no activity` | — | network | transient | — |

### Codex(codex-sdk → codex exec)

| 样本 id | 真相 | 来源 | 路径 · 通道 | 原文(脱敏、截断) | provider 已给的码 / 被丢掉的结构 | health/classify | 三档 | 其余判为真的 |
|---|---|---|---|---|---|---|---|---|
| `codex.not_logged_in.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: «cf-ray», request id: «req-id»` | — | llm_auth | auth_failed | assistantText, sdkError, authFailError, llmHealthAuth |
| `codex.not_logged_in.session` | auth | 诱发 | session · error_event | `Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: «cf-ray»)` | code=`auth_failed` | llm_auth | auth_failed | assistantText, sdkError, authFailError, llmHealthAuth, registryAuthCode |
| `codex.bad_key.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `unexpected status 401 Unauthorized: Incorrect API key provided: «masked-key». You can find your API key at https://platform.openai.com/account/api-keys., url: https://api…` | — | llm_auth | auth_failed | assistantText, sdkError, authFailError, llmHealthAuth |
| `codex.bad_key.session_exit` | auth | 诱发 | session · thrown | `Codex Exec exited with code 1: Reading prompt from stdin...⏎«ts» ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthori…` | — | network **✗** | transient | assistantText, sdkError, authFailError, llmHealthAuth, connectFailure |
| `codex.exec_exit_bare.session` | unknown | 采集 | session · thrown | `Codex Exec exited with code 1: Reading prompt from stdin...⏎` | — | unknown | unknown | — |
| `codex.empty_error.session` | unknown | 采集 | session · error_event | `(空)` | — | unknown | unknown | — |
| `codex.quota.session` | quota | 采集 | session · error_event | `You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:2…` | — | unknown | unknown | quota=quota |
| `codex.quota.workbench` | quota | 采集 | workbench · error_event | `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 20th, 2026 6:52 AM.` | — | unknown | unknown | quota=quota |
| `codex.model_too_new.session` | model_unsupported | 采集 | session · error_event | `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.6-terra' model requires a newer version of Codex. Please upgrade to the latest …` | — | unknown | unknown | — |
| `codex.model_unsupported.workbench` | model_unsupported | 采集 | workbench · error_event | `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}` | — | unknown | unknown | — |

### Cursor(一次性评估 = print 模式;会话 = ACP)

| 样本 id | 真相 | 来源 | 路径 · 通道 | 原文(脱敏、截断) | provider 已给的码 / 被丢掉的结构 | health/classify | 三档 | 其余判为真的 |
|---|---|---|---|---|---|---|---|---|
| `cursor.not_logged_in.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `cursor-agent exited 1: Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.⏎` | — | llm_auth | auth_failed | llmHealthAuth |
| `cursor.not_logged_in.acp_raw` | auth | 诱发 | acp_setup · acp_error | `Authentication required` | status=-32000 丢:`error.code=-32000` `error.data.message="Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'."` | llm_auth | auth_failed | llmHealthAuth |
| `cursor.not_logged_in.acp` | auth | 诱发 | acp_setup · thrown | `acp_auth_required` | — | unknown **✗** | unknown | — |
| `cursor.bad_key.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `cursor-agent exited 1: ⚠ Warning: The provided API key is invalid.⏎The API key was loaded from the CURSOR_API_KEY environment variable.⏎Please check you have the right ke…` | — | unknown **✗** | unknown | — |
| `cursor.bad_key.acp` | auth | 诱发 | acp_setup · thrown | `acp_session_failed: Internal error` | 丢:`error.code=-32603` `error.data.message="Failed to initialize session services"` | unknown **✗** | unknown | — |
| `cursor.net_proxy.cheap_eval` | network | 诱发 | cheap_eval · thrown | `cursor-agent exited 1: ✗ Failed to reach the Cursor API. Check that your proxy (http://127.0.0.1:9/) is reachable.⏎` | — | unknown **✗** | unknown | — |
| `cursor.net_proxy.acp` | network | 诱发 | acp_setup · thrown | `acp_session_failed: Internal error` | 丢:`error.code=-32603` `error.data.message="Failed to initialize session services"` | unknown **✗** | unknown | — |
| `cursor.timeout_proxy.cheap_eval` | timeout | 诱发 | cheap_eval · thrown | `cursor-agent exited 1: ✗ Failed to reach the Cursor API. Check that your proxy (http://10.255.255.1:9/) is reachable.⏎` | — | unknown **✗** | unknown | — |
| `cursor.dns.cheap_eval` | network | 采集 | cheap_eval · thrown | `cursor-agent exited 1: Error: [unavailable] getaddrinfo ENOTFOUND api2.cursor.sh` | — | network | transient | connectFailure |
| `cursor.tls.cheap_eval` | network | 采集 | cheap_eval · thrown | `cursor-agent exited 1: Error: [aborted] Client network socket disconnected before secure TLS connection was established` | — | network | transient | — |
| `cursor.quota.acp_text` | quota | 采集 | workbench · text_event | `Upgrade your plan to continue` | — | unknown | unknown | quotaRefusalText, quota=quota |

### agy(Antigravity CLI)

| 样本 id | 真相 | 来源 | 路径 · 通道 | 原文(脱敏、截断) | provider 已给的码 / 被丢掉的结构 | health/classify | 三档 | 其余判为真的 |
|---|---|---|---|---|---|---|---|---|
| `agy.ambiguous.cheap_eval` | auth_ambiguous | 采集 | cheap_eval · thrown | `agy result status=ERROR: authentication failed or timed out` | — | network | transient | assistantText, llmHealthAuth |
| `agy.tls_timeout.cheap_eval` | network | 采集 | cheap_eval · thrown | `agy result status=ERROR: Eligibility check failed: failed to get profile picture: Get "https://lh3.googleusercontent.com/a/«opaque»=s96-c": net/http: TLS handshake timeou…` | — | network | transient | — |
| `agy.server_500.cheap_eval` | server | 采集 | cheap_eval · thrown | `agy result status=ERROR: Eligibility check failed: failed to fetch user info: 500 Internal Server Error` | — | unknown | unknown | — |
| `agy.dns.cheap_eval` | network | 采集 | cheap_eval · thrown | `agy result status=ERROR: Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": dial tcp: lookup daily-cloudcode-pa.googlea…` | — | unknown **✗** | unknown | — |
| `agy.eof.cheap_eval` | network | 采集 | cheap_eval · thrown | `agy result status=ERROR: Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": EOF` | — | unknown **✗** | unknown | — |
| `agy.userinfo_eof.cheap_eval` | network | 采集 | cheap_eval · thrown | `agy result status=ERROR: Eligibility check failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": EOF` | — | unknown **✗** | unknown | — |
| `agy.network_issue.cheap_eval` | network | 采集 | cheap_eval · thrown | `agy result status=ERROR: There was a network issue connecting to the server, please try again.` | — | unknown **✗** | unknown | — |

### openai 兼容(自有循环 + AI SDK;DeepSeek / Kimi / 自建 litellm 网关)

| 样本 id | 真相 | 来源 | 路径 · 通道 | 原文(脱敏、截断) | provider 已给的码 / 被丢掉的结构 | health/classify | 三档 | 其余判为真的 |
|---|---|---|---|---|---|---|---|---|
| `openai.bad_key_deepseek.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `auth_failed: Authentication Fails, Your api key: «masked-key» is invalid (request_id: «req-id»)` | — | llm_auth | auth_failed | llmHealthAuth, registryAuthCode |
| `openai.bad_key_deepseek.session` | auth | 诱发 | session · error_event | `Authentication Fails, Your api key: «masked-key» is invalid (request_id: «req-id»)` | code=`auth_failed` status=401 | llm_auth | auth_failed | authFailError, llmHealthAuth, registryAuthCode |
| `openai.bad_key_moonshot.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `auth_failed: Invalid Authentication` | — | llm_auth | auth_failed | llmHealthAuth, registryAuthCode |
| `openai.bad_key_moonshot.session` | auth | 诱发 | session · error_event | `Invalid Authentication` | code=`auth_failed` status=401 | llm_auth | auth_failed | authFailError, llmHealthAuth, registryAuthCode |
| `openai.bad_key_moonshot.status_lost` | auth | 诱发 | session · error_event | `Invalid Authentication` | — | llm_auth | auth_failed | llmHealthAuth |
| `openai.net_refused.cheap_eval` | network | 诱发 | cheap_eval · thrown | `Unable to connect. Is the computer able to access the url?` | 丢:`err.code="ConnectionRefused"` | network | transient | connectFailure |
| `openai.net_refused.session` | network | 诱发 | session · error_event | `Unable to connect. Is the computer able to access the url?` | — | network | transient | connectFailure |
| `openai.net_dns.cheap_eval` | network | 诱发 | cheap_eval · thrown | `unknown certificate verification error` | 丢:`err.code="UNKNOWN_CERTIFICATE_VERIFICATION_ERROR"` | network | transient | — |
| `openai.gateway_503.session` | server | 采集 | session · error_event | `Failed after 3 attempts. Last error: litellm.ServiceUnavailableError: ServiceUnavailableError: OpenAIException - <html>⏎<head><title>503 Service Temporarily Unavailable</…` | — | unknown | unknown | — |
| `openai.gateway_524.session` | timeout | 采集 | session · error_event | `Failed after 3 attempts. Last error: <none>` | 丢:`RetryError.errors[].statusCode=524` `RetryError.reason="maxRetriesExceeded"` `APICallError.isRetryable=true` | unknown **✗** | unknown | — |
| `openai.socket_closed.session` | network | 采集 | session · error_event | `The socket connection was closed unexpectedly. For more information, pass 'verbose: true' in the second argument to fetch()` | — | unknown **✗** | unknown | — |
| `openai.step_budget.session` | not_provider | 采集 | session · error_event | `step budget 25 exhausted` | — | unknown | unknown | — |

### Gemini API-key 路(deprecated)

| 样本 id | 真相 | 来源 | 路径 · 通道 | 原文(脱敏、截断) | provider 已给的码 / 被丢掉的结构 | health/classify | 三档 | 其余判为真的 |
|---|---|---|---|---|---|---|---|---|
| `gemini.bad_key.cheap_eval` | auth | 诱发 | cheap_eval · thrown | `{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo…` | status=400 | unknown **✗** | unknown | — |
| `gemini.net_refused.cheap_eval` | network | 诱发 | cheap_eval · thrown | `Unable to connect. Is the computer able to access the url?` | — | network | transient | connectFailure |
## 4. 错判与分歧(按代价排)

### 4.1 Claude 会话路径:API 错误被当成正文,原样发给主人

诱发结果:未登录以外的所有 API 失败(401 假 key、拒连、超时),在会话路径上都是 **一个 `text` 事件 + 一个正常的 `result` 事件**。回合记成 `completed`,没有任何判定看到它;主人没调 reply 工具时,coordinator 的 fallback 把这句原文当成回复发到微信。真机上发生过:`channel.log` 2026-07-28 `[FALLBACK_REPLY] provider=claude chunks=1 preview="Failed to authenticate. API Error: 403 Request not allowed"`。

而 SDK 其实**给了**结构:助理消息上 `error: "authentication_failed" | "server_error"`、`is_api_error_message: true`,结果消息上 `is_error: true`、`terminal_reason: "api_error"`、`api_error_status: 401 | null`。`claude-agent-provider.ts` 把它们全丢了,只留正文给双哨兵去扫。一次性评估路径同理:SDK 抛的是 `Claude Code returned an error result: <正文>`,结构也没了。

**红线 A 在这里的位置**:红线防的是「把模型正文里引用的 401 当成登录失效」。SDK 的 `error: "authentication_failed"` 不是正文,是 SDK 对一次 API 失败的标注 —— 用它不会误伤正文。但它会让 401 假 key / 403 `Request not allowed` 也报成 auth,这超出了「只在双哨兵上报登录过期」的字面。第 2 步要 owner 定:`authentication_failed` 是否可以报 auth,但提示文案不说「登录过期」(例如「Claude 拒绝了凭证」)。

### 4.2 agy 歧义句:决定通知的那处守住了红线 B,「测试连接」没守住

`agy result status=ERROR: authentication failed or timed out`:health/classify 判 `network` ✓,三档判 `transient` ✓,registry 不当 auth ✓ —— 红线 B 今天守住了,**但只靠 health/classify 里「网络优先」这一个顺序**。同一句在 `llm-health` 的 `AUTH_RE`(`looksLikeAuthFailure`)上是 auth,面板「测试连接」会报 AUTH FAILED 外加「去重新登录」提示;`assistant-text` 窄集也命中(今天只扫返回正文,碰不到它)。顺序依赖反过来也会伤人:`codex.bad_key.session_exit` 的 stderr 是 `failed to connect to websocket: HTTP error: 401 Unauthorized`,真 401 先撞上 `failed to connect` 被判成网络。

### 4.3 Cursor:唯一的结构化码没人认;ACP 上 key 无效与断网逐字相同

- ACP 未登录时 `session/new` 回 `{code: -32000, message: "Authentication required"}`,`setupError` 收成裸码 `acp_auth_required` —— 这正是第 2 步要的形状,但 health/classify、llm-health、三档**都判 unknown**(没人认这个码)。
- 假 key 和死代理在 ACP 上**都是** `{code: -32603, message: "Internal error", data: {message: "Failed to initialize session services"}}` → `acp_session_failed: Internal error`。光凭 ACP 这一面区分不了,只能靠 print 模式或 `cursor-agent status` 旁证。
- print 模式:`The provided API key is invalid.`(宽集只认 `invalid api key` 词序)、`Failed to reach the Cursor API. Check that your proxy … is reachable.`(网络词表里没有 `failed to reach`)都判 unknown;原文还带 ANSI 颜色码。

### 4.4 没有错误,只有沉默

| 场景 | 实测 | 下游看到的 |
|---|---|---|
| codex 一次性评估 / 会话,base URL 拒连或黑洞 | 一次性评估与会话各跑 400 秒,**都没有任何输出**(既无事件也不抛;推测是 codex 内部重连,未深究)| 设了预算的调用方(披露闸门)拿到自己的超时;**没设的(ingest、gardener 等)一直挂着** |
| openai 兼容,黑洞地址 | 40 秒内无任何输出:AI SDK 没有请求超时 | 会话只能等 600 秒回合看门狗:`turn timed out after 600000ms with no activity` |
| claude,假 key,默认重试 | 90 秒内无输出(401 也在重试);`CLAUDE_CODE_MAX_RETRIES=0` 时 2 秒 | 同上 |

这一类不是判定问题,是边界没有超时 —— 结构化错误码救不了一个永远不来的错误。第 2 步要顺手给每个边界一个 `timeout` 码的产生点。

### 4.5 状态码被吃掉

- 自建 litellm 网关 Cloudflare 524:AI SDK 重试三次后抛 `Failed after 3 attempts. Last error: <none>`,524 只在 `RetryError.errors[]` 里 → unknown。
- openai 兼容 `cheapEval` 把 401 重抛成 `auth_failed: …` 时新 Error **不带 status**。今天靠前缀还能认,但 Kimi 那句 `Invalid Authentication` 若丢了前缀与 status,就只剩散文词 `authentication` 撑着(样本 `openai.bad_key_moonshot.status_lost`)。
- Gemini 对无效 key 回 **400** `INVALID_ARGUMENT` / `reason: API_KEY_INVALID`,`isAuthFailError` 只认 401 → unknown。

### 4.6 网络词表只认 Node 与 Bun,不认 Go 与各家 CLI 的说法

agy(Go)`dial tcp: lookup …: no such host`、`…: EOF`、`There was a network issue connecting to the server`;openai 兼容(Bun)`The socket connection was closed unexpectedly`;claude `Your computer went to sleep mid-response` —— 全判 unknown(按规则应是 network:不通知、按瞬时)。今天的结果偏安全(unknown 也不打扰),但主人在「为什么没回」时拿不到「网络问题」这句解释。

### 4.7 信息在边界就丢光了

`Codex Exec exited with code 1: Reading prompt from stdin...⏎`(stderr 只剩第一行)、`turn_records` 里 5 行 `outcome=error` 而 `error` 为 NULL。这两类无论下游怎么判都只能是 unknown。

### 4.8 其它

- codex 一轮里冒出 11 个 `error` 事件(`Reconnecting... 2/5 (…401…)` 是**非终止**的重连通知),每个都被盖上 `auth_failed`。今天 coordinator 取的是汇总,没出事,但「error 事件 = 这一轮失败」的契约并不成立。
- 额度类(codex `You've hit your usage limit`、cursor `Upgrade your plan to continue`)只有 `provider-quota` 认得,health/classify 判 unknown。两条路各管各的,目前没打架。
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

1. **claude**:读 SDK 助理消息的 `error` 字段与结果消息的 `is_error` / `api_error_status`,不再扫正文。会话路径上 `is_api_error_message: true` 的那条**不再作为 text 事件发出**,改发 `error` 事件(修掉 §4.1 的 fallback 外发)。**红线 A**:双哨兵仍是「登录过期」文案的唯一来源;`authentication_failed` 而非哨兵 → `auth_invalid`,文案不说登录过期 —— 这一条要 owner 拍板。
2. **openai 兼容 / gemini**:按 HTTP status 产码(401/403 → auth,400 + `API_KEY_INVALID` → auth,429 → rate_limit,5xx/524 → server),并从 `RetryError.errors[]` 取最后一个 status。给 AI SDK 调用加请求超时。
3. **cursor**:ACP 按 JSON-RPC code(`-32000` → `auth_missing`,`-32603` → `ambiguous`);print 模式剥 ANSI 后匹配它自己的三句(这是**边界内**的正则,只认这一家 CLI 的固定输出,不外溢)。
4. **codex**:codex 的错误文本里已有 `unexpected status <N>` 与 `auth error code: <code>` 这两个稳定的结构尾巴,在边界解析成码;非终止的 `Reconnecting…` 降成日志,不发 `error` 事件;给 `runStreamed` / 一次性评估一个边界超时。
5. **agy**:只有 `result status=ERROR: <文本>`。在边界把已知几句映射成码,**红线 B**:`authentication failed or timed out` 固定映射到 `ambiguous`(→ transient),不进 auth;其余未知句 → `unknown`。

**下游怎么收**:`health/classify` 与 `llm-health` 改为先看码,码缺失时才回退到今天的文本判定(过渡期两条路并存,用本次 fixture 对拍:回退路径在全部样本上的答案不得变);`provider-registry` 冷却与 coordinator 的 `auth_failed` 分支只认码。迁移完成后删掉回退与 `AUTH_FAIL_SDK_ERROR` 宽集。

**验证**:本 PR 的 fixture 就是第 2 步的回归语料 —— 每条样本加一个 `expectedCode`,测试同时钉「边界产的码」与「下游据码的结论」;§4 里每一条 ✗ 都应翻成 ✓,两条红线的断言(`provider-error-shapes.test.ts` 末尾那组)必须一直绿。
