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
   * matter_id, it's REUSED (text updated) instead of inserting a second row
   * — otherwise a chatty matter (a few quiet↔busy flaps in one autonomous
   * round, or a chat the owner ignores all day) would accumulate
   * unboundedly (evaluation round 1, review issue ②).
   *
   * Two things a merge must NOT do (evaluation round 2, review issues ③④):
   *   - Reset next_at unconditionally. A row with attempts>0 is mid-backoff
   *     for a REASON (send is failing); an unconditional reset would turn
   *     every re-enqueue into an immediate retry attempt, collapsing the
   *     exponential backoff to ~1/min — backoff is a WeChat risk-control
   *     rule here, not a performance nicety. next_at only jumps to `now`
   *     when attempts===0 (nothing has failed yet, so there's no schedule
   *     to protect).
   *   - Touch more than one row. Before this fix, a matter could already
   *     have accumulated multiple pending rows (dogfood data predates the
   *     ② merge fix); merging into ALL of them would give them all the same
   *     text and next_at, and the sweep would then send that text once per
   *     duplicate row. `insert` always collapses onto the single
   *     lowest-id pending row for a matter and deletes any other pending
   *     duplicates outright (DML, not a schema change — no unique
   *     constraint on matter_id+status exists in v65).
   *
   * `attempts`/`created_at` are never touched by a merge — repeated
   * re-enqueuing must not be a way to dodge the give-up window in
   * sweeper.ts, and created_at anchors that window to the FIRST time this
   * matter's report was queued, not the latest edit. Returns the row id
   * (new or the merged/collapsed existing one).
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
  // The one canonical pending row for a matter, if any — lowest id wins
  // (deterministic; matters if dogfood data has historical duplicates).
  const stmtPendingIdByMatter = db.query<{id: number}, [string]>(
    "SELECT id FROM matter_report_outbox WHERE matter_id = ? AND status = 'pending' ORDER BY id LIMIT 1",
  )
  // Merge into that ONE row by id (not by matter_id — a second matching row
  // must not also be touched). next_at only jumps to `now` when attempts=0
  // (nothing has failed yet); otherwise the existing backoff schedule
  // stands untouched.
  const stmtMergeById = db.query<unknown, [string, number, number]>(
    "UPDATE matter_report_outbox SET text = ?, next_at = CASE WHEN attempts = 0 THEN ? ELSE next_at END WHERE id = ?",
  )
  // Any OTHER pending row for the same matter (historical duplicate from
  // before this fix) collapses away — it would otherwise get the same text
  // stamped onto it too and be sent a second time by the sweeper.
  const stmtDeleteOtherPending = db.query<unknown, [string, number]>(
    "DELETE FROM matter_report_outbox WHERE matter_id = ? AND status = 'pending' AND id <> ?",
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
      const existing = stmtPendingIdByMatter.get(report.matterId)
      if (existing) {
        stmtMergeById.run(report.text, now, existing.id)
        stmtDeleteOtherPending.run(report.matterId, existing.id)
        return existing.id
      }
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
