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
  /**
   * When this row FIRST hit a non-(-2) delivery failure (v66; evaluation
   * round 3). Null = it has never really failed yet (either brand new, or
   * every failure so far has been errcode=-2 — the owner just hasn't been
   * back). The give-up window in sweeper.ts is anchored here, not at
   * `createdAt`: `createdAt` keeps advancing through however many -2
   * deferrals happen while the owner is away, so anchoring the window there
   * meant the window could already be spent before the FIRST real failure
   * ever occurred (the exact bug this column fixes).
   */
  firstFailAt: number | null
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
   *     lowest-id pending row for a matter; any OTHER pending row for the
   *     same matter is marked `dropped` (not silently deleted — evaluation
   *     round 3 issue ②: a queue row represents a real delivery intent, and
   *     collapsing it away without a trace made it look like it never
   *     existed). Pure DML either way, not a schema change — no unique
   *     constraint on matter_id+status exists in v65.
   *
   * `attempts`/`created_at`/`first_fail_at` are never touched by a merge —
   * repeated re-enqueuing must not be a way to dodge the give-up window in
   * sweeper.ts (which is anchored at `first_fail_at`, v66 — see
   * OutboxRecord's doc comment for why `created_at` doesn't work). Returns
   * the row id (new or the merged/collapsed existing one).
   */
  insert(report: PendingReport, now: number): Promise<number>
  /** Pending rows with next_at <= now, oldest-due first. */
  listDue(now: number): Promise<OutboxRecord[]>
  /** Mark delivered. */
  markSent(id: number): Promise<void>
  /** Mark a permanent failure (e.g. origin chat no longer bound) — never retried. */
  markDropped(id: number): Promise<void>
  /**
   * Record a transient delivery failure: bump attempts, reschedule next_at,
   * stay pending. `firstFailureAt`, when given, sets `first_fail_at` ONLY if
   * it isn't already set (`COALESCE(first_fail_at, ?)` — first write wins,
   * later calls are no-ops on this column). Callers pass it for non-(-2)
   * failures only; the errcode=-2 path omits it so -2 deferrals never start
   * (or advance) the give-up-window clock.
   */
  recordAttempt(id: number, nextAt: number, firstFailureAt?: number): Promise<void>
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
  first_fail_at: number | null
}

const COLS = 'id, matter_id, origin_matter_id, origin_message_id, text, status, attempts, next_at, created_at, first_fail_at'

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
    firstFailAt: r.first_fail_at,
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
  // before the ② merge fix) is marked dropped, not deleted — it would
  // otherwise get the same text stamped onto it too and be sent a second
  // time by the sweeper, and a silent DELETE leaves no trace that a real
  // queued delivery intent ever existed (evaluation round 3 issue ②).
  const stmtDropOtherPending = db.query<unknown, [string, number]>(
    "UPDATE matter_report_outbox SET status = 'dropped' WHERE matter_id = ? AND status = 'pending' AND id <> ?",
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
  // COALESCE means "first write wins": if first_fail_at is already set, the
  // second (and third, ...) call leaves it untouched. Passing null for the
  // -2 path is a genuine no-op on this column — COALESCE(x, NULL) = x.
  const stmtRecordAttempt = db.query<unknown, [number, number | null, number]>(
    'UPDATE matter_report_outbox SET attempts = attempts + 1, next_at = ?, first_fail_at = COALESCE(first_fail_at, ?) WHERE id = ?',
  )

  return {
    async insert(report, now) {
      const existing = stmtPendingIdByMatter.get(report.matterId)
      if (existing) {
        stmtMergeById.run(report.text, now, existing.id)
        stmtDropOtherPending.run(report.matterId, existing.id)
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
    async recordAttempt(id, nextAt, firstFailureAt) {
      stmtRecordAttempt.run(nextAt, firstFailureAt ?? null, id)
    },
  }
}
