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
const KEY_INVALID = /provided API key is invalid|invalid api key/i
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
