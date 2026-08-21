/**
 * Reminders store — per-chat, precise-time one-shot reminders backed by the
 * daemon's SQLite db (migration v29).
 *
 * Contrast with the companion agenda (src/daemon/companion/agenda.ts):
 *   - agenda  : day-granular (due:YYYY-MM-DD), operator-only (default_chat_id),
 *               fire-once-then-resolve, surfaced to the LLM to decide.
 *   - reminders: minute-precise (due_at full ISO), any chat_id, delivered
 *               directly by the sweeper, with retry/attempt tracking.
 *
 * The store is intentionally thin — schedule / cancel / list / listDue /
 * markSent / markFailed. The sweep policy (when to retry vs. give up) lives
 * in the sweeper, not here, so it stays side-effect-free and unit-testable.
 * last_attempt_at drives the sweeper's exponential backoff (spec 2026-08-20 §2.2).
 */
import type { Db } from '../../lib/db'

export type ReminderStatus = 'pending' | 'sent' | 'cancelled' | 'failed'

export interface ReminderRecord {
  id: string             // rmr_<random>
  chat_id: string        // which WeChat user gets this
  due_at: string         // ISO 8601 — full timestamp, not a date
  text: string           // message body to deliver
  created_at: string     // ISO 8601
  status: ReminderStatus
  attempts: number       // delivery attempts so far
  last_error: string | null
  last_attempt_at: string | null
}

export interface RemindersStore {
  /** Insert a pending reminder; returns the generated id. */
  schedule(rec: { chat_id: string; due_at: string; text: string }): Promise<string>
  /** Cancel a pending reminder owned by chatId. Returns true if one was cancelled. */
  cancel(id: string, chatId: string): Promise<boolean>
  /** All reminders for a chat (any status), newest-due first. */
  list(chatId: string): Promise<ReminderRecord[]>
  /** Pending reminders with due_at <= `nowIso`, oldest-due first. */
  listDue(nowIso: string): Promise<ReminderRecord[]>
  /** Mark delivered. */
  markSent(id: string): Promise<void>
  /** Mark permanently failed (retry window exhausted) with a reason. */
  markFailed(id: string, error: string): Promise<void>
  /** Record a transient delivery failure: bump attempts + last_error, stay pending. */
  recordAttempt(id: string, error: string, nowIso: string): Promise<void>
}

interface Row {
  id: string
  chat_id: string
  due_at: string
  text: string
  created_at: string
  status: string
  attempts: number
  last_error: string | null
  last_attempt_at: string | null
}

function rowToRecord(r: Row): ReminderRecord {
  return {
    id: r.id,
    chat_id: r.chat_id,
    due_at: r.due_at,
    text: r.text,
    created_at: r.created_at,
    status: r.status as ReminderStatus,
    attempts: r.attempts,
    last_error: r.last_error,
    last_attempt_at: r.last_attempt_at,
  }
}

function newReminderId(): string {
  return `rmr_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

const COLS = 'id, chat_id, due_at, text, created_at, status, attempts, last_error, last_attempt_at'

export function makeRemindersStore(db: Db): RemindersStore {
  const stmtInsert = db.query<unknown, [string, string, string, string, string]>(
    'INSERT INTO reminders(id, chat_id, due_at, text, created_at, status, attempts, last_error) ' +
    "VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL)",
  )
  // Cancel only pending rows — a reminder already sent/failed can't be cancelled.
  const stmtCancel = db.query<unknown, [string, string]>(
    "UPDATE reminders SET status = 'cancelled' WHERE id = ? AND chat_id = ? AND status = 'pending'",
  )
  const stmtList = db.query<Row, [string]>(
    `SELECT ${COLS} FROM reminders WHERE chat_id = ? ORDER BY due_at DESC`,
  )
  const stmtListDue = db.query<Row, [string]>(
    `SELECT ${COLS} FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC`,
  )
  const stmtMarkSent = db.query<unknown, [string]>(
    "UPDATE reminders SET status = 'sent', attempts = attempts + 1 WHERE id = ?",
  )
  const stmtMarkFailed = db.query<unknown, [string, string]>(
    "UPDATE reminders SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?",
  )
  const stmtRecordAttempt = db.query<unknown, [string, string, string]>(
    'UPDATE reminders SET attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE id = ?',
  )

  return {
    async schedule(rec) {
      const id = newReminderId()
      const created_at = new Date().toISOString()
      stmtInsert.run(id, rec.chat_id, rec.due_at, rec.text, created_at)
      return id
    },
    async cancel(id, chatId) {
      // .run() returns { changes } — the number of rows the UPDATE actually
      // touched. Because stmtCancel's WHERE pins status='pending', a row that
      // is already cancelled/sent/failed yields changes=0, giving idempotent
      // "did THIS call cancel something?" semantics.
      const res = stmtCancel.run(id, chatId) as { changes: number }
      return res.changes > 0
    },
    async list(chatId) {
      return stmtList.all(chatId).map(rowToRecord)
    },
    async listDue(nowIso) {
      return stmtListDue.all(nowIso).map(rowToRecord)
    },
    async markSent(id) {
      stmtMarkSent.run(id)
    },
    async markFailed(id, error) {
      stmtMarkFailed.run(error.slice(0, 500), id)
    },
    async recordAttempt(id, error, nowIso) {
      stmtRecordAttempt.run(error.slice(0, 500), nowIso, id)
    },
  }
}
