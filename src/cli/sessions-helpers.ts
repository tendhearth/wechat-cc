import type { SessionRecord } from '../core/session-store'

export interface ChatEntry {
  chat_id: string
  user_name: string | null
  account_id: string | null
  session_count: number
  last_used_at: string
}

/**
 * Group session records by chat_id. `session_count` is the number of
 * distinct aliases for that chat (what the filtered right-panel list shows);
 * `last_used_at` is the max across the chat's rows. Sorted most-recent first.
 * Name/account are resolved via the injected lookups (kept pure — no store I/O).
 */
export function groupChats(
  records: SessionRecord[],
  nameOf: (chatId: string) => string | null,
  accountOf: (chatId: string) => string | null,
): ChatEntry[] {
  const byChat = new Map<string, { aliases: Set<string>; last: string }>()
  for (const r of records) {
    const g = byChat.get(r.chat_id) ?? { aliases: new Set<string>(), last: r.last_used_at }
    g.aliases.add(r.alias)
    if (Date.parse(r.last_used_at) > Date.parse(g.last)) g.last = r.last_used_at
    byChat.set(r.chat_id, g)
  }
  return [...byChat.entries()]
    .map(([chat_id, g]) => ({
      chat_id,
      user_name: nameOf(chat_id),
      account_id: accountOf(chat_id),
      session_count: g.aliases.size,
      last_used_at: g.last,
    }))
    .sort((a, b) => Date.parse(b.last_used_at) - Date.parse(a.last_used_at))
}
