/**
 * Knowledge store — daemon-owned persistence for the Knowledge Kernel.
 *
 * Two separate SQLite files live under one root directory:
 *   - source.db:   normalized wxvault-decoded messages (Ingest side).
 *   - semantic.db: chunks + embeddings + own-content FTS5 (Query side).
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
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
   *  write, defaults to false — see `local_type`. */
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

export interface KnowledgeStore {
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
  close(): void
}

function openSqlite(path: string): Database {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  return db
}

/** Float32Array -> a fresh, tightly-packed Uint8Array view for BLOB storage. */
function vectorToBlob(vector: number[]): Uint8Array {
  const f32 = Float32Array.from(vector)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

export function openKnowledge(root: string): KnowledgeStore {
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 })

  // ---- source.db --------------------------------------------------------
  const sourceDb = openSqlite(join(root, 'source.db'))
  sourceDb.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      msg_key TEXT PRIMARY KEY,
      conversation TEXT, sender TEXT, time INTEGER,
      type TEXT, text TEXT, server_id TEXT,
      local_type INTEGER, is_group INTEGER, kind TEXT,
      ingested_watermark INTEGER
    );
    CREATE INDEX IF NOT EXISTS messages_watermark ON messages(ingested_watermark);
    CREATE INDEX IF NOT EXISTS messages_kind ON messages(kind);
    CREATE TABLE IF NOT EXISTS contacts (
      username TEXT PRIMARY KEY, display TEXT
    );
    CREATE TABLE IF NOT EXISTS source_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS source_mentions (msg_key TEXT, target_un TEXT);
    CREATE INDEX IF NOT EXISTS source_mentions_msg_key ON source_mentions(msg_key);
  `)

  const stmtMaxWatermark = sourceDb.query<{ w: number | null }, []>(
    'SELECT MAX(ingested_watermark) AS w FROM messages',
  )
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
  semanticDb.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      rowid INTEGER PRIMARY KEY,
      msg_key TEXT, conversation TEXT, sender TEXT,
      time INTEGER, kind TEXT, text TEXT,
      vector BLOB, model_id TEXT, model_version TEXT,
      UNIQUE(msg_key, model_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize='trigram');
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `)

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

    close() {
      sourceDb.close()
      semanticDb.close()
    },
  }
}
