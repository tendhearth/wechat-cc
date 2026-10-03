import type { ProviderErrorCode } from '../lib/provider-error-code'

/**
 * SDK 对一次 API 失败的结构化标注 → 本仓库的 provider 错误码(arch backlog #4
 * 第 2 步,owner 2026-10-02)。
 *
 * WHY:会话路径上,Claude 的 401/403、拒连、超时以前是「一条正文 text 事件 +
 * 一个正常的 result」—— 回合记成 completed,fallback 把错误原文当回复发到
 * 微信(真机 2026-07-28:`Failed to authenticate. API Error: 403 Request not
 * allowed`)。SDK 其实在助理消息上标了 `error`,结果消息上给了
 * `api_error_status`,这里只读这两个结构字段,不扫正文。
 *
 *   · `authentication_failed` → `auth_rejected`。**不是** `auth_failed`:红线 A
 *     规定「登录过期」只属于两句哨兵,哨兵由调用方先判(命中就仍是 auth_failed)。
 *   · `server_error` 有 HTTP status → `server_error`;没有(null / 缺)→ `network`
 *     —— SDK 自己的约定:status 为 null 表示连接层失败,没拿到响应(拒连、
 *     重置、TLS、请求超时、睡眠断线)。
 *   · `max_output_tokens` 不是失败(正文只是被截断),返回 null,正文照常发。
 *   · 认不得的新标注 → `provider_error`:SDK 说了这是失败,就别当正文发出去。
 */
export function claudeApiErrorCode(sdkError: string | undefined, apiErrorStatus?: number | null): ProviderErrorCode | null {
  switch (sdkError) {
    case undefined: case '': case 'max_output_tokens': return null
    case 'authentication_failed': return 'auth_rejected'
    case 'billing_error': return 'quota'
    case 'rate_limit': return 'rate_limited'
    case 'invalid_request': return 'invalid_request'
    case 'server_error': return typeof apiErrorStatus === 'number' ? 'server_error' : 'network'
    default: return 'provider_error'
  }
}
