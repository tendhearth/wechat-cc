/**
 * social-seen-intent-store.ts — forwarding loop-prevention dedup (spec #2). A
 * relay records each intent_id it has forwarded; a second arrival of the same
 * intent_id (diamond path / cycle) is skipped, not re-forwarded. INSERT OR
 * IGNORE keeps markSeen idempotent on the PK.
 */
import type { Db } from '../lib/db'

// Server-side dedup retention window — deliberately INDEPENDENT of the
// peer-supplied card `expires_at` (the inbound /a2a/intent schema only
// requires a non-empty string for it, so it is attacker-controlled). If
// pruning were driven by the card's expires_at, a malicious paired peer
// could send a card whose expires_at is already in the past: markSeen would
// insert the row and immediately prune it, so hasSeen would never observe
// it as seen, and resubmitting the same intent_id would re-trigger a full
// forward fan-out (up to 5 peers) on every POST — a DoS amplification. 1h
// is comfortably larger than the broker's ~10-min card TTL, so it dedups
// every intent that could still be legitimately in flight.
const SEEN_RETENTION_MS = 60 * 60 * 1000

export interface SeenIntentRow { intent_id: string; first_seen_at: string; expires_at: string }
export interface SeenIntentStore {
  markSeen(s: { intentId: string; expiresAt: string }): void
  hasSeen(intentId: string): boolean
}

export function makeSeenIntentStore(db: Db): SeenIntentStore {
  const ins = db.query<unknown, [string, string, string]>(
    `INSERT OR IGNORE INTO social_seen_intent(intent_id, first_seen_at, expires_at) VALUES (?, ?, ?)`,
  )
  const sel = db.query<{ one: number }, [string]>(
    'SELECT 1 as one FROM social_seen_intent WHERE intent_id = ?',
  )
  const prune = db.query<unknown, [string]>('DELETE FROM social_seen_intent WHERE first_seen_at < ?')
  return {
    markSeen(s) {
      const now = new Date().toISOString()
      ins.run(s.intentId, now, s.expiresAt)
      prune.run(new Date(Date.now() - SEEN_RETENTION_MS).toISOString())
    },
    hasSeen(intentId) { return sel.get(intentId) != null },
  }
}
