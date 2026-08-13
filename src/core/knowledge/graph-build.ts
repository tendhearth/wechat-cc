/**
 * Graph rebuild orchestration — Knowledge Graph inproc Task 4.
 *
 * `rebuildGraphFromSource` is the glue between the already-open
 * `KnowledgeStore` (source.db, GR T1) and the pure graph modules built in
 * T2/T3 (`buildProfiles`, `detectOwner`, `buildMentionEdges`): it reads
 * EVERY message + mention row currently in source, maps them onto the
 * shapes those modules need, and writes the result into graph.db via
 * `store.rebuildGraph`. Mirrors wxgraph's `source.build()` orchestration
 * (which does the same read-everything-then-rebuild-the-whole-graph shape),
 * but with the read side going through the in-proc store instead of parsing
 * WCDB tables directly (T1 already did that normalization once, into
 * source.db).
 *
 * `now` is an injected parameter (this module never calls Date.now() itself)
 * — same posture as graph-profiles.ts, so callers (and tests) fully control
 * the clock.
 *
 * Incremental gating: a full rebuild re-reads and re-scores EVERY message in
 * source, which is wasted work when nothing has changed since the last
 * build. Before doing any of that, this function peeks `store.sourceWatermark()`
 * (source.db's current high-water mark) against the `source_watermark` value
 * `rebuildGraph` persisted into graph meta last time — if they match (and a
 * previous build has actually happened, i.e. graph meta isn't empty), the
 * rebuild is skipped entirely (`skipped: true`). The very first call always
 * runs, even against an empty source (graph meta has no `source_watermark`
 * key yet), so a fresh daemon gets an (empty but present) graph rather than
 * silently never building one.
 */
import { buildMentionEdges, detectOwner, type MentionRow } from './graph'
import { buildProfiles, DEFAULT_WEIGHTS, type Msg, type Weights } from './graph-profiles'
import type { KnowledgeStore, SourceMsg } from './store'

/** All source is read in pages of this size (same shape as the indexer's
 *  DEFAULT_BATCH) — keeps a single page's memory bounded even though the
 *  end result (every message, in one array) is not itself paged. */
const PAGE_SIZE = 2000

export interface RebuildGraphFromSourceOpts {
  store: KnowledgeStore
  now: number
  /** Passed straight to `detectOwner` — wins outright over vote-detection
   *  when present. `null`/`undefined` both mean "let detectOwner decide". */
  ownerOverride?: string | null
  weights?: Weights
}

export interface RebuildGraphFromSourceResult {
  owner: string | null
  /** Contacts written by THIS call — 0 when `skipped`. */
  contacts: number
  /** Edges written by THIS call ("me" edges + mention edges) — 0 when
   *  `skipped`. */
  edges: number
  /** When a rebuild actually ran, this is `now`. When skipped, this is the
   *  `built_at` timestamp of the graph's last real build (from graph meta),
   *  or 0 if the graph has never been built at all. */
  builtAt: number
  /** True when this call was a no-op because source hasn't advanced since
   *  the last build (the watermark gate) — no rebuild work was done. */
  skipped: boolean
}

function toGraphMsg(m: SourceMsg): Msg {
  return {
    is_group: !!m.is_group,
    sender_un: m.sender,
    conversation: m.conversation,
    ts: m.time,
    ltype: m.local_type ?? 1,
    content: m.text,
    kind: m.kind ?? 'text',
  }
}

export function rebuildGraphFromSource(opts: RebuildGraphFromSourceOpts): RebuildGraphFromSourceResult {
  const { store, now, ownerOverride, weights = DEFAULT_WEIGHTS } = opts

  // Watermark gate — skip the (potentially large) full re-read/re-score pass
  // when nothing new has landed in source since the graph's last build.
  // `getGraphMeta` returning null means "never built" (fresh graph.db), which
  // must NOT skip even if source itself is currently empty (watermark 0 ==
  // 0) — that's the very-first-boot case, and it should still produce an
  // (empty) graph rather than silently doing nothing forever.
  const lastWatermarkRaw = store.getGraphMeta('source_watermark')
  const currentWatermark = store.sourceWatermark()
  if (lastWatermarkRaw !== null && Number(lastWatermarkRaw) === currentWatermark) {
    return {
      owner: store.getGraphMeta('owner') || null,
      contacts: 0,
      edges: 0,
      builtAt: Number(store.getGraphMeta('built_at') ?? '0'),
      skipped: true,
    }
  }

  // Page through ALL of source (every kind — unlike the search indexer,
  // which filters to kind: 'text', the graph needs voice/call/transfer/…
  // rows too for profile scoring's type-tag/intimacy signal). Two derived
  // views come out of the same pass: the `Msg[]` buildProfiles/detectOwner
  // need, and a msg_key -> {sender, is_group} lookup so each mention row
  // (which only carries msg_key + target_un) can be joined back to its
  // originating message's sender/is_group for buildMentionEdges.
  const messages: Msg[] = []
  const msgLookup = new Map<string, { sender: string; is_group: boolean }>()
  let cursor = 0
  for (;;) {
    const page = store.listMessages(cursor, PAGE_SIZE)
    if (page.messages.length === 0) break
    for (const m of page.messages) {
      msgLookup.set(m.msg_key, { sender: m.sender, is_group: !!m.is_group })
      messages.push(toGraphMsg(m))
    }
    cursor = page.watermark
  }

  const displayMap: Record<string, string> = {}
  for (const c of store.allSourceContacts()) displayMap[c.username] = c.display

  const owner = detectOwner(messages, ownerOverride)

  const profiles = buildProfiles(messages, owner ?? '', now, weights)

  const mentionRows: MentionRow[] = []
  for (const mention of store.allMentions()) {
    const src = msgLookup.get(mention.msg_key)
    if (!src) continue // mention row's originating message isn't in source (shouldn't happen; defensive)
    mentionRows.push({ sender_un: src.sender, is_group: src.is_group, target_un: mention.target_un })
  }
  const mentionEdges = buildMentionEdges(mentionRows, owner)

  store.rebuildGraph(profiles, mentionEdges, displayMap, owner, now, currentWatermark)

  return {
    owner,
    contacts: profiles.length,
    edges: profiles.length + mentionEdges.length,
    builtAt: now,
    skipped: false,
  }
}
