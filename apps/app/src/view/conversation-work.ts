import type { MatterT } from '../backend/types'
import type { Bubble } from './chat'
import type { HomeRow, HomeView } from './home'

/** Stable reference identity. Execution status never creates another chat message. */
export type ConversationItem = { key: string; at: number; bubble?: Bubble; row?: HomeRow; historical?: boolean; card?: import('./companion').CompanionCard }
export function conversationItems(bubbles: Bubble[], view: HomeView, matters: MatterT[], ownerChatId: string | undefined, opened: readonly string[] = [], fresh: readonly string[] = []): ConversationItem[] {
  const messages = new Map(bubbles.map(b => [b.key, b]))
  const items: ConversationItem[] = bubbles.map(bubble => ({ key: bubble.key, at: bubble.at, bubble }))
  for (const row of view.groups.flatMap(g => g.rows)) {
    const matter = matters.find(m => m.id === row.id)
    const source = matter?.originMatterId === ownerChatId && matter?.originMessageId ? messages.get(matter.originMessageId) : undefined
    if (!source && !opened.includes(`${row.source}:${row.id}`)) continue
    items.push({ key: `ref:${row.source}:${row.id}`, at: source?.at ?? matter?.createdAt ?? row.updatedAt, row, historical: !source && !fresh.includes(`${row.source}:${row.id}`) })
  }
  return items.sort((a, b) => a.at - b.at || (a.bubble ? -1 : b.bubble ? 1 : a.key.localeCompare(b.key)))
}
