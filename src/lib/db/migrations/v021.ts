import type { Migration } from './types'

// v21 — forwarding hop (spec #2). Two nullable relay columns on social_echo
// (the seeker's degree-2 echoes) + the intermediary's social_relay table
// (links the two proxied reveal legs) + social_seen_intent (loop-prevention
// dedup). Nullable-TEXT ADD COLUMN is safe on STRICT; social_echo is created
// unconditionally by v19, so the ALTER is safe even in user_version=9 harnesses.
// See docs/superpowers/specs/2026-07-15-forwarding-hop-design.md.
export const migration: Migration = (db) => {
    db.exec(`
      ALTER TABLE social_echo ADD COLUMN relay_via TEXT;
      ALTER TABLE social_echo ADD COLUMN relay_token TEXT;
      CREATE TABLE IF NOT EXISTS social_relay (
        id                     TEXT PRIMARY KEY,   -- intent_id:relay_token
        intent_id              TEXT NOT NULL,
        relay_token            TEXT NOT NULL,
        upstream_agent_id      TEXT NOT NULL,       -- who W received the card from (the seeker S)
        downstream_agent_id    TEXT NOT NULL,       -- who W forwarded to + got the yes from (Q)
        upstream_revealed_at   TEXT,                -- S revealed to W (nullable)
        downstream_revealed_at TEXT,                -- Q revealed to W (nullable)
        created_at             TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_social_relay_intent_downstream ON social_relay(intent_id, downstream_agent_id);
      CREATE TABLE IF NOT EXISTS social_seen_intent (
        intent_id     TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL,
        expires_at    TEXT NOT NULL
      ) STRICT;
    `)
  }
