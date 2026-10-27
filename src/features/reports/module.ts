/**
 * 回报接进 daemon 的那一份(模块清单在 index.ts):队列 + ReportSink(`report-outbox`,工作台入队要它)和投递那一拍(`reports`)。
 * 只有 daemon-modules.ts import 这个文件。
 */
import { log } from '../../lib/log'
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import type { WiredDeps } from '../../daemon/wiring'
import { reportsFeature, reportSweeperFeature, type ReportsFeature } from './index'

export function reportOutboxModule(f: Foundation): DaemonModule<ReportsFeature> {
  const { db } = f
  return reportsFeature({ needs: [], deps: () => ({ db, matters: f.matters, log: (t, l) => log(t, l) }) })
}

/** 每轮答复回原对话说一声,人不在就等人回来再送(task-3,2026-09-23)。 */
export function reportsModule(): DaemonModule {
  return reportSweeperFeature({ needs: ['wired'], speech: (c) => c.get<WiredDeps>('wired').speech })
}
