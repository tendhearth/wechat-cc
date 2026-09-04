import { describe, expect, it } from 'vitest'
import { Database } from 'bun:sqlite'
import { migrations, openTestDb, openDb, renameMigrated, runMigrations, withLockRetry } from './db'
import type { Db } from './db'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      rmSync(dir, { recursive: true, force: true })
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
      rmSync(dir, { recursive: true, force: true })
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
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('swallows ENOENT when the file is already gone (concurrent first-boot race)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-'))
    try {
      const file = join(dir, 'legacy.json')
      // Simulate "another process already renamed it" — file does not exist.
      expect(() => renameMigrated(file)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('migration v10 — sessions.chat_id', () => {
  it('adds chat_id column with _legacy default for pre-existing rows', () => {
    const db = new Database(':memory:')
    db.exec(`
      PRAGMA user_version = 9;
      CREATE TABLE sessions (
        alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        summary TEXT,
        summary_updated_at TEXT,
        PRIMARY KEY (alias, provider)
      ) STRICT;
      INSERT INTO sessions(alias, provider, session_id, last_used_at)
        VALUES ('_default', 'claude', 'sess1', '${new Date().toISOString()}');
    `)

    runMigrations(db)

    const cols = db.query("PRAGMA table_info('sessions')").all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('chat_id')

    const row = db.query("SELECT chat_id FROM sessions WHERE alias = '_default'").get() as { chat_id: string }
    expect(row.chat_id).toBe('_legacy')

    const ver = db.query('PRAGMA user_version').get() as { user_version: number }
    expect(ver.user_version).toBeGreaterThanOrEqual(10)
  })

  it('legacy rows older than 1 day are cleaned up', () => {
    const db = new Database(':memory:')
    const oldTs = new Date(Date.now() - 2 * 86_400_000).toISOString()
    db.exec(`
      PRAGMA user_version = 9;
      CREATE TABLE sessions (
        alias TEXT NOT NULL, provider TEXT NOT NULL, session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL, summary TEXT, summary_updated_at TEXT,
        PRIMARY KEY (alias, provider)
      ) STRICT;
      INSERT INTO sessions(alias, provider, session_id, last_used_at) VALUES
        ('_default', 'claude', 'old_sess', '${oldTs}'),
        ('_default', 'codex',  'fresh',    '${new Date().toISOString()}');
    `)
    runMigrations(db)
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
    const db = new Database(':memory:')
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA user_version = 26;
      CREATE TABLE customer_reviews (id TEXT PRIMARY KEY NOT NULL) STRICT;
      CREATE TABLE customer_review_items (
        review_id TEXT NOT NULL REFERENCES customer_reviews(id) ON DELETE CASCADE,
        source_key TEXT NOT NULL, commitment TEXT NOT NULL,
        ai_status TEXT NOT NULL CHECK (ai_status IN ('open','completed')),
        due_date TEXT, confidence TEXT NOT NULL CHECK (confidence IN ('medium','high')),
        review_status TEXT NOT NULL DEFAULT 'unreviewed'
          CHECK (review_status IN ('unreviewed','confirmed','corrected','rejected','ignored')),
        corrected_text TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (review_id, source_key)
      ) STRICT;
      CREATE TABLE customer_review_evidence (
        review_id TEXT NOT NULL, source_key TEXT NOT NULL, evidence_key TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('commitment','completion','due_date')),
        message_time TEXT NOT NULL, sender_side TEXT NOT NULL CHECK (sender_side IN ('me','contact')),
        PRIMARY KEY (review_id, source_key, evidence_key, role),
        FOREIGN KEY (review_id, source_key)
          REFERENCES customer_review_items(review_id, source_key) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE customer_review_feedback (
        contact_id TEXT NOT NULL, source_key TEXT NOT NULL,
        review_status TEXT NOT NULL CHECK (review_status IN ('confirmed','corrected','rejected','ignored')),
        corrected_text TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (contact_id, source_key)
      ) STRICT;
      INSERT INTO customer_reviews VALUES ('r1');
      INSERT INTO customer_review_items VALUES ('r1','k1','发送报价','open',NULL,'high','confirmed',NULL,'2026-01-01','2026-01-01');
      INSERT INTO customer_review_evidence VALUES ('r1','k1','e1','commitment','2026-01-01','me');
      INSERT INTO customer_review_feedback VALUES ('c1','k1','confirmed',NULL,'2026-01-01');
    `)

    runMigrations(db)

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
    // Build a db that has run migrations 0..12 (user_version=13) so it
    // has the v13 events schema (with memory_deleted kind + memory_path col)
    // but has NOT yet run v14. We do this by running all migrations then
    // rolling back user_version — but since SQLite doesn't support undoing
    // DDL, the cleanest approach is to construct the v13 schema directly,
    // matching the shape the v13 migration leaves behind, then run v14.
    const db = new Database(':memory:')
    // Replicate the exact v13 schema so runMigrations sees user_version=13
    // and only applies v14.
    db.exec(`
      PRAGMA user_version = 13;
      CREATE TABLE events (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
          'observation_written', 'milestone',
          'memory_deleted'
        )),
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT,
        memory_path TEXT
      ) STRICT;
      CREATE INDEX events_chat_ts ON events(chat_id, ts DESC);
    `)
    // Insert a row using the memory_deleted kind and a non-null memory_path
    db.exec(
      "INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning, memory_path) " +
      "VALUES ('evt_pre14', 'chat1', '2026-06-01T00:00:00.000Z', 'memory_deleted', 'mcp_tool_call', 'user said forget', '/foo/bar.md')"
    )
    // Run remaining migrations (only v14 applies, since user_version=13)
    runMigrations(db)
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
    const db = new Database(':memory:')
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
    expect(() => runMigrations(db)).not.toThrow()
  })

  it('restores every missing social/penpal table (though v43 later drops social ones)', () => {
    const db = branchBuildDb()
    runMigrations(db)
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
    runMigrations(db)
    const row = db
      .query<{ id: string; contact_display_name: string }, []>('SELECT id, contact_display_name FROM customer_reviews')
      .get()
    expect(row).toEqual({ id: 'r1', contact_display_name: 'Alice' })
  })

  it('leaves the database fully migrated afterwards', () => {
    const db = branchBuildDb()
    runMigrations(db)
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
    const db = new Database(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    for (let i = 0; i < 21; i++) migrations[i]!(db)
    db.exec('PRAGMA user_version = 21;')

    expect(() => runMigrations(db)).not.toThrow()

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
    expect(() => runMigrations(db)).not.toThrow()
    const after = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(after).toBe(before)
  })
})

describe('migration v41 — reminders back-fills columns the old June schema lacked', () => {
  it('adds last_attempt_at/last_error/attempts to a pre-v29 reminders table', () => {
    // Reproduce the "no such column: last_attempt_at" boot error: a database
    // that ran June's feat/reminders (a reminders table without the backoff
    // columns) already has the table, so v29's CREATE TABLE IF NOT EXISTS
    // skips it and the columns never arrive. user_version=29 marks v29 done.
    const db = new Database(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
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

    expect(() => runMigrations(db)).not.toThrow()

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
    expect(() => runMigrations(db)).not.toThrow()
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

    expect(() => runMigrations(db)).not.toThrow()

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
