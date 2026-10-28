import type { Migration } from './types'

// v8 — tighten events.kind with a CHECK constraint mirroring the
// closed EventKind TS union in src/daemon/events/store.ts. Posture-
// aligned with conversations.mode_kind (which has had its CHECK since
// v3). SQLite's ALTER TABLE can't add a CHECK on an existing column,
// so we recreate the table; rows preserved via INSERT…SELECT, and the
// events_chat_ts index has to be re-created (DROP TABLE drops it too).
// If any pre-existing row has a kind outside the union, the CHECK will
// fail this migration — that's the desired outcome (loud failure beats
// silent drift; the store-side type only narrowed *new* writes).
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE events_new (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
          'observation_written', 'milestone'
        )),
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT
      ) STRICT;
      INSERT INTO events_new SELECT * FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX events_chat_ts ON events(chat_id, ts DESC);
    `)
  }
