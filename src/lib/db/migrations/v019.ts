import type { Migration } from './types'

// agent-social 觅食台 state (M2 P1): persisted seeks + echoes so the
// desktop forager's-desk has queryable state. See
// docs/superpowers/specs/2026-07-15-forage-desk-agent-page-design.md.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS social_seek (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,          -- 'seek' | 'fun'
        topic        TEXT NOT NULL,
        status       TEXT NOT NULL,          -- 'foraging' | 'echoed' | 'connected' | 'closed'
        hop          INTEGER NOT NULL DEFAULT 1,
        peers_asked  INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS social_echo (
        id           TEXT PRIMARY KEY,
        seek_id      TEXT NOT NULL,
        peer_masked  TEXT NOT NULL,          -- e.g. "第 1 度的某人"
        degree       INTEGER NOT NULL DEFAULT 1,
        content      TEXT NOT NULL,
        status       TEXT NOT NULL,          -- 'pending' | 'revealed' | 'declined'
        created_at   TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_social_echo_seek ON social_echo(seek_id);
    `)
  }
