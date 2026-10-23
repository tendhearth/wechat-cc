import type { Migration } from './types'

// v27 — a user can complete an otherwise-valid commitment through email,
// phone, a client system, or offline. Keep that human fact separate from an
// AI completion inference that has WeChat evidence.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_review_items_v27 (
        review_id        TEXT NOT NULL REFERENCES customer_reviews(id) ON DELETE CASCADE,
        source_key       TEXT NOT NULL,
        commitment       TEXT NOT NULL,
        ai_status        TEXT NOT NULL CHECK (ai_status IN ('open','completed')),
        due_date         TEXT,
        confidence       TEXT NOT NULL CHECK (confidence IN ('medium','high')),
        review_status    TEXT NOT NULL DEFAULT 'unreviewed'
          CHECK (review_status IN ('unreviewed','confirmed','corrected','completed_elsewhere','rejected','ignored')),
        corrected_text   TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (review_id, source_key)
      ) STRICT;
      INSERT INTO customer_review_items_v27
        SELECT review_id, source_key, commitment, ai_status, due_date, confidence,
               review_status, corrected_text, created_at, updated_at
        FROM customer_review_items;

      CREATE TABLE IF NOT EXISTS customer_review_evidence_v27 (
        review_id    TEXT NOT NULL,
        source_key   TEXT NOT NULL,
        evidence_key TEXT NOT NULL,
        role         TEXT NOT NULL CHECK (role IN ('commitment','completion','due_date')),
        message_time TEXT NOT NULL,
        sender_side  TEXT NOT NULL CHECK (sender_side IN ('me','contact')),
        PRIMARY KEY (review_id, source_key, evidence_key, role),
        FOREIGN KEY (review_id, source_key)
          REFERENCES customer_review_items_v27(review_id, source_key) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO customer_review_evidence_v27
        SELECT review_id, source_key, evidence_key, role, message_time, sender_side
        FROM customer_review_evidence;

      CREATE TABLE IF NOT EXISTS customer_review_feedback_v27 (
        contact_id     TEXT NOT NULL,
        source_key     TEXT NOT NULL,
        review_status  TEXT NOT NULL
          CHECK (review_status IN ('confirmed','corrected','completed_elsewhere','rejected','ignored')),
        corrected_text TEXT,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (contact_id, source_key)
      ) STRICT;
      INSERT INTO customer_review_feedback_v27
        SELECT contact_id, source_key, review_status, corrected_text, updated_at
        FROM customer_review_feedback;

      DROP TABLE customer_review_evidence;
      DROP TABLE customer_review_items;
      DROP TABLE customer_review_feedback;
      ALTER TABLE customer_review_items_v27 RENAME TO customer_review_items;
      ALTER TABLE customer_review_evidence_v27 RENAME TO customer_review_evidence;
      ALTER TABLE customer_review_feedback_v27 RENAME TO customer_review_feedback;
      CREATE INDEX IF NOT EXISTS customer_review_items_review_status
        ON customer_review_items(review_id, review_status);
    `)
  }
