import { placementPriority, renderPlacedItems } from '../../domain/place-map-prompt'
import { allowedTopicEntryIds, localTopicContext, topicMatterAccess } from '../../lib/topic-provenance'
/**
 * reader.ts —— 「地方」读写口(设计稿 docs/superpowers/specs/2026-11-18-cc-two-sides-design.md §3)。
 * 数据和名单同一份(gatherRoster),只是往回看 30 天、再按项目根目录归拢;顺序 / 名字 / 收起读写 places 表。
 */
import type { makeLabsSettings } from '../../adapters/store/labs-settings'
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
import { makePlaceOutlines, type PlaceOutlineDeps } from './place-outline'
import { readOutlineInput } from './place-outline-input'
import type { SessionRecaps } from './session-recap'
import { claudeProjectSlug, makeProjectRoot, SCRATCH_PREFIX } from './project-root'

export const PLACES_WINDOW_MS = 30 * 24 * 3_600_000

export interface PlacesReaderDeps {
  roster: RosterReaderDeps
  mapWorkbench?: RosterReaderDeps['workbench']
  store: PlacesStore
  labs?: ReturnType<typeof makeLabsSettings>
  outlines?: PlaceOutlineDeps
  recaps?: SessionRecaps
  noteDesktopSeen?: (id: string) => void
  mapTopics?: { db: Db; owner: () => string | null; makeResolver: MapTopicResolver }
  opinion?: (requestId: string) => PlaceOpinionT | undefined
  root?: (path: string | null | undefined) => string | null
}


export const placeKey = (root: string) => `p:${createHash('sha256').update(root).digest('hex').slice(0, 16)}`

export function makePlacesReader(deps: PlacesReaderDeps) {
  const placeMapEnabled = () => deps.labs?.placeMapEnabled() ?? false
  const root = deps.root ?? makeProjectRoot()
  function collect(scope: 'operator' | 'device', roster = deps.roster, onHead?: (key: string, item: RosterItemT) => void) {
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
      items, onHead,
      rootOf: item => resolved(raw.get(item.key)),
      originOf: id => g.matters.get(id)?.originMessageId ?? null,
      saved,
      keyOf: placeKey,
      nameOf: r => basename(r) || r,
    })
    return { ...result, saved, now, items, rootOf: (path: string | null) => resolved(root(path)) }
  }

  const collectMapPlaces = () => collect('operator', { ...deps.roster, workbench: deps.mapWorkbench })
  async function mapProjection(key: string) {
    const { places, saved, added, items, rootOf } = collectMapPlaces()
    const place = places.find(place => place.key === key)
    const records = [...saved, ...added]
    const record = records.find(record => record.key === key)
    if (!place || !record) return null
    const owner = deps.mapTopics?.owner()
    const entries = owner && deps.mapTopics
      ? await placeMapEntries(deps.mapTopics.db, owner, record.root, records.map(record => record.root), rootOf, deps.mapTopics.makeResolver)
      : { items: [], truncated: false }
    if (owner !== deps.mapTopics?.owner()) return null
    const data = { place: { key, name: place.name }, items: [...entries.items, ...placeMapRoster(place, items)], truncated: entries.truncated }
    const pins = deps.store.mapPins(key, data.items.map(item => item.id))
    for (const item of data.items) {
      const pin = pins.get(item.id)
      if (pin && !item.id.startsWith('a:')) item.pin = pin
    }
    return { data, pins, owner, location: { root: record.root, rootOf } }
  }

  type Projection = NonNullable<Awaited<ReturnType<typeof mapProjection>>>
  function placedIn({ data, pins }: Projection) {
    const byId = new Map(data.items.map(item => [item.id, item]))
    return [...pins.keys()].flatMap(id => {
      const item = byId.get(id)
      return item?.pin ? [{ id, kind: item.kind, branch: item.pin, line: item.line }] : []
    }).sort((a, b) => placementPriority(a.branch) - placementPriority(b.branch))
  }

  function outlineSnapshot(projection: Projection) {
    const { data, owner, location } = projection
    if (!owner || !deps.mapTopics || deps.mapTopics.owner() !== owner) return null
    const { db } = deps.mapTopics
    const matterIds = new Map(data.items.map(item => [item.id, item.from.matterId]))
    const pinned = placedIn(projection)
    const allowed = topicMatterAccess(db, localTopicContext(owner), pinned.flatMap(item => matterIds.get(item.id) ?? [])).entryAllowed
    const visible = pinned.filter(item => {
      const matterId = matterIds.get(item.id)
      return item.id.startsWith('e:') || (matterId && allowed.has(matterId))
    }).slice(0, 8)
    const placed = renderPlacedItems(visible)
    const placements = placed ? visible.slice(0, placed.split('\n').length - 1) : []
    const pinnedEntries = placements.flatMap(item => item.id.startsWith('e:') ? [item.id.slice(2)] : [])
    const pinnedMatters = placements.flatMap(item => {
      const matterId = matterIds.get(item.id)
      return !item.id.startsWith('e:') && matterId ? [{ id: item.id, matterId }] : []
    })
    return { owner, location, items: data.items, pinnedEntries, pinnedMatters,
      input: readOutlineInput(db, owner, data.items, placed, deps.roster.executorName ?? (id => id), location) }
  }

  const outlines = deps.outlines && deps.mapTopics ? makePlaceOutlines({
    ...deps.outlines, db: deps.mapTopics.db, owner: deps.mapTopics.owner,
    now: deps.roster.now ?? Date.now, enabled: placeMapEnabled,
    async load(key) {
      const projection = await mapProjection(key)
      return projection && outlineSnapshot(projection)
    },
  }) : undefined

  async function map(key: string, includeOutline = false): ReturnType<PlacesReader['map']> {
    const projection = await mapProjection(key)
    if (!projection) return null
    const { data } = projection
    const revision = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)
    const response = { ok: true as const, ...data, revision }
    if (!includeOutline || !placeMapEnabled()) return response
    return { ...response, outline: outlines?.read(key, outlineSnapshot(projection)) ?? { state: 'none', canRun: false } }
  }

  return {
    recapEnabled: () => deps.recaps?.enabled() ?? false,
    setRecapEnabled: deps.recaps?.setEnabled,
    recap: (id: string) => deps.recaps?.enabled() ? deps.recaps.read(id) : undefined,
    read(scope, includeRecap = true) {
      const heads = new Map<string, string>()
      const recaps = scope === 'operator' && includeRecap && deps.recaps?.enabled() ? deps.recaps : undefined
      const { places, hidden, added, now } = collect(scope, deps.roster, recaps && ((key, item) => {
        if (item.terminal) heads.set(key, item.terminal.sessionId)
      }))
      if (added.length) deps.store.add(added, now)
      for (const place of places) {
        const id = heads.get(place.key)
        const recap = id && recaps?.read(id)
        if (recap) place.recap = recap
        const waiting = place.waiting
        if (waiting?.requestId) Object.assign(waiting, deps.opinion?.(waiting.requestId))
      }
      const data = { places, hidden, ...(placeMapEnabled() ? { labs: { placeMap: true as const } } : {}) }
      const version = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)
      return { ...data, version }
    },
    placeMapEnabled,
    setPlaceMap(enabled) {
      if (!deps.labs) return false
      deps.labs.setPlaceMap(enabled)
      if (!enabled) outlines?.invalidate()
      return true
    },
    placeForPath(path) {
      const { rootOf, places } = collectMapPlaces()
      const root = rootOf(path)
      const key = root && placeKey(root)
      return key && places.some(place => place.key === key) ? key : null
    },
    placeForEntries(owner, entryIds) {
      if (!deps.mapTopics || deps.mapTopics.owner() !== owner || entryIds.length === 0) return null
      const { db } = deps.mapTopics
      const rows = db.query<{ id: string; path: string | null; private: number }, [string, string]>(`
        SELECT e.id, m.project_path AS path, t.private
        FROM topic_entries e JOIN threads t ON t.id=e.thread_id
        LEFT JOIN matters m ON m.id=e.matter_id
        WHERE e.id IN (SELECT value FROM json_each(?)) AND t.chat_id=?
          AND e.status='live' AND e.matter_id IS NOT NULL
      `).all(JSON.stringify(entryIds), owner)
      if (!rows.length) return null
      const allowed = allowedTopicEntryIds(db, localTopicContext(owner), rows.map(row => row.id))
      if (rows.some(row => row.private || !allowed.has(row.id))) return null
      const { rootOf, places } = collectMapPlaces()
      const roots = new Set(rows.map(row => rootOf(row.path)))
      if (roots.size !== 1) return null
      const [root] = roots
      const key = root && placeKey(root)
      return key && places.some(place => place.key === key) ? key : null
    },
    async placedItems(key) {
      const projection = await mapProjection(key)
      return projection ? placedIn(projection) : []
    },
    map,
    startOutline: key => outlines?.start(key) ?? Promise.resolve('unavailable' as const),
    async pin({ key, itemId, branch }) {
      if (!placeMapEnabled()) return 'lab_off'
      const current = await map(key)
      if (!placeMapEnabled()) return 'lab_off'
      if (!current) return 'place_not_found'
      if (!current.items.some(item => item.id === itemId)) return 'place_map_item_not_found'
      if (itemId.startsWith('a:')) return 'place_map_item_fixed'
      deps.store.setMapPin(key, itemId, branch)
      return null
    },
    planPlaces() {
      // Planning reads saved roots using the operator view without persisting newly discovered places.
      const { places, saved } = collect('operator')
      const visible = new Set(places.map(place => place.key))
      return saved.filter(place => visible.has(place.key))
    },
    move: (key, to) => deps.store.move(key, to),
    hide: (key, hidden) => deps.store.setHidden(key, hidden),
    seen(key, desktop = false) {
      if (!deps.store.markSeen(key, deps.roster.now?.() ?? Date.now())) return false
      if (desktop && deps.recaps?.enabled() && deps.noteDesktopSeen) {
        const place = collect('operator').places.find(place => place.key === key)
        for (const id of place?.matterIds ?? []) deps.noteDesktopSeen(id)
      }
      return true
    },
  } satisfies PlacesReader & { planPlaces(): ReturnType<PlacesStore['list']> }
}
