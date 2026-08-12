/**
 * Source adapter (Knowledge Kernel Phase 01, Task 4) — normalizes wxvault's
 * decrypted output (`out/decrypted/message_*.sqlite`) into source.db ONCE:
 * zstd-decode `message_content`, strip the exact sender-username prefix,
 * resolve `Name2Id` rowid -> user_name / is_session, compute
 * `msg_key = "<table>:<local_id>"`. This is the normalization every plugin
 * (wxsearch's old text_source.py, wxvault_mcp) duplicated — centralized here
 * so downstream (search indexer, distillation, etc.) reads clean `SourceMsg`
 * rows from the Knowledge API instead of re-deriving them from wxvault's raw
 * WCDB tables.
 *
 * Ported from the reviewed Python
 * (wechat-cc-plugins/packages/wxsearch/wxsearch/text_source.py: `_to_text`,
 * ZMAGIC, the Name2Id rowid resolution, exact-prefix strip, table_conv). Only
 * TEXT_TYPE(1) rows are handled here — the non-text/wxmedia-derived join
 * `text_source.py` also did is out of scope for this slice.
 *
 * zstd: Bun 1.3+ ships a native `Bun.zstdDecompressSync` (libzstd under the
 * hood) — verified it decodes WCDB's dictionary-less zstd AND the
 * content-size-less frame variant (the bug class that forced Python's
 * `zstandard` binding to fall back from `.decompress()` to
 * `.stream_reader()`: `.decompress()` there needs to preallocate a
 * known-size output buffer up front, which a content-size-less frame
 * doesn't provide). Bun's native decompressor streams internally so it
 * doesn't hit that limitation — confirmed against a zstandard-produced
 * content-size-less frame. No new dependency added.
 *
 * Incremental cursor: source.db's own `ingested_watermark` is assigned by
 * the STORE on every putSourceMessages call (including upserts of an
 * unchanged msg_key), so re-submitting an already-ingested row would bump
 * its watermark again — churn that would make the semantic indexer (T6)
 * think the row is new and re-embed it. To avoid ever re-submitting a row
 * this adapter has already seen, we persist our OWN cursor via the store's
 * meta table (`getMeta`/`setMeta`), one key per (source db file, Msg_*
 * table): `source_adapter_cursor:<dbfile>:<table>` -> the highest `local_id`
 * read from that table so far. `local_id` is that table's autoincrement
 * rowid-equivalent (monotonically increasing per WCDB table), so "highest
 * local_id seen" is a correct, cheap watermark — cheaper than tracking every
 * processed msg_key. Every row in `(cursor, +inf]` is examined exactly once,
 * even rows that don't end up emitted (non-text type, or empty text after
 * stripping) — the cursor advances past those too so they aren't rescanned
 * forever. The cursor is persisted after each batch flush (crash-safety)
 * and once more at the end of a table's scan (covers any skipped rows past
 * the last flush).
 */
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { KnowledgeStore, SourceMsg } from './store'

const TEXT_TYPE = 1
const ZMAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])
const DEFAULT_BATCH = 500
const MESSAGE_DB_RE = /^message_.*\.sqlite$/

interface RawRow {
  local_id: number
  local_type: number | null
  real_sender_id: number | null
  create_time: number | null
  server_id: string | number | null
  message_content: Uint8Array | string | null
}

function isZstd(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === ZMAGIC[0] &&
    bytes[1] === ZMAGIC[1] &&
    bytes[2] === ZMAGIC[2] &&
    bytes[3] === ZMAGIC[3]
  )
}

/** Decode message_content (str, or zstd-compressed bytes) and strip the exact
 *  resolved-sender prefix. Mirrors text_source.py's `_to_text`: the prefix is
 *  stripped only when it exactly matches the resolved sender username, never
 *  on a bare colon. */
function toText(content: Uint8Array | string | null, senderUn: string | null): string {
  if (content == null) return ''
  let s: string
  if (typeof content === 'string') {
    s = content
  } else {
    let bytes = content
    if (isZstd(bytes)) {
      try {
        bytes = new Uint8Array(Bun.zstdDecompressSync(bytes))
      } catch {
        // Malformed/truncated frame — fall through and decode the raw
        // (still-compressed) bytes, mirroring text_source.py's final `pass`:
        // garbage output, not a crash.
      }
    }
    s = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
  if (senderUn) {
    for (const pref of [senderUn + ':\n', senderUn + ':']) {
      if (s.startsWith(pref)) return s.slice(pref.length)
    }
  }
  return s
}

function listMessageDbs(decryptedDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(decryptedDir)
  } catch {
    return []
  }
  return names.filter(n => MESSAGE_DB_RE.test(n)).sort().map(n => join(decryptedDir, n))
}

export function runSourceAdapter(opts: {
  decryptedDir: string
  store: KnowledgeStore
  batch?: number
}): { ingested: number } {
  const { decryptedDir, store } = opts
  const batchSize = opts.batch && opts.batch > 0 ? opts.batch : DEFAULT_BATCH
  let ingested = 0

  for (const dbPath of listMessageDbs(decryptedDir)) {
    const dbFile = dbPath.split('/').pop() ?? dbPath
    const db = new Database(dbPath, { readonly: true })
    try {
      const tableNames = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map(r => r.name)

      if (!tableNames.includes('Name2Id')) continue

      const n2i = new Map<number, string>()
      for (const r of db
        .query<{ rowid: number; user_name: string }, []>('SELECT rowid, user_name FROM Name2Id')
        .all()) {
        n2i.set(r.rowid, r.user_name)
      }

      const tableConv = new Map<string, string>()
      for (const r of db
        .query<{ user_name: string }, []>('SELECT user_name FROM Name2Id WHERE is_session=1')
        .all()) {
        tableConv.set('Msg_' + createHash('md5').update(r.user_name).digest('hex'), r.user_name)
      }

      for (const tbl of tableNames.filter(n => n.startsWith('Msg_'))) {
        const conv = tableConv.get(tbl) ?? tbl
        const cursorKey = `source_adapter_cursor:${dbFile}:${tbl}`
        const cursor = Number(store.getMeta(cursorKey) ?? '0')

        const rows = db
          .query<
            RawRow,
            [number]
          >(
            `SELECT local_id, local_type, real_sender_id, create_time, server_id, message_content
             FROM "${tbl}" WHERE local_id > ? ORDER BY local_id ASC`,
          )
          .all(cursor)

        if (rows.length === 0) continue

        let pending: SourceMsg[] = []
        let lastFlushedLocalId = cursor

        const flush = (uptoLocalId: number) => {
          if (pending.length > 0) {
            store.putSourceMessages(pending)
            ingested += pending.length
            pending = []
          }
          store.setMeta(cursorKey, String(uptoLocalId))
          lastFlushedLocalId = uptoLocalId
        }

        for (const row of rows) {
          const ltype = (row.local_type ?? 0) >>> 0
          if (ltype === TEXT_TYPE) {
            const senderUn = row.real_sender_id != null ? n2i.get(row.real_sender_id) ?? null : null
            const text = toText(row.message_content, senderUn).trim()
            if (text) {
              pending.push({
                msg_key: `${tbl}:${row.local_id}`,
                conversation: conv,
                sender: senderUn ?? '',
                time: row.create_time ?? 0,
                type: 'text',
                text,
                server_id: row.server_id != null ? String(row.server_id) : '',
              })
            }
          }
          if (pending.length >= batchSize) flush(row.local_id)
        }

        const lastRow = rows[rows.length - 1]!
        if (pending.length > 0 || lastRow.local_id !== lastFlushedLocalId) {
          flush(lastRow.local_id)
        }
      }
    } finally {
      db.close()
    }
  }

  return { ingested }
}
