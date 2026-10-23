import type { Migration } from './types'

// v31 — widen events.kind CHECK with 'config_changed' (config-surface
// audit: every successful config_set MCP write lands one row, mirroring
// memory_deleted's audit posture). Same rebuild dance as v8: SQLite can't
// widen a CHECK in place, so copy → drop → rename → reindex. Same
// hasEvents guard as the previous widening — unit-test harnesses that
// start mid-chain may not have an events table yet.
export const migration: Migration = (db) => {
    const hasEvents = db
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='events'"
      )
      .get()
    if (!hasEvents || hasEvents.cnt === 0) return
    db.exec(`
      CREATE TABLE events_new (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
          'observation_written', 'milestone',
          'memory_deleted', 'threads_extracted', 'config_changed'
        )),
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT,
        memory_path TEXT
      ) STRICT;
      INSERT INTO events_new
        SELECT id, chat_id, ts, kind, trigger, reasoning,
               push_text, observation_id, milestone_id, jsonl_session_id, memory_path
        FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX events_chat_ts ON events(chat_id, ts DESC);
    `)
  }
