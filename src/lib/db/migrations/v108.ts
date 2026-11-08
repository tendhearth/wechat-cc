import type { Migration } from './types'

// S4b: persistent reservation shares S2's pending store. Existing lanes and
// payloads are copied without changing their retry or expiry contracts.
export const migration: Migration = (db) => {
  const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='speech_pending'").get()?.sql ?? ''
  if (sql.includes("'reservation'")) return
  db.exec(`
    CREATE TABLE speech_pending_v108 (
      id TEXT PRIMARY KEY,
      lane TEXT NOT NULL CHECK(lane IN ('say','push','reservation')),
      chat_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      attach TEXT,
      ref TEXT,
      created_at INTEGER NOT NULL,
      next_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      first_failed_at INTEGER,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','overflow','reserved','sending','unknown','done'))
    ) STRICT;
    INSERT INTO speech_pending_v108 SELECT * FROM speech_pending;
    DROP TABLE speech_pending;
    ALTER TABLE speech_pending_v108 RENAME TO speech_pending;
    CREATE INDEX speech_pending_lane_chat ON speech_pending(lane,status,chat_id,created_at);
    CREATE INDEX speech_pending_lane_next ON speech_pending(lane,status,next_at);
    CREATE UNIQUE INDEX speech_pending_ref ON speech_pending(lane,ref) WHERE ref IS NOT NULL;
    CREATE UNIQUE INDEX speech_pending_active_recipient ON speech_pending(chat_id)
      WHERE lane='reservation' AND status IN ('reserved','sending');
  `)
}
