import type { Migration } from './types'

// v25 — async discovery (spec 2026-07-22-async-discovery-over-mailbox).
// origin_agent_id on social_seen_intent: who SENT us this intent. A relay
// (W) needs it to route a downstream echo onward after a restart — a
// null-origin row (pre-v25) fails closed: the late echo is dropped.
// Nullable-TEXT ADD COLUMN is safe on STRICT; social_seen_intent is
// created unconditionally by v21.
export const migration: Migration = (db) => {
    db.exec(`ALTER TABLE social_seen_intent ADD COLUMN origin_agent_id TEXT;`)
  }
