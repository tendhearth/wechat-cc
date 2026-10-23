import type { Migration } from './types'

// v30 — cross-session FTS (the "SQLite FTS upgrade tracked for v0.5" from
// sessions/searcher.ts, landed by 2026-08-23-memory-upgrades). One FTS5
// trigram row per session-jsonl line (trigram matches CJK the way
// knowledge/semantic.db's chunks_fts already does); alias/session_id/
// turn_index are UNINDEXED payload for hit resolution. session_fts_state
// tracks the per-file incremental watermark (lines_indexed) plus byte_size
// so a truncated/rewritten transcript triggers a from-scratch reindex.
// FTS5 virtual tables cannot be STRICT; the state table is.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_turns_fts USING fts5(
        text, alias UNINDEXED, session_id UNINDEXED, turn_index UNINDEXED,
        tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS session_fts_state (
        path          TEXT PRIMARY KEY NOT NULL,
        alias         TEXT NOT NULL,
        session_id    TEXT NOT NULL,
        lines_indexed INTEGER NOT NULL,
        byte_size     INTEGER NOT NULL
      ) STRICT;
    `)
  }
