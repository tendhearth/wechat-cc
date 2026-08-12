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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
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

/** Builds message_1.sqlite covering every message shape Task 1 must handle:
 *  a 1:1 conversation ("friend1") with a text row, a voice row, and a
 *  transfer row; and a group conversation ("room1@chatroom") with a text
 *  row carrying an <atuserlist> @mention and a quote row carrying a
 *  <refermsg><chatusr> reference. Returns both Msg_<md5> table names. */
function buildAllKindsFixtureDb(
  decryptedDir: string,
): { friendTable: string; roomTable: string } {
  const dbPath = join(decryptedDir, 'message_1.sqlite')
  const db = new Database(dbPath, { create: true })
  db.exec('CREATE TABLE Name2Id (user_name TEXT, is_session INTEGER)')
  const insertName = db.query<unknown, [string, number]>(
    'INSERT INTO Name2Id (user_name, is_session) VALUES (?, ?)',
  )
  insertName.run('friend1', 1) // rowid 1 — a 1:1 session
  insertName.run('bob', 0) // rowid 2 — sender in both conversations
  insertName.run('carol', 0) // rowid 3 — unused as sender, mentioned only
  insertName.run('room1@chatroom', 1) // rowid 4 — a group session
  insertName.run('dave', 0) // rowid 5 — mentioned only

  const friendTable = 'Msg_' + md5('friend1')
  const roomTable = 'Msg_' + md5('room1@chatroom')
  for (const t of [friendTable, roomTable]) {
    db.exec(`
      CREATE TABLE "${t}" (
        local_id INTEGER PRIMARY KEY,
        local_type INTEGER,
        real_sender_id INTEGER,
        create_time INTEGER,
        server_id TEXT,
        message_content BLOB
      )
    `)
  }
  const insert = (t: string) =>
    db.query<unknown, [number, number, number, number, string, string]>(
      `INSERT INTO "${t}" (local_id, local_type, real_sender_id, create_time, server_id, message_content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )

  const insFriend = insert(friendTable)
  insFriend.run(1, 1, 2, 1000, 's1', 'hello friend') // text
  insFriend.run(2, 34, 2, 1001, 's2', '') // voice — no text body
  insFriend.run(3, 49, 2, 1002, 's3', '<msg><appmsg><type>2000</type></appmsg></msg>') // transfer

  const insRoom = insert(roomTable)
  // @mention via <atuserlist> — two targets, comma-separated.
  insRoom.run(1, 1, 2, 2000, 'g1', '<msgsource><atuserlist>carol,dave</atuserlist></msgsource>')
  // quote via <refermsg><chatusr> — chatusr wins over displayname.
  insRoom.run(
    2,
    49,
    2,
    2001,
    'g2',
    '<msg><appmsg><refermsg><chatusr>dave</chatusr><displayname>Dave</displayname></refermsg><type>57</type></appmsg></msg>',
  )

  db.close()
  return { friendTable, roomTable }
}

/** Minimal single-conversation, single-row message db, used by the WAL and
 *  sender-fallback tests below. If `walMode` is true, sets journal_mode=WAL
 *  before writing (giving the file a WAL-format header) and, after closing,
 *  deletes any `-wal`/`-shm` sidecars it left behind — matching real
 *  wxvault-decrypted output, which ships only the main `.sqlite` file. */
function buildMinimalDb(
  path: string,
  opts: { walMode?: boolean; realSenderId: number | null; conversation?: string },
): { table: string } {
  const db = new Database(path, { create: true })
  if (opts.walMode) db.exec('PRAGMA journal_mode=WAL;')
  db.exec('CREATE TABLE Name2Id (user_name TEXT, is_session INTEGER)')
  const insertName = db.query<unknown, [string, number]>(
    'INSERT INTO Name2Id (user_name, is_session) VALUES (?, ?)',
  )
  const conv = opts.conversation ?? 'group1'
  insertName.run(conv, 1) // rowid 1 — the session/conversation

  const table = 'Msg_' + md5(conv)
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
  db.query<unknown, [number, number, number | null, number, string, string]>(
    `INSERT INTO "${table}" (local_id, local_type, real_sender_id, create_time, server_id, message_content)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(1, 1, opts.realSenderId, 5000, 'srv-min', 'minimal db text')
  db.close()

  if (opts.walMode) {
    for (const suf of ['-wal', '-shm']) {
      const sidecar = path + suf
      if (existsSync(sidecar)) unlinkSync(sidecar)
    }
  }
  return { table }
}

/** Builds contact.sqlite in decryptedDir: a `contact` table with rows
 *  exercising the display priority (remark > nick_name > alias > username). */
function buildContactFixtureDb(decryptedDir: string): void {
  const dbPath = join(decryptedDir, 'contact.sqlite')
  const db = new Database(dbPath, { create: true })
  db.exec(`
    CREATE TABLE contact (
      username TEXT PRIMARY KEY, remark TEXT, nick_name TEXT, alias TEXT
    )
  `)
  const insert = db.query<unknown, [string, string | null, string | null, string | null]>(
    'INSERT INTO contact (username, remark, nick_name, alias) VALUES (?, ?, ?, ?)',
  )
  insert.run('wxid_alice', 'Alice Remark', 'Alice Nick', 'alice_alias')
  insert.run('wxid_bob', '', 'Bob Nick', 'bob_alias')
  insert.run('wxid_carol', null, null, 'carol_alias')
  insert.run('wxid_dave', null, null, null)
  db.close()
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

  it('ingests every message kind (text/voice/transfer/group/@mention/refermsg), not just text', () => {
    const { friendTable, roomTable } = buildAllKindsFixtureDb(decryptedDir)

    const result = runSourceAdapter({ decryptedDir, store })
    expect(result.ingested).toBe(5)

    const { messages } = store.listMessages(0, 100)
    expect(messages).toHaveLength(5)
    const byKey = new Map(messages.map(m => [m.msg_key, m]))

    // 1:1 text row — decoded/stripped as before, is_group false.
    expect(byKey.get(`${friendTable}:1`)).toMatchObject({
      local_type: 1,
      is_group: false,
      kind: 'text',
      text: 'hello friend',
    })
    // 1:1 voice row — ingested, but not text kind => empty text.
    expect(byKey.get(`${friendTable}:2`)).toMatchObject({
      local_type: 34,
      is_group: false,
      kind: 'voice',
      text: '',
    })
    // 1:1 transfer row (app subtype 2000) — classified, empty text.
    expect(byKey.get(`${friendTable}:3`)).toMatchObject({
      local_type: 49,
      is_group: false,
      kind: 'transfer',
      text: '',
    })
    // group text row — is_group true.
    expect(byKey.get(`${roomTable}:1`)).toMatchObject({
      local_type: 1,
      is_group: true,
      kind: 'text',
    })
    // group quote row (<refermsg> present) — classified 'quote', empty text.
    expect(byKey.get(`${roomTable}:2`)).toMatchObject({
      local_type: 49,
      is_group: true,
      kind: 'quote',
      text: '',
    })

    // @mention targets parsed from <atuserlist> (comma-separated).
    expect(store.mentionsFor(`${roomTable}:1`).sort()).toEqual(['carol', 'dave'])
    // refermsg <chatusr> preferred as the quote target.
    expect(store.mentionsFor(`${roomTable}:2`)).toEqual(['dave'])
    // Mentions are only extracted from GROUP messages (mirrors wxgraph
    // edges.py's `if not msg["is_group"]: continue`) — the 1:1 transfer
    // row's app-type content is decoded for kind classification but never
    // scanned for mention targets.
    expect(store.mentionsFor(`${friendTable}:3`)).toEqual([])
    expect(store.mentionsFor(`${friendTable}:1`)).toEqual([])

    // wxsearch's text-only view is unaffected: only the two text-kind rows.
    const textOnly = store.listMessages(0, 100, 'text')
    expect(textOnly.messages.map(m => m.msg_key).sort()).toEqual(
      [`${friendTable}:1`, `${roomTable}:1`].sort(),
    )
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

  it('opens a WAL-mode source db with no -wal/-shm sidecars (real wxvault output shape) via immutable open', () => {
    const dbPath = join(decryptedDir, 'message_0.sqlite')
    const { table } = buildMinimalDb(dbPath, { walMode: true, realSenderId: 1, conversation: 'group1' })
    expect(existsSync(dbPath + '-wal')).toBe(false)
    expect(existsSync(dbPath + '-shm')).toBe(false)

    const result = runSourceAdapter({ decryptedDir, store })
    expect(result.ingested).toBe(1)

    const { messages } = store.listMessages(0, 100)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      msg_key: `${table}:1`,
      conversation: 'group1',
      text: 'minimal db text',
      server_id: 'srv-min',
    })
  })

  it('skips an unreadable/garbage message_*.sqlite and still ingests the other dbs in the dir, without throwing', () => {
    buildMinimalDb(join(decryptedDir, 'message_0.sqlite'), { walMode: false, realSenderId: 1 })
    writeFileSync(join(decryptedDir, 'message_bad.sqlite'), 'this is not a sqlite database file')

    let result: { ingested: number } | undefined
    expect(() => {
      result = runSourceAdapter({ decryptedDir, store })
    }).not.toThrow()

    expect(result?.ingested).toBe(1)
    const { messages } = store.listMessages(0, 100)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe('minimal db text')
  })

  it('falls back to the numeric real_sender_id when the sender cannot be resolved via Name2Id', () => {
    const dbPath = join(decryptedDir, 'message_0.sqlite')
    // real_sender_id 999 has no matching Name2Id rowid, so senderUn resolves
    // to null and the adapter must fall back to String(real_sender_id).
    buildMinimalDb(dbPath, { walMode: false, realSenderId: 999, conversation: 'group1' })

    const result = runSourceAdapter({ decryptedDir, store })
    expect(result.ingested).toBe(1)

    const { messages } = store.listMessages(0, 100)
    expect(messages[0]?.sender).toBe('999')
  })

  describe('contact.sqlite ingestion (GR T4.5 — display-name map)', () => {
    it('ingests contact.sqlite into source.contacts with remark > nick_name > alias > username priority', () => {
      buildContactFixtureDb(decryptedDir)

      expect(() => runSourceAdapter({ decryptedDir, store })).not.toThrow()

      const byUsername = new Map(store.allSourceContacts().map(c => [c.username, c.display]))
      expect(byUsername.get('wxid_alice')).toBe('Alice Remark') // remark wins over nick_name/alias
      expect(byUsername.get('wxid_bob')).toBe('Bob Nick') // empty remark -> nick_name
      expect(byUsername.get('wxid_carol')).toBe('carol_alias') // no remark/nick_name -> alias
      expect(byUsername.get('wxid_dave')).toBe('wxid_dave') // nothing else -> username itself
    })

    it('a missing contact.sqlite does not crash the adapter and still ingests messages', () => {
      buildFixtureDb(decryptedDir) // message_0.sqlite, no contact.sqlite anywhere in decryptedDir

      let result: { ingested: number } | undefined
      expect(() => {
        result = runSourceAdapter({ decryptedDir, store })
      }).not.toThrow()

      expect(result?.ingested).toBe(3)
      expect(store.allSourceContacts()).toEqual([])
    })

    it('a corrupt/garbage contact.sqlite does not crash the adapter', () => {
      writeFileSync(join(decryptedDir, 'contact.sqlite'), 'this is not a sqlite database file')

      expect(() => runSourceAdapter({ decryptedDir, store })).not.toThrow()
      expect(store.allSourceContacts()).toEqual([])
    })

    it('a contact.sqlite whose `contact` table is missing expected columns does not crash the adapter', () => {
      const dbPath = join(decryptedDir, 'contact.sqlite')
      const db = new Database(dbPath, { create: true })
      db.exec('CREATE TABLE contact (username TEXT PRIMARY KEY, some_other_col TEXT)')
      db.query<unknown, [string, string]>('INSERT INTO contact (username, some_other_col) VALUES (?, ?)').run(
        'wxid_eve',
        'whatever',
      )
      db.close()

      expect(() => runSourceAdapter({ decryptedDir, store })).not.toThrow()
      expect(store.allSourceContacts()).toEqual([])
    })
  })
})
