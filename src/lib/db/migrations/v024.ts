import type { Migration } from './types'

// v24 — 派心愿 propose→confirm (P4). Two nullable columns on social_seek hold
// the redacted wording the owner approved at PROPOSE time; confirmSeek forages
// this stored string verbatim (WYSIWYG — no second gate). The status union
// also gains 'proposed'/'cancelled' but the column has no CHECK constraint, so
// that is a TypeScript-only change (no SQL here). Nullable-TEXT ADD COLUMN is
// safe on the STRICT table; social_seek is created unconditionally by v19.
// See docs/superpowers/specs/2026-07-20-p4-seek-confirm-design.md.
export const migration: Migration = (db) => {
    db.exec(`
      ALTER TABLE social_seek ADD COLUMN redacted_topic TEXT;
      ALTER TABLE social_seek ADD COLUMN redacted_city TEXT;
    `)
  }
