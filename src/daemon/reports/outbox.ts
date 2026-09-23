/**
 * Report outbox store — the delivery queue backing matter_report_outbox
 * (migration v65, src/lib/db.ts).
 *
 * This is NOT where the report's "trace" lives — that stays in the origin
 * conversation's own message flow (spec's Option A, no new source of truth).
 * This table only tracks DELIVERY: pending / attempts / next_at, plus the
 * exact text to resend verbatim if a retry is needed. Contrast with
 * src/daemon/reminders/store.ts, which this mirrors structurally.
 */
import type {Db} from '../../lib/db'
import type {PendingReport} from '../../core/matters/report'

export type OutboxStatus = 'pending' | 'sent' | 'dropped'

export interface OutboxRecord {
  id: number
  matterId: string
  originMatterId: string
  originMessageId: string | null
  text: string
  status: OutboxStatus
  attempts: number
  nextAt: number
  createdAt: number
}

export interface ReportOutboxStore {
  /**
   * Enqueue a report for delivery. If a pending row already exists for this
   * matter_id, its text is UPDATED in place (and next_at reset to `now`,
   * so the freshest content gets first crack at the next sweep) instead of
   * inserting a second row — otherwise a chatty matter (a few quiet↔busy
   * flaps in one autonomous round, or a chat the owner ignores all day)
   * would accumulate unboundedly. `attempts` is left untouched by a merge
   * — repeated re-enqueuing must not be a way to dodge the give-up cap in
   * sweeper.ts (evaluation round 1, review issues ①②). Returns the row id
   * (new or the merged existing one).
   */
  insert(report: PendingReport, now: number): Promise<number>
  /** Pending rows with next_at <= now, oldest-due first. */
  listDue(now: number): Promise<OutboxRecord[]>
  /** Mark delivered. */
  markSent(id: number): Promise<void>
  /** Mark a permanent failure (e.g. origin chat no longer bound) — never retried. */
  markDropped(id: number): Promise<void>
  /** Record a transient delivery failure: bump attempts, reschedule next_at, stay pending. */
  recordAttempt(id: number, nextAt: number): Promise<void>
}

interface Row {
  id: number
  matter_id: string
  origin_matter_id: string
  origin_message_id: string | null
  text: string
  status: string
  attempts: number
  next_at: number
  created_at: number
}

const COLS = 'id, matter_id, origin_matter_id, origin_message_id, text, status, attempts, next_at, created_at'

function rowToRecord(r: Row): OutboxRecord {
  return {
    id: r.id,
    matterId: r.matter_id,
    originMatterId: r.origin_matter_id,
    originMessageId: r.origin_message_id,
    text: r.text,
    status: r.status as OutboxStatus,
    attempts: r.attempts,
    nextAt: r.next_at,
    createdAt: r.created_at,
  }
}

export function makeReportOutboxStore(db: Db): ReportOutboxStore {
  const stmtInsert = db.query<{id: number}, [string, string, string | null, string, number, number]>(
    "INSERT INTO matter_report_outbox(matter_id, origin_matter_id, origin_message_id, text, status, attempts, next_at, created_at) "
    + "VALUES (?, ?, ?, ?, 'pending', 0, ?, ?) RETURNING id",
  )
  // Merge target: a pending row for the same matter. Text + next_at only —
  // attempts and origin_matter_id/origin_message_id (fixed for a matter's
  // lifetime) are untouched.
  const stmtMergeExisting = db.query<unknown, [string, number, string]>(
    "UPDATE matter_report_outbox SET text = ?, next_at = ? WHERE matter_id = ? AND status = 'pending'",
  )
  const stmtPendingIdByMatter = db.query<{id: number}, [string]>(
    "SELECT id FROM matter_report_outbox WHERE matter_id = ? AND status = 'pending' ORDER BY id LIMIT 1",
  )
  const stmtListDue = db.query<Row, [number]>(
    `SELECT ${COLS} FROM matter_report_outbox WHERE status = 'pending' AND next_at <= ? ORDER BY next_at ASC, id ASC`,
  )
  // Status-guarded like reminders' markSent: a row that raced to 'dropped' (or
  // was already sent) must not flip back to 'sent'.
  const stmtMarkSent = db.query<unknown, [number]>(
    "UPDATE matter_report_outbox SET status = 'sent' WHERE id = ? AND status = 'pending'",
  )
  const stmtMarkDropped = db.query<unknown, [number]>(
    "UPDATE matter_report_outbox SET status = 'dropped' WHERE id = ? AND status = 'pending'",
  )
  const stmtRecordAttempt = db.query<unknown, [number, number]>(
    'UPDATE matter_report_outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?',
  )

  return {
    async insert(report, now) {
      const merged = stmtMergeExisting.run(report.text, now, report.matterId) as {changes: number}
      if (merged.changes > 0) return stmtPendingIdByMatter.get(report.matterId)!.id
      const row = stmtInsert.get(report.matterId, report.originMatterId, report.originMessageId, report.text, now, now)
      return row!.id
    },
    async listDue(now) {
      return stmtListDue.all(now).map(rowToRecord)
    },
    async markSent(id) {
      stmtMarkSent.run(id)
    },
    async markDropped(id) {
      stmtMarkDropped.run(id)
    },
    async recordAttempt(id, nextAt) {
      stmtRecordAttempt.run(nextAt, id)
    },
  }
}
