import type { Migration } from './types'

// v14 — dialogue real data: canonical messages store, topic threads,
// extraction watermark; events gains 'threads_extracted' kind (CHECK
// constraints can't be altered in SQLite → rebuild events in place).
// Spec: docs/superpowers/specs/2026-06-11-dialogue-real-data-design.md
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id        TEXT PRIMARY KEY NOT NULL,
        chat_id   TEXT NOT NULL,
        ts        TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        kind      TEXT NOT NULL DEFAULT 'text',
        text      TEXT NOT NULL,
        provider  TEXT,
        source    TEXT NOT NULL DEFAULT 'live'
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);

      CREATE TABLE IF NOT EXISTS threads (
        id          TEXT PRIMARY KEY NOT NULL,
        chat_id     TEXT NOT NULL,
        title       TEXT NOT NULL,
        summary     TEXT NOT NULL DEFAULT '',
        facets      TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        private     INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','done')),
        episodes    TEXT NOT NULL DEFAULT '[]',
        created_ts  TEXT NOT NULL,
        last_active TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_threads_chat ON threads(chat_id, last_active);

      CREATE TABLE IF NOT EXISTS thread_extract_state (
        chat_id         TEXT PRIMARY KEY NOT NULL,
        extracted_to_ts TEXT NOT NULL
      ) STRICT;
    `)
    // events CHECK rebuild: create new → copy → rename. Column set matches the existing schema; only the kind set widens.
    // Guard: some unit-test harnesses skip the full migration chain and may
    // not have an events table (mirrors v11/v13 guard posture).
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
          'memory_deleted', 'threads_extracted'
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
