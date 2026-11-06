import type { MatterT } from '../backend/types'
import type { Bubble } from './chat'
import type { HomeRow, HomeView } from './home'

/** Stable reference identity. Execution status never creates another chat message. */
export type ConversationItem = { key: string; at: number; bubble?: Bubble; row?: HomeRow; historical?: boolean; card?: import('./companion').CompanionCard }
export function conversationItems(bubbles: Bubble[], view: HomeView, matters: MatterT[], ownerChatId: string | undefined, opened: readonly string[] = [], fresh: readonly string[] = []): ConversationItem[] {
  const messages = new Map(bubbles.map(b => [b.key, b]))
  const items: ConversationItem[] = bubbles.map(bubble => ({ key: bubble.key, at: bubble.at, bubble }))
  for (const row of view.groups.flatMap(g => g.rows)) {
    const identity = row.matterId ? `matter:${row.matterId}` : `${row.source}:${row.id}`
    const alias = `${row.source}:${row.id}`
    const matter = matters.find(m => m.id === (row.matterId ?? row.id))
    const source = matter?.originMatterId === ownerChatId && matter?.originMessageId ? messages.get(matter.originMessageId) : undefined
    if (!source && !opened.includes(identity) && !opened.includes(alias)) continue
    items.push({ key: `ref:${identity}`, at: source?.at ?? matter?.createdAt ?? row.updatedAt, row, historical: !source && !fresh.includes(identity) && !fresh.includes(alias) })
  }
  return items.sort((a, b) => a.at - b.at || (a.bubble && !b.bubble ? -1 : b.bubble && !a.bubble ? 1 : a.key.localeCompare(b.key)))
}
