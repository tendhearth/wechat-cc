import type { BackendCode } from '../backend/types'

const STALE = new Set(['permission_stale', 'question_stale', 'input_stale'])
/** daemon 的 409:这件事这一轮还在跑 / 上一条补充还没交付 / 会话正在回话 / 同一个请求 id 撞上不同内容。都是「等这一轮做完再说」。 */
const BUSY = new Set(['workbench_busy', 'input_delivery_busy', 'reply_sink_busy', 'input_conflict', 'chat_busy'])
/** 找不到:事项不在 / 还没有主人那条对话(页面当空对话)/ 原生会话读不了。 */
const NOT_FOUND = new Set(['matter_not_found', 'no_owner_chat', 'unsupported'])
/** daemon 这一块没接上(503):推送 / 跟 CC 说 / 连接 / 原生会话。 */
const UNAVAILABLE = new Set(['push_not_wired', 'chat_not_wired', 'connections_not_wired', 'sessions_not_wired'])
/** 接着做电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions D11):各有各的一句话,不能都说「没送到」。
 *  必须在 `invalid_` 前缀规则之前判(invalid_path ⇒ folder_missing)。native_history_changed / _empty / _already_managed
 *  故意不在这里:落到 unknown(中性),不冒充「没到电脑」。 */
const SPECIFIC: ReadonlyMap<string, BackendCode> = new Map<string, BackendCode>([
  ['native_session_busy', 'session_busy'], ['native_folder_busy', 'folder_busy'],
  ['unavailable_provider', 'provider_missing'], ['invalid_path', 'folder_missing'], ['provider_quota_exhausted', 'quota'],
])
const errOf = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) return null
  const e = (body as { error?: unknown }).error
  return typeof e === 'string' ? e : null
}

/** 一条已到达的响应算不算失败、算哪种。成功 ⇒ null(之后再过 schema)。 */
export function mapPhoneError(status: number, body: unknown): BackendCode | null {
  const err = errOf(body)
  if (status === 401 || err === 'unauthorized') return 'revoked'
  const okFalse = typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === false
  if (!okFalse && status < 400) return null
  if (err && STALE.has(err)) return 'stale'
  if (err && BUSY.has(err)) return 'busy'
  const specific = err ? SPECIFIC.get(err) : undefined
  if (specific) return specific
  if (err && UNAVAILABLE.has(err)) return 'unavailable'
  if (status === 503 && err === 'unavailable') return 'unavailable'
  if (err && NOT_FOUND.has(err)) return 'not_found'
  if (err === 'invalid' || (err !== null && err.startsWith('invalid_'))) return 'invalid'
  return 'unknown'
}

/** 协议客户端拒绝请求的原因(client.ts 的 Error.message)。 */
export function transportErrorCode(e: unknown): BackendCode {
  const m = e instanceof Error ? e.message : ''
  if (m === 'auth_failed') return 'revoked'
  if (m === 'timeout') return 'timeout'
  if (m === 'frame_too_large' || m === 'binary_body_needs_v2') return 'unknown'
  return 'offline'
}
