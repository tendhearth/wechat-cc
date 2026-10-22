import type { Migration } from './types'
import { initializeWechatNotificationSchema } from '../schema-helpers'

// v56 — original-account task subscriptions and durable delivery state.
export const migration: Migration = (db) => {
    initializeWechatNotificationSchema(db)
    db.exec(`ALTER TABLE workbench_control_receipts RENAME TO workbench_control_receipts_v52;
      CREATE TABLE workbench_control_receipts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
        run_id TEXT, action TEXT NOT NULL CHECK(action IN ('stop','watch','mute')),
        text_hash TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO workbench_control_receipts SELECT * FROM workbench_control_receipts_v52;
      DROP TABLE workbench_control_receipts_v52;`)
  }
