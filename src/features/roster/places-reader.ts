/**
 * reader.ts —— 「地方」读写口(设计稿 docs/superpowers/specs/2026-11-18-cc-two-sides-design.md §3)。
 * 数据和名单同一份(gatherRoster),只是往回看 30 天、再按项目根目录归拢;顺序 / 名字 / 收起读写 places 表。
 */
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { RosterItemT } from '@wechat-cc/protocol'
import { buildRoster } from '../../domain/roster'
import { buildPlaces } from '../../domain/places'
import { gatherRoster, type RosterReaderDeps } from './reader'
import type { PlacesStore } from '../../adapters/store/places-store'
import type { PlacesReader } from '../../ports/places'
import { makeProjectRoot } from './project-root'

export const PLACES_WINDOW_MS = 30 * 24 * 3_600_000

export interface PlacesReaderDeps {
  roster: RosterReaderDeps
  store: PlacesStore
  root?: (path: string | null | undefined) => string | null
}


export const placeKey = (root: string) => `p:${createHash('sha256').update(root).digest('hex').slice(0, 16)}`

export function makePlacesReader(deps: PlacesReaderDeps): PlacesReader {
  const root = deps.root ?? makeProjectRoot()
  return {
    read(scope) {
      const now = deps.roster.now?.() ?? Date.now()
      const g = gatherRoster(deps.roster, scope, now, PLACES_WINDOW_MS)
      const items = buildRoster({ ...g.input, seen: deps.roster.seen, now, backWindowMs: PLACES_WINDOW_MS })
      const pathOf = (item: RosterItemT): string | null => {
        if (item.kind === 'terminal') return g.sessions.get(item.id)?.project ?? null
        const m = g.matters.get(item.id)
        if (m?.projectPath) return m.projectPath
        return item.terminal ? g.sessions.get(item.terminal.sessionId)?.project ?? null : null
      }
      const { places, added } = buildPlaces({
        items,
        rootOf: item => root(pathOf(item)),
        originOf: id => g.matters.get(id)?.originMessageId ?? null,
        saved: deps.store.list(),
        keyOf: placeKey,
        nameOf: r => basename(r) || r,
      })
      if (added.length) deps.store.add(added, now)
      const version = createHash('sha256').update(JSON.stringify(places)).digest('hex').slice(0, 16)
      return { places, version }
    },
    move: (key, to) => deps.store.move(key, to),
    hide: (key, hidden) => deps.store.setHidden(key, hidden),
  }
}
