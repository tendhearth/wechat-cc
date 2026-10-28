/**
 * codex 边界的错误分类与超时(arch backlog #4 第 2 步;样本见
 * docs/reference/provider-error-shapes.md 的 Codex 一节)。
 *
 * codex 的错误文本(app-server 的 `message`,以前 SDK 路径 `codex exec` 的唯一信息)措辞是这一家
 * CLI 自己的**固定尾巴**:`unexpected status <N>`、
 * `HTTP error: <N>`、`auth error code: <code>`、`Reconnecting... waiting for network`、
 * `You've hit your usage limit`。这里在边界把它们解析成 lib/provider-error-code 的码,
 * 只认这一家的固定输出,不外溢到别处;下游只看码。
 *
 * 对话与工作台都走 app-server(B1 2026-10-25),那条路有真正的结构(`TurnError.codexErrorInfo`,带
 * `httpStatusCode`)—— 见 codexAppServerErrorCode,优先用它,文本只作缺省。
 * 连不上时的边界超时(first_event / connect)在 codex-app-server.ts 的回合看门狗里。
 */
import { codeForHttpStatus, type ProviderErrorCode } from '../../../lib/provider-error-code'
import { isConnectFailure } from '../../../lib/net-errors'

/**
 * codex 的错误文本 → 码;认不出 ⇒ undefined(调用方回退到旧的文本判定)。
 *
 * 顺序有讲究:**HTTP status 先于「连不上」措辞** —— `failed to connect to websocket:
 * HTTP error: 401 Unauthorized` 里同时有 `failed to connect` 和 401,真相是凭证被拒
 * (§4.2 的那条顺序依赖:以前被判成网络)。
 *
 *   · `Missing bearer or basic authentication` ⇒ `auth_failed`:根本没有凭证(没跑过
 *     `codex login`,或登录态没了),修法就是 codex 的登录命令。
 *   · 其余 401 / 403 / `auth error code: …` ⇒ `auth_rejected`:凭证被拒,但没有证据说
 *     是登录过期 —— 文案不说登录过期(红线 A 的细化推广到 codex,owner 2026-10-02)。
 *   · `usage limit` ⇒ `quota`。
 */
export function codexErrorCode(message: string): ProviderErrorCode | undefined {
  const m = message ?? ''
  if (!m.trim()) return undefined
  if (/you'?ve hit your usage limit|usage limit reached|insufficient_quota|exceeded your current quota/i.test(m)) return 'quota'
  if (/Missing bearer or basic authentication/i.test(m)) return 'auth_failed'
  if (/auth error code:\s*[a-z_]+/i.test(m)) return 'auth_rejected'
  const status = /(?:unexpected status|HTTP error:)\s*(\d{3})\b/i.exec(m)?.[1] ?? /"status"\s*:\s*(\d{3})\b/.exec(m)?.[1]
  if (status) {
    const code = codeForHttpStatus(Number(status), m)
    if (code) return code
  }
  if (/rate limit/i.test(m)) return 'rate_limited'
  if (/waiting for network|error sending request|stream disconnected|connection (?:failed|reset|closed)|dns error|timed out|timeout/i.test(m) || isConnectFailure(m)) return 'network'
  return undefined
}

type CodexErrorInfo = string | Record<string, { httpStatusCode?: number | null } | undefined> | null | undefined

/**
 * 工作台 app-server 的 `TurnError`(`{ message, codexErrorInfo }`)→ 码。
 * codexErrorInfo 是 codex 自己的分类(`codex app-server generate-ts` 的 CodexErrorInfo):
 * 字符串变体,或 `{ httpConnectionFailed: { httpStatusCode } }` 这类带 status 的变体
 * —— status 为 null 表示没拿到 HTTP 响应(连不上)。认不出就退到文本。
 */
export function codexAppServerErrorCode(error: { message?: unknown; codexErrorInfo?: unknown } | null | undefined): ProviderErrorCode | undefined {
  const message = typeof error?.message === 'string' ? error.message : ''
  const info = error?.codexErrorInfo as CodexErrorInfo
  if (typeof info === 'string') {
    switch (info) {
      case 'unauthorized': return codexErrorCode(message) === 'auth_failed' ? 'auth_failed' : 'auth_rejected'
      case 'usageLimitExceeded': case 'sessionBudgetExceeded': return 'quota'
      case 'rateLimitExceeded': return 'rate_limited'
      case 'serverOverloaded': case 'internalServerError': return 'server_error'
      case 'contextWindowExceeded': case 'badRequest': return 'invalid_request'
    }
  } else if (info && typeof info === 'object') {
    for (const variant of ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']) {
      const detail = info[variant]
      if (detail === undefined) continue
      const status = detail?.httpStatusCode
      if (status === null || status === undefined) return 'network'
      return codeForHttpStatus(status, message) ?? 'provider_error'
    }
  }
  return codexErrorCode(message)
}

export interface CodexTimeouts {
  /** 这一轮开始后,**一个**有进展的事件(item.* / turn.completed / turn.failed)都没等到的上限。 */
  firstEventTimeoutMs: number
  /** codex 报「Reconnecting…」之后、再没有任何进展的上限 —— 连不上就在这里收尾。 */
  connectTimeoutMs: number
}

/** 缺省:连不上 60s 收尾;一个事件都没有 180s 收尾(长思考的模型第一个 item 也很少超过它)。 */
export const DEFAULT_CODEX_TIMEOUTS: CodexTimeouts = { firstEventTimeoutMs: 180_000, connectTimeoutMs: 60_000 }

const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** `WECHAT_CODEX_FIRST_EVENT_TIMEOUT_MS` / `WECHAT_CODEX_CONNECT_TIMEOUT_MS` 可改;非法值用缺省。 */
export function codexTimeoutsFromEnv(): CodexTimeouts {
  return {
    firstEventTimeoutMs: envMs('WECHAT_CODEX_FIRST_EVENT_TIMEOUT_MS', DEFAULT_CODEX_TIMEOUTS.firstEventTimeoutMs),
    connectTimeoutMs: envMs('WECHAT_CODEX_CONNECT_TIMEOUT_MS', DEFAULT_CODEX_TIMEOUTS.connectTimeoutMs),
  }
}
