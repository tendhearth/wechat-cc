/**
 * places.ts —— 「地方」:把名单里的行按项目归拢成正面上半的几行(设计稿 docs/superpowers/specs/2026-11-18-cc-two-sides-design.md §3)。
 *
 * 纯函数:不读时钟、不碰 IO。名单行、每行属于哪个项目根目录、主人存下的顺序,都由 features/roster/places-reader.ts 取好了交进来。
 *
 * 规矩:
 *   - 一个项目根目录 = 一个地方。说不出项目的事(没有文件夹的小事)不成行,留在说话里。
 *   - 顺序只看存下的 position,不按状态重排;第一次见到的地方追加在末尾(同一次见到好几个:最近动过的在前)。
 *   - 主人收起(hidden)的地方不列,除非那里有事在等他。
 *   - 现状那一句:有在等你的 ⇒ 等得最久的那条;否则主人上次看过这一行以后动过的 ⇒ 最近动的那件;
 *     否则有在干的 ⇒ 最近在干的那件;否则最近动过的那件。(「坐回来」:那一句先说你不在时变了什么。)
 *   - 主人看过这一行(seenAt)以后的事才算「没看过」;没记过 ⇒ 照每件事自己的看没看过。
 */
import type { PlaceT, RosterItemT } from '@wechat-cc/protocol'

export interface PlaceRecord {
  key: string; root: string; name: string; position: number; hidden: boolean
  /** 主人上次看这一行(点开筛说话 / 打开里面一件)的时刻;没看过 ⇒ 不带或 null。 */
  seenAt?: number | null
}

export interface PlacesInput {
  /** buildRoster 的输出(等你的在前、等得久的更前)。 */
  items: RosterItemT[]
  /** 这一行属于哪个项目根目录;说不出 ⇒ null。 */
  rootOf: (item: RosterItemT) => string | null
  /** 这件事是从主人哪条消息分出来的。 */
  originOf: (matterId: string) => string | null
  saved: PlaceRecord[]
  keyOf: (root: string) => string
  nameOf: (root: string) => string
  /** 每个地方最多带多少件事的 id 去筛说话。 */
  maxIds?: number
}

export interface PlacesOutput { places: PlaceT[]; hidden: Pick<PlaceT, 'key' | 'name'>[]; added: PlaceRecord[] }

export const rosterLine = (item: RosterItemT) => item.terminal?.summary?.trim() || item.title

export function buildPlaces(input: PlacesInput): PlacesOutput {
  const max = input.maxIds ?? 50
  const groups = new Map<string, RosterItemT[]>()
  for (const item of input.items) {
    const root = input.rootOf(item)
    if (!root) continue
    const list = groups.get(root)
    if (list) list.push(item)
    else groups.set(root, [item])
  }

  const byRoot = new Map(input.saved.map(r => [r.root, r]))
  const byKey = new Map(input.saved.map(r => [r.key, r]))
  const latest = (items: RosterItemT[]) => Math.max(...items.map(i => i.updatedAt))
  const fresh = [...groups.entries()].filter(([root]) => !byRoot.has(root) && !byKey.has(input.keyOf(root)))
    .sort((a, b) => latest(b[1]) - latest(a[1]) || a[0].localeCompare(b[0]))
  let next = input.saved.reduce((m, r) => Math.max(m, r.position + 1), 0)
  const added: PlaceRecord[] = fresh.map(([root]) => ({ key: input.keyOf(root), root, name: input.nameOf(root), position: next++, hidden: false }))

  const records = [...input.saved, ...added].sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
  const places: PlaceT[] = []
  const hidden: PlacesOutput['hidden'] = []
  for (const rec of records) {
    const items = groups.get(rec.root) ?? []
    const waitingItems = items.filter(i => i.group === 'waiting')
    if (rec.hidden && waitingItems.length === 0) {
      hidden.push({ key: rec.key, name: rec.name })
      continue
    }

    const first = waitingItems[0]
    const waiting: PlaceT['waiting'] = first ? {
      itemKey: first.key,
      kind: first.waiting?.kind ?? 'terminal',
      ...(first.kind === 'matter' ? { matterId: first.id } : {}),
      ...(first.waiting ? { requestId: first.waiting.requestId } : {}),
      ...(first.terminal ? { sessionId: first.terminal.sessionId } : {}),
      summary: first.waiting?.summary || rosterLine(first),
      count: waitingItems.reduce((n, i) => n + (i.waiting?.count ?? 1), 0),
    } : null

    const recent = [...items].sort((a, b) => b.updatedAt - a.updatedAt)
    const seenAt = rec.seenAt ?? null
    const changed = seenAt == null ? [] : recent.filter(i => i.updatedAt > seenAt)
    const head = first ?? changed[0] ?? recent.find(i => i.group === 'working') ?? recent[0]
    const matterIds = recent.filter(i => i.kind === 'matter').slice(0, max).map(i => i.id)
    const messageIds = [...new Set(matterIds.map(id => input.originOf(id)).filter((m): m is string => !!m))]
    const sessionIds = [...new Set(recent.flatMap(i => i.terminal ? [i.terminal.sessionId] : []))].slice(0, max)

    places.push({
      key: rec.key,
      name: rec.name,
      line: head ? (first ? waiting!.summary : rosterLine(head)) : null,
      status: head ? head.status : null,
      waiting,
      moving: items.some(i => i.group === 'working'),
      unseen: items.some(i => i.unseen && (seenAt == null || i.updatedAt > seenAt)),
      alsoChanged: changed.filter(i => i !== head).length,
      updatedAt: items.length ? latest(items) : null,
      matterIds,
      messageIds,
      sessionIds,
    })
  }
  return { places, hidden, added }
}
