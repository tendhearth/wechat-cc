/**
 * mw-messages — mirror every allow-listed inbound message into the
 * canonical messages table (spec D4). Runs BEFORE next() so messages
 * consumed by command routing (admin / mode / onboarding) still land,
 * with kind='command'. Placed after access (denied senders never reach
 * here) — see build.ts ordering.
 */
import type { Middleware } from './types'
import type { MessageRecord } from '../../lib/messages-store'
import { inboundMessageId, inboundFallbackMessageId } from '../../lib/messages-store'
import { isoFromMs } from '../../lib/iso-time'

export interface MessagesMwDeps {
  append(rec: MessageRecord): Promise<number>
  log: (tag: string, line: string) => void
  /**
   * 记一笔"有入站活动"。此处是语义正确的位置:access + dedup 之后(陌生人
   * 与重复消息不算),且在所有消费型中间件之前(管理员命令也算用户在活动)。
   * 可选:省略即不记录,既有测试与 e2e 不受影响。
   */
  markInboundActivity?: () => void
}

export function makeMwMessages(deps: MessagesMwDeps): Middleware {
  return async (ctx, next) => {
    try { deps.markInboundActivity?.() } catch { /* 绝不能因为记一笔就打断入站管线 */ }
    const messageId = ctx.msg.createTimeMs
      ? inboundMessageId(ctx.msg.userId, ctx.msg.createTimeMs)
      : inboundFallbackMessageId(ctx.msg.userId, ctx.msg.text)
    const rec: MessageRecord = {
      id: messageId,
      chatId: ctx.msg.chatId,
      // Guard against an out-of-range create_time_ms (untrusted poll payload):
      // a raw new Date(huge).toISOString() throws RangeError, which here — on
      // the hot path that records every inbound — would silently drop the
      // user's message. Fall back to the receive time.
      ts: isoFromMs(ctx.msg.createTimeMs || ctx.receivedAtMs, ctx.receivedAtMs),
      direction: 'in',
      kind: ctx.msg.text.startsWith('/') ? 'command'
        : ctx.msg.msgType !== 'text' ? ctx.msg.msgType
        : 'text',
      text: ctx.msg.text,
      source: 'live',
    }
    try { await deps.append(rec) } catch (err) {
      deps.log('MESSAGES', `inbound record failed for ${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`)
    }
    await next()
  }
}
