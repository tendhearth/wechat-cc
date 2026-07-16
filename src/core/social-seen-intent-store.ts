/**
 * social-seen-intent-store.ts — forwarding loop-prevention dedup (spec #2). A
 * relay records each intent_id it has forwarded; a second arrival of the same
 * intent_id (diamond path / cycle) is skipped, not re-forwarded. INSERT OR
 * IGNORE keeps markSeen idempotent on the PK.
 */
import type { Db } from '../lib/db'

export interface SeenIntentRow { intent_id: string; first_seen_at: string; expires_at: string }
export interface SeenIntentStore {
  markSeen(s: { intentId: string; expiresAt: string }): void
  hasSeen(intentId: string): boolean
}

export function makeSeenIntentStore(db: Db): SeenIntentStore {
  const ins = db.query<unknown, [string, string, string]>(
    `INSERT OR IGNORE INTO social_seen_intent(intent_id, first_seen_at, expires_at) VALUES (?, ?, ?)`,
  )
  const sel = db.query<{ one: number }, [string]>('SELECT 1 as one FROM social_seen_intent WHERE intent_id = ?')
  return {
    markSeen(s) { ins.run(s.intentId, new Date().toISOString(), s.expiresAt) },
    hasSeen(intentId) { return sel.get(intentId) != null },
  }
}
