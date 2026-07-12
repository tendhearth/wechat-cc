/**
 * connection-heartbeat.ts — per-account last-successful-poll timestamp.
 *
 * Records the ISO timestamp of each successful ilink getUpdates poll.
 * Keyed by account.id (the directory id) for consistency with session_state
 * and the doctor report's expiredBots keying.
 *
 * Backed by connection_heartbeat(account_id PK, last_update_ok_at) in the
 * daemon's SQLite db (migration v14). Uses INSERT OR REPLACE (upsert) so
 * each successful poll simply overwrites the previous timestamp.
 */
import type { Db } from '../lib/db'

export interface HeartbeatStore {
  /** Record a successful poll for the given account at the given ISO timestamp. */
  recordOk(accountId: string, iso: string): void
  /** Returns the last successful poll ISO timestamp, or null if never recorded. */
  lastOk(accountId: string): string | null
}

export function makeHeartbeatStore(db: Db): HeartbeatStore {
  const stmtUpsert = db.query<unknown, [string, string]>(
    'INSERT OR REPLACE INTO connection_heartbeat(account_id, last_update_ok_at) VALUES (?, ?)',
  )
  const stmtSelect = db.query<{ last_update_ok_at: string }, [string]>(
    'SELECT last_update_ok_at FROM connection_heartbeat WHERE account_id = ?',
  )

  return {
    recordOk(accountId, iso) {
      stmtUpsert.run(accountId, iso)
    },

    lastOk(accountId) {
      return stmtSelect.get(accountId)?.last_update_ok_at ?? null
    },
  }
}
