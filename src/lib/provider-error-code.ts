/**
 * provider-error-code — provider 边界产出的**结构化错误码**闭集(arch backlog
 * #4 第 2 步;依据 docs/reference/provider-error-shapes.md)。
 *
 * 错误在 provider 边界被分类一次,带着码往下走(`AgentEvent.error.code` →
 * `TurnSummary.errorCode` → `TurnRecord.errorCode` → health 判定)。下游**有码
 * 就只看码**,码缺失(还没迁移的 provider)才回退到今天的文本判定。
 *
 * 第一片(#190)只有 Claude 会话路径产码;第 2 步余下部分(owner 2026-10-02 批准)
 * 让**每家** provider 的边界都产这一组码(codex / openai 兼容 / cursor / agy /
 * Claude 一次性评估与工作台)。各家怎么从自己的结构(HTTP status、JSON-RPC
 * code、SDK 标注、CLI 固定句式)映射到这里,写在各自边界旁边;下游只认码。
 * 文本判定只剩「码缺失」时的最后回退。
 *
 * 守护拒绝(`network_unprotected`,lib/network-gate)**不是** provider 错误 ——
 * 那一次调用根本没发出去。它永远不进这个闭集,也永远不会被归成 `network`。
 *
 * 红线 A(owner 2026-10-02 细化):「登录过期 / 请重新登录」的文案**只**属于
 * `auth_failed`,而 Claude 只在两句哨兵上产 `auth_failed`。SDK 标了
 * `authentication_failed` 但哨兵没中 ⇒ `auth_rejected`:仍是认证失败,但文案
 * 说「认证没通过(401/403),检查账号或密钥」,不说登录过期。
 */

export const PROVIDER_ERROR_CODES = [
  /** 登录失效(Claude:双哨兵命中)。唯一可以说「登录过期」的码。 */
  'auth_failed',
  /** 凭证被拒(API 401/403),但没有证据说是「登录过期」。 */
  'auth_rejected',
  /** 连不上 / 被重置 / TLS / 请求超时 —— 没拿到 HTTP 响应。瞬时。 */
  'network',
  /** 对端回了 HTTP 错误(5xx / 529 过载等)。瞬时。 */
  'server_error',
  /** 限流(429)。 */
  'rate_limited',
  /** 额度 / 计费耗尽。与 core/provider-quota 的 QuotaKind 'quota' 同名。 */
  'quota',
  /** 请求本身不合法(上下文太长、模型不可用等)。 */
  'invalid_request',
  /** provider 明确标了这是一次 API 失败,但没说是哪类。 */
  'provider_error',
] as const

export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[number]

const CODES: ReadonlySet<string> = new Set(PROVIDER_ERROR_CODES)

export function isProviderErrorCode(code: unknown): code is ProviderErrorCode {
  return typeof code === 'string' && CODES.has(code)
}

/** 两种认证失败码。下游「要不要释放会话 + 发认证提示」认这一组,措辞再按码分。 */
export function isAuthErrorCode(code: unknown): code is 'auth_failed' | 'auth_rejected' {
  return code === 'auth_failed' || code === 'auth_rejected'
}

/**
 * 抛出物 / 错误对象上携带码的属性名。刻意**不用** `code` —— Node 的系统错误
 * 已经占了它(`ECONNREFUSED` …),混用会让判定把系统码当 provider 码。
 */
export const PROVIDER_ERROR_CODE_PROP = 'providerErrorCode'

/** 从一个抛出物上读 provider 码;没有或不在闭集里 ⇒ undefined(调用方回退到文本)。 */
export function providerErrorCodeOf(err: unknown): ProviderErrorCode | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  let code: unknown
  try { code = (err as Record<string, unknown>)[PROVIDER_ERROR_CODE_PROP] } catch { return undefined }
  return isProviderErrorCode(code) ? code : undefined
}

/**
 * 给一个已有的抛出物挂上码(保留原 message / stack / status 等字段),再原样抛出。
 * 码不在闭集里就什么都不挂。非 Error 的抛出物包成 Error。
 */
export function withProviderCode<E>(err: E, code: ProviderErrorCode | undefined): E | Error {
  if (!code) return err
  const target: Error = err instanceof Error ? err : new Error(String(err))
  try { Object.assign(target, { [PROVIDER_ERROR_CODE_PROP]: code }) } catch { return errorWithProviderCode(target.message, code) }
  return target
}

/**
 * HTTP status → 码。给**拿到了 HTTP 响应**的边界用(openai 兼容 / gemini / codex
 * 文本里的 `unexpected status N` / codex app-server 的 `httpStatusCode`)。
 *
 *   · 401 / 403 → `auth_rejected`(不是 `auth_failed`:401 说明凭证被拒,不说明是
 *     「登录过期」—— 红线 A 的细化)
 *   · 400 且正文明说 key 无效(Gemini:`API_KEY_INVALID` / `API key not valid`)→
 *     `auth_rejected`;其余 400 / 404 / 413 / 422 → `invalid_request`
 *   · 402 → `quota`;429 → `rate_limited`
 *   · 408 → `network`(请求超时,没拿到正文)
 *   · 5xx(含 Cloudflare 524、Anthropic 529)→ `server_error`
 *   · 其余 → undefined(调用方自己决定回退)
 */
export function codeForHttpStatus(status: unknown, body?: string): ProviderErrorCode | undefined {
  if (typeof status !== 'number' || !Number.isFinite(status)) return undefined
  if (status === 401 || status === 403) return 'auth_rejected'
  if (status === 400 && typeof body === 'string' && /API_KEY_INVALID|API key not valid|invalid[_ ]api[_ ]key/i.test(body)) return 'auth_rejected'
  if (status === 402) return 'quota'
  if (status === 429) return 'rate_limited'
  if (status === 408) return 'network'
  if (status >= 500 && status <= 599) return 'server_error'
  if (status >= 400 && status <= 499) return 'invalid_request'
  return undefined
}

/** 造一个带码的 Error(给 health 这类只吃抛出物的判定用)。 */
export function errorWithProviderCode(message: string, code: string | undefined): Error {
  const err = new Error(message)
  if (isProviderErrorCode(code)) Object.assign(err, { [PROVIDER_ERROR_CODE_PROP]: code })
  return err
}
