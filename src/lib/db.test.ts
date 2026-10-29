import { describe, expect, it } from 'vitest'
import { openSqlite } from './runtime/sqlite'
import { migrations, openTestDb, openDb, openWechatDb, renameMigrated, runMigrations, withLockRetry } from './db'
import type { Db } from './db'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from './test-temp'

/**
 * 一个真正走到第 n 版的库(第三批 3e 迁移第 3 步):用前 n 个真迁移建出来,再把 user_version 记成 n。
 * 以前这几条测试手写一个「声称自己在 v9 / v26」的假库,表和真 v9 / v26 不一样 —— 迁移体里那批「表在不在」的守卫就是为
 * 这些假库加的。改从真迁移起步以后,测的就是用户真正走的那条升级路。
 */
function migratedTo(n: number): Db {
  const db = openSqlite(':memory:') as unknown as Db
  db.exec('PRAGMA foreign_keys = ON;')
  for (const m of migrations.slice(0, n)) m(db)
  db.exec(`PRAGMA user_version = ${n};`)
  return db
}

describe('withLockRetry', () => {
  const noop = () => {}

  it('retries a "database is locked" failure and returns once it succeeds', () => {
    let calls = 0
    const r = withLockRetry(() => {
      calls++
      if (calls < 3) throw new Error('database is locked')
      return 42
    }, { attempts: 5, sleep: noop })
    expect(r).toBe(42)
    expect(calls).toBe(3) // failed twice, succeeded on the third
  })

  it('rethrows a non-lock error immediately without retrying', () => {
    let calls = 0
    expect(() => withLockRetry(() => { calls++; throw new Error('disk I/O error') }, { attempts: 5, sleep: noop }))
      .toThrow('disk I/O error')
    expect(calls).toBe(1)
  })

  it('gives up after `attempts` locked failures and rethrows the last', () => {
    let calls = 0
    expect(() => withLockRetry(() => { calls++; throw new Error('database is locked') }, { attempts: 3, sleep: noop }))
      .toThrow('database is locked')
    expect(calls).toBe(3)
  })
})

describe('openDb', () => {
  it('returns a database with all migrations applied', () => {
    const db = openTestDb()
    const v = db.query('PRAGMA user_version').get() as { user_version: number }
    expect(v.user_version).toBeGreaterThan(0)
    // schema for v1: session_state table exists
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toContain('session_state')
  })

  it('is idempotent: re-opening an existing file does not re-run migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-test-'))
    try {
      const path = join(dir, 'test.db')
      const db1 = openDb({ path })
      const v1 = (db1.query('PRAGMA user_version').get() as { user_version: number }).user_version
      db1.exec("INSERT INTO session_state(bot_id, first_seen_expired_at) VALUES ('b1', '2026-01-01T00:00:00Z')")
      db1.close()

      const db2 = openDb({ path })
      const v2 = (db2.query('PRAGMA user_version').get() as { user_version: number }).user_version
      expect(v2).toBe(v1)
      const row = db2.query("SELECT bot_id FROM session_state WHERE bot_id='b1'").get() as { bot_id: string } | null
      expect(row?.bot_id).toBe('b1')
      db2.close()
    } finally {
      removeTempDir(dir)
    }
  })

  it('enables WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-test-wal-'))
    try {
      const db = openDb({ path: join(dir, 'wal.db') })
      const mode = db.query('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(mode.journal_mode.toLowerCase()).toBe('wal')
      db.close()
    } finally {
      removeTempDir(dir)
    }
  })

  // Windows CI 上 db.test 这几条清理时 EBUSY、重试 21 轮也删不掉,直到撞 20s 超时:不是盘慢,
  // 是 close() 根本没关上 —— 迁移跑了 30 来条不同的 SQL,挤出 bun:sqlite 查询缓存(20 条)的
  // 语句没 finalize,close_v2 只把连接挂成僵尸,句柄留到 GC。严格关(sqlite3_close)在还有
  // 未 finalize 的语句时会抛 "database is locked",所以这条在 macOS / Linux 上也能看出来。
  it('close() really releases the file: no statement left unfinalized after migrations and many distinct queries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-test-close-'))
    try {
      const db = openDb({ path: join(dir, 'close.db') })
      for (let i = 0; i < 40; i++) db.query(`SELECT ${i} AS n`).get()
      const kept = db.prepare('SELECT 1 AS one')
      kept.get()
      expect(() => db.close(true)).not.toThrow()
    } finally {
      removeTempDir(dir)
    }
  })

  // 上一条的弱引用有个缝(2026-10-28,Windows CI native-continue「Hook timed out」那次查出来的):
  // GC 已经把语句收走、FinalizationRegistry 已经把它从登记里拿掉,原生那头却要等 JSC 懒清扫才
  // sqlite3_finalize —— 这时 close() 两头都够不着它,连接照样变僵尸。工作台跑过一轮的测试几乎条条中。
  // 这里造垃圾逼出几次小 GC、让出一拍让登记的回调跑完,正好卡在那个缝里。修之前本机 20 次里十几次抛
  // database is locked;GC 时机因机器而异,所以按次数判、留两次余量,没修时远远超过。
  it('close() still releases the file when GC already dropped statements whose native side is not finalized yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-test-close-gc-'))
    try {
      let locked = 0
      for (let run = 0; run < 20; run++) {
        const db = openSqlite(join(dir, `gc-${run}.db`), { create: true })
        ;(() => { for (let i = 0; i < 200; i++) db.query(`SELECT ${i} AS n`).get() })()
        ;(() => { const junk: { i: number }[] = []; for (let i = 0; i < 200_000; i++) junk.push({ i }); return junk.length })()
        await new Promise(resolve => setTimeout(resolve, 10))
        try { db.close(true) } catch { locked++; db.close() }
      }
      expect(locked).toBeLessThanOrEqual(2)
    } finally {
      removeTempDir(dir)
    }
  })
})

describe('renameMigrated', () => {
  it('renames the file to <file>.migrated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-'))
    try {
      const file = join(dir, 'legacy.json')
      writeFileSync(file, '{}')
      renameMigrated(file)
      expect(existsSync(file)).toBe(false)
      expect(existsSync(`${file}.migrated`)).toBe(true)
    } finally {
      removeTempDir(dir)
    }
  })

  it('swallows ENOENT when the file is already gone (concurrent first-boot race)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-'))
    try {
      const file = join(dir, 'legacy.json')
      // Simulate "another process already renamed it" — file does not exist.
      expect(() => renameMigrated(file)).not.toThrow()
    } finally {
      removeTempDir(dir)
    }
  })
})

describe('migration v10 — sessions.chat_id', () => {
  it('adds chat_id column with _legacy default for pre-existing rows', () => {
    const db = migratedTo(9)
    db.exec(`
      INSERT INTO sessions(alias, provider, session_id, last_used_at)
        VALUES ('_default', 'claude', 'sess1', '${new Date().toISOString()}');
    `)

    runMigrations(db, migrations)

    const cols = db.query("PRAGMA table_info('sessions')").all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('chat_id')

    const row = db.query("SELECT chat_id FROM sessions WHERE alias = '_default'").get() as { chat_id: string }
    expect(row.chat_id).toBe('_legacy')

    const ver = db.query('PRAGMA user_version').get() as { user_version: number }
    expect(ver.user_version).toBeGreaterThanOrEqual(10)
  })

  it('legacy rows older than 1 day are cleaned up', () => {
    const db = migratedTo(9)
    const oldTs = new Date(Date.now() - 2 * 86_400_000).toISOString()
    db.exec(`
      INSERT INTO sessions(alias, provider, session_id, last_used_at) VALUES
        ('_default', 'claude', 'old_sess', '${oldTs}'),
        ('_default', 'codex',  'fresh',    '${new Date().toISOString()}');
    `)
    runMigrations(db, migrations)
    const remaining = db.query<{ session_id: string }, []>('SELECT session_id FROM sessions').all()
    expect(remaining.map(r => r.session_id)).toContain('fresh')
    expect(remaining.map(r => r.session_id)).not.toContain('old_sess')
  })
})

describe('migration v12 — a2a_events table', () => {
  it('creates a2a_events table with expected columns', () => {
    const db = openDb({ path: ':memory:' })
    const cols = db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('a2a_events')"
    ).all()
    const names = cols.map(c => c.name).sort()
    expect(names).toEqual(['agent_id', 'direction', 'http_status', 'id', 'status', 'text', 'ts', 'urgency'])
  })

  it('PRAGMA user_version is at least 12 after v12 (latest migrations applied)', () => {
    const db = openDb({ path: ':memory:' })
    const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(v).toBeGreaterThanOrEqual(12)
  })

  it('agent_ts index exists', () => {
    const db = openDb({ path: ':memory:' })
    const idx = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='a2a_events'"
    ).all()
    expect(idx.find(i => i.name === 'a2a_events_agent_ts')).toBeDefined()
  })
})

describe('migration v27/v28 — customer review completed elsewhere and analysis coverage', () => {
  it('upgrades v26 review feedback without losing items or evidence', () => {
    const db = migratedTo(26)
    db.exec(`
      INSERT INTO customer_reviews(id, contact_id, contact_display_name, range_from, range_to, status, provider, created_at, updated_at)
        VALUES ('r1', 'c1', '客户一', '2026-01-01', '2026-01-31', 'ready', 'claude', '2026-01-01', '2026-01-01');
      INSERT INTO customer_review_items VALUES ('r1','k1','发送报价','open',NULL,'high','confirmed',NULL,'2026-01-01','2026-01-01');
      INSERT INTO customer_review_evidence VALUES ('r1','k1','e1','commitment','2026-01-01','me');
      INSERT INTO customer_review_feedback VALUES ('c1','k1','confirmed',NULL,'2026-01-01');
    `)

    runMigrations(db, migrations)

    const version = db.query('PRAGMA user_version').get() as { user_version: number }
    expect(version.user_version).toBe(migrations.length)
    expect(db.query('SELECT commitment FROM customer_review_items').get()).toMatchObject({ commitment: '发送报价' })
    expect(db.query('SELECT evidence_key FROM customer_review_evidence').get()).toMatchObject({ evidence_key: 'e1' })
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'customer_review_analysis_issues'").get()).toMatchObject({ name: 'customer_review_analysis_issues' })
    expect(() => db.prepare(`
      INSERT INTO customer_review_feedback(contact_id, source_key, review_status, corrected_text, updated_at)
      VALUES ('c1', 'k2', 'completed_elsewhere', NULL, '2026-01-02')
    `).run()).not.toThrow()
    db.close()
  })
})

describe('migration v13 — events.kind adds memory_deleted + memory_path column', () => {
  it('extends events.kind CHECK to include memory_deleted', () => {
    const db = openDb({ path: ':memory:' })
    // Should succeed (kind allowed)
    expect(() => db.exec(
      "INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning) " +
      "VALUES ('evt_a', 'chat1', '2026-05-26T00:00:00.000Z', 'memory_deleted', 'mcp_tool_call', 'user said forget')"
    )).not.toThrow()
  })

  it('rejects kind values outside the union (CHECK still active)', () => {
    const db = openDb({ path: ':memory:' })
    expect(() => db.exec(
      "INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning) " +
      "VALUES ('evt_b', 'chat1', '2026-05-26T00:00:00.000Z', 'not_a_real_kind', 'mcp_tool_call', 'whatever')"
    )).toThrow()
  })

  it('preserves pre-v13 rows through the table recreate, and adds memory_path nullable TEXT column', () => {
    const db = openDb({ path: ':memory:' })
    // Insert a row with a pre-existing kind
    db.exec(
      "INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning) " +
      "VALUES ('evt_legacy', 'chat1', '2026-05-25T00:00:00.000Z', 'milestone', 'manual', 'old row preserved')"
    )
    // The migration ran on openDb (all-in-one). Validate the schema:
    const cols = db.query<{ name: string; type: string; notnull: number }, []>(
      "SELECT name, type, [notnull] FROM pragma_table_info('events')"
    ).all()
    const mp = cols.find(c => c.name === 'memory_path')
    expect(mp).toBeDefined()
    expect(mp!.type).toBe('TEXT')
    expect(mp!.notnull).toBe(0)
    // And the legacy row survived
    const row = db.query<{ reasoning: string }, []>(
      "SELECT reasoning FROM events WHERE id = 'evt_legacy'"
    ).get()
    expect(row?.reasoning).toBe('old row preserved')
  })
})

describe('migration v13→v14 upgrade — events data preserved', () => {
  it('preserves pre-v14 rows through the table recreate, memory_path intact', () => {
    // 用前 13 个真迁移走到 v13(3e 迁移第 3 步:以前这里手写了一个只有 events 表的假 v13 库,说「SQLite 撤不回 DDL」——
    // 但撤不回不用撤,只跑前 13 个就是真的 v13)。之后只有 v14 起的那些会跑。
    const db = migratedTo(13)
    // Insert a row using the memory_deleted kind and a non-null memory_path
    db.exec(
      "INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning, memory_path) " +
      "VALUES ('evt_pre14', 'chat1', '2026-06-01T00:00:00.000Z', 'memory_deleted', 'mcp_tool_call', 'user said forget', '/foo/bar.md')"
    )
    // Run remaining migrations (only v14 applies, since user_version=13)
    runMigrations(db, migrations)
    // The row must have survived the CHECK rebuild
    const row = db.query<{ reasoning: string; memory_path: string | null }, []>(
      "SELECT reasoning, memory_path FROM events WHERE id = 'evt_pre14'"
    ).get()
    expect(row?.reasoning).toBe('user said forget')
    expect(row?.memory_path).toBe('/foo/bar.md')
    // And threads_extracted must now be accepted as a valid kind
    expect(() => db.exec(
      "INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning) " +
      "VALUES ('evt_new', 'chat1', '2026-06-11T00:00:00.000Z', 'threads_extracted', 'introspect', 'extracted threads')"
    )).not.toThrow()
  })
})

describe('dialogue migration', () => {
  it('creates messages / threads / thread_extract_state tables', () => {
    const db = openTestDb()
    db.exec(`INSERT INTO messages(id, chat_id, ts, direction, kind, text, source)
             VALUES ('m1', 'c1', '2026-06-11T00:00:00Z', 'in', 'text', 'hi', 'live')`)
    db.exec(`INSERT INTO threads(id, chat_id, title, facets, created_ts, last_active)
             VALUES ('t1', 'c1', '排产', '["task"]', '2026-06-11T00:00:00Z', '2026-06-11T00:00:00Z')`)
    db.exec(`INSERT INTO thread_extract_state(chat_id, extracted_to_ts)
             VALUES ('c1', '2026-06-11T00:00:00Z')`)
    expect(db.query('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 1 })
  })

  it('messages.direction is constrained to in/out', () => {
    const db = openTestDb()
    expect(() => db.exec(
      `INSERT INTO messages(id, chat_id, ts, direction, kind, text, source)
       VALUES ('m2', 'c1', '2026-06-11T00:00:00Z', 'sideways', 'text', 'x', 'live')`,
    )).toThrow()
  })

  it('events accepts the new threads_extracted kind and still accepts old kinds', () => {
    const db = openTestDb()
    db.exec(`INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning)
             VALUES ('e1', 'c1', '2026-06-11T00:00:00Z', 'threads_extracted', 'introspect', 'r')`)
    db.exec(`INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning)
             VALUES ('e2', 'c1', '2026-06-11T00:00:00Z', 'observation_written', 'cron', 'r')`)
    expect(db.query('SELECT COUNT(*) c FROM events').get()).toEqual({ c: 2 })
  })

  it('events rows survive the CHECK rebuild', () => {
    const db = openTestDb()
    const cols = db.query(`SELECT name FROM pragma_table_info('events')`).all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('observation_id')
  })
})

describe('migration v11 — participants column', () => {
  it('adds nullable TEXT participants column to conversations', () => {
    const db = openDb({ path: ':memory:' })
    const cols = db.query<{ name: string; type: string; notnull: number }, []>(
      "SELECT name, type, [notnull] FROM pragma_table_info('conversations')"
    ).all()
    const col = cols.find(c => c.name === 'participants')
    expect(col).toBeDefined()
    expect(col!.type).toBe('TEXT')
    expect(col!.notnull).toBe(0)
  })

  it('pre-v11 rows hydrate with NULL participants', () => {
    const db = openDb({ path: ':memory:' })
    db.exec(
      "INSERT INTO conversations(chat_id, mode_kind, mode_provider, mode_primary, updated_at) " +
      "VALUES ('legacy-chat', 'chatroom', NULL, NULL, '2026-05-22T00:00:00.000Z')"
    )
    const row = db.query<{ participants: string | null }, []>(
      "SELECT participants FROM conversations WHERE chat_id = 'legacy-chat'"
    ).get()
    expect(row).toBeDefined()
    expect(row!.participants).toBeNull()
  })
})

describe('migration v24 — social_seek redacted columns', () => {
  it('adds nullable redacted_topic / redacted_city columns to social_seek (before v43 retirement)', () => {
    // Build a db at exactly v23 (before v24, before v43 drops the tables)
    const db = openSqlite(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    for (let i = 0; i < 24; i++) migrations[i]!(db)
    db.exec('PRAGMA user_version = 24;')
    const cols = db.query<{ name: string }, []>("PRAGMA table_info('social_seek')").all()
    const names = cols.map(c => c.name)
    expect(names).toContain('redacted_topic')
    expect(names).toContain('redacted_city')
  })

  it('PRAGMA user_version is at least 24', () => {
    const db = openTestDb()
    const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(v).toBeGreaterThanOrEqual(24)
  })
})

// Regression for issue #79 — "desktop-v1.3.7 升级即崩: no such table: social_relay".
//
// The customer-review branch (45a52114, 2026-07-25) was cut from a tree whose
// migrations ended at v18 and numbered its own three as v19/v20/v21. Mainline
// meanwhile had v19–v25 (social/penpal), so the merge renumbered customer
// review to v26–v28. A database that ran the branch build therefore records
// user_version=21 meaning "customer-review analysis metadata done", while the
// released runner reads 21 as "social forwarding hop done" and resumes at v22
// — which ALTERs social_relay, a table that database never created.
//
// Officially-released installs are NOT affected: v1–v21 are byte-identical
// between desktop-v1.3.2 and today apart from one comment. Only databases that
// passed through that pre-merge branch build carry the mismatch.
describe('issue #79 — database left mid-schema by the customer-review branch build', () => {
  const SOCIAL_TABLES = [
    'social_seek', 'social_echo', 'social_pledge', 'social_relay',
    'social_seen_intent', 'penpal_channel', 'penpal_letter',
  ]

  // A database in exactly the shape the branch build left behind: every
  // customer_review_* table present and populated, every social_* and
  // penpal_* table absent, user_version parked at 21.
  function branchBuildDb() {
    const db = openTestDb()
    db.exec(`
      INSERT INTO customer_reviews
        (id, contact_id, contact_display_name, range_from, range_to, status,
         provider, model, source_message_count, source_first_at, source_last_at,
         error_code, created_at, updated_at, completed_at)
      VALUES ('r1', 'c1', 'Alice', '2026-01-01', '2026-02-01', 'ready',
              'claude', 'opus', 12, NULL, NULL, NULL, '2026-01-01', '2026-01-01', NULL);
    `)
    for (const t of SOCIAL_TABLES) db.exec(`DROP TABLE IF EXISTS ${t};`)
    db.exec('PRAGMA user_version = 21;')
    return db
  }

  it('runMigrations no longer dies on `no such table: social_relay`', () => {
    const db = branchBuildDb()
    expect(() => runMigrations(db, migrations)).not.toThrow()
  })

  it('restores every missing social/penpal table (though v43 later drops social ones)', () => {
    const db = branchBuildDb()
    runMigrations(db, migrations)
    const present = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map(r => r.name)
    // v19-v25 restore the social tables, but v43 drops them. So we check that
    // penpal tables (which survive v43) are present, and social tables are gone.
    expect(present).toContain('penpal_channel')
    expect(present).toContain('penpal_letter')
    for (const t of ['social_seek', 'social_echo', 'social_pledge', 'social_relay', 'social_seen_intent']) {
      expect(present).not.toContain(t)
    }
  })

  it('keeps the customer-review rows the branch build had already written', () => {
    const db = branchBuildDb()
    runMigrations(db, migrations)
    const row = db
      .query<{ id: string; contact_display_name: string }, []>('SELECT id, contact_display_name FROM customer_reviews')
      .get()
    expect(row).toEqual({ id: 'r1', contact_display_name: 'Alice' })
  })

  it('leaves the database fully migrated afterwards', () => {
    const db = branchBuildDb()
    runMigrations(db, migrations)
    const fresh = (openTestDb().query('PRAGMA user_version').get() as { user_version: number }).user_version
    const healed = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(healed).toBe(fresh)
  })

  it('upgrades a genuine desktop-v1.3.2 database normally — the repair must not fire', () => {
    // The release line's own user_version=21: social tables present at their
    // v21 shape (no v22+ columns), no customer_review_* at all.
    //
    // 2026-09-01:原来的写法是「先全量迁移,再手工 DROP 掉 v22–v25 加的东西」。
    // 那份手工清单每加一条动 social_*/penpal_* 的迁移就会烂掉一次(v32 就把它
    // 弄红了),而且烂法是「重复的列名」这种看不出因果的报错。改成直接跑
    // migrations[0..20] —— 那就是 1.3.2 真正装出来的库,不需要维护任何清单。
    const db = openSqlite(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    for (let i = 0; i < 21; i++) migrations[i]!(db)
    db.exec('PRAGMA user_version = 21;')

    expect(() => runMigrations(db, migrations)).not.toThrow()

    const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(v).toBe(migrations.length)
    // v22 ran for real: penpal_channel and penpal_letter tables exist.
    // (v43 later drops social_relay, so we can't check that anymore.)
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)
    expect(tables).toContain('penpal_channel')
    expect(tables).toContain('penpal_letter')
  })

  it('leaves an already-healthy fully-migrated database alone', () => {
    const db = openTestDb()
    const before = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(() => runMigrations(db, migrations)).not.toThrow()
    const after = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(after).toBe(before)
  })
})

// 2026-10 变异基线:#79 修复的两道签名(customer_reviews 在、social_echo 不在)各自换成 false 都不红 ——
// 上面「真 1.3.2 库」那条两道同时不满足,去掉哪一道都还有另一道兜着。这里各造一个只差一道的库。
describe('issue #79 — 修复的签名两道缺一不可', () => {
  const version = (db: Db) => (db.query('PRAGMA user_version').get() as { user_version: number }).user_version

  it('没有 customer_reviews(不是那个分支建的库)⇒ 不回退:就算社交表也不在,也照原样往下跑、原样报错', () => {
    // 真的 v1–v18,user_version 却记成 21:缺社交表,但也没有客户回顾 —— 不是 #79 那批库,修复不认它、不猜。
    const db = migratedTo(18)
    db.exec('PRAGMA user_version = 21;')
    expect(() => runMigrations(db, migrations)).toThrow(/social_relay/)
    expect(version(db)).toBe(21)
  })

  it('社交表在(正式发布的 1.3.2 库,又多了客户回顾表)⇒ 不回退,从 v22 正常往下跑', () => {
    // 回退到 v18 会把 v19–v21 在已有的社交表上重跑一遍;正式发布的库一个字节都不许这样碰。
    const db = migratedTo(21)
    migrations[25]!(db) // v26:客户回顾表(CREATE TABLE IF NOT EXISTS,之后 v26 再跑一次是空操作)
    db.exec('PRAGMA user_version = 21;')
    expect(() => runMigrations(db, migrations)).not.toThrow()
    expect(version(db)).toBe(migrations.length)
  })
})

describe('openDb — 外键约束是开着的', () => {
  it('子表指向一条不存在的父行 ⇒ 写入被拒', () => {
    const db = openTestDb()
    expect((db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
    expect(() => db.exec(
      "INSERT INTO workbench_wechat_subscriptions (task_id, owner_chat_id, account_id, enabled, generation, created_at, updated_at) VALUES ('no-such-task', 'c', 'a', 1, 1, 0, 0)",
    )).toThrow(/FOREIGN KEY/)
  })
})

describe('migration v41 — reminders back-fills columns the old June schema lacked', () => {
  it('adds last_attempt_at/last_error/attempts to a pre-v29 reminders table', () => {
    // Reproduce the "no such column: last_attempt_at" boot error: a database
    // that ran June's feat/reminders (a reminders table without the backoff
    // columns) already has the table, so v29's CREATE TABLE IF NOT EXISTS
    // skips it and the columns never arrive. user_version=29 marks v29 done.
    // 真的 v1–v28,再加六月 feat/reminders 那张缺退避列的旧表 —— 这才是那批真机上的样子(3e 迁移第 3 步:以前整个库只有这一张表)。
    const db = migratedTo(28)
    db.exec(`
      CREATE TABLE reminders (
        id         TEXT PRIMARY KEY NOT NULL,
        chat_id    TEXT NOT NULL,
        due_at     TEXT NOT NULL,
        text       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending'
      ) STRICT;
      PRAGMA user_version = 29;
    `)
    db.exec(
      "INSERT INTO reminders (id, chat_id, due_at, text, created_at) VALUES ('r1','c1','2026-08-20T10:00:00.000Z','hi','2026-08-20T09:00:00.000Z')",
    )

    expect(() => runMigrations(db, migrations)).not.toThrow()

    const cols = new Set(
      db.query<{ name: string }, []>('PRAGMA table_info(reminders)').all().map((r) => r.name),
    )
    expect(cols.has('last_attempt_at')).toBe(true)
    expect(cols.has('last_error')).toBe(true)
    expect(cols.has('attempts')).toBe(true)
    // The healed column is writable — the sweeper's stamping UPDATE no longer throws.
    expect(() =>
      db.exec("UPDATE reminders SET attempts = attempts + 1, last_attempt_at = '2026-08-20T10:01:00.000Z' WHERE id = 'r1'"),
    ).not.toThrow()
    // The pre-existing row survived the migration.
    const row = db.query<{ attempts: number }, []>("SELECT attempts FROM reminders WHERE id = 'r1'").get()
    expect(row?.attempts).toBe(1)
  })

  it('is a no-op on a fresh database where v29 already created the columns', () => {
    const db = openTestDb()
    expect(() => runMigrations(db, migrations)).not.toThrow()
    const cols = new Set(
      db.query<{ name: string }, []>('PRAGMA table_info(reminders)').all().map((r) => r.name),
    )
    expect(cols.has('last_attempt_at')).toBe(true)
  })
})

describe('migration v42 — heals the Atelier-branch v35 tool_calls collision', () => {
  it('adds tool_calls when user_version advanced past the skipped official v35', () => {
    const db = openTestDb()
    db.exec('ALTER TABLE turn_records DROP COLUMN tool_calls; PRAGMA user_version = 41;')

    expect(() => runMigrations(db, migrations)).not.toThrow()

    const cols = db.query<{ name: string }, []>("PRAGMA table_info('turn_records')").all().map(c => c.name)
    expect(cols).toContain('tool_calls')
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version
    expect(version).toBe(migrations.length)
    db.close()
  })
})

describe('旧社交表退役(spec 2026-09-04-wish-postcard §3)', () => {
  const tables = (db: Db) => new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name))
  it('全迁移库里没有四张社交表和 seen_intent;penpal/journal 还在', () => {
    const db = openDb({ path: ':memory:' })
    const t = tables(db)
    for (const n of ['social_seek', 'social_echo', 'social_pledge', 'social_relay', 'social_seen_intent']) expect(t.has(n), n).toBe(false)
    for (const n of ['penpal_channel', 'penpal_letter', 'journal', 'a2a_events']) expect(t.has(n), n).toBe(true)
  })
  it('迁移条数与 user_version 一致(位置契约)', () => {
    const db = openDb({ path: ':memory:' })
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(migrations.length)
  })
})


// 跑完整条迁移阶梯,CI 慢机上实测 7.5s,默认 5s 会假红。
// 真文件库、全部迁移跑两遍:Windows runner 上 32s(10-10 #323 的 windows 红),给 60s。
it('upgrades a real v46 database retaining task history, native identity and approved artifacts',{timeout:60_000},()=>{
  const dir=mkdtempSync(join(tmpdir(),'workbench-v46-')),path=join(dir,'state.db')
  try {
    const prior=openSqlite(path)
    prior.exec('PRAGMA foreign_keys=ON')
    for(const migration of migrations.slice(0,46))migration(prior)
    prior.exec('PRAGMA user_version=46')
    prior.query('INSERT INTO workbench_tasks(id,title,path,provider_id,owner_chat_id,session_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('deadbeef','old task','/missing/project','codex','owner','native-session','completed',1,2)
    prior.query('INSERT INTO workbench_events(task_id,kind,text,created_at) VALUES(?,?,?,?)').run('deadbeef','user','old request',3)
    prior.query('INSERT INTO workbench_artifacts(id,task_id,name,mime,size,sha256,storage_path,created_at,approved_at) VALUES(?,?,?,?,?,?,?,?,?)').run('artifact-id','deadbeef','report.md','text/plain',7,'a'.repeat(64),'/immutable/file',4,5)
    const oldTask=prior.query('SELECT * FROM workbench_tasks').get(),oldEvents=prior.query('SELECT * FROM workbench_events').all(),oldArtifacts=prior.query('SELECT * FROM workbench_artifacts').all()
    prior.close()
    for(let i=0;i<2;i++) {
      const upgraded=openDb({path})
      try {
        expect(upgraded.query('SELECT * FROM workbench_tasks').get()).toEqual({...oldTask as object,archived_at:null,matter_id:(oldTask as {id:string}).id,execution_choice_json:'{"defaults":"provider","model":null,"reasoningEffort":null}',seq:0,workspace_kind:'project',writer_groups:null})
        expect(upgraded.query('SELECT * FROM workbench_events').all()).toEqual(oldEvents.map(row=>({...row as object,source_id:null,run_id:null,event_key:null,activity_json:null,attachments_json:'[]',seq:0})))
        expect(upgraded.query('SELECT * FROM workbench_artifacts').all()).toEqual(oldArtifacts)
      } finally {upgraded.close()}
    }
  } finally {removeTempDir(dir)}
})


it('upgrades v51 with separate durable control receipts while preserving task history and text inputs',()=>{
  const db=openSqlite(':memory:')
  try{
    for(const migration of migrations.slice(0,51))migration(db)
    db.exec('PRAGMA user_version=51')
    db.query('INSERT INTO workbench_tasks(id,title,path,provider_id,owner_chat_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('deadbeef','task','/project','claude','owner','completed',1,2)
    db.query('INSERT INTO workbench_events(task_id,kind,text,created_at,run_id) VALUES(?,?,?,?,?)').run('deadbeef','user','original input',3,'run-original')
    db.query('INSERT INTO workbench_live_inputs(id,task_id,run_id,text,status,created_at) VALUES(?,?,?,?,?,?)').run('input-one','deadbeef','run-original','supplement','delivered',4)
    const tasks=db.query('SELECT * FROM workbench_tasks').all(),events=db.query('SELECT * FROM workbench_events').all(),inputs=db.query('SELECT * FROM workbench_live_inputs').all()
    runMigrations(db, migrations)
    db.query('INSERT INTO workbench_control_receipts(id,task_id,run_id,action,text_hash,created_at) VALUES(?,?,?,?,?,?)').run('stop-one','deadbeef','run-original','stop','hash',5)
    runMigrations(db, migrations)
    expect(db.query('SELECT * FROM workbench_tasks').all()).toEqual(tasks.map(row=>({...row as object,matter_id:(row as {id:string}).id,execution_choice_json:'{"defaults":"provider","model":null,"reasoningEffort":null}',seq:0,workspace_kind:'project',writer_groups:null})))
    expect(db.query('SELECT * FROM workbench_events').all()).toEqual(events.map(row=>({...row as object,attachments_json:'[]',seq:0})))
    expect(db.query('SELECT * FROM workbench_live_inputs').all()).toEqual(inputs.map(row=>({...row as object,attachments_json:'[]',execution_json:null})))
    expect(db.query('SELECT * FROM workbench_control_receipts').all()).toHaveLength(1)
  }finally{db.close()}
})

it('upgrades v52 with staged attachments and empty refs on existing messages and inputs',()=>{
  const db=openSqlite(':memory:')
  try{
    for(const migration of migrations.slice(0,52))migration(db)
    db.exec('PRAGMA user_version=52')
    db.query('INSERT INTO workbench_tasks(id,title,path,provider_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('deadbeef','task','/project','claude','completed',1,2)
    db.query('INSERT INTO workbench_events(task_id,kind,text,created_at,run_id) VALUES(?,?,?,?,?)').run('deadbeef','user','original',3,'run-original')
    db.query('INSERT INTO workbench_live_inputs(id,task_id,run_id,text,status,created_at) VALUES(?,?,?,?,?,?)').run('input-one','deadbeef','run-original','supplement','held',4)
    runMigrations(db, migrations);runMigrations(db, migrations)
    expect(db.query('SELECT attachments_json FROM workbench_events').get()).toEqual({attachments_json:'[]'})
    expect(db.query('SELECT attachments_json FROM workbench_live_inputs').get()).toEqual({attachments_json:'[]'})
    expect(db.query("SELECT name FROM sqlite_master WHERE name='workbench_attachments'").get()).toEqual({name:'workbench_attachments'})
  }finally{db.close()}
})

it('adds request_event_id to a workbench_handoffs table that predates the column',()=>{
  // 真机 2026-09-15:这张表是在源码还没有 request_event_id 时建的,而 v49 用的是
  // `CREATE TABLE IF NOT EXISTS` —— 对已存在的表是空操作,所以这一列再也补不上,
  // store.detail() 的 HANDOFF_SELECT 每次都炸,工作台一个任务都显示不了。
  // 新建库拿不到这个形状,所以这条必须自己造旧表。
  const db=openSqlite(':memory:')
  try{
    for(const migration of migrations.slice(0,49))migration(db)
    db.exec('DROP TABLE workbench_handoffs')
    db.exec(`CREATE TABLE workbench_handoffs (
      id TEXT PRIMARY KEY, source_task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
      target_task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
      purpose TEXT NOT NULL CHECK(purpose IN ('review','revision')), request TEXT NOT NULL,
      packet_sha256 TEXT NOT NULL, artifact_refs_json TEXT NOT NULL, quote_json TEXT,
      created_at INTEGER NOT NULL, source_native_id TEXT, target_native_id TEXT,
      packet_json TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE
    ) STRICT`)
    for(const id of ['srctask1','tgttask1'])db.query('INSERT INTO workbench_tasks(id,title,path,provider_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,'t','/p','claude','completed',1,2)
    db.query('INSERT INTO workbench_handoffs(id,source_task_id,target_task_id,purpose,request,packet_sha256,artifact_refs_json,quote_json,created_at,source_native_id,target_native_id,packet_json,token_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('h1','srctask1','tgttask1','review','看一下','sha','[]',null,3,null,null,'{}','tok')
    db.exec('PRAGMA user_version=49')
    runMigrations(db, migrations);runMigrations(db, migrations)
    const columns=db.query<{name:string},[]>('PRAGMA table_info(workbench_handoffs)').all().map(column=>column.name)
    expect(columns).toContain('request_event_id')
    // 补列不能把既有交接记录洗掉。
    expect(db.query('SELECT id,request,request_event_id AS e FROM workbench_handoffs').all()).toEqual([{id:'h1',request:'看一下',e:null}])
  }finally{db.close()}
})

it('upgrades v53 with provider defaults, native import defaults and nullable queued execution snapshots',()=>{
  const db=openSqlite(':memory:')
  try{
    for(const migration of migrations.slice(0,53))migration(db)
    db.exec('PRAGMA user_version=53')
    for(const id of ['deadbeef','feedbeef'])db.query('INSERT INTO workbench_tasks(id,title,path,provider_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,'task','/project','claude','completed',1,2)
    db.query('INSERT INTO workbench_sources(id,task_id,provider_id,native_id,cwd,imported_at,snapshot_sha256,observed_fingerprint,selected_message_count,truncated,snapshot_json,pages_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('source','feedbeef','claude','native-original','/project',3,'sha','fingerprint',0,0,'{}','[]')
    db.query('INSERT INTO workbench_live_inputs(id,task_id,run_id,text,status,created_at) VALUES(?,?,?,?,?,?)').run('input','deadbeef','run','queued','held',4)
    const oldTasks=db.query<Record<string,unknown>,[]>('SELECT * FROM workbench_tasks ORDER BY id').all()
    runMigrations(db, migrations);runMigrations(db, migrations)
    const tasks=db.query<Record<string,unknown>,[]>('SELECT * FROM workbench_tasks ORDER BY id').all()
    expect(tasks).toEqual(oldTasks.map(row=>({...row,matter_id:row.id,execution_choice_json:JSON.stringify({defaults:row.id==='feedbeef'?'native':'provider',model:null,reasoningEffort:null}),seq:0,workspace_kind:'project',writer_groups:null})))
    expect(db.query('SELECT execution_json FROM workbench_live_inputs').get()).toEqual({execution_json:null})
    expect(db.query("SELECT name FROM sqlite_master WHERE name='workbench_run_execution'").get()).toEqual({name:'workbench_run_execution'})
    // Repair replay must not overwrite an accepted native task choice.
    db.query('UPDATE workbench_tasks SET execution_choice_json=? WHERE id=?').run('{"defaults":"native","model":"chosen","reasoningEffort":"high"}','feedbeef')
    migrations[53]!(db)
    expect(db.query('SELECT execution_choice_json FROM workbench_tasks WHERE id=?').get('feedbeef')).toEqual({execution_choice_json:'{"defaults":"native","model":"chosen","reasoningEffort":"high"}'})
  }finally{db.close()}
})

it('upgrades v67 without assigning staged legacy attachments to a new owner',()=>{
  const db=openSqlite(':memory:')
  try{
    db.exec('PRAGMA foreign_keys=ON')
    for(const migration of migrations.slice(0,67))migration(db)
    db.exec('PRAGMA user_version=67')
    db.query('INSERT INTO workbench_tasks(id,title,path,provider_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('deadbeef','old','/project','claude','completed',1,2)
    db.query('INSERT INTO workbench_attachments(id,draft_id,task_id,upload_task_id,name,mime,size,sha256,storage_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('old-attachment','old-draft',null,null,'old.txt','text/plain',3,'old-hash','/private/blob',3)
    const prior=db.query('SELECT * FROM workbench_attachments').get()
    runMigrations(db, migrations);runMigrations(db, migrations)
    expect(db.query('SELECT * FROM workbench_attachments').get()).toEqual({...prior as object,owner_key:null})
    expect(db.query('SELECT workspace_kind FROM workbench_tasks').get()).toEqual({workspace_kind:'project'})
    expect(db.query('SELECT * FROM workbench_entry_requests').all()).toEqual([])
  } finally {db.close()}
})

it('v61: workbench_tasks / workbench_events 都有 seq 列,事件表有 (task_id, seq) 索引', () => {
  const db = openTestDb()
  const cols = (t: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all().map(c => c.name)
  expect(cols('workbench_tasks')).toContain('seq')
  expect(cols('workbench_events')).toContain('seq')
  const idx = db.query<{ name: string }, []>("PRAGMA index_list('workbench_events')").all().map(i => i.name)
  expect(idx).toContain('workbench_events_task_seq')
  db.close()
})

it('v62: workbench_review_marks 表存在,主键为 (task_id, artifact_sha256, path)', () => {
  const db = openTestDb()
  const cols = db.query<{ name: string; pk: number }, []>("PRAGMA table_info(workbench_review_marks)").all()
  expect(cols.map(c => c.name)).toEqual(['task_id', 'artifact_sha256', 'path', 'after_sha256', 'mark', 'comment', 'created_at'])
  expect(cols.filter(c => c.pk > 0).map(c => c.name)).toEqual(['task_id', 'artifact_sha256', 'path'])
  db.close()
})

it('v63 migrates old task folders into durable projects without changing sessions or history',()=>{
 const db=openSqlite(':memory:')
 try{
  db.exec('PRAGMA foreign_keys=ON')
  for(const migration of migrations.slice(0,62))migration(db)
  db.exec("INSERT INTO workbench_tasks(id,title,path,provider_id,status,created_at,updated_at,session_id) VALUES ('aaaaaaaa','first','/old/site','codex','completed',1,2,'native-one'),('bbbbbbbb','second','/old/site','claude','completed',3,4,'native-two'); PRAGMA user_version=62")
  runMigrations(db, migrations)
  expect(db.query('SELECT path FROM workbench_projects').all()).toEqual([{path:'/old/site'}])
  expect(db.query('SELECT session_id FROM workbench_tasks ORDER BY id').all()).toEqual([{session_id:'native-one'},{session_id:'native-two'}])
  const before=db.query('SELECT * FROM workbench_projects').all();runMigrations(db, migrations)
  expect(db.query('SELECT * FROM workbench_projects').all()).toEqual(before)
 }finally{db.close()}
})

it('creates durable resumable upload state without rewriting legacy material',()=>{
  const db=openTestDb()
  try{expect(db.query('SELECT * FROM workbench_attachment_uploads').all()).toEqual([])}finally{db.close()}
})

it('v70 creates the chat-matter say receipts table empty (phone requestId dedupe)',()=>{
  const db=openTestDb()
  try{expect(db.query('SELECT * FROM matter_say_receipts').all()).toEqual([])}finally{db.close()}
})

it('v71 adds the reply-delivery columns to turn_records (spec 2026-10-03 §4.10)',()=>{
  const db=openTestDb()
  try{
    const cols=(db.query("PRAGMA table_info('turn_records')").all() as {name:string}[]).map(c=>c.name)
    expect(cols).toEqual(expect.arrayContaining(['delivery','bubbles','attachments','narration_segments']))
  }finally{db.close()}
})

it('v72 adds the nullable extras column to messages (app reply attachments + narration)',()=>{
  const db=openTestDb()
  try{
    const cols=(db.query("PRAGMA table_info('messages')").all() as {name:string;notnull:number}[])
    expect(cols.find(c=>c.name==='extras')).toMatchObject({notnull:0})
  }finally{db.close()}
})

it('v79 adds worktree script/port columns, a unique port index and the script approvals table',()=>{
  const db=openTestDb()
  try{
    const cols=(db.query("PRAGMA table_info('workbench_worktrees')").all() as {name:string;notnull:number}[])
    for(const name of ['script_sha','port','script_groups','setup_at'])expect(cols.find(c=>c.name===name)).toMatchObject({notnull:0})
    const add=(id:string,port:number|null)=>db.query('INSERT INTO workbench_worktrees(task_id,project_path,repo_root,root,branch,created_at,port) VALUES(?,?,?,?,?,?,?)').run(id,'/p','/p','/r/'+id,'cc/'+id,1,port)
    add('a',null);add('b',null);add('c',47100)
    expect(()=>add('d',47100)).toThrow()
    expect(db.query('SELECT * FROM workbench_script_approvals').all()).toEqual([])
  }finally{db.close()}
})

it('v81 creates workbench_rewinds with the applying/done/failed/needs_owner state check and a task index',()=>{
  const db=openTestDb()
  try{
    db.query("INSERT INTO workbench_tasks(id,title,path,provider_id,status,created_at,updated_at) VALUES('t1','t','/p','claude','completed',1,1)").run()
    const add=(id:string,state:string,point='end')=>db.query("INSERT INTO workbench_rewinds(id,task_id,target_artifact_id,target_point,target_commit,prior_head,backup_ref,backup_commit,discarded_json,state,created_at) VALUES(?,'t1','a',?,'c','h','refs/tendhearth/rewind/t1/1','b','[]',?,1)").run(id,point,state)
    add('r1','applying');add('r2','done');add('r3','failed');add('r6','needs_owner')
    expect(()=>db.query("UPDATE workbench_rewinds SET resolution='maybe' WHERE id='r6'").run()).toThrow()
    db.query("UPDATE workbench_rewinds SET resolution='keep' WHERE id='r6'").run()
    expect(()=>add('r4','undone')).toThrow()
    expect(()=>add('r5','done','middle')).toThrow()
    const cols=(db.query("PRAGMA table_info('workbench_rewinds')").all() as {name:string;notnull:number}[])
    for(const name of ['notice_sent_at','undone_at','resolution'])expect(cols.find(c=>c.name===name)).toMatchObject({notnull:0})
    expect((db.query("PRAGMA index_list('workbench_rewinds')").all() as {name:string}[]).map(i=>i.name)).toContain('workbench_rewinds_task')
    db.query("DELETE FROM workbench_tasks WHERE id='t1'").run()
    expect(db.query('SELECT * FROM workbench_rewinds').all()).toEqual([])
  }finally{db.close()}
})

it('v83 creates review comment + hunk tables with state checks, a task index and task cascade',()=>{
  const db=openTestDb()
  try{
    db.query("INSERT INTO workbench_tasks(id,title,path,provider_id,status,created_at,updated_at) VALUES('t1','t','/p','claude','completed',1,1)").run()
    const comment=(id:string,state:string)=>db.query("INSERT INTO workbench_review_comments(id,task_id,artifact_id,artifact_sha256,path,hunk_index,hunk_sha256,quote,body,state,created_at,updated_at) VALUES(?,'t1','a','s','f.ts',0,'h','q','b',?,1,1)").run(id,state)
    comment('c1','draft');comment('c2','sent')
    expect(()=>comment('c3','resolved')).toThrow()
    expect(()=>comment('c1','draft')).toThrow()
    const hunk=(i:number,state:string)=>db.query("INSERT INTO workbench_review_hunks(task_id,artifact_sha256,path,hunk_index,hunk_sha256,state,created_at) VALUES('t1','s','f.ts',?,'h',?,1)").run(i,state)
    hunk(0,'reverted');hunk(1,'restored')
    expect(()=>hunk(2,'accepted')).toThrow()
    expect(()=>hunk(0,'restored')).toThrow()
    // STRICT:整数列不收文本
    expect(()=>db.query("INSERT INTO workbench_review_hunks(task_id,artifact_sha256,path,hunk_index,hunk_sha256,state,created_at) VALUES('t1','s','f.ts','x','h','reverted',1)").run()).toThrow()
    const cols=(db.query("PRAGMA table_info('workbench_review_comments')").all() as {name:string;notnull:number}[])
    for(const name of ['row_start','row_end','side','line_start','line_end','sent_request_id','sent_at','resolved_at'])expect(cols.find(c=>c.name===name)).toMatchObject({notnull:0})
    expect((db.query("PRAGMA index_list('workbench_review_comments')").all() as {name:string}[]).map(i=>i.name)).toContain('workbench_review_comments_task')
    expect(()=>db.query("INSERT INTO workbench_review_hunks(task_id,artifact_sha256,path,hunk_index,hunk_sha256,state,created_at) VALUES('nope','s','f.ts',0,'h','reverted',1)").run()).toThrow()
    db.query("DELETE FROM workbench_tasks WHERE id='t1'").run()
    expect(db.query('SELECT * FROM workbench_review_comments').all()).toEqual([])
    expect(db.query('SELECT * FROM workbench_review_hunks').all()).toEqual([])
  }finally{db.close()}
})

it('v84 creates speech_log (CC 主动开口的外发账) with origin / outcome checks, a chat index, STRICT, and no text column',()=>{
  const db=openTestDb()
  try{
    const ins=(origin:string,outcome:string)=>db.query("INSERT INTO speech_log(at,kind,origin,chat_id,outcome,reason,channel) VALUES(1,'companion',?,'c',?,NULL,NULL)").run(origin,outcome)
    for(const o of ['blocking','requested','report','initiative'])ins(o,'allowed')
    for(const o of ['deferred','dropped','failed'])ins('initiative',o)
    expect(()=>ins('urgent','allowed')).toThrow()
    expect(()=>ins('initiative','sent')).toThrow()
    expect(()=>db.query("INSERT INTO speech_log(at,kind,origin,chat_id,outcome) VALUES('x','k','report','c','allowed')").run()).toThrow()
    const cols=(db.query("PRAGMA table_info('speech_log')").all() as {name:string}[]).map(c=>c.name)
    expect(cols).toEqual(['id','at','kind','origin','chat_id','outcome','reason','channel'])
    expect((db.query("PRAGMA index_list('speech_log')").all() as {name:string}[]).map(i=>i.name)).toContain('speech_log_chat_at')
  }finally{db.close()}
})

describe('v85 — permission_decisions 的 surface 放开 chat(重建表)', () => {
  it('从真 v84 升上来:每一行原样留着、chat 能写进去、索引还在', () => {
    const db = migratedTo(84)
    const ins = db.query('INSERT INTO permission_decisions(id,at,surface,provider,project,tool,summary,verdict,by_,rule_id,reason,scope) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    const rows = [
      [7, 1_700_000_000_000, 'terminal', 'claude', '/w/proj', 'Bash', 'git status', 'allow', 'rule', 's1', '看状态不用问', 'sess-1'],
      [8, 1_700_000_000_500, 'workbench', 'codex', null, 'fileChange', 'src/a.ts', 'allow', 'review', null, '初审:低风险', 'task-9'],
      [42, 1_700_000_001_000, 'terminal', 'claude', '/w/other', 'Bash', 'rm -rf x', 'deny', 'rule', 'no-rm', '规则拒绝', 'sess-2'],
    ] as const
    for (const r of rows) ins.run(...r)
    expect(() => ins.run(43, 1, 'chat', 'claude', null, 't', 's', 'allow', 'rule', 'r', 'x', 'chat:a')).toThrow()
    runMigrations(db, migrations)
    const after = db.query('SELECT id,at,surface,provider,project,tool,summary,verdict,by_,rule_id,reason,scope FROM permission_decisions ORDER BY id').all() as Record<string, unknown>[]
    expect(after.map(r => Object.values(r))).toEqual(rows.map(r => [...r]))
    ins.run(43, 1_700_000_002_000, 'chat', 'gemini', null, 'mcp__wechat__memory_delete', 'memory_delete', 'allow', 'rule', 'mem', '删记忆不用问', 'chat:owner')
    expect(db.query("SELECT COUNT(*) AS n FROM permission_decisions WHERE surface='chat'").get()).toEqual({ n: 1 })
    expect(() => ins.run(44, 1, 'phone', 'claude', null, 't', 's', 'allow', 'rule', 'r', 'x', 'p')).toThrow()
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='permission_decisions_at' AND tbl_name='permission_decisions'").get()).toEqual({ name: 'permission_decisions_at' })
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'permission_decisions_v85%'").all()).toEqual([])
  })
})

describe('v87 — 记忆一个源的三张表(G2)', () => {
  it('从真 v86 升上来:旧数据不动、三张表建好,约束和外键都在', () => {
    const db = migratedTo(86)
    db.query("INSERT INTO openai_chat_sessions(id,chat_id,alias,path,config_hash,revision,messages_json,state,created_at,updated_at) VALUES('s1','c1','ds','/w','h',0,'[]','ready',1,1)").run()
    runMigrations(db, migrations)
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: migrations.length })
    expect(db.query('SELECT id, state FROM openai_chat_sessions').all()).toEqual([{ id: 's1', state: 'ready' }])
    const ins = db.query("INSERT INTO memory_facts(chat_id,key,doc,subject,text,status,source,created_at,updated_at,replaces) VALUES(?,?,?,'owner',?,?,'import',1,1,?)")
    ins.run('c1', 'c:aa01', 'memory', '年糕是狸花猫', 'retracted', null)
    ins.run('c1', 'o:k1', 'owner', '年糕是橘猫', 'active', 1)
    ins.run('c2', 'o:k1', 'owner', '另一个对话可以用同一个 key', 'active', null)
    expect(() => ins.run('c1', 'o:k1', 'owner', '同一个对话 key 不许重复', 'active', null)).toThrow()
    expect(() => ins.run('c1', 'm:01', 'notes', 'x', 'active', null)).toThrow()
    expect(() => ins.run('c1', 'm:02', 'memory', 'x', 'deleted', null)).toThrow()
    expect(() => ins.run('c1', 'm:03', 'memory', 'x', 'active', 999)).toThrow()
    expect(db.query("SELECT scope, ord FROM memory_facts WHERE key='c:aa01'").get()).toEqual({ scope: 'chat', ord: 0 })
    const ev = db.query("INSERT INTO memory_fact_events(fact_id,chat_id,ts,action,actor) VALUES(?,?,1,'added','import')")
    ev.run(1, 'c1'); ev.run(2, 'c1')
    expect(() => ev.run(99, 'c1')).toThrow()
    expect(db.query('SELECT MAX(seq) AS rev FROM memory_fact_events WHERE chat_id = ?').get('c1')).toEqual({ rev: 2 })
    db.query("INSERT INTO memory_derived(chat_id,kind,body,input_rev,generated_at) VALUES('c1','overview','x',2,1)").run()
    expect(() => db.query("INSERT INTO memory_derived(chat_id,kind,body,input_rev,generated_at) VALUES('c1','overview','y',3,2)").run()).toThrow()
    db.close()
  })
})

// 2026-10 变异基线第二轮:runner 外围活着的变异(重试之间的等待、建状态目录、只吞 ENOENT、#79 修复只给主库)。
describe('withLockRetry — 两次重试之间等一下,最后一次失败之后不等', () => {
  it('锁住 3 次全失败 ⇒ 等 2 次,每次按 delayMs', () => {
    const waits: number[] = []
    expect(() => withLockRetry(() => { throw new Error('SQLITE_BUSY: database is busy') }, { attempts: 3, delayMs: 7, sleep: ms => waits.push(ms) }))
      .toThrow(/busy/)
    expect(waits).toEqual([7, 7])
  })
  it('不传 delayMs ⇒ 每次等 250ms;第二次就成功 ⇒ 只等一次', () => {
    const waits: number[] = []
    let calls = 0
    expect(withLockRetry(() => { if (++calls < 2) throw new Error('database is locked'); return 'ok' }, { sleep: ms => waits.push(ms) })).toBe('ok')
    expect(waits).toEqual([250])
  })
})

describe('openDb — 状态目录', () => {
  it('父目录不在 ⇒ 逐级建出来,权限 0700(别的用户读不到库)', () => {
    const root = mkdtempSync(join(tmpdir(), 'db-test-dir-'))
    try {
      const dir = join(root, 'a', 'b')
      const db = openDb({ path: join(dir, 'x.db') })
      db.close()
      expect(existsSync(join(dir, 'x.db'))).toBe(true)
      // Windows 没有 POSIX 权限位,只看建出来了
      if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700)
    } finally {
      removeTempDir(root)
    }
  })
  it('openWechatDb ⇒ 库就是 <stateDir>/wechat-cc.db,迁移跑完', () => {
    const root = mkdtempSync(join(tmpdir(), 'db-test-wechat-'))
    try {
      const db = openWechatDb(root)
      expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(migrations.length)
      db.close()
      expect(existsSync(join(root, 'wechat-cc.db'))).toBe(true)
    } finally {
      removeTempDir(root)
    }
  })
  it('busy_timeout 是 5 秒(CLI 和 daemon 同时写时不立刻报 locked)', () => {
    const db = openTestDb()
    const row = db.query('PRAGMA busy_timeout').get() as Record<string, number>
    expect(Object.values(row)[0]).toBe(5000)
  })
})

describe('renameMigrated — 只吞 ENOENT', () => {
  it('改名因为别的原因失败(目标是个非空目录)⇒ 往上抛,不当成「已经搬过了」', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-'))
    try {
      const file = join(dir, 'legacy')
      mkdirSync(file)
      mkdirSync(join(`${file}.migrated`, 'occupied'), { recursive: true })
      expect(() => renameMigrated(file)).toThrow()
      expect(existsSync(file)).toBe(true)
    } finally {
      removeTempDir(dir)
    }
  })
})

describe('runMigrations — #79 修复只认主库那份迁移表', () => {
  it('知识库自己的迁移表:库长得像 #79(v21、有 customer_reviews、没社交表)也不回退', () => {
    const db = openTestDb()
    for (const t of ['social_seek', 'social_echo', 'social_pledge', 'social_relay', 'social_seen_intent']) db.exec(`DROP TABLE IF EXISTS ${t};`)
    db.exec('PRAGMA user_version = 21;')
    const ran: number[] = []
    const list = Array.from({ length: 23 }, (_, i) => () => { ran.push(i + 1) })
    runMigrations(db, list)
    expect(ran).toEqual([22, 23]) // 回退到 v18 的话会从 v19 跑起
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(23)
  })
})
