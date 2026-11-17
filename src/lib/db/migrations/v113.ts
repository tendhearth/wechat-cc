import type {Migration} from './types'

// v113 — approved sequential relay plans; existing work and ledger rows stay untouched.
export const migration: Migration = db=>{
  db.exec(`CREATE TABLE IF NOT EXISTS matter_plans (
    matter_id TEXT PRIMARY KEY REFERENCES matters(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK(state IN ('approved','cancelled','done')),
    approved_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS matter_plan_legs (
    matter_id TEXT NOT NULL REFERENCES matter_plans(matter_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 6),
    executor TEXT NOT NULL, brief TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','running','completed','stopped')),
    run_id TEXT UNIQUE, auto_dispatches INTEGER NOT NULL DEFAULT 0 CHECK(auto_dispatches>=0),
    stop_reason TEXT,
    PRIMARY KEY(matter_id,position)
  ) STRICT;`)
}
