import type {Migration} from './types'

// v112 — one short ledger per matter; batons reuse workbench runs and sessions.
export const migration: Migration = db=>{
  db.exec(`CREATE TABLE IF NOT EXISTS matter_agents (
    matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL UNIQUE, executor TEXT NOT NULL, brief TEXT NOT NULL,
    position INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),
    created_at INTEGER NOT NULL, ended_at INTEGER, injected_at INTEGER,
    PRIMARY KEY(matter_id,position)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS matter_notes (
    id INTEGER PRIMARY KEY, matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
    run_id TEXT, author TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('plan','note','artifact')),
    text TEXT NOT NULL, created_at INTEGER NOT NULL,
    entry_key TEXT, UNIQUE(matter_id,entry_key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS matter_notes_order ON matter_notes(matter_id,id);`)
}
