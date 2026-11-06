import { matterOrigin } from './origin'
import type { MatterT } from '../backend/types'
import type { Bubble } from './chat'
import type { HomeRow, HomeView } from './home'

/** Stable reference identity. Execution status never creates another chat message. */
export type ConversationItem = { key: string; at: number; bubble?: Bubble; row?: HomeRow; historical?: boolean; gap?:true; card?: import('./companion').CompanionCard }
export function conversationItems(bubbles: Bubble[], view: HomeView, matters: MatterT[], ownerChatId: string | undefined, opened: readonly string[] = [], fresh: readonly string[] = [], anchors:ReadonlyMap<string,string>=new Map()): ConversationItem[] {
  const messages = new Map(bubbles.map(b => [b.key, b]))
  const items: ConversationItem[] = bubbles.map(bubble => ({ key: bubble.key, at: bubble.at, bubble }))
  const rows:HomeRow[]=view.groups.flatMap(g=>g.rows)
  for(const matter of matters)if(matter.kind==='act'&&anchors.has(matter.id)&&!rows.some(row=>row.id===matter.id))rows.push({id:matter.id,source:'matter',href:`/matter/${encodeURIComponent(matter.id)}`,title:matter.title,caption:null,detail:null,note:null,status:matter.state==='working'?'working':matter.state==='waiting'?'waiting':matter.state==='failed'?'failed':matter.state==='cancelled'?'stopped':matter.state==='done'?'done':'replied',pendingRequestId:null,agents:matter.agents??[],agentNames:matter.agentNames,origin:matterOrigin(matter.origin),updatedAt:matter.updatedAt})
  for (const row of rows) {
    const identity = row.matterId ? `matter:${row.matterId}` : `${row.source}:${row.id}`
    const alias = `${row.source}:${row.id}`
    const matter = matters.find(m => m.id === (row.matterId ?? row.id))
    const anchor=anchors.get(row.matterId??row.id)??(matter?.originMatterId===ownerChatId?matter?.originMessageId:null)
    const source=anchor?messages.get(anchor):undefined
    if (!source && !opened.includes(identity) && !opened.includes(alias)) continue
    items.push({ key: `ref:${identity}`, at: source?.at ?? matter?.createdAt ?? row.updatedAt, row, historical: !source && !fresh.includes(identity) && !fresh.includes(alias) })
  }
  return items.sort((a, b) => a.at - b.at || (a.bubble && !b.bubble ? -1 : b.bubble && !a.bubble ? 1 : a.key.localeCompare(b.key)))
}
