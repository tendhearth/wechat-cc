/**
 * codex 边界的错误分类与超时(arch backlog #4 第 2 步;样本见
 * docs/reference/provider-error-shapes.md 的 Codex 一节)。
 *
 * codex 的 SDK 路径(`codex exec --experimental-json`)只给一句 `message`,没有
 * 结构化字段 —— 但它的措辞是这一家 CLI 自己的**固定尾巴**:`unexpected status <N>`、
 * `HTTP error: <N>`、`auth error code: <code>`、`Reconnecting... waiting for network`、
 * `You've hit your usage limit`。这里在边界把它们解析成 lib/provider-error-code 的码,
 * 只认这一家的固定输出,不外溢到别处;下游只看码。
 *
 * 工作台走 app-server,那条路有真正的结构(`TurnError.codexErrorInfo`,带
 * `httpStatusCode`)—— 见 codexAppServerErrorCode,优先用它,文本只作缺省。
 */
import type { ThreadEvent } from '@openai/codex-sdk'
import { codeForHttpStatus, errorWithProviderCode, type ProviderErrorCode } from '../lib/provider-error-code'
import { isConnectFailure } from '../lib/net-errors'

/** codex 自己的「这次没连上,正在重试」通知。**不是**这一轮的终态。 */
export function isCodexReconnectNotice(message: string): boolean {
  return /^Reconnecting\.\.\./.test(message.trim())
}

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

/** 一轮被边界超时收掉:带码(`network`,或最后一条重连通知里认出来的码)的抛出物。 */
export function codexTimeoutError(kind: 'first_event' | 'connect', ms: number, lastNotice: string | undefined): Error & { providerErrorCode?: string } {
  const why = kind === 'connect' ? `codex 连不上服务,${Math.round(ms / 1000)}s 内没有恢复` : `codex ${Math.round(ms / 1000)}s 内没有任何回应`
  const detail = lastNotice ? `(最后一条:${lastNotice.slice(0, 200)})` : ''
  return errorWithProviderCode(`${why}${detail}`, (lastNotice && codexErrorCode(lastNotice)) || 'network')
}

const PROGRESS = new Set(['item.started', 'item.updated', 'item.completed', 'turn.completed', 'turn.failed'])

/**
 * 包一层 codex 的事件流:把非终止的「Reconnecting…」通知**拿掉**(交给 onNotice 记日志),
 * 并给这一轮套两个边界超时(见 CodexTimeouts)。超时 ⇒ 调 `abort()`(杀掉 codex 子进程),
 * 抛 codexTimeoutError。
 *
 * WHY(sandbox 2026-10-02,codex-cli 0.153.4,base URL 拒连):codex 每隔 4s→43s 发一条
 * `Reconnecting... waiting for network (Connection failed: error sending request)`,永不结束。
 * 这些通知以前被当成 `error` 事件往下送 —— collectTurn 的看门狗按事件重置,于是这一轮
 * **永远**不会超时,主人那边就是一片沉默。
 */
export async function* watchCodexEvents(
  events: AsyncIterable<ThreadEvent>,
  opts: { timeouts: CodexTimeouts; abort: () => void; onNotice?: (message: string) => void; now?: () => number },
): AsyncGenerator<ThreadEvent> {
  const now = opts.now ?? Date.now
  const it = events[Symbol.asyncIterator]()
  const startedAt = now()
  let progressed = false
  let reconnectingSince: number | null = null
  let lastNotice: string | undefined
  const TIMEOUT = Symbol('timeout')
  for (;;) {
    const deadlines: Array<{ at: number; kind: 'first_event' | 'connect'; ms: number }> = []
    if (!progressed) deadlines.push({ at: startedAt + opts.timeouts.firstEventTimeoutMs, kind: 'first_event', ms: opts.timeouts.firstEventTimeoutMs })
    if (reconnectingSince !== null) deadlines.push({ at: reconnectingSince + opts.timeouts.connectTimeoutMs, kind: 'connect', ms: opts.timeouts.connectTimeoutMs })
    deadlines.sort((a, b) => a.at - b.at)
    const next = deadlines[0]
    let timer: ReturnType<typeof setTimeout> | undefined
    const step = await (next
      ? Promise.race([it.next(), new Promise<typeof TIMEOUT>(resolve => { timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, next.at - now())) })])
      : it.next())
    if (timer) clearTimeout(timer)
    if (step === TIMEOUT) {
      opts.abort()
      void Promise.resolve(it.return?.()).catch(() => {})
      throw codexTimeoutError(next!.kind, next!.ms, lastNotice)
    }
    if (step.done) return
    const ev = step.value
    if (ev.type === 'error' && isCodexReconnectNotice(ev.message)) {
      lastNotice = ev.message
      reconnectingSince ??= now()
      opts.onNotice?.(ev.message)
      continue
    }
    if (PROGRESS.has(ev.type)) { progressed = true; reconnectingSince = null }
    yield ev
  }
}
