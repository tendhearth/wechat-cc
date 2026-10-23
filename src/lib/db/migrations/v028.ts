import type { Migration } from './types'

// v28 — analysis coverage metadata. Long histories can yield a grounded
// partial result while one model window remains untrusted; persist only the
// uncovered time span and safe error code, never raw chat text.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_review_analysis_issues (
        review_id    TEXT NOT NULL REFERENCES customer_reviews(id) ON DELETE CASCADE,
        window_index INTEGER NOT NULL,
        range_from   TEXT NOT NULL,
        range_to     TEXT NOT NULL,
        error_code   TEXT NOT NULL,
        attempts     INTEGER NOT NULL CHECK (attempts >= 1 AND attempts <= 3),
        PRIMARY KEY (review_id, window_index)
      ) STRICT;
    `)
  }
