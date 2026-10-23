/**
 * SQLite connection + schema migration for the daemon's state stores.
 *
 * Single ~/.claude/channels/wechat/wechat-cc.db file owned by the daemon
 * process. Each table that used to live as a JSON/JSONL file under the
 * channel state dir is migrated here one-at-a-time across PR7 commits.
 *
 * Schema versioning: PRAGMA user_version. Each `migrations` entry below
 * advances the version by one and creates / alters the table for that
 * step. openDb() applies any missing migrations in order.
 *
 * Concurrency posture:
 *   - WAL journal mode → daemon is the single writer; dashboard / CLI
 *     read-only queries can run concurrently without blocking writes.
 *   - foreign_keys = ON for safety even though we don't currently model
 *     cross-table refs; cheap pragma, lets future schema use FKs.
 *
 * No ORM — call sites use db.prepare() / .query() with prepared
 * statements. bun:sqlite is API-compatible enough with better-sqlite3
 * that swapping later (if Bun ever drops the builtin) would be local.
 */
import { openSqlite, type SqlDatabase as Database } from './runtime/sqlite'
import { sleepSync } from './runtime'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { migrations } from './db/migrations'
import { hasTable } from './db/schema-helpers'
export { initializeWechatNotificationSchema, initializeArtifactDeliverySchema, initializeApiSessionSchema } from './db/schema-helpers'

export type Db = Database

// 迁移本身一版一个文件,顺序在 ./db/migrations/index.ts(第三批 3e)。
export { migrations }

export interface OpenDbOpts {
  /**
   * Filesystem path to the SQLite file. Use `:memory:` for tests. Parent
   * directory is created (recursively, mode 0700) if it doesn't exist.
   */
  path: string
}

/**
 * Convenience wrapper that resolves the daemon's canonical state file
 * (`<stateDir>/wechat-cc.db`) and opens it. Used by the CLI leaf commands
 * — every read-only `wechat-cc <noun> list` path goes through here so the
 * boilerplate isn't repeated 10× across cli.ts.
 *
 * For tests / non-canonical paths, use `openDb({ path })` directly.
 */
export function openWechatDb(stateDir: string): Database {
  return openDb({ path: join(stateDir, 'wechat-cc.db') })
}

function isLockedError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /database is locked|database is busy|SQLITE_BUSY/i.test(m)
}

/**
 * Run `fn`, retrying briefly on a SQLite "database is locked" error. Sync,
 * since openDb is sync. Survives the WAL-lock race when the daemon restarts
 * before the SIGKILLed old process released the lock — `busy_timeout` doesn't
 * cover the journal-mode switch, so that switch would otherwise crash the boot
 * with "database is locked". Non-lock errors rethrow immediately; `sleep` is
 * injectable for tests.
 */
export function withLockRetry<T>(
  fn: () => T,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => void } = {},
): T {
  const attempts = opts.attempts ?? 12
  const delayMs = opts.delayMs ?? 250
  const sleep = opts.sleep ?? sleepSync
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return fn()
    } catch (e) {
      lastErr = e
      if (!isLockedError(e)) throw e
      if (i < attempts - 1) sleep(delayMs)
    }
  }
  throw lastErr
}

export function openDb(opts: OpenDbOpts): Database {
  if (opts.path !== ':memory:') {
    const dir = dirname(opts.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  // Opening + switching to WAL takes a brief exclusive lock; on a daemon
  // restart the SIGKILLed old process may still hold it (busy_timeout doesn't
  // cover the journal-mode switch). Retry instead of crashing the boot.
  const db = withLockRetry(() => {
    const d = openSqlite(opts.path, { create: true })
    d.exec('PRAGMA journal_mode = WAL;')
    return d
  })
  db.exec('PRAGMA foreign_keys = ON;')
  // 5s busy_timeout — the CLI process and daemon may try to write the same
  // db simultaneously (e.g. `wechat-cc sessions delete` while the daemon
  // bumps last_used_at). With WAL the conflict window is short; the
  // timeout makes it transparent.
  db.exec('PRAGMA busy_timeout = 5000;')
  runMigrations(db)
  return db
}

/**
 * Heal a database whose user_version was written by the customer-review
 * branch build (issue #79).
 *
 * That branch (45a52114, 2026-07-25) was cut from a tree whose migrations
 * ended at v18 and numbered its own three v19/v20/v21. Mainline already had
 * v19–v25 (social/penpal), so merging renumbered customer review to v26–v28.
 * A database that ran the branch build therefore stores user_version=21
 * meaning "customer-review analysis metadata applied", while this runner
 * reads 21 as "social forwarding hop applied" and resumes at v22 — whose
 * first statement ALTERs social_relay, a table that database never created.
 * Hence the crash-on-boot loop: `no such table: social_relay`.
 *
 * The fork point is exactly v18, and mainline v19–v28 are replay-safe against
 * such a database: v19 creates the social tables fresh, v20–v25 add their
 * columns to those fresh tables, v26/v28 are CREATE TABLE IF NOT EXISTS
 * no-ops, and v27 rebuilds the customer-review tables by copying from
 * themselves, which preserves the rows. So the whole repair is to put
 * user_version back to the fork point and let the normal loop run.
 *
 * The signature is deliberately narrow — user_version past the fork, customer
 * review present, social absent — because officially-released databases must
 * not be touched. v1–v21 are byte-identical between desktop-v1.3.2 and today
 * apart from one comment, so a real 1.3.2 install at user_version=21 has the
 * social tables and fails this check, as does any fully-migrated database.
 */
function repairBranchRenumberedSchema(db: Database, current: number): number {
  const FORK_POINT = 18
  // The branch's migration list ended at its own v21, so a database it touched
  // can only be at 19, 20 or 21. Bounding the top end matters: without it the
  // signature also matches synthetic test harnesses that build a customer-review
  // schema at a later user_version without any social tables, and rewinding
  // those would replay migrations they never meant to run.
  const BRANCH_TERMINAL = 21
  if (current <= FORK_POINT || current > BRANCH_TERMINAL) return current
  if (!hasTable(db, 'customer_reviews')) return current
  if (hasTable(db, 'social_echo')) return current
  console.error(
    `[db] user_version=${current} but the social schema is missing and customer-review tables are present — `
    + `this database came from the pre-merge customer-review build (issue #79). `
    + `Rewinding to v${FORK_POINT} and re-applying v${FORK_POINT + 1}+ to restore the missing tables.`,
  )
  db.exec(`PRAGMA user_version = ${FORK_POINT};`)
  return FORK_POINT
}

/**
 * Apply any migrations whose index is greater than the database's current
 * PRAGMA user_version. Exported so tests can drive the runner against a
 * pre-populated in-memory db (e.g. simulating an upgrade from v9).
 */
export function runMigrations(db: Database): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null
  const current = repairBranchRenumberedSchema(db, row?.user_version ?? 0)
  for (let i = current; i < migrations.length; i++) {
    const next = migrations[i]!
    db.transaction(() => {
      next(db)
      // PRAGMA user_version doesn't accept bound params; safe — value is
      // a literal integer index from our own array, not user input.
      db.exec(`PRAGMA user_version = ${i + 1};`)
    })()
  }
}

/** Test helper — opens a fresh in-memory db with all migrations applied. */
export function openTestDb(): Database {
  return openDb({ path: ':memory:' })
}

/**
 * Mark a legacy state file as imported by renaming it to `<file>.migrated`.
 *
 * Concurrent-first-boot safety: when daemon + CLI both boot against a
 * pre-PR7 install, both can pass the `existsSync` gate in their store
 * factories, both run their (idempotent) INSERT OR REPLACE/IGNORE
 * transactions, and both reach the rename. The first wins; the second's
 * `renameSync` would throw ENOENT and propagate as an unhelpful error
 * out of the store constructor. Swallow ENOENT here — the file being
 * gone IS the success state.
 *
 * Other errors (EACCES, ENOSPC, …) still propagate.
 */
export function renameMigrated(file: string): void {
  try {
    renameSync(file, `${file}.migrated`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw err
  }
}
