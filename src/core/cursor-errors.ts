/**
 * Cursor 边界的错误分类(arch backlog #4 第 2 步;样本见 provider-error-shapes.md 的
 * Cursor 一节)。两条路,各认各的:
 *
 *   · ACP(对话 + 工作台):JSON-RPC 错误对象的 `code` 与 `data`。`-32000` = 要登录;
 *     `-32603 Internal error` 是 cursor-agent 的「什么都可能」—— 假 key 和死代理在这一面
 *     **逐字相同**(`data.message = "Failed to initialize session services"`),所以除非
 *     `data` 里明说了原因,一律 `provider_error`,**不猜**(owner 2026-10-02)。
 *   · print 模式(一次性评估):cursor-agent 自己的几句固定输出(带 ANSI 颜色)。这是
 *     **边界内**的匹配,只认这一家 CLI 的原话,不外溢。
 */
import { AcpRequestError } from './acp/rpc'
import type { ProviderErrorCode } from '../lib/provider-error-code'
import { isConnectFailure } from '../lib/net-errors'

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
export const stripAnsi = (text: string): string => text.replace(ANSI, '')

const AUTH_REQUIRED = /Authentication required|Please run '?(?:cursor-)?agent login'?|Not logged in/i
// 只认 cursor-agent 自己的原话(「invalid api key」这类通用词汇只能在 lib/auth-failure 里,见那里的仓库守卫)。
const KEY_INVALID = /The provided API key is invalid/i
const UNREACHABLE = /Failed to reach the Cursor API|network socket disconnected|socket hang up|\[unavailable\]|ETIMEDOUT|timed out/i
const QUOTA = /Upgrade your plan to continue|hit your usage limit|usage limit reached|out of (?:fast )?requests/i

/** print 模式(`cursor-agent -p`)的 stderr / 错误事件文本 → 码;认不出 ⇒ undefined。 */
export function cursorPrintErrorCode(text: string): ProviderErrorCode | undefined {
  const t = stripAnsi(text ?? '')
  if (!t.trim()) return undefined
  if (KEY_INVALID.test(t)) return 'auth_rejected'
  if (AUTH_REQUIRED.test(t)) return 'auth_failed'
  if (QUOTA.test(t)) return 'quota'
  if (UNREACHABLE.test(t) || isConnectFailure(t)) return 'network'
  return undefined
}

const dataText = (data: unknown): string => {
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    const m = (data as Record<string, unknown>).message
    if (typeof m === 'string') return m
    try { return JSON.stringify(data) } catch { return '' }
  }
  return ''
}

/**
 * ACP 的 JSON-RPC 错误 → 码。
 *   -32000                         ⇒ auth_failed(cursor-agent:要先 `agent login`)
 *   data 明说要登录 / key 无效 / 连不上 ⇒ 对应的码
 *   -32602(参数)                    ⇒ invalid_request
 *   其余(含 -32603 无可用 data)     ⇒ provider_error —— 不猜是 key 还是网络
 */
export function acpErrorCode(error: unknown): ProviderErrorCode | undefined {
  if (!(error instanceof AcpRequestError)) return undefined
  if (error.code === -32000) return 'auth_failed'
  const detail = `${dataText(error.data)} ${error.message}`
  const fromText = cursorPrintErrorCode(detail)
  if (fromText) return fromText
  if (error.code === -32602) return 'invalid_request'
  return 'provider_error'
}

/**
 * ACP 的**带内**错误:cursor-agent acp 一轮里出错时不回 JSON-RPC 错误,而是把错误**写进助理消息**、
 * 照常回 `stopReason: "end_turn"`。来源是 cursor-agent(2026.09.02-c22c1a3)ACP 服务端
 * `processPrompt` 的 catch —— 一共三种写法,每种都是**一次** `sendAgentMessageChunk`(一整块),
 * 前面固定两个换行,之后这一轮什么都不再发:
 *
 *   1. `ActionRequiredError`:`\n\n` + 按 action 取的固定句(login / upgrade / payment / config;
 *      action 不在表里时是服务端给的任意 message —— 认不出,照旧当正文);
 *   2. 未包装的 ConnectError 且 code = Unauthenticated:`\n\nError: [unauthenticated] Backend rejected …`(整句固定);
 *   3. 其余:`\n\nError: ${String(e)}` —— e 是 cursor 自己的 `RetriableError` / `NonRetriableError`
 *      (`name: message`;ConnectError 的 message 以 `[connect code] ` 开头),真机录到的
 *      「Agent Looping Detected」就是这一种。`CancelledError` 不写(静默结束)。
 *
 * 所以这里只认**一整块**:`\n\n` + 上面的固定句 / 固定模板。调用方(acp/events 翻译器)负责「这一块是本轮
 * 最后一个可见 update」这条结构条件 —— 后面再来文字或工具调用,它就是正文,原样放行。正文里提到这些词
 * (不是整块、没有 `\n\n` 前缀、模板对不上)一律不算。
 */
export interface AcpInbandError { code: ProviderErrorCode; message: string }

const ACTION_REQUIRED: Readonly<Record<string, ProviderErrorCode>> = {
  // NOT_LOGGED_IN / AUTH_TOKEN_EXPIRED / UNAUTHORIZED …;修法就是 `cursor-agent login`(红线 A:只在这种情形产 auth_failed)。
  'Please sign in to continue': 'auth_failed',
  // FREE/PRO_USER_USAGE_LIMIT 与各种 RATE_LIMIT —— cursor 自己就把用量与限流并成了这一句,分不开,沿用已有判定 quota。
  'Upgrade your plan to continue': 'quota',
  // USAGE_PRICING_REQUIRED。
  'Add a payment method to continue': 'quota',
  // BAD_API_KEY / BAD_USER_API_KEY / OUTDATED_CLIENT 混在一句里 —— 不猜是 key 还是版本。
  'Check your settings to continue': 'provider_error',
}
const UNAUTHENTICATED = 'Error: [unauthenticated] Backend rejected authentication. Verify this is a User API Key for the same endpoint/environment, then rerun with --debug for request-level auth logs.'
/** `Error: ` + String(e):`<Name>Error: `(cursor 的错误类 / 原生 Error)和 / 或 `[connect code] `,至少一个。 */
const STRING_E = /^Error: (?:([A-Za-z]*Error): )?(?:\[([a-z_]+)\] )?/
const CONNECT_CODE: Readonly<Record<string, ProviderErrorCode>> = {
  unauthenticated: 'auth_rejected', permission_denied: 'auth_rejected',
  resource_exhausted: 'rate_limited',
  unavailable: 'network', deadline_exceeded: 'network', aborted: 'network',
  internal: 'server_error',
  invalid_argument: 'invalid_request', failed_precondition: 'invalid_request', out_of_range: 'invalid_request',
}

/** 一整块 agent_message_chunk 的文字 → 带内错误;不是 cursor-agent 写错误的那几种整块 ⇒ null。 */
export function cursorAcpInbandError(chunk: string): AcpInbandError | null {
  if (typeof chunk !== 'string' || !chunk.startsWith('\n\n')) return null
  const body = chunk.slice(2)
  if (Object.hasOwn(ACTION_REQUIRED, body)) return { code: ACTION_REQUIRED[body]!, message: body }
  if (body === UNAUTHENTICATED) return { code: 'auth_rejected', message: body }
  const m = STRING_E.exec(body)
  if (!m || (!m[1] && !m[2])) return null
  const rest = body.slice(m[0].length)
  if (!rest.trim()) return null
  const byConnect = m[2] && Object.hasOwn(CONNECT_CODE, m[2]) ? CONNECT_CODE[m[2]] : undefined
  return { code: byConnect ?? (isConnectFailure(rest) ? 'network' : 'provider_error'), message: body }
}
