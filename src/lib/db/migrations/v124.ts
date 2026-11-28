import type {Migration} from './types'

// v124 — parallel candidates belong to a relay position, with independent workbench tasks.
export const migration: Migration = db=>{
  db.exec(`CREATE TABLE IF NOT EXISTS matter_plan_candidates (
    matter_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
    executor TEXT NOT NULL,
    task_id TEXT UNIQUE REFERENCES matters(id) ON DELETE SET NULL,
    run_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','completed','failed','cancelled','interrupted')),
    result TEXT,
    compared INTEGER NOT NULL DEFAULT 0 CHECK(compared IN (0,1)),
    chosen INTEGER NOT NULL DEFAULT 0 CHECK(chosen IN (0,1)),
    PRIMARY KEY(matter_id,position,ordinal),
    FOREIGN KEY(matter_id,position) REFERENCES matter_plan_legs(matter_id,position) ON DELETE CASCADE
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS matter_plan_candidate_chosen ON matter_plan_candidates(matter_id,position) WHERE chosen=1;`)
}
