/**
 * Introspect's "用户最近发的消息" feed. Reads a window from the canonical
 * messages table (spec D4) rather than any live poll state — the introspect
 * tick runs on a 24h cadence, so persisted history IS the right source.
 * Fetches limit*3 rows to survive interleaved 'out' bubbles (reply-splitting
 * writes several 'out' rows per 'in'), then keeps the newest `limit` inbound.
 */
import type { MessagesStore } from '../../lib/messages-store'

export async function recentInboundTexts(
  store: MessagesStore,
  chatId: string,
  limit = 10,
): Promise<string[]> {
  const rows = await store.listRange(chatId, { limit: limit * 3 })
  return rows
    .filter(r => r.direction === 'in' && r.kind !== 'command' && r.text.trim().length > 0)
    .slice(-limit)
    .map(r => r.text)
}
