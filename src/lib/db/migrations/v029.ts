import type { Migration } from './types'

// v29 — reminders (ported from the June feat/reminders branch, dcbaf94b;
// spec docs/superpowers/specs/2026-08-20-reminders-port-design.md).
// Per-chat, minute-precise, one-shot reminders delivered by the reminder
// sweeper (src/daemon/reminders). Unlike the companion agenda (day-granular,
// operator-only), due_at is a full ISO 8601 timestamp, any chat_id, and
// pending rows survive restarts. attempts/last_error/last_attempt_at track
// delivery retries — last_attempt_at drives the sweeper's exponential
// backoff (June's every-60s retry violated the no-retry-storm rule).
// The June branch numbered this v15; it lands here as v29 because
// user_version is a COUNT (#79) — body is IF NOT EXISTS, replay-safe.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id              TEXT PRIMARY KEY NOT NULL,
        chat_id         TEXT NOT NULL,
        due_at          TEXT NOT NULL,            -- ISO 8601, full timestamp
        text            TEXT NOT NULL,
        created_at      TEXT NOT NULL,            -- ISO 8601
        status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','sent','cancelled','failed')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        last_attempt_at TEXT                      -- ISO 8601; drives retry backoff
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reminders_status_due ON reminders(status, due_at);
      CREATE INDEX IF NOT EXISTS reminders_chat ON reminders(chat_id, due_at);
    `)
  }
