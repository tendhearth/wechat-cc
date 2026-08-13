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
 * ZMAGIC, the Name2Id rowid resolution, exact-prefix strip, table_conv).
 *
 * Knowledge Graph inproc Task 1: EVERY row is now ingested, not just
 * TEXT_TYPE(1) — the graph/facts/person understanding layers need the full
 * message stream (voice/call/transfer/redpacket/system/…), not just text.
 * Each row gets a normalized `kind` (ported from wxgraph/source.py's
 * `classify_type`, see `classifyKind` below), `local_type` (raw), and
 * `is_group` (conversation ends with `@chatroom`, mirroring wxgraph
 * `source.iter_messages`). `text` stays populated only for kind === 'text'
 * — every other kind's `text` is `''`, so wxsearch's indexer (which already
 * filters out empty-text rows, and can additionally pass `kind: 'text'` to
 * `listMessages`) is unaffected. @mention / refermsg targets found in group
 * messages are written to `source_mentions` (see `extractMentionTargets`)
 * for the graph builder (Task 3) to turn into mention edges.
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
 * SOURCE-SIDE meta table (`getSourceMeta`/`setSourceMeta`, backed by
 * `source_meta` in source.db — the SAME file `messages` lives in, not
 * semantic.db), one key per (source db file, Msg_* table):
 * `source_adapter_cursor:<dbfile>:<table>` -> the highest `local_id` read
 * from that table so far. `local_id` is that table's autoincrement
 * rowid-equivalent (monotonically increasing per WCDB table), so "highest
 * local_id seen" is a correct, cheap watermark — cheaper than tracking every
 * processed msg_key. Every row in `(cursor, +inf]` is examined exactly once,
 * even rows that don't end up emitted (non-text type, or empty text after
 * stripping) — the cursor advances past those too so they aren't rescanned
 * forever.
 *
 * Crash-safety (honest version): the cursor is written after each batch
 * flush and once more at the end of a table's scan, in a SEPARATE statement
 * from `putSourceMessages`'s insert — the two are not one transaction, so a
 * crash between them is possible. That is NOT the "re-embed forever" failure
 * the incremental design exists to prevent: because the cursor write always
 * happens no earlier than the matching message insert, the only failure
 * mode is the message insert having committed while the cursor write did
 * not, so on restart the adapter re-scans and re-upserts at most the last
 * in-flight batch (<= `batch`, default 500 rows) once. Those rows upsert
 * idempotently on `msg_key` and the resulting one-time watermark bump for
 * that batch is a bounded, single-occurrence blip for the semantic indexer
 * — not unbounded churn.
 *
 * WAL-mode source dbs: wxvault's decrypted `message_*.sqlite` output is
 * written in WAL mode (header write_ver/read_ver = 2) and the accompanying
 * `-wal`/`-shm` sidecars are frequently NOT shipped alongside the main file
 * (the normal shape for Windows-decrypted output in particular). A plain
 * `new Database(path, { readonly: true })` open of such a file throws
 * `SQLITE_CANTOPEN` in that case — verified against a real WAL-header file
 * with its sidecars removed. Opening via the URI immutable form instead
 * (`file:<path>?mode=ro&immutable=1`) tells SQLite the file won't change
 * and it may read the WAL-mode header directly without needing to recover
 * a WAL — verified this succeeds on the same fixture. `mode=ro` still means
 * wxvault's files are never written to. Each db's open + processing is
 * additionally wrapped in try/catch so one corrupt/unreadable db logs and
 * is skipped (accumulating whatever other dbs in the dir succeeded) instead
 * of aborting the entire run.
 *
 * Contacts (`contact.sqlite`, GR Task 4.5): ingested into source.db's
 * `contacts` table so the graph builder (graph-build.ts) has a display-name
 * map (`display = remark || nick_name || alias || username`, ported from
 * wxgraph's `load_display_map`). Unlike messages, contacts change rarely and
 * carry no per-row cursor of their own in WCDB, so every adapter run simply
 * re-reads the WHOLE `contact` table and re-puts it — `putContacts` upserts
 * on username, so this is idempotent and cheap enough to redo every time.
 * Missing/unreadable/schema-mismatched `contact.sqlite` is non-fatal: caught
 * and skipped (leaves source.db's contacts exactly as they were), never
 * aborts the message ingestion this function otherwise does.
 */
import { Database, constants } from 'bun:sqlite'

/**
 * Open flags for every read of wxvault's output.
 *
 * The `file:...?immutable=1` URI form below is load-bearing (see the header
 * comment) — but passing `{ readonly: true }` is NOT enough to get it parsed
 * as a URI. bun:sqlite links the *system* libsqlite3 on macOS, which is built
 * with URI filenames enabled by default; on Linux and Windows it uses bun's
 * own SQLite build, where they are off. There the whole `file:...?...` string
 * is taken as a literal path and the open fails with "unable to open database
 * file" — which both call sites catch and log, so the adapter silently
 * ingested NOTHING on those platforms while passing every test on macOS.
 *
 * `SQLITE_OPEN_URI` goes straight to `sqlite3_open_v2` and forces URI parsing
 * regardless of the compile-time default, so the same code path works on all
 * three platforms.
 */
const IMMUTABLE_RO = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { KnowledgeStore, SourceMention, SourceMsg } from './store'

const TEXT_TYPE = 1
const APP_TYPE = 49
const ZMAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])
const DEFAULT_BATCH = 500
const MESSAGE_DB_RE = /^message_.*\.sqlite$/

// local_type -> coarse kind. Ported from wxgraph/source.py's `_SIMPLE`
// (itself mirroring wxvault_mcp._decode_body).
const SIMPLE_KIND: Record<number, string> = {
  1: 'text',
  3: 'image',
  34: 'voice',
  43: 'video',
  44: 'video',
  47: 'sticker',
  42: 'card',
  67: 'card',
  48: 'location',
  50: 'call',
  10000: 'system',
  10002: 'system',
}
// type=49 <type> subtype -> kind. Ported from wxgraph/source.py's `_APPSUB`
// (mirroring wxvault_mcp._decode_app).
const APPSUB_KIND: Record<number, string> = {
  2: 'miniprogram',
  4: 'link',
  5: 'link',
  33: 'link',
  36: 'link',
  6: 'file',
  8: 'sticker',
  19: 'chatlog',
  51: 'channel',
  63: 'channel',
  53: 'solitaire',
  62: 'pat',
  87: 'notice',
  2000: 'transfer',
  2001: 'redpacket',
}

function xmlInt(content: string, tag: string): number {
  const m = new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`).exec(content)
  return m ? parseInt(m[1]!, 10) : 0
}

/** Normalized message classification. Ported from wxgraph/source.py's
 *  `classify_type(ltype, content)` — same tags, same precedence (refermsg
 *  presence beats the app subtype lookup). `content` is only consulted for
 *  local_type 49 (app messages); pass null when it isn't needed/decoded. */
export function classifyKind(localType: number, content: string | null): string {
  if (localType in SIMPLE_KIND) return SIMPLE_KIND[localType]!
  if (localType === APP_TYPE) {
    if (content && content.includes('<refermsg>')) return 'quote'
    const sub = xmlInt(content ?? '', 'type')
    if (sub in APPSUB_KIND) return APPSUB_KIND[sub]!
    return 'app'
  }
  return 'other'
}

const ATUSERLIST_RE = /<atuserlist>([\s\S]*?)<\/atuserlist>/
const REFERMSG_RE = /<refermsg>([\s\S]*?)<\/refermsg>/
const CHATUSR_RE = /<chatusr>([\s\S]*?)<\/chatusr>/

/** Parse @mention / quote targets out of one group message's raw (decoded,
 *  un-prefix-stripped) content. Ported from wxgraph/edges.py's `_targets`,
 *  minus the displayname->username fallback: that needs a display_to_un map
 *  built from contact.sqlite, which isn't available at the source layer —
 *  deferred to the graph builder (Task 3), matching edges.py's "never
 *  guess" policy for ambiguous signals. Exact signals (atuserlist wxids,
 *  refermsg chatusr) are extracted directly here. */
export function extractMentionTargets(content: string): string[] {
  const out: string[] = []
  const m = ATUSERLIST_RE.exec(content)
  if (m) {
    const raw = m[1]!.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
    for (const u of raw.trim().split(/[,\s]+/)) {
      if (u) out.push(u)
    }
  }
  const rm = REFERMSG_RE.exec(content)
  if (rm) {
    const cu = CHATUSR_RE.exec(rm[1]!)
    if (cu && cu[1]!.trim()) out.push(cu[1]!.trim())
  }
  return out
}

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

/** Decode message_content (str, or zstd-compressed bytes) to a raw string —
 *  no prefix stripping. Mirrors wxgraph/source.py's `zstd_text`. */
function decodeRaw(content: Uint8Array | string | null): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
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
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** Strip the exact resolved-sender prefix off decoded text. Mirrors
 *  text_source.py's `_to_text`: the prefix is stripped only when it exactly
 *  matches the resolved sender username, never on a bare colon. */
function stripSenderPrefix(s: string, senderUn: string | null): string {
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

interface RawContactRow {
  username: string
  remark: string | null
  nick_name: string | null
  alias: string | null
}

/** Ingests `<decryptedDir>/contact.sqlite` into `store.contacts` — the
 *  display-name map the graph builder reads (GR T4.5). Never throws: a
 *  missing file, a corrupt file, or a `contact` table that doesn't have the
 *  expected columns (some contact.sqlite variants differ) is caught here and
 *  logged, leaving source.db's existing contacts untouched. */
function ingestContacts(decryptedDir: string, store: KnowledgeStore): void {
  const contactPath = join(decryptedDir, 'contact.sqlite')

  let db: Database
  try {
    // Same immutable WAL-safe read as message_*.sqlite (see header comment)
    // — read-only, tolerant of a WAL-mode file shipped without its
    // -wal/-shm sidecars, and never writes to wxvault's output. Also throws
    // (caught below) when contact.sqlite simply doesn't exist.
    db = new Database(`file:${contactPath}?mode=ro&immutable=1`, IMMUTABLE_RO)
  } catch (err) {
    console.error(`[source-adapter] skipping missing/unreadable contact.sqlite:`, err)
    return
  }

  try {
    const rows = db
      .query<RawContactRow, []>('SELECT username, remark, nick_name, alias FROM contact')
      .all()
    const contacts = rows.map(r => ({
      username: r.username,
      // Display priority ported from wxgraph's load_display_map: first
      // non-empty of remark / nick_name / alias / username.
      display: r.remark || r.nick_name || r.alias || r.username,
    }))
    if (contacts.length > 0) store.putContacts(contacts)
  } catch (err) {
    // `contact` table missing, or missing one of the expected columns
    // (schema mismatch across contact.sqlite variants) — skip, don't crash
    // the whole adapter run over it.
    console.error(`[source-adapter] skipping contact.sqlite after schema mismatch/error:`, err)
  } finally {
    db.close()
  }
}

export function runSourceAdapter(opts: {
  decryptedDir: string
  store: KnowledgeStore
  batch?: number
}): { ingested: number } {
  const { decryptedDir, store } = opts
  const batchSize = opts.batch && opts.batch > 0 ? opts.batch : DEFAULT_BATCH
  let ingested = 0

  ingestContacts(decryptedDir, store)

  for (const dbPath of listMessageDbs(decryptedDir)) {
    const dbFile = dbPath.split('/').pop() ?? dbPath

    let db: Database
    try {
      // Immutable URI open: works on wxvault's WAL-mode output even when
      // the -wal/-shm sidecars aren't present (see header comment). Still
      // strictly read-only — wxvault's files are never written to.
      db = new Database(`file:${dbPath}?mode=ro&immutable=1`, IMMUTABLE_RO)
    } catch (err) {
      console.error(`[source-adapter] skipping unreadable db ${dbFile}:`, err)
      continue
    }

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
        // Mirrors wxgraph/source.py's iter_messages: `is_group = conv.endswith("@chatroom")`.
        const isGroup = conv.endsWith('@chatroom')
        const cursorKey = `source_adapter_cursor:${dbFile}:${tbl}`
        const cursor = Number(store.getSourceMeta(cursorKey) ?? '0')

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
        let pendingMentions: SourceMention[] = []
        let lastFlushedLocalId = cursor

        const flush = (uptoLocalId: number) => {
          if (pending.length > 0) {
            store.putSourceMessages(pending)
            ingested += pending.length
            pending = []
          }
          if (pendingMentions.length > 0) {
            store.putMentions(pendingMentions)
            pendingMentions = []
          }
          store.setSourceMeta(cursorKey, String(uptoLocalId))
          lastFlushedLocalId = uptoLocalId
        }

        for (const row of rows) {
          const ltype = (row.local_type ?? 0) >>> 0
          const senderUn = row.real_sender_id != null ? n2i.get(row.real_sender_id) ?? null : null
          // Mirrors text_source.py: `sender_un or (str(sid) if sid else "")`
          // — fall back to the numeric real_sender_id (e.g. self-sent
          // messages, or a participant not yet resolved in Name2Id) rather
          // than dropping the sender to empty.
          const sender = senderUn ?? (row.real_sender_id ? String(row.real_sender_id) : '')
          const msgKey = `${tbl}:${row.local_id}`

          // Decode content only when something downstream needs it: text
          // rows need it for `text`; app-type (49) rows need it to classify
          // the quote/subtype; group rows of ANY type need it to scan for
          // @mention/refermsg targets. Mirrors source.py's iter_messages
          // decode gate (`ltype == 49 or is_group`), extended to also cover
          // TEXT_TYPE since (unlike the graph builder) this adapter's own
          // `text` field needs the decoded body regardless of group-ness.
          const raw =
            ltype === TEXT_TYPE || ltype === APP_TYPE || isGroup
              ? decodeRaw(row.message_content)
              : null

          const kind = classifyKind(ltype, ltype === APP_TYPE ? raw : null)
          const text = kind === 'text' ? stripSenderPrefix(raw ?? '', senderUn).trim() : ''

          pending.push({
            msg_key: msgKey,
            conversation: conv,
            sender,
            time: row.create_time ?? 0,
            // Legacy field, kept for existing callers; now generalized to
            // the normalized kind rather than a hardcoded 'text'.
            type: kind,
            text,
            server_id: row.server_id != null ? String(row.server_id) : '',
            local_type: ltype,
            is_group: isGroup,
            kind,
          })

          // Mention/quote targets are a group-only signal — mirrors
          // wxgraph/edges.py's `build_mention_edges`, which skips any
          // message where `is_group` is false.
          if (isGroup && raw) {
            for (const target of extractMentionTargets(raw)) {
              pendingMentions.push({ msg_key: msgKey, target_un: target })
            }
          }

          if (pending.length >= batchSize) flush(row.local_id)
        }

        const lastRow = rows[rows.length - 1]!
        if (pending.length > 0 || pendingMentions.length > 0 || lastRow.local_id !== lastFlushedLocalId) {
          flush(lastRow.local_id)
        }
      }
    } catch (err) {
      // Corrupt/garbage db content discovered mid-read (e.g. sqlite_master
      // is readable but a table scan then fails). Whatever batches already
      // flushed for this db stay ingested (accumulated in `ingested`); skip
      // the rest of this db and move on rather than aborting the whole run.
      console.error(`[source-adapter] skipping db ${dbFile} after error mid-processing:`, err)
    } finally {
      db.close()
    }
  }

  return { ingested }
}
