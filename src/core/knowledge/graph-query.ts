/**
 * Graph Query accessor — Knowledge Graph inproc Task 5. Wraps the pure query
 * functions in `graph.ts` (contactProfile/topContacts/rankContacts/
 * relationshipSubgraph/connectors, ported from wxgraph's `graph.py`) with the
 * real store-backed reader closures they need (`allContacts`, `edgesFor`,
 * `sharedGroupsOf`, owner from graph meta) — this is the seam between
 * `graph.ts`'s no-DB pure functions and the actual `KnowledgeStore` (graph.db,
 * built by Task 4's `rebuildGraph`/`graph-build.ts`).
 *
 * `makeGraphQueryApi(store)` is called once at bootstrap (mirrors how
 * `knowledge.embedQuery` is built once, not per-request) and returned as
 * `deps.knowledge.graph` — `routes-knowledge.ts`'s `/v1/knowledge/graph/*`
 * routes just call straight through to it.
 *
 * `sharedGroupsOf` (graph.py has no equivalent — it just reads each
 * contact's OWN `shared_groups` count, see `graph.ts`'s doc comment on
 * `connectors`) needs the real per-group speaker sets, which aren't
 * persisted anywhere — this module derives them by paging ALL of
 * `store.listMessages()` (same full-scan shape `graph-build.ts`'s
 * `rebuildGraphFromSource` already does) and caches the result, invalidated
 * whenever `store.sourceWatermark()` moves past what was cached (so a
 * `connectors` call right after a fresh ingest doesn't serve a stale index,
 * without re-scanning on every single call either).
 */
import type { KnowledgeStore } from './store'
import {
  connectors as connectorsFn,
  contactProfile as contactProfileFn,
  rankContacts as rankContactsFn,
  relationshipSubgraph as relationshipSubgraphFn,
  topContacts as topContactsFn,
  type Candidate,
  type Contact,
  type ConnectorsResult,
  type Edge,
  type RelationshipSubgraph,
} from './graph'

const GROUP_SCAN_PAGE_SIZE = 2000

export interface GraphStatus {
  contacts: number
  owner: string | null
  built_at: number | null
  /** True when source has advanced since the graph's last build — the
   *  answer may be missing recent contacts/edges until the next rebuild
   *  cycle runs (mirrors wxgraph's `status()`'s `stale`, but keyed off the
   *  watermark gate `graph-build.ts` already uses instead of file mtimes,
   *  which this in-proc store has no equivalent of). */
  stale: boolean
}

export interface GraphQueryApi {
  contactProfile(name: string): { resolved: false; candidates: Candidate[] } | (Contact & { resolved: true; mention_partners: Edge[] })
  topContacts(by: string, limit?: number, kind?: 'person' | 'group'): Contact[]
  rankContacts(topic?: string | null, limit?: number): Array<{ username: string; display: string; closeness: number }>
  relationshipSubgraph(center?: string | null, limit?: number): RelationshipSubgraph
  connectors(a: string, b: string): ConnectorsResult
  status(): GraphStatus
}

export function makeGraphQueryApi(store: KnowledgeStore): GraphQueryApi {
  const edgesFor = (username: string, kind: string): Edge[] => store.edgesFor(username, kind)

  // Lazy, watermark-invalidated cache of per-group speaker sets (conversation
  // -> set of usernames who sent a message there) — see module header.
  let cachedWatermark = -1
  let cachedGroupSpeakers: Map<string, Set<string>> | null = null

  function groupSpeakerSets(): Map<string, Set<string>> {
    const watermark = store.sourceWatermark()
    if (cachedGroupSpeakers && cachedWatermark === watermark) return cachedGroupSpeakers

    const sets = new Map<string, Set<string>>()
    let cursor = 0
    for (;;) {
      const page = store.listMessages(cursor, GROUP_SCAN_PAGE_SIZE)
      if (page.messages.length === 0) break
      for (const m of page.messages) {
        if (!m.is_group) continue
        let s = sets.get(m.conversation)
        if (!s) {
          s = new Set()
          sets.set(m.conversation, s)
        }
        s.add(m.sender)
      }
      cursor = page.watermark
    }

    cachedWatermark = watermark
    cachedGroupSpeakers = sets
    return sets
  }

  function sharedGroupsOf(a: string, b: string): number {
    let n = 0
    for (const speakers of groupSpeakerSets().values()) {
      if (speakers.has(a) && speakers.has(b)) n++
    }
    return n
  }

  return {
    contactProfile(name) {
      return contactProfileFn(store.allContacts(), edgesFor, name)
    },
    topContacts(by, limit = 20, kind = 'person') {
      return topContactsFn(store.allContacts(), by, limit, kind)
    },
    rankContacts(topic, limit = 20) {
      return rankContactsFn(store.allContacts(), topic, limit)
    },
    relationshipSubgraph(center, limit = 30) {
      return relationshipSubgraphFn(store.allContacts(), edgesFor, store.getGraphMeta('owner'), center, limit)
    },
    connectors(a, b) {
      return connectorsFn(store.allContacts(), edgesFor, sharedGroupsOf, a, b)
    },
    status() {
      const builtAtRaw = store.getGraphMeta('built_at')
      const storedWatermarkRaw = store.getGraphMeta('source_watermark')
      // Never built ⇒ nothing to be stale about. Otherwise stale iff source
      // has moved past the watermark the last build was stamped with —
      // exactly the gate `rebuildGraphFromSource` itself checks before
      // deciding whether a rebuild is worth doing.
      const stale = storedWatermarkRaw !== null && Number(storedWatermarkRaw) !== store.sourceWatermark()
      return {
        contacts: store.countContacts(),
        owner: store.getGraphMeta('owner'),
        built_at: builtAtRaw !== null ? Number(builtAtRaw) : null,
        stale,
      }
    },
  }
}
