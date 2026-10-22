import type { Migration } from './types'

// v13 — events: add `memory_deleted` kind + `memory_path` column for the
// soft-delete audit log (see docs/specs/2026-05-21-memory-delete-safety-design.md).
// Same posture as v8: SQLite can't widen a CHECK in place, so the table
// is rebuilt and the chat-ts index re-created.
export const migration: Migration = (db) => {
    // Guard: some unit-test harnesses start from user_version=9 with only
    // a sessions table — no events table to migrate. Mirrors v11's
    // conversations guard so those targeted-scope tests stay green while
    // real production dbs (which went through v6/v7) take the rebuild path.
    const hasEvents = db
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='events'"
      )
      .get()
    if (!hasEvents || hasEvents.cnt === 0) return
    db.exec(`
      CREATE TABLE events_v13 (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
          'observation_written', 'milestone',
          'memory_deleted'
        )),
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT,
        memory_path TEXT
      ) STRICT;
      INSERT INTO events_v13 (id, chat_id, ts, kind, trigger, reasoning,
                              push_text, observation_id, milestone_id, jsonl_session_id)
        SELECT id, chat_id, ts, kind, trigger, reasoning,
               push_text, observation_id, milestone_id, jsonl_session_id FROM events;
      DROP TABLE events;
      ALTER TABLE events_v13 RENAME TO events;
      CREATE INDEX events_chat_ts ON events(chat_id, ts DESC);
    `)
  }
