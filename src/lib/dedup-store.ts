/**
 * dedup store — records which inbound messages have been FULLY processed
 * (reply sent / command consumed), so a redelivery of the same message is
 * not handled twice.
 *
 * Why this exists: the long-poll cursor (sync_buf) is at-least-once by design
 * — a crash (or, on macOS, a sleep/wake that restarts the daemon or lets a
 * second instance steal the lock) can load a sync_buf older than the last
 * answered message, and the ilink server then redelivers it. The messages
 * table dedups the conversation-log ROW (INSERT OR IGNORE) but does not stop
 * the agent from running again. This table is the processing-level guard.
 *
 * It is written only AFTER the inbound pipeline settles without throwing — so
 * a message whose first turn crashed mid-reply is intentionally absent here
 * and gets reprocessed on redelivery (at-least-once → effectively-once for
 * completed turns, preserving crash recovery for incomplete ones).
 */
import type { Db } from './db'

export interface DedupStore {
  /** True iff this message id has already been fully processed. */
  isHandled(id: string): boolean
  /** Mark a message id as fully processed. Idempotent on id. */
  markHandled(id: string, atIso: string): void
  /**
   * Record one processing attempt for a message id, returning the new total
   * attempt count (1 on first call). Persists across restarts so mw-dedup can
   * give up on a "poison" message that keeps throwing instead of reprocessing
   * it forever.
   */
  recordAttempt(id: string, atIso: string): number
}

export function makeDedupStore(db: Db): DedupStore {
  const stmtHas = db.query<{ one: number }, [string]>(
    'SELECT 1 AS one FROM handled_messages WHERE id = ? LIMIT 1',
  )
  const stmtMark = db.query<unknown, [string, string]>(
    'INSERT OR IGNORE INTO handled_messages(id, handled_at) VALUES (?, ?)',
  )
  const stmtAttempt = db.query<{ attempts: number }, [string, string]>(
    `INSERT INTO message_attempts(id, attempts, first_seen) VALUES (?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1
     RETURNING attempts`,
  )
  return {
    isHandled(id) {
      return stmtHas.get(id) !== null
    },
    markHandled(id, atIso) {
      stmtMark.run(id, atIso)
    },
    recordAttempt(id, atIso) {
      return stmtAttempt.get(id, atIso)?.attempts ?? 1
    },
  }
}
