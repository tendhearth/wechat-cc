import type { Migration } from './types'

// v20 — async foraging spine. Adds the reveal columns to social_echo (the
// seeker's side) + the social_pledge table (the answerer's mirror side) so
// dual-confirm can move OUT of the seek broker call into a durable, row-driven,
// restart-survivable mutual reveal. Nullable-TEXT ADD COLUMN is safe on a
// STRICT table; social_echo is created unconditionally by v19 above, so no
// table-exists guard is needed even for the user_version=9 test harnesses.
// See docs/superpowers/specs/2026-07-15-async-foraging-spine-design.md.
export const migration: Migration = (db) => {
    db.exec(`
      ALTER TABLE social_echo ADD COLUMN peer_agent_id TEXT;
      ALTER TABLE social_echo ADD COLUMN self_revealed_at TEXT;
      ALTER TABLE social_echo ADD COLUMN peer_revealed_at TEXT;
      CREATE TABLE IF NOT EXISTS social_pledge (
        id                TEXT PRIMARY KEY,
        intent_id         TEXT NOT NULL,
        seeker_agent_id   TEXT NOT NULL,      -- who sought (POST back their /a2a/reveal)
        topic             TEXT NOT NULL,
        self_revealed_at  TEXT,               -- when THIS owner revealed (nullable)
        peer_revealed_at  TEXT,               -- when the seeker revealed (nullable)
        created_at        TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_social_pledge_intent ON social_pledge(intent_id);
    `)
  }
