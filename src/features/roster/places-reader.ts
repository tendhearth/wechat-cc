/**
 * reader.ts —— 「地方」读写口(设计稿 docs/superpowers/specs/2026-11-18-cc-two-sides-design.md §3)。
 * 数据和名单同一份(gatherRoster),只是往回看 30 天、再按项目根目录归拢;顺序 / 名字 / 收起读写 places 表。
 */
import type { Db } from '../../lib/db'
import { placeMapEntries, placeMapRoster, type MapTopicResolver } from './place-map'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { PlaceOpinionT, RosterItemT } from '@wechat-cc/protocol'
import { buildRoster } from '../../domain/roster'
import { buildPlaces } from '../../domain/places'
import { gatherRoster, type RosterReaderDeps } from './reader'
import type { PlacesStore } from '../../adapters/store/places-store'
import type { PlacesReader } from '../../ports/places'
import { claudeProjectSlug, makeProjectRoot, SCRATCH_PREFIX } from './project-root'

export const PLACES_WINDOW_MS = 30 * 24 * 3_600_000

export interface PlacesReaderDeps {
  roster: RosterReaderDeps
  mapWorkbench?: RosterReaderDeps['workbench']
  store: PlacesStore
  mapTopics?: { db: Db; owner: () => string | null; makeResolver: MapTopicResolver }
  opinion?: (requestId: string) => PlaceOpinionT | undefined
  root?: (path: string | null | undefined) => string | null
}


export const placeKey = (root: string) => `p:${createHash('sha256').update(root).digest('hex').slice(0, 16)}`

export function makePlacesReader(deps: PlacesReaderDeps) {
  const root = deps.root ?? makeProjectRoot()
  function collect(scope: 'operator' | 'device', roster = deps.roster) {
    const now = roster.now?.() ?? Date.now()
    const g = gatherRoster(roster, scope, now, PLACES_WINDOW_MS)
    const items = buildRoster({ ...g.input, seen: roster.seen, now, backWindowMs: PLACES_WINDOW_MS })
    const pathOf = (item: RosterItemT): string | null => {
      if (item.kind === 'terminal') return g.sessions.get(item.id)?.project ?? null
      const m = g.matters.get(item.id)
      if (m?.projectPath) return m.projectPath
      return item.terminal ? g.sessions.get(item.terminal.sessionId)?.project ?? null : null
    }
    const saved = deps.store.list()
    const raw = new Map(items.map(item => [item.key, root(pathOf(item))]))
    // Claude Code 在临时目录里干活:路径里编码着原目录,对回已知的项目(这一批里认出来的 + 存下的);对不上就不算。
    const bySlug = new Map<string, string>()
    for (const r of [...saved.map(x => x.root), ...raw.values()]) if (r && !r.startsWith(SCRATCH_PREFIX)) bySlug.set(claudeProjectSlug(r), r)
    const resolved = (r: string | null | undefined) => (r?.startsWith(SCRATCH_PREFIX) ? bySlug.get(r.slice(SCRATCH_PREFIX.length)) ?? null : r ?? null)
    const result = buildPlaces({
      items,
      rootOf: item => resolved(raw.get(item.key)),
      originOf: id => g.matters.get(id)?.originMessageId ?? null,
      saved,
      keyOf: placeKey,
      nameOf: r => basename(r) || r,
    })
    return { ...result, saved, now, items, rootOf: (path: string | null) => resolved(root(path)) }
  }

  return {
    read(scope) {
      const { places, hidden, added, now } = collect(scope)
      if (added.length) deps.store.add(added, now)
      for (const place of places) {
        const waiting = place.waiting
        if (waiting?.requestId) Object.assign(waiting, deps.opinion?.(waiting.requestId))
      }
      const version = createHash('sha256').update(JSON.stringify({ places, hidden })).digest('hex').slice(0, 16)
      return { places, hidden, version }
    },
    async map(key) {
      const { places, saved, added, items, rootOf } = collect('operator', { ...deps.roster, workbench: deps.mapWorkbench })
      const place = places.find(place => place.key === key)
      const records = [...saved, ...added]
      const record = records.find(record => record.key === key)
      if (!place || !record) return null
      const owner = deps.mapTopics?.owner()
      const entries = owner && deps.mapTopics
        ? await placeMapEntries(deps.mapTopics.db, owner, record.root, records.map(record => record.root), rootOf, deps.mapTopics.makeResolver)
        : { items: [], truncated: false }
      const data = { place: { key, name: place.name }, items: [...entries.items, ...placeMapRoster(place, items)], truncated: entries.truncated }
      const revision = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)
      return { ok: true, ...data, revision }
    },
    planPlaces() {
      // Planning reads saved roots using the operator view without persisting newly discovered places.
      const { places, saved } = collect('operator')
      const visible = new Set(places.map(place => place.key))
      return saved.filter(place => visible.has(place.key))
    },
    move: (key, to) => deps.store.move(key, to),
    hide: (key, hidden) => deps.store.setHidden(key, hidden),
    seen: key => deps.store.markSeen(key, deps.roster.now?.() ?? Date.now()),
  } satisfies PlacesReader & { planPlaces(): ReturnType<PlacesStore['list']> }
}
