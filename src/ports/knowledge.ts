/**
 * 知识库的口(架构终态 E5):来源消息、语义块、文档摘要、事实与 store 的形状。实现在 src/adapters/knowledge/store.ts
 * (source / semantic / graph / facts 几个 SQLite 文件);app 的入索引与 domain/knowledge 的纯算法只经这里认它们。只有类型,没有逻辑。
 */
import type { Contact, Edge } from '../domain/knowledge/graph'
import type { Profile } from '../domain/knowledge/graph-profiles'

export interface SourceMsg {
  msg_key: string
  conversation: string
  sender: string
  time: number
  type: string
  text: string
  server_id: string
  /** Raw WCDB local_type (1=text, 34=voice, 49=app/quote/transfer/…, …).
   *  Optional on write (defaults to 1/text) so pre-Task-1 callers that only
   *  ever ingested text messages don't need updating; listMessages always
   *  returns the actual stored value. */
  local_type?: number
  /** Whether `conversation` is a group chat (vs a 1:1 session). Optional on
   *  write, defaults to false — see `local_type`.
   *  Known follow-up (GR T1 review): source-adapter.ts's Msg_* → conversation
   *  mapping falls back to the raw (hashed) table name when a table isn't
   *  found in the Name2Id session set, rather than skipping it — an orphaned
   *  table's rows land here with `is_group=false` instead of being excluded. */
  is_group?: boolean
  /** Normalized message classification — ported from wxgraph's
   *  classify_type (text/voice/call/image/transfer/redpacket/quote/app/…).
   *  Optional on write, defaults to 'text' — see `local_type`. */
  kind?: string
}

/** One @atuserlist / refermsg target parsed out of a group message's raw
 *  content — an edge candidate for the graph layer's mention edges. */
export interface SourceMention {
  msg_key: string
  target_un: string
}

export interface Chunk {
  msg_key: string
  conversation: string
  sender: string
  time: number
  kind: string
  text: string
  vector: number[]
}

export interface DocSummary {
  conversation: string
  sender: string
  time: number
  kind: string
  text: string
}

/** Agent-supplied claim (record_facts) — the input shape to `upsertFact`. */
export interface Fact {
  contact?: string
  kind?: string
  predicate: string
  value: string
  related_contact?: string
  time_ref?: string
  /** 'low'|'med'|'high', default 'med'. */
  confidence?: string
  source_msg_keys?: string[]
}

/** Stored facts.db row — `upsertFact`'s merge target and every read method's
 *  return shape. */
export interface FactRow {
  id: number
  contact: string
  kind: string | null
  predicate: string
  value: string
  related_contact: string | null
  time_ref: string | null
  confidence: string
  source_msg_keys: string[]
  status: string
  created_at: number
  updated_at: number
  /** Temporal validity (2026-08 memory-upgrades): when the fact became true
   *  (stamped `now` at insert; backfilled from `created_at` on upgraded
   *  stores), when it was invalidated by a supersede, and which fact id
   *  superseded it. All null while the fact is live. */
  valid_from: number | null
  invalidated_at: number | null
  superseded_by: number | null
}

/**
 * 联系人事实 + 抽取水位 + 判官指纹(架构终态 G7,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3):
 * 以前在 knowledge/facts.db,现在是主库 memory_facts 里 doc = 'contact' 的行(key = `k:<原 id>`,对外的 id 不变)和
 * knowledge_extraction_state / knowledge_judge_state 两张表。实现在 src/adapters/store/memory-facts.ts(唯一写那张表的地方)。
 */
export interface KnowledgeFactsStore {
  /** Faithful port of wxfacts's `store.py` merge semantics: on conflict of
   *  (contact,predicate,value), MERGE rather than replace — `source_msg_keys`
   *  is an ordered union (no dupes), `confidence` takes the max by
   *  `{low:0,med:1,high:2}`, `related_contact`/`time_ref` fill only when
   *  currently absent, and `status` is left untouched (a resolved fact
   *  merging new evidence stays resolved). Returns which branch fired plus
   *  the row id (inserted or existing) — conflict detection needs the id. */
  upsertFact(fact: Fact & { contact: string }, now: number): { outcome: 'inserted' | 'merged'; id: number }
  /** Same-predicate different-value ACTIVE facts for a contact — the
   *  conflict-candidate set a just-recorded fact is judged against. */
  activeFactsSharingPredicate(contact: string, predicate: string, excludeValue: string): FactRow[]
  /** Marks `oldId` superseded by `newId` (status='superseded',
   *  invalidated_at=now, superseded_by=newId). Only fires on an ACTIVE row —
   *  returns false (and stamps nothing) otherwise, so a double supersede
   *  never rewrites history. */
  supersedeFactById(oldId: number, newId: number, now: number): boolean
  factById(id: number): FactRow | null
  /** ACTIVE same-(contact,predicate) groups with ≥2 distinct values — the
   *  stock-conflict sweep's feed. Facts inside each group are newest-first
   *  (updated_at DESC). */
  conflictedFactGroups(limit: number): Array<{ contact: string; predicate: string; facts: FactRow[] }>
  /** Contacts carrying ≥2 ACTIVE obligations, heaviest first — the
   *  obligation-dedup sweep's feed. */
  obligationHeavyContacts(limit: number, minCount?: number): Array<{ contact: string; n: number }>
  /** Sweep judge-state: the fingerprint last judged under `key` (null =
   *  never judged). Sweeps skip stock whose fingerprint hasn't changed
   *  since the last no-action verdict — see companion/ingest sweeps. */
  judgeFingerprint(key: string): string | null
  setJudgeFingerprint(key: string, fingerprint: string, now: number): void
  /** `[last_ts, last_local_id]`, `[0, 0]` when the contact has no watermark
   *  row yet. */
  factWatermark(contact: string): [number, number]
  /** Advances the watermark iff `(ts, localId)` is strictly greater than the
   *  stored tuple (ts first, then localId) — never regresses. */
  advanceFactWatermark(contact: string, ts: number, localId: number, now: number): void
  allFactWatermarks(): Map<string, [number, number]>
  factsForContact(contact: string, status: string): FactRow[]
  /** `kind`/`predicate` are exact-match filters (null = no filter); `query`
   *  is a substring match over predicate OR value (null = no filter). */
  findFactRows(kind: string | null, predicate: string | null, query: string | null, status: string, limit: number): FactRow[]
  /**
   * 改一条联系人事实的状态(待办页「完成 / 捞回 / 不对」、MCP set_fact_status):`resolved` = 办完了(resolve),
   * `rejected` = 不对(收回,retract)、`superseded` = 被取代(supersede)、`active` = 捞回(reopen)。每次都记一条事件。
   * 别的状态 / 没有这一条 ⇒ false。架构终态 G7 起在主库的表里(以前是 facts.db 的 setFactStatusById,直接 UPDATE)。
   */
  changeFactStatus(id: number, status: string, now: number): boolean
  factCountsByKind(): Record<string, number>

}

export interface KnowledgeStore extends KnowledgeFactsStore {
  putSourceMessages(msgs: SourceMsg[]): { watermark: number }
  /** `kind` optionally filters to one normalized kind (e.g. 'text' — what
   *  the search indexer wants); omitted returns every kind. */
  listMessages(
    sinceWatermark: number,
    limit: number,
    kind?: string,
  ): { messages: SourceMsg[]; watermark: number }
  /** Replaces all mention rows for each distinct msg_key in `rows` with the
   *  given set (idempotent re-ingest: re-submitting the same msg_key's
   *  mentions never duplicates them). */
  putMentions(rows: SourceMention[]): void
  mentionsFor(msg_key: string): string[]
  /** Every mention row in source.db — the graph builder's (Task 3) read of
   *  the whole @mention/refermsg edge set. */
  allMentions(): SourceMention[]
  putSemantic(model_id: string, model_version: string, chunks: Chunk[]): void
  loadVectors(model_id: string): { rowids: number[]; dim: number; mat: Float32Array }
  keywordSearch(query: string, k: number): number[]
  getDocs(rowids: number[]): Map<number, DocSummary>
  getMeta(key: string): string | null
  setMeta(key: string, value: string): void
  /** Same shape as getMeta/setMeta but backed by source.db (not semantic.db).
   *  Exists so callers that must stay in the same file as their data (e.g.
   *  the source-adapter's ingest cursor, which is written alongside
   *  `messages`) don't split state across two separate SQLite files. */
  getSourceMeta(key: string): string | null
  setSourceMeta(key: string, value: string): void
  countSemantic(model_id?: string): number
  /** Cheap peek at source.db's current high-water mark
   *  (`MAX(ingested_watermark)` over `messages`, 0 on an empty store) —
   *  lets a caller (graph-build.ts's `rebuildGraphFromSource`) decide
   *  whether a full rebuild is worth doing WITHOUT paging through
   *  `listMessages` first. */
  sourceWatermark(): number
  /** Latest WeChat message time in the store (ms); null when empty. Used by the 「CC 的连接」card. */
  latestMessageAtMs(): number | null
  /** When the source adapter last completed a clean pass (ms); null if never recorded. Staleness is judged on THIS, not on message time (a quiet weekend is not "behind"). */
  lastSyncAtMs(): number | null
  markSynced(atMs?: number): void
  /** Source-side display names (source.db's `contacts` table), populated by
   *  source-adapter.ts's contact.sqlite ingestion (GR T4.5). A username with
   *  no row here (contact.sqlite unreadable, or the contact simply isn't in
   *  it) has "no display data available" — callers fall back to username,
   *  exactly like `rebuildGraph`'s `displayMap` parameter does. */
  allSourceContacts(): Array<{ username: string; display: string }>
  /** Idempotent upsert of source-side display names, keyed on `username`
   *  (re-putting the same username replaces its `display`, never
   *  duplicates the row). Contacts change rarely, so the adapter re-puts
   *  the WHOLE contact.sqlite snapshot on every run rather than tracking a
   *  cursor — this must stay cheap to call with the full set every time. */
  putContacts(rows: Array<{ username: string; display: string }>): void

  // ---- graph.db (GR Task 4) -----------------------------------------------
  /** Atomically replaces the whole contacts/edges/meta snapshot — port of
   *  `GraphStore.rebuild`. `profiles` (GR Task 2's `buildProfiles` output)
   *  are joined against `displayMap` (falling back to username when a
   *  contact has no display entry) and written with `is_group=false` (v1
   *  profiles are person-only); one synthesized `{owner, username, 'me',
   *  closeness}` edge is written per profile alongside `mentionEdges` (GR
   *  Task 3's `buildMentionEdges` output). `sourceWatermark` is persisted
   *  into graph meta as `source_watermark` — the value `rebuildGraphFromSource`
   *  compares against `sourceWatermark()` on the next call to decide whether
   *  a rebuild is worth doing at all. */
  rebuildGraph(
    profiles: Profile[],
    mentionEdges: Edge[],
    displayMap: Record<string, string>,
    owner: string | null,
    now: number,
    sourceWatermark: number,
  ): void
  getContact(username: string): Contact | null
  allContacts(): Contact[]
  /** Both directions (`a=? OR b=?`), highest weight first — matches
   *  `store.py`'s `edges_for` and is exactly the `EdgesFor` shape
   *  `graph.ts`'s query functions (`contactProfile`, `relationshipSubgraph`,
   *  `connectors`) take as a callback parameter. */
  edgesFor(username: string, kind: string): Edge[]
  getGraphMeta(key: string): string | null
  setGraphMeta(key: string, value: string): void
  countContacts(): number

  // ---- facts(架构终态 G7 起在主库,见 KnowledgeFactsStore)----------------------
  // ---- source reads (source.db, read by the facts extractor) --------------
  /** Every 1:1 (non-group) text message in source.db — the extractor's full
   *  candidate set before per-contact watermark filtering. */
  oneToOneTextMessages(): Array<{ msg_key: string; conversation: string; sender: string; time: number; text: string }>
  /** Newest-first, capped at `limit`, text messages only (same `kind='text'`
   *  filter as `oneToOneTextMessages`) — recent-context window for a single
   *  conversation. */
  recentMessages(conversation: string, limit: number): Array<{ sender: string; time: number; text: string }>

  close(): void
}
