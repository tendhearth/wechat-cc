/**
 * Knowledge store — daemon-owned persistence for the Knowledge Kernel.
 *
 * Three separate SQLite files live under one root directory:
 *   - source.db:   normalized wxvault-decoded messages (Ingest side).
 *   - semantic.db: chunks + embeddings + own-content FTS5 (Query side).
 *   - graph.db:    contacts + edges + meta (Graph side, GR Task 4) — a TS
 *                  port of wxgraph's `store.py` (GraphStore). `rebuildGraph`
 *                  always replaces the WHOLE snapshot (delete + reinsert,
 *                  same as `GraphStore.rebuild`) rather than patching it
 *                  incrementally — this in-proc kernel treats the graph as a
 *                  derived, fully-recomputable projection of `source`, not
 *                  independently-mutable state.
 *
 * Mirrors the bun:sqlite usage pattern in ../a2a-events-store.ts (prepared
 * statements built once, plain functions closing over them) and the
 * upsert/FTS/load_vectors shape reviewed in wxsearch's Python IndexStore
 * (wechat-cc-plugins/packages/wxsearch/wxsearch/index.py) — this is that
 * store's TS port plus the provenance columns (model_id/model_version).
 *
 * Provenance is the whole point of semantic.db: every chunks row carries
 * the model_id/model_version that produced its vector, and loadVectors
 * filters on model_id so a caller can never accidentally np.stack (here:
 * Float32Array-concat) vectors from two different embedding models into
 * one matrix of mismatched dimension.
 */
import { openSqlite as openRuntimeSqlite, type SqlDatabase as Database } from '../../lib/runtime/sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runMigrations } from '../../lib/db'
import { migrations as sourceMigrations } from './migrations/source'
import { migrations as semanticMigrations } from './migrations/semantic'
import { migrations as graphMigrations } from './migrations/graph'
import { migrations as factsMigrations } from './migrations/facts'
import type { Contact, Edge } from '../../domain/knowledge/graph'
import type { Profile } from '../../domain/knowledge/graph-profiles'
import type { Chunk, DocSummary, Fact, FactRow, KnowledgeStore, SourceMention, SourceMsg } from '../../ports/knowledge'

function openSqlite(path: string): Database {
  const db = openRuntimeSqlite(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  return db
}

/** Float32Array -> a fresh, tightly-packed Uint8Array view for BLOB storage. */
function vectorToBlob(vector: number[]): Uint8Array {
  const f32 = Float32Array.from(vector)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

/** Confidence ranking for `upsertFact`'s merge (higher wins, never downgrades). */
const CONF_RANK: Record<string, number> = { low: 0, med: 1, high: 2 }

/** facts.db stores `source_msg_keys` as a JSON-encoded TEXT column; every
 *  read path goes through this to get back the `string[]` shape callers see. */
function parseFactRow(r: any): FactRow {
  return { ...r, source_msg_keys: r.source_msg_keys ? JSON.parse(r.source_msg_keys) : [] }
}

export function openKnowledge(root: string): KnowledgeStore {
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 })

  // ---- source.db --------------------------------------------------------
  const sourceDb = openSqlite(join(root, 'source.db'))
  // 四个库的表结构都在 ./migrations/<库>/,和主库同一套规矩(架构终态 G1;docs/maintainer/migrations.md)。
  runMigrations(sourceDb, sourceMigrations)

  const stmtMaxWatermark = sourceDb.query<{ w: number | null }, []>(
    'SELECT MAX(ingested_watermark) AS w FROM messages',
  )
  const stmtLatestTime = sourceDb.query<{ t: number | null }, []>('SELECT MAX(time) AS t FROM messages')
  const stmtGetSourceMeta = sourceDb.query<{ value: string }, [string]>(
    'SELECT value FROM source_meta WHERE key = ?',
  )
  const stmtSetSourceMeta = sourceDb.query<unknown, [string, string]>(
    `INSERT INTO source_meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
  const stmtUpsertMessage = sourceDb.query<
    unknown,
    [string, string, string, number, string, string, string, number, number, string, number]
  >(
    `INSERT INTO messages(msg_key, conversation, sender, time, type, text, server_id, local_type, is_group, kind, ingested_watermark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(msg_key) DO UPDATE SET
       conversation = excluded.conversation,
       sender = excluded.sender,
       time = excluded.time,
       type = excluded.type,
       text = excluded.text,
       server_id = excluded.server_id,
       local_type = excluded.local_type,
       is_group = excluded.is_group,
       kind = excluded.kind,
       ingested_watermark = excluded.ingested_watermark`,
  )
  type MsgRow = Omit<SourceMsg, 'is_group'> & { is_group: number; ingested_watermark: number }
  const stmtListMessages = sourceDb.query<MsgRow, [number, number]>(
    `SELECT msg_key, conversation, sender, time, type, text, server_id, local_type, is_group, kind, ingested_watermark
     FROM messages
     WHERE ingested_watermark > ?
     ORDER BY ingested_watermark ASC
     LIMIT ?`,
  )
  const stmtListMessagesByKind = sourceDb.query<MsgRow, [number, string, number]>(
    `SELECT msg_key, conversation, sender, time, type, text, server_id, local_type, is_group, kind, ingested_watermark
     FROM messages
     WHERE ingested_watermark > ? AND kind = ?
     ORDER BY ingested_watermark ASC
     LIMIT ?`,
  )

  const runPutSourceMessages = sourceDb.transaction((rows: SourceMsg[]) => {
    let w = stmtMaxWatermark.get()?.w ?? 0
    for (const m of rows) {
      w += 1
      stmtUpsertMessage.run(
        m.msg_key,
        m.conversation,
        m.sender,
        m.time,
        m.type,
        m.text,
        m.server_id,
        m.local_type ?? 1,
        m.is_group ? 1 : 0,
        m.kind ?? 'text',
        w,
      )
    }
    return w
  })

  const stmtDeleteMentions = sourceDb.query<unknown, [string]>(
    'DELETE FROM source_mentions WHERE msg_key = ?',
  )
  const stmtInsertMention = sourceDb.query<unknown, [string, string]>(
    'INSERT INTO source_mentions(msg_key, target_un) VALUES (?, ?)',
  )
  const stmtMentionsFor = sourceDb.query<{ target_un: string }, [string]>(
    'SELECT target_un FROM source_mentions WHERE msg_key = ?',
  )
  const stmtAllMentions = sourceDb.query<SourceMention, []>(
    'SELECT msg_key, target_un FROM source_mentions',
  )
  const stmtAllSourceContacts = sourceDb.query<{ username: string; display: string }, []>(
    'SELECT username, display FROM contacts',
  )
  const stmtUpsertContact = sourceDb.query<unknown, [string, string]>(
    `INSERT INTO contacts(username, display) VALUES (?, ?)
     ON CONFLICT(username) DO UPDATE SET display = excluded.display`,
  )
  const runPutContacts = sourceDb.transaction((rows: Array<{ username: string; display: string }>) => {
    for (const r of rows) stmtUpsertContact.run(r.username, r.display)
  })

  const runPutMentions = sourceDb.transaction((rows: SourceMention[]) => {
    const cleared = new Set<string>()
    for (const r of rows) {
      if (!cleared.has(r.msg_key)) {
        stmtDeleteMentions.run(r.msg_key)
        cleared.add(r.msg_key)
      }
      stmtInsertMention.run(r.msg_key, r.target_un)
    }
  })

  // ---- semantic.db --------------------------------------------------------
  const semanticDb = openSqlite(join(root, 'semantic.db'))
  // In-memory vector matrix cache (2026-08-24): auto-recall runs a
  // semanticSearch per admin message, and loadVectors was re-reading the
  // whole matrix from SQLite every call (~105MB / ~300ms cold at 53k
  // vectors). Invalidation is count-based — a cheap COUNT per read compares
  // against the count captured at cache time, so writes from THIS process
  // (indexer) and any other process are both picked up. Keyed per model_id.
  const vectorCache = new Map<string, { rowids: number[]; dim: number; mat: Float32Array; count: number }>()
  runMigrations(semanticDb, semanticMigrations)

  const stmtFindChunk = semanticDb.query<{ rowid: number }, [string, string]>(
    'SELECT rowid FROM chunks WHERE msg_key = ? AND model_id = ?',
  )
  const stmtInsertChunk = semanticDb.query<
    unknown,
    [string, string, string, number, string, string, Uint8Array, string, string]
  >(
    `INSERT INTO chunks(msg_key, conversation, sender, time, kind, text, vector, model_id, model_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const stmtLastRowid = semanticDb.query<{ id: number }, []>('SELECT last_insert_rowid() AS id')
  const stmtUpdateChunk = semanticDb.query<
    unknown,
    [string, string, number, string, string, Uint8Array, string, number]
  >(
    `UPDATE chunks
     SET conversation = ?, sender = ?, time = ?, kind = ?, text = ?, vector = ?, model_version = ?
     WHERE rowid = ?`,
  )
  const stmtFtsDelete = semanticDb.query<unknown, [number]>('DELETE FROM chunks_fts WHERE rowid = ?')
  const stmtFtsInsert = semanticDb.query<unknown, [number, string]>(
    'INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)',
  )

  const runPutSemantic = semanticDb.transaction(
    (model_id: string, model_version: string, chunks: Chunk[]) => {
      for (const c of chunks) {
        const blob = vectorToBlob(c.vector)
        const existing = stmtFindChunk.get(c.msg_key, model_id)
        let rowid: number
        if (existing) {
          rowid = existing.rowid
          stmtUpdateChunk.run(c.conversation, c.sender, c.time, c.kind, c.text, blob, model_version, rowid)
          stmtFtsDelete.run(rowid)
        } else {
          stmtInsertChunk.run(c.msg_key, c.conversation, c.sender, c.time, c.kind, c.text, blob, model_id, model_version)
          rowid = stmtLastRowid.get()!.id
        }
        stmtFtsInsert.run(rowid, c.text)
      }
    },
  )

  const stmtLoadVectors = semanticDb.query<{ rowid: number; vector: Uint8Array }, [string]>(
    `SELECT rowid, vector FROM chunks WHERE model_id = ? AND vector IS NOT NULL ORDER BY rowid`,
  )
  const stmtFtsSearch = semanticDb.query<{ rowid: number }, [string, number]>(
    `SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`,
  )
  const stmtLikeSearch = semanticDb.query<{ rowid: number }, [string, number]>(
    `SELECT rowid FROM chunks WHERE text LIKE '%'||?||'%' ORDER BY length(text) ASC LIMIT ?`,
  )
  const stmtGetDoc = semanticDb.query<DocSummary, [number]>(
    'SELECT conversation, sender, time, kind, text FROM chunks WHERE rowid = ?',
  )
  const stmtGetMeta = semanticDb.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
  const stmtSetMeta = semanticDb.query<unknown, [string, string]>(
    `INSERT INTO meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
  const stmtCountAll = semanticDb.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM chunks')
  const stmtCountByModel = semanticDb.query<{ n: number }, [string]>(
    'SELECT COUNT(*) AS n FROM chunks WHERE model_id = ?',
  )

  // ---- graph.db (GR Task 4) ------------------------------------------------
  // TS port of wxgraph's store.py (GraphStore): contacts + edges + meta, one
  // whole-snapshot rebuild per pass (see rebuildGraph below), no incremental
  // patching.
  const graphDb = openSqlite(join(root, 'graph.db'))
  runMigrations(graphDb, graphMigrations)

  // Insert column order mirrors store.py's `_CONTACT_COLS` (username first).
  const GRAPH_CONTACT_COLS = [
    'username', 'display', 'is_group', 'total', 'sent', 'recv', 'first_ts', 'last_ts',
    'known_days', 'active_days', 'initiations', 'transfer_in', 'transfer_out',
    'shared_groups', 'types', 's_volume', 's_recency', 's_reciprocity', 's_intimacy', 'closeness',
  ] as const

  const stmtGraphDeleteContacts = graphDb.query<unknown, []>('DELETE FROM contacts')
  const stmtGraphDeleteEdges = graphDb.query<unknown, []>('DELETE FROM edges')
  const stmtGraphDeleteMeta = graphDb.query<unknown, []>('DELETE FROM meta')
  const stmtGraphInsertContact = graphDb.query<
    unknown,
    [string, string, number, number, number, number, number, number, number, number, number, number, number, number, string, number, number, number, number, number]
  >(
    `INSERT INTO contacts(${GRAPH_CONTACT_COLS.join(',')}) VALUES (${GRAPH_CONTACT_COLS.map(() => '?').join(',')})`,
  )
  const stmtGraphInsertEdge = graphDb.query<unknown, [string, string, string, number]>(
    'INSERT OR REPLACE INTO edges(a, b, kind, weight) VALUES (?, ?, ?, ?)',
  )
  const stmtGraphInsertMeta = graphDb.query<unknown, [string, string]>(
    'INSERT INTO meta(key, value) VALUES (?, ?)',
  )
  const runRebuildGraph = graphDb.transaction(
    (
      profiles: Profile[],
      mentionEdges: Edge[],
      displayMap: Record<string, string>,
      owner: string | null,
      now: number,
      sourceWatermark: number,
    ) => {
      stmtGraphDeleteContacts.run()
      stmtGraphDeleteEdges.run()
      stmtGraphDeleteMeta.run()
      for (const p of profiles) {
        const display = displayMap[p.username] ?? p.username
        stmtGraphInsertContact.run(
          p.username,
          display,
          0, // is_group — v1 profiles are person-only (graph-profiles.ts's buildProfiles never emits group contacts)
          p.total,
          p.sent,
          p.recv,
          p.first_ts,
          p.last_ts,
          p.known_days,
          p.active_days,
          p.initiations,
          p.transfer_in,
          p.transfer_out,
          p.shared_groups,
          JSON.stringify(p.types),
          p.s_volume,
          p.s_recency,
          p.s_reciprocity,
          p.s_intimacy,
          p.closeness,
        )
        // One synthesized owner->contact "me" edge per profile, exactly like
        // store.py's rebuild — written even when `owner` is null/undetected
        // (falls back to '', same posture as graph.ts's relationshipSubgraph
        // using `owner ?? ''`) rather than skipping the edge outright.
        stmtGraphInsertEdge.run(owner ?? '', p.username, 'me', p.closeness)
      }
      for (const e of mentionEdges) {
        stmtGraphInsertEdge.run(e.a, e.b, e.kind, e.weight)
      }
      stmtGraphInsertMeta.run('owner', owner ?? '')
      stmtGraphInsertMeta.run('built_at', String(now))
      stmtGraphInsertMeta.run('source_watermark', String(sourceWatermark))
    },
  )

  type GraphContactRow = {
    username: string; display: string; is_group: number; total: number; sent: number; recv: number
    first_ts: number; last_ts: number; known_days: number; active_days: number; initiations: number
    transfer_in: number; transfer_out: number; shared_groups: number; types: string
    s_volume: number; s_recency: number; s_reciprocity: number; s_intimacy: number; closeness: number
  }
  function toContact(r: GraphContactRow): Contact {
    const { is_group, types, ...rest } = r
    return { ...rest, is_group: !!is_group, types: types ? JSON.parse(types) : {} }
  }
  const stmtGraphGetContact = graphDb.query<GraphContactRow, [string]>(
    'SELECT * FROM contacts WHERE username = ?',
  )
  const stmtGraphAllContacts = graphDb.query<GraphContactRow, []>('SELECT * FROM contacts')
  const stmtGraphEdgesFor = graphDb.query<Edge, [string, string, string]>(
    'SELECT a, b, kind, weight FROM edges WHERE kind = ? AND (a = ? OR b = ?) ORDER BY weight DESC',
  )
  const stmtGraphGetMeta = graphDb.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
  const stmtGraphSetMeta = graphDb.query<unknown, [string, string]>(
    `INSERT INTO meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
  const stmtGraphCountContacts = graphDb.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM contacts')

  // ---- facts.db (facts + person slice) -------------------------------------
  // TS port of wxfacts's store.py (facts table + extraction_state watermark).
  const factsDb = openSqlite(join(root, 'facts.db'))
  runMigrations(factsDb, factsMigrations)

  return {
    putSourceMessages(msgs) {
      const watermark = runPutSourceMessages(msgs)
      return { watermark }
    },

    listMessages(sinceWatermark, limit, kind) {
      const rows =
        kind === undefined
          ? stmtListMessages.all(sinceWatermark, limit)
          : stmtListMessagesByKind.all(sinceWatermark, kind, limit)
      if (rows.length === 0) return { messages: [], watermark: sinceWatermark }
      const watermark = rows[rows.length - 1]!.ingested_watermark
      const messages = rows.map(({ ingested_watermark, is_group, ...rest }) => ({
        ...rest,
        is_group: !!is_group,
      }))
      return { messages, watermark }
    },

    putMentions(rows) {
      runPutMentions(rows)
    },

    mentionsFor(msg_key) {
      return stmtMentionsFor.all(msg_key).map(r => r.target_un)
    },

    allMentions() {
      return stmtAllMentions.all()
    },

    putSemantic(model_id, model_version, chunks) {
      runPutSemantic(model_id, model_version, chunks)
      // Record the active model in meta on every call (last-indexed wins) —
      // feeds both semanticSearch's stale-check (reads meta 'embed_model')
      // and GET /v1/knowledge/semantic/status.
      stmtSetMeta.run('embed_model', model_id)
      stmtSetMeta.run('embed_model_version', model_version)
    },

    loadVectors(model_id) {
      const count = stmtCountByModel.get(model_id)?.n ?? 0
      const cached = vectorCache.get(model_id)
      if (cached && cached.count === count) {
        return { rowids: cached.rowids, dim: cached.dim, mat: cached.mat }
      }
      const rows = stmtLoadVectors.all(model_id)
      if (rows.length === 0) return { rowids: [], dim: 0, mat: new Float32Array(0) }
      const dim = rows[0]!.vector.byteLength / 4
      const mat = new Float32Array(rows.length * dim)
      const rowids: number[] = new Array(rows.length)
      rows.forEach((r, i) => {
        rowids[i] = r.rowid
        const v = new Float32Array(r.vector.buffer, r.vector.byteOffset, dim)
        mat.set(v, i * dim)
      })
      vectorCache.set(model_id, { rowids, dim, mat, count })
      return { rowids, dim, mat }
    },

    keywordSearch(query, k) {
      const q = (query ?? '').trim()
      if (!q) return []
      if (q.length >= 3) {
        // Wrap as a single FTS5 phrase literal so punctuation / operator words
        // (AND, -, ", *, :, ...) are matched literally instead of raising a
        // MATCH syntax error. Mirrors wxsearch's keyword_search.
        const fq = '"' + q.replace(/"/g, '""') + '"'
        return stmtFtsSearch.all(fq, k).map(r => r.rowid)
      }
      return stmtLikeSearch.all(q, k).map(r => r.rowid)
    },

    getDocs(rowids) {
      const out = new Map<number, DocSummary>()
      for (const rid of rowids) {
        const row = stmtGetDoc.get(rid)
        if (row) out.set(rid, row)
      }
      return out
    },

    getMeta(key) {
      return stmtGetMeta.get(key)?.value ?? null
    },

    setMeta(key, value) {
      stmtSetMeta.run(key, value)
    },

    getSourceMeta(key) {
      return stmtGetSourceMeta.get(key)?.value ?? null
    },

    setSourceMeta(key, value) {
      stmtSetSourceMeta.run(key, value)
    },

    countSemantic(model_id) {
      if (model_id === undefined) return stmtCountAll.get()?.n ?? 0
      return stmtCountByModel.get(model_id)?.n ?? 0
    },

    sourceWatermark() {
      return stmtMaxWatermark.get()?.w ?? 0
    },

    lastSyncAtMs() {
      const n = Number(stmtGetSourceMeta.get('last_sync_at_ms')?.value)
      return Number.isFinite(n) && n > 0 ? n : null
    },

    markSynced(atMs) {
      stmtSetSourceMeta.run('last_sync_at_ms', String(atMs ?? Date.now()))
    },

    latestMessageAtMs() {
      const t = stmtLatestTime.get()?.t ?? null
      return t !== null && t > 0 ? t * 1000 : null
    },

    allSourceContacts() {
      return stmtAllSourceContacts.all()
    },

    putContacts(rows) {
      runPutContacts(rows)
    },

    // ---- graph.db ----------------------------------------------------------
    rebuildGraph(profiles, mentionEdges, displayMap, owner, now, sourceWatermark) {
      runRebuildGraph(profiles, mentionEdges, displayMap, owner, now, sourceWatermark)
    },

    getContact(username) {
      const row = stmtGraphGetContact.get(username)
      return row ? toContact(row) : null
    },

    allContacts() {
      return stmtGraphAllContacts.all().map(toContact)
    },

    edgesFor(username, kind) {
      return stmtGraphEdgesFor.all(kind, username, username)
    },

    getGraphMeta(key) {
      return stmtGraphGetMeta.get(key)?.value ?? null
    },

    setGraphMeta(key, value) {
      stmtGraphSetMeta.run(key, value)
    },

    countContacts() {
      return stmtGraphCountContacts.get()?.n ?? 0
    },

    // ---- facts.db ------------------------------------------------------------
    upsertFact(fact, now) {
      const keys = [...(fact.source_msg_keys ?? [])]
      const conf = fact.confidence || 'med'
      const cur = factsDb.query('SELECT * FROM facts WHERE contact=? AND predicate=? AND value=?')
        .get(fact.contact, fact.predicate, fact.value) as any
      if (!cur) {
        const r = factsDb.query(`INSERT INTO facts(contact,kind,predicate,value,related_contact,time_ref,
          confidence,source_msg_keys,status,created_at,updated_at,valid_from) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(fact.contact, fact.kind ?? null, fact.predicate, fact.value,
               fact.related_contact ?? null, fact.time_ref ?? null, conf,
               JSON.stringify(keys), 'active', now, now, now)
        return { outcome: 'inserted', id: Number((r as unknown as { lastInsertRowid: number | bigint }).lastInsertRowid) }
      }
      const prev = parseFactRow(cur)
      const merged = [...new Set([...prev.source_msg_keys, ...keys])] // ordered union
      const best = (CONF_RANK[conf] ?? 1) > (CONF_RANK[prev.confidence ?? 'med'] ?? 1) ? conf : prev.confidence
      factsDb.query(`UPDATE facts SET kind=?, related_contact=?, time_ref=?, confidence=?,
        source_msg_keys=?, updated_at=? WHERE id=?`) // status + valid_from untouched
        .run(fact.kind || prev.kind, fact.related_contact || prev.related_contact,
             fact.time_ref || prev.time_ref, best, JSON.stringify(merged), now, prev.id)
      return { outcome: 'merged', id: prev.id }
    },

    activeFactsSharingPredicate(contact, predicate, excludeValue) {
      return (factsDb.query(
        "SELECT * FROM facts WHERE contact=? AND predicate=? AND value<>? AND status='active' ORDER BY updated_at DESC",
      ).all(contact, predicate, excludeValue) as any[]).map(parseFactRow)
    },

    supersedeFactById(oldId, newId, now) {
      const c = factsDb.query(
        "UPDATE facts SET status='superseded', invalidated_at=?, superseded_by=?, updated_at=? WHERE id=? AND status='active'",
      ).run(now, newId, now, oldId)
      return (c as unknown as { changes: number }).changes > 0
    },

    factById(id) {
      const r = factsDb.query('SELECT * FROM facts WHERE id=?').get(id) as any
      return r ? parseFactRow(r) : null
    },

    obligationHeavyContacts(limit, minCount = 2) {
      // minCount=2 is the dedup feed (a duplicate needs a pair); the
      // settlement backfill passes 1 — a lone promise can still be settled.
      return factsDb.query(
        `SELECT contact, COUNT(*) AS n FROM facts
         WHERE kind='obligation' AND status='active'
         GROUP BY contact HAVING n >= ? ORDER BY n DESC LIMIT ?`,
      ).all(minCount, limit) as Array<{ contact: string; n: number }>
    },

    conflictedFactGroups(limit) {
      // Stock-sweep feed: ACTIVE same-(contact,predicate) groups holding ≥2
      // distinct values — contradictions recorded before conflict detection
      // existed (or whose judge call failed). Newest-first inside each group
      // so the sweep can treat facts[0] as the presumed-current value.
      const groups = factsDb.query(
        `SELECT contact, predicate FROM facts WHERE status='active'
         GROUP BY contact, predicate HAVING COUNT(DISTINCT value) >= 2
         ORDER BY MAX(updated_at) DESC LIMIT ?`,
      ).all(limit) as Array<{ contact: string; predicate: string }>
      return groups.map((g) => ({
        contact: g.contact,
        predicate: g.predicate,
        facts: (factsDb.query(
          "SELECT * FROM facts WHERE contact=? AND predicate=? AND status='active' ORDER BY updated_at DESC, id DESC",
        ).all(g.contact, g.predicate) as any[]).map(parseFactRow),
      }))
    },

    judgeFingerprint(key) {
      const r = factsDb.query('SELECT fingerprint FROM judge_state WHERE key=?').get(key) as
        { fingerprint: string } | null
      return r ? r.fingerprint : null
    },

    setJudgeFingerprint(key, fingerprint, now) {
      factsDb.query(`INSERT INTO judge_state(key,fingerprint,judged_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET fingerprint=excluded.fingerprint, judged_at=excluded.judged_at`)
        .run(key, fingerprint, now)
    },

    factWatermark(contact) {
      const r = factsDb.query('SELECT last_ts,last_local_id FROM extraction_state WHERE contact=?')
        .get(contact) as any
      return r ? [r.last_ts, r.last_local_id] : [0, 0]
    },

    advanceFactWatermark(contact, ts, localId, now) {
      const [pt, pl] = this.factWatermark(contact)
      const nt = ts > pt || (ts === pt && localId > pl) ? [ts, localId] : [pt, pl] // monotonic tuple
      factsDb.query(`INSERT INTO extraction_state(contact,last_ts,last_local_id,updated_at)
        VALUES(?,?,?,?) ON CONFLICT(contact) DO UPDATE SET last_ts=excluded.last_ts,
        last_local_id=excluded.last_local_id, updated_at=excluded.updated_at`)
        .run(contact, nt[0]!, nt[1]!, now)
    },

    allFactWatermarks() {
      const m = new Map<string, [number, number]>()
      for (const r of factsDb.query('SELECT contact,last_ts,last_local_id FROM extraction_state').all() as any[])
        m.set(r.contact, [r.last_ts, r.last_local_id])
      return m
    },

    factsForContact(contact, status) {
      return (factsDb.query('SELECT * FROM facts WHERE contact=? AND status=? ORDER BY updated_at DESC')
        .all(contact, status) as any[]).map(parseFactRow)
    },

    findFactRows(kind, predicate, query, status, limit) {
      let sql = 'SELECT * FROM facts WHERE status=?'
      const args: any[] = [status]
      if (kind) { sql += ' AND kind=?'; args.push(kind) }
      if (predicate) { sql += ' AND predicate=?'; args.push(predicate) }
      if (query) { sql += " AND (predicate LIKE '%'||?||'%' OR value LIKE '%'||?||'%')"; args.push(query, query) }
      sql += ' ORDER BY updated_at DESC LIMIT ?'
      args.push(limit)
      return (factsDb.query(sql).all(...args) as any[]).map(parseFactRow)
    },

    setFactStatusById(id, status, now) {
      const c = factsDb.query('UPDATE facts SET status=?, updated_at=? WHERE id=?').run(status, now, id)
      return c.changes > 0
    },

    factCountsByKind() {
      const out: Record<string, number> = {}
      for (const r of factsDb.query('SELECT kind, COUNT(*) n FROM facts GROUP BY kind').all() as any[])
        out[r.kind] = r.n
      return out
    },

    oneToOneTextMessages() {
      return sourceDb.query(`SELECT msg_key, conversation, sender, time, text FROM messages
        WHERE is_group=0 AND kind='text'`).all() as any[]
    },

    recentMessages(conversation, limit) {
      // kind='text' matches oneToOneTextMessages above — the recent-context
      // window is a text-conversation transcript, not a raw event log, so
      // non-text rows (voice/call/transfer/…) are excluded the same way.
      return sourceDb.query(`SELECT sender, time, text FROM messages WHERE conversation=? AND kind='text'
        ORDER BY time DESC LIMIT ?`).all(conversation, limit) as any[]
    },

    close() {
      sourceDb.close()
      semanticDb.close()
      graphDb.close()
      factsDb.close()
    },
  }
}
