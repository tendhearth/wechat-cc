/**
 * relationships.ts — 「关系」:一条记录 = 一个对方(架构重构 §2.2)。
 *
 * 此前"我认识谁、认识多深、怎么认识的"没有地方存:邻居的记忆在 neighbors.json,
 * 匿名对端的 mask 在 echo 表,真朋友的名字在 registry,人类朋友的名字在
 * conversations。registry 是**可达性 + 授权**(url / token / may_exec),不是关系。
 *
 * 这一步先做**派生视图**:从四个来源拼出来,不落表。跑一段再决定物化什么。
 * 手(capabilities 含 exec)不在这里 —— 它是设备。
 */

import { primaryChannels } from './penpal-channel-store'

export type RelationshipKind = 'peer' | 'anon' | 'neighbor' | 'human'

export interface Relationship {
  /** 稳定键:peer:<agentId> | anon:<channelId> | neighbor:<id> | human:<chatId> */
  id: string
  kind: RelationshipKind
  /** 怎么称呼:名字 / 第 N 度的某人 / 邻居「阿柚」/ 小王 */
  label: string
  /** 能发信封的信道 id;human 和 neighbor 为 null。 */
  channel: string | null
  familiarity: { visits: number; lastAt: string | null; note: string | null }
  /** 怎么认识的(给人读的一句)。 */
  origin: string
  /** 自动串门会不会去(对端证明过认得协议 / 邻居永远可以)。 */
  autoVisit: boolean
}

export interface RelationshipInputs {
  /** registry 里的对端(已去掉手)。 */
  peers: ReadonlyArray<{ id: string; name: string; transport: string; paused: boolean }>
  /** 开着的信道。 */
  channels: ReadonlyArray<{ id: string; peer_agent_id: string | null; degree: number; status: string; created_at: string }>
  /** 每条信道上的串门:visit id 集合 + 最近一次 + 对方回过没有。 */
  visitsByChannel: Record<string, { ids: number; lastAt: string | null; peerReplied: boolean }>
  neighbors: ReadonlyArray<{ id: string; name: string }>
  neighborMemory: { lastId: string | null; notes: Record<string, { at: string; note: string; visits?: number }> }
  /** 非主人的 chat:有名字就带上,以及来过几次(guest-visits 计数)。 */
  humans: ReadonlyArray<{ chatId: string; name: string | null; visits: number; lastAt: string | null }>
}

export function buildRelationships(i: RelationshipInputs): Relationship[] {
  const out: Relationship[] = []
  const peerName = new Map(i.peers.map(p => [p.id, p.name]))
  const seenPeer = new Set<string>()

  // 1) 有信道的:知道对端 id → peer;不知道(经介绍人)→ anon
  //    同一个对端可能有好几条 open 行(每次重新配对都按 nonce 建新行),
  //    只认最新的那条 —— 一个朋友一行,「串门」也去最新的那条。
  for (const ch of primaryChannels(i.channels)) {
    const v = i.visitsByChannel[ch.id] ?? { ids: 0, lastAt: null, peerReplied: false }
    const known = ch.peer_agent_id && peerName.has(ch.peer_agent_id)
    if (known) seenPeer.add(ch.peer_agent_id!)
    out.push({
      id: known ? `peer:${ch.peer_agent_id}` : `anon:${ch.id}`,
      kind: known ? 'peer' : 'anon',
      label: known ? peerName.get(ch.peer_agent_id!)! : `第 ${ch.degree} 度的某人`,
      channel: ch.id,
      familiarity: { visits: v.ids, lastAt: v.lastAt, note: null },
      // 「派心愿牵线」只可能出现在旧揭晓流程留下的历史行上;2026-09-04 起配对即开信道,新行一律「配对」。
      origin: known ? '配对' : `派心愿牵线(${ch.degree} 度)`,
      autoVisit: v.peerReplied,
    })
  }
  // 2) registry 里有、但还没开信道的对端:认识,但伙伴还去不了它家
  for (const p of i.peers) {
    if (seenPeer.has(p.id)) continue
    out.push({
      id: `peer:${p.id}`, kind: 'peer', label: p.name, channel: null,
      familiarity: { visits: 0, lastAt: null, note: null },
      origin: p.paused ? '配对(已暂停)' : '配对(还没开信道)',
      autoVisit: false,
    })
  }
  // 3) 邻居
  for (const nb of i.neighbors) {
    const m = i.neighborMemory.notes[nb.id]
    out.push({
      id: `neighbor:${nb.id}`, kind: 'neighbor', label: `邻居「${nb.name}」`, channel: null,
      familiarity: { visits: m?.visits ?? (m ? 1 : 0), lastAt: m?.at ?? null, note: m?.note ?? null },
      origin: '公共伙伴(tendhearth)',
      autoVisit: true,
    })
  }
  // 4) 人类朋友
  for (const h of i.humans) {
    out.push({
      id: `human:${h.chatId}`, kind: 'human', label: h.name?.trim() || `「${h.chatId.split('@')[0]?.slice(0, 6)}…」那位`, channel: null,
      familiarity: { visits: h.visits, lastAt: h.lastAt, note: null },
      origin: '来找我聊过',
      autoVisit: false,
    })
  }
  // 最近有往来的在前;从没往来的按 kind 稳定排
  const rank: Record<RelationshipKind, number> = { peer: 0, anon: 1, human: 2, neighbor: 3 }
  return out.sort((a, b) => {
    const la = a.familiarity.lastAt ?? '', lb = b.familiarity.lastAt ?? ''
    if (la !== lb) return lb.localeCompare(la)
    return rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label)
  })
}
