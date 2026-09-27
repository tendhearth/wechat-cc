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
  /**
   * 这个 task 的微信提醒开着吗(workbench store 的
   * `wechatNotifications.subscription(id)?.enabled ?? true` —— 没有订阅
   * 记录就是没静音过,默认开)。终审 Critical:「任务 <id> 静音」之后回
   * 报照发,而机器人明说已关——这条路以前从不读这张表。闸放在 enqueue
   * 这一侧,不是发送侧:静音的意思是"别产生噪音",放在发送侧会让 outbox
   * 堆积永远没有消费者的行。
   */
  notificationsEnabled(taskId: string): boolean
  now?: () => number
  /** Best-effort diagnostics for the rare async insert failure (the sqlite
   *  write itself is synchronous, so this is defense in depth, not the
   *  primary error path — that's the try/catch around opts.reports.enqueue
   *  in service.ts). */
  log?: (tag: string, line: string) => void
}

export function makeReportSink(deps: ReportSinkDeps): ReportSink {
  return {
    enqueue(matterId, turn, body) {
      const matter = deps.matters.get(matterId)
      if (!matter) {
        // 终审 Important:这不是预期路径——桌面任务是下一行 renderReport
        // (没有出生地)过滤掉的,不是在这里。matter 建的时候 m.create
        // 抛过一次(STRICT/CHECK 违规、磁盘满、FK)就会落到这一支,而
        // matterSync(service.ts)吞掉了那次失败——不留这条日志,主人会
        // 永久收不到回报、且没有任何地方说明原因。
        deps.log?.('MATTER_REPORT', `enqueue skipped for ${matterId}: no matter row (unexpected — matterSync may have swallowed a create failure)`)
        return
      }
      if (!deps.notificationsEnabled(matterId)) {
        // 主人说过「静音」——闸在这里,不在发送侧;不留任何一行回报,连
        // outbox 都不进(静音的意思就是别产生噪音)。留一条日志方便运维
        // 核对"这轮为什么没报",不算错误。
        deps.log?.('MATTER_REPORT', `enqueue skipped for ${matterId}: wechat notifications muted`)
        return
      }
      const report = renderReport({matter, title: deps.taskTitle(matterId), artifactCount: deps.artifactCount(matterId), turn, body})
      if (!report) return // No birthplace — renderReport already decided not to report.
      void deps.outbox.insert(report, deps.now?.() ?? Date.now())
        .catch(err => deps.log?.('MATTER_REPORT', `outbox insert failed for ${matterId}: ${err instanceof Error ? err.message : err}`))
    },
  }
}
