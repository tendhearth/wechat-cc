import type { Migration } from './types'

// v11 — participants column on conversations (N-way modes, P3).
// Nullable JSON-encoded TEXT array of provider ids. NULL on pre-v11 rows
// (legacy 2-way parallel/chatroom); the coordinator's resolveParticipants
// helper backfills these to the first-two-registered providers on first
// dispatch under the new code so the user's "this chat was 2-way"
// expectation is preserved. New explicit /chat <p1> <p2> ... commands
// write the list directly.
// See docs/superpowers/specs/2026-05-23-n-way-modes-design.md.
export const migration: Migration = (db) => {
    // Guard: unit-test harnesses that start from user_version=9 (sessions-only
    // schema) will reach this migration without a conversations table. The
    // guard keeps those pre-existing v10 tests green while still applying the
    // column in every real database that went through the full migration chain.
    const has = db
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='conversations'"
      )
      .get()
    if (has && has.cnt > 0) {
      db.exec(`ALTER TABLE conversations ADD COLUMN participants TEXT;`)
    }
  }
