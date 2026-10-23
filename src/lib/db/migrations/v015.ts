import type { Migration } from './types'

// v15 — turn_records: per-turn outcome log for daemon observability. One
// row per dispatched turn (solo / each parallel participant / each chatroom
// speaker turn). Survives restart so a daemon hang/crash is diagnosable
// post-mortem ("why did chat X stop replying at HH:MM"). Pruned per-chat by
// the store on append. Mirrors a2a_events (v12).
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE turn_records (
        id TEXT PRIMARY KEY NOT NULL,
        ts TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        alias TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        reply_tool_called INTEGER NOT NULL,
        text_chunks INTEGER NOT NULL,
        error TEXT
      ) STRICT;
      CREATE INDEX turn_records_chat_ts ON turn_records(chat_id, ended_at DESC);
    `)
  }
