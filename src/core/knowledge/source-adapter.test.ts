// src/core/knowledge/source-adapter.test.ts
//
// Knowledge Kernel Task 4 — runSourceAdapter normalizes wxvault's decrypted
// message_*.sqlite output into source.db exactly once. Builds a real
// bun:sqlite fixture DB (Name2Id + a Msg_<md5> table) shaped like WCDB's
// output and asserts against a REAL KnowledgeStore (openKnowledge), the
// same "real deps, not mocks" style as routes-knowledge.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSourceAdapter } from './source-adapter'
import { openKnowledge, type KnowledgeStore } from './store'

// A real WCDB-style "dictionary-less zstd" frame with NO content-size field
// in its header — produced once via Python's
// `zstandard.ZstdCompressor(write_content_size=False)` and pasted here so
// the test doesn't depend on python being present at test time. Decodes to
// CONTENT_SIZE_LESS_TEXT. This is the exact bug class text_source.py's
// `_to_text` needed a `stream_reader` fallback for: a single-shot
// decompressor that preallocates a known-size output buffer chokes on a
// frame that never declares one. (Bun.zstdDecompressSync streams
// internally and handles it directly — see source-adapter.ts's header
// comment — but this fixture still proves it end-to-end.)
const CONTENT_SIZE_LESS_TEXT = 'hello world content-size-less frame test 1234567890'
const CONTENT_SIZE_LESS_ZSTD_B64 =
  'KLUv/QAAmQEAaGVsbG8gd29ybGQgY29udGVudC1zaXplLWxlc3MgZnJhbWUgdGVzdCAxMjM0NTY3ODkw'

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex')
}

/** Builds message_0.sqlite in decryptedDir: one session conversation
 *  ("group1"), one non-session participant ("bob"), and three message rows
 *  covering plain text, zstd-compressed (content-size-less frame), and
 *  exact-sender-prefixed text. Returns the Msg_<md5> table name so tests can
 *  assert exact msg_key values. */
function buildFixtureDb(decryptedDir: string): { table: string } {
  const dbPath = join(decryptedDir, 'message_0.sqlite')
  const db = new Database(dbPath, { create: true })
  db.exec('CREATE TABLE Name2Id (user_name TEXT, is_session INTEGER)')
  const insertName = db.query<unknown, [string, number]>(
    'INSERT INTO Name2Id (user_name, is_session) VALUES (?, ?)',
  )
  insertName.run('group1', 1) // rowid 1 — the session/conversation
  insertName.run('bob', 0) // rowid 2 — a participant, not itself a session

  const table = 'Msg_' + md5('group1')
  db.exec(`
    CREATE TABLE "${table}" (
      local_id INTEGER PRIMARY KEY,
      local_type INTEGER,
      real_sender_id INTEGER,
      create_time INTEGER,
      server_id TEXT,
      message_content BLOB
    )
  `)
  const insertMsg = db.query<
    unknown,
    [number, number, number, number, string, string | Uint8Array]
  >(
    `INSERT INTO "${table}" (local_id, local_type, real_sender_id, create_time, server_id, message_content)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  // (a) plain text row (TEXT storage class — no zstd)
  insertMsg.run(1, 1, 2, 1000, 's1', 'hello world')
  // (b) zstd BLOB row — content-size-less frame
  const zstdBytes = new Uint8Array(Buffer.from(CONTENT_SIZE_LESS_ZSTD_B64, 'base64'))
  insertMsg.run(2, 1, 2, 1001, 's2', zstdBytes)
  // (c) exact-sender-prefix row
  insertMsg.run(3, 1, 2, 1002, 's3', 'bob:\nprefixed text body')

  db.close()
  return { table }
}

describe('runSourceAdapter', () => {
  let dir: string
  let decryptedDir: string
  let store: KnowledgeStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'source-adapter-'))
    decryptedDir = join(dir, 'decrypted')
    mkdirSync(decryptedDir, { recursive: true })
    store = openKnowledge(join(dir, 'knowledge'))
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('normalizes plain text, zstd (content-size-less frame), and prefix-stripped rows', () => {
    const { table } = buildFixtureDb(decryptedDir)

    const result = runSourceAdapter({ decryptedDir, store })
    expect(result.ingested).toBe(3)

    const { messages } = store.listMessages(0, 100)
    expect(messages).toHaveLength(3)
    const byKey = new Map(messages.map(m => [m.msg_key, m]))

    expect(byKey.get(`${table}:1`)).toMatchObject({
      conversation: 'group1',
      sender: 'bob',
      time: 1000,
      type: 'text',
      text: 'hello world',
      server_id: 's1',
    })
    expect(byKey.get(`${table}:2`)).toMatchObject({
      conversation: 'group1',
      sender: 'bob',
      time: 1001,
      type: 'text',
      text: CONTENT_SIZE_LESS_TEXT,
      server_id: 's2',
    })
    expect(byKey.get(`${table}:3`)).toMatchObject({
      conversation: 'group1',
      sender: 'bob',
      time: 1002,
      type: 'text',
      text: 'prefixed text body',
      server_id: 's3',
    })
  })

  it('is incremental: a second run ingests nothing new and does not churn the watermark', () => {
    buildFixtureDb(decryptedDir)

    const first = runSourceAdapter({ decryptedDir, store })
    expect(first.ingested).toBe(3)
    const { watermark: watermarkAfterFirst, messages: messagesAfterFirst } = store.listMessages(0, 100)
    expect(messagesAfterFirst).toHaveLength(3)

    const second = runSourceAdapter({ decryptedDir, store })
    expect(second.ingested).toBe(0)

    const { messages, watermark } = store.listMessages(0, 100)
    expect(messages).toHaveLength(3)
    // No re-upsert of already-ingested rows ⇒ watermark unchanged (churn-free,
    // so a downstream semantic indexer paging by watermark never re-embeds).
    expect(watermark).toBe(watermarkAfterFirst)
  })

  it('returns ingested: 0 and does not throw when decryptedDir has no message_*.sqlite files', () => {
    const result = runSourceAdapter({ decryptedDir, store })
    expect(result.ingested).toBe(0)
    expect(store.listMessages(0, 100).messages).toHaveLength(0)
  })
})
