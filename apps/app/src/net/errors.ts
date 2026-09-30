import type { BackendCode } from '../backend/types'

const STALE = new Set(['permission_stale', 'question_stale', 'input_stale'])
/** daemon 的 409:这件事这一轮还在跑 / 上一条补充还没交付 / 会话正在回话 / 同一个请求 id 撞上不同内容。都是「等这一轮做完再说」。 */
const BUSY = new Set(['workbench_busy', 'input_delivery_busy', 'reply_sink_busy', 'input_conflict'])
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
  if (err === 'matter_not_found') return 'not_found'
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
