/**
 * openai 兼容边界(AI SDK + DeepSeek / Kimi / 自建网关)的错误分类(arch backlog #4
 * 第 2 步;样本见 provider-error-shapes.md 的 openai 兼容一节)。
 *
 * 这一家拿得到**真结构**:AI SDK 的 `APICallError`(`statusCode`、`responseBody`)、
 * `RetryError`(`errors[]` 里每次尝试的那个 APICallError)、Bun fetch 的系统码
 * (`err.code`)、以及 lib/timeout-fetch 自己挂的码。只看这些,不扫厂商正文 ——
 * 唯一的例外是 Gemini 风格的「400 但正文明说 key 无效」,那是 codeForHttpStatus
 * 里的一条固定规则。
 */
import { codeForHttpStatus, providerErrorCodeOf, type ProviderErrorCode } from '../lib/provider-error-code'
import { isConnectFailure } from '../lib/net-errors'

type Obj = Record<string, unknown>
const obj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

/** RetryError → 最后一次真正带 HTTP 结果的尝试;否则就是它自己。 */
function lastAttempt(err: unknown): unknown {
  if (!obj(err)) return err
  const errors = Array.isArray(err.errors) ? err.errors : undefined
  if (errors && errors.length > 0) {
    for (let i = errors.length - 1; i >= 0; i--) if (obj(errors[i]) && typeof (errors[i] as Obj).statusCode === 'number') return errors[i]
    return errors[errors.length - 1]
  }
  if (obj(err.lastError)) return err.lastError
  return err
}

const statusOf = (e: unknown): number | undefined => {
  if (!obj(e)) return undefined
  const s = e.statusCode ?? e.status
  return typeof s === 'number' ? s : undefined
}
const bodyOf = (e: unknown): string => (obj(e) && typeof e.responseBody === 'string' ? e.responseBody : '')
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e ?? ''))

/** Bun / Node fetch 的「连不上」系统码(放在 err.code 或 err.cause.code)。 */
const NET_CODES = /^(ConnectionRefused|ConnectionClosed|FailedToOpenSocket|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_[A-Z_]+|UNKNOWN_CERTIFICATE_VERIFICATION_ERROR|CERT_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_[A-Z_]+)$/

export function openaiErrorCode(err: unknown): ProviderErrorCode | undefined {
  const own = providerErrorCodeOf(err)
  if (own) return own
  const attempt = lastAttempt(err)
  const fromAttempt = providerErrorCodeOf(attempt)
  if (fromAttempt) return fromAttempt
  const status = statusOf(attempt) ?? statusOf(err)
  const http = codeForHttpStatus(status, `${bodyOf(attempt)} ${messageOf(attempt)}`)
  if (http) return http
  for (const e of [attempt, err, obj(attempt) ? attempt.cause : undefined]) {
    if (obj(e) && typeof e.code === 'string' && NET_CODES.test(e.code)) return 'network'
  }
  const text = `${messageOf(attempt)} ${messageOf(err)}`
  if (isConnectFailure(text) || /certificate|Cannot connect to API|timed out/i.test(text)) return 'network'
  return undefined
}

/**
 * 给人 / 日志看的那句话。AI SDK 重试三次后抛 `Failed after 3 attempts. Last error: <none>`
 * —— 524 只在 `errors[]` 里(§4.5)。这里把真实的 status 拼回来。
 */
export function openaiErrorMessage(err: unknown): string {
  const base = messageOf(err)
  const attempt = lastAttempt(err)
  if (attempt === err) return base
  const status = statusOf(attempt)
  const detail = (bodyOf(attempt) || messageOf(attempt)).replace(/\s+/g, ' ').trim().slice(0, 200)
  const tries = obj(err) && Array.isArray(err.errors) ? err.errors.length : undefined
  return `${status ? `HTTP ${status}` : 'request failed'}${tries ? ` (after ${tries} attempts)` : ''}${detail ? `: ${detail}` : ''}`
}
