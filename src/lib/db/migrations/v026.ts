import type { Migration } from './types'

// v26 — customer review tasks, grounded commitment candidates, evidence
// references, and durable user feedback overlays. Raw WeChat message text is
// deliberately NOT stored here; evidence rows only keep the app-generated
// key, timestamp, sender side, and role so the UI can re-read source content
// from wxvault on demand.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_reviews (
        id                   TEXT PRIMARY KEY NOT NULL,
        contact_id           TEXT NOT NULL,
        contact_display_name TEXT NOT NULL,
        range_from           TEXT NOT NULL,
        range_to             TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (status IN ('queued','analyzing','ready','failed')),
        provider             TEXT NOT NULL,
        model                TEXT,
        source_message_count INTEGER NOT NULL DEFAULT 0,
        source_first_at      TEXT,
        source_last_at       TEXT,
        error_code           TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        completed_at         TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS customer_reviews_contact_created
        ON customer_reviews(contact_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS customer_review_items (
        review_id        TEXT NOT NULL REFERENCES customer_reviews(id) ON DELETE CASCADE,
        source_key       TEXT NOT NULL,
        commitment       TEXT NOT NULL,
        ai_status        TEXT NOT NULL CHECK (ai_status IN ('open','completed')),
        due_date         TEXT,
        confidence       TEXT NOT NULL CHECK (confidence IN ('medium','high')),
        review_status    TEXT NOT NULL DEFAULT 'unreviewed'
          CHECK (review_status IN ('unreviewed','confirmed','corrected','rejected','ignored')),
        corrected_text   TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (review_id, source_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS customer_review_items_review_status
        ON customer_review_items(review_id, review_status);

      CREATE TABLE IF NOT EXISTS customer_review_evidence (
        review_id    TEXT NOT NULL,
        source_key   TEXT NOT NULL,
        evidence_key TEXT NOT NULL,
        role         TEXT NOT NULL CHECK (role IN ('commitment','completion','due_date')),
        message_time TEXT NOT NULL,
        sender_side  TEXT NOT NULL CHECK (sender_side IN ('me','contact')),
        PRIMARY KEY (review_id, source_key, evidence_key, role),
        FOREIGN KEY (review_id, source_key)
          REFERENCES customer_review_items(review_id, source_key) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS customer_review_feedback (
        contact_id     TEXT NOT NULL,
        source_key     TEXT NOT NULL,
        review_status  TEXT NOT NULL
          CHECK (review_status IN ('confirmed','corrected','rejected','ignored')),
        corrected_text TEXT,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (contact_id, source_key)
      ) STRICT;
    `)
  }
