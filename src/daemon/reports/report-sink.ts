/**
 * report-sink.ts — the daemon-side ReportSink (src/core/matters/report.ts)
 * that src/core/workbench/service.ts's settleQuiet calls into.
 *
 * Thin glue: look up the matter, ask the pure renderReport whether this turn
 * should be reported at all (no birthplace ⇒ null, handled there — not
 * re-decided here), and if so write the pending row to the outbox for the
 * sweeper (./sweeper.ts) to deliver. taskTitle/artifactCount are narrow reads
 * instead of a full WorkbenchStore so this stays trivially testable.
 */
import type {MatterStore} from '../../core/matters/store'
import {renderReport, type ReportSink} from '../../core/matters/report'
import type {ReportOutboxStore} from './outbox'

export interface ReportSinkDeps {
  matters: MatterStore
  /** Current task title (workbench store's `get(id).title`). */
  taskTitle(taskId: string): string
  /** Artifact count for this task so far (workbench store's `artifacts(id).length`). */
  artifactCount(taskId: string): number
  outbox: ReportOutboxStore
  now?: () => number
  /** Best-effort diagnostics for the rare async insert failure (the sqlite
   *  write itself is synchronous, so this is defense in depth, not the
   *  primary error path — that's the try/catch around opts.reports.enqueue
   *  in service.ts). */
  log?: (tag: string, line: string) => void
}

export function makeReportSink(deps: ReportSinkDeps): ReportSink {
  return {
    enqueue(matterId) {
      const matter = deps.matters.get(matterId)
      if (!matter) return // Defensive: settleQuiet only ever passes a live task's own id.
      const report = renderReport({matter, title: deps.taskTitle(matterId), artifactCount: deps.artifactCount(matterId)})
      if (!report) return // No birthplace — renderReport already decided not to report.
      void deps.outbox.insert(report, deps.now?.() ?? Date.now())
        .catch(err => deps.log?.('MATTER_REPORT', `outbox insert failed for ${matterId}: ${err instanceof Error ? err.message : err}`))
    },
  }
}
