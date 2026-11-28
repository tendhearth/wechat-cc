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
    chosen INTEGER NOT NULL DEFAULT 0 CHECK(chosen IN (0,1)),
    PRIMARY KEY(matter_id,position,ordinal),
    FOREIGN KEY(matter_id,position) REFERENCES matter_plan_legs(matter_id,position) ON DELETE CASCADE
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS matter_plan_candidate_chosen ON matter_plan_candidates(matter_id,position) WHERE chosen=1;
  CREATE TABLE IF NOT EXISTS matter_plan_comparisons (
    matter_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    text TEXT,
    enqueued INTEGER NOT NULL DEFAULT 0 CHECK(enqueued IN (0,1)),
    dispatch_pending INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_pending IN (0,1)),
    PRIMARY KEY(matter_id,position),
    FOREIGN KEY(matter_id,position) REFERENCES matter_plan_legs(matter_id,position) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS matter_plan_choice_receipts (
    request_id TEXT PRIMARY KEY,
    command_hash TEXT NOT NULL,
    task_id TEXT,
    reply TEXT NOT NULL
  ) STRICT;`)
  const columns=db.query<{name:string},[]>('PRAGMA table_info(matter_report_outbox)').all()
  if(!columns.some(c=>c.name==='comparison_position'))db.exec('ALTER TABLE matter_report_outbox ADD COLUMN comparison_position INTEGER')
  if(!columns.some(c=>c.name==='comparison_revision'))db.exec('ALTER TABLE matter_report_outbox ADD COLUMN comparison_revision INTEGER')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS matter_report_comparison ON matter_report_outbox(matter_id,comparison_position,comparison_revision) WHERE comparison_position IS NOT NULL')
}
