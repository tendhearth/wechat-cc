/**
 * 回报(task-3,2026-09-23)—— 每轮答复回那次交办它的对话说一声,人不在就等人回来再送。一个功能一个目录(架构终态 A5)。
 *
 *  - `outbox.ts`:投递队列 matter_report_outbox(v65 / v66)的读写;
 *  - `report-sink.ts`:工作台 settleQuiet 那一拍调的 ReportSink(口在 core/matters/report.ts),判断要不要报、写进队列;
 *  - `sweeper.ts`:每分钟一拍把到点的回报经 CC 开口那道门送出去(退避、放弃窗口、粗闸降噪);
 *  - 这个文件:两个模块 ——
 *    `report-outbox`(必需):队列 + ReportSink,工作台 needs 它(工作台开在 wired 之前,所以它得更早);
 *      搬家前队列在地基里造,造不出来照样挡开机,所以是必需的;
 *    `reports`(可选):投递那一拍,要 wired(CC 开口那道门)起来以后才开动,坏了只降级 ——
 *      名字、位置都跟搬家前一样(/v1/health.subsystems、关机顺序快照不变)。
 * 它要的东西(`ReportsFeatureDeps`)由同目录的 `module.ts`(接进 daemon 的那一份)从上游模块里填。
 */
import type { Db } from '../../lib/db'
import type { Lifecycle } from '../../lib/lifecycle'
import type { ReportSink } from '../../domain/matters/report'
import type { MatterStore } from '../../ports/matters'
import { makeWorkbenchStore } from '../../adapters/store/workbench/store'
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import { lifecycleModule } from '../../daemon/modules/lifecycle-module'
import type { SpeechPolicy } from '../../daemon/speech/policy'
import { makeReportOutboxStore } from './outbox'
import { makeReportSink } from './report-sink'
import { registerReportSweeper, sendReportVia } from './sweeper'

export { makeReportOutboxStore, type ReportOutboxStore } from './outbox'
export { makeReportSink } from './report-sink'

export interface ReportsFeature {
  /** 工作台入队回报用的那一个(类型是 core 的口)。 */
  sink: ReportSink
  /** 开动投递那一拍(`reports` 模块在 start 段调)。 */
  startSweeper(speech: SpeechPolicy): Lifecycle
}

export interface ReportsFeatureDeps {
  db: Db
  /** 「一件事」登记处(地基里那一份):找出生地、找要回的那个对话。 */
  matters: MatterStore
  log: (tag: string, line: string) => void
}

export function reportsFeature(o: { needs: readonly string[]; deps: (ctx: ModuleCtx) => ReportsFeatureDeps }): DaemonModule<ReportsFeature> {
  return {
    name: 'report-outbox',
    needs: o.needs,
    init: (ctx) => makeReports(o.deps(ctx)),
  }
}

/** 模块 init 造的那一套(导出给接线测试:工作台 + 真的 ReportSink + 真的队列端到端)。 */
export function makeReports(d: ReportsFeatureDeps): ReportsFeature {
  const outbox = makeReportOutboxStore(d.db)
  // 独立的一份 WorkbenchStore(同一个 db,写入互相可见;它只是 db 上的一层查询):回报读任务标题 / 成果数 / 静音,
  // 「放弃投递」在那件事自己的时间线上留一笔。
  const store = makeWorkbenchStore(d.db)
  const sink = makeReportSink({
    matters: d.matters, outbox,
    taskTitle: id => store.get(id).title, artifactCount: id => store.artifacts(id).length,
    // 终审 Critical:「任务 <id> 静音」落的是 workbench_wechat_subscriptions.enabled=0;
    // 没有订阅记录(从没配置过)按"没静音过"处理,不是默认静音。
    notificationsEnabled: id => store.wechatNotifications.subscription(id)?.enabled ?? true,
    log: d.log,
  })
  return {
    sink,
    startSweeper: (speech) => registerReportSweeper({
      store: outbox,
      matters: d.matters,
      send: sendReportVia(speech),
      log: d.log,
      noteAbandoned: (matterId, text) => {
        try { store.addEvent(matterId, 'system', text) } catch { /* best effort — the drop itself already succeeded */ }
      },
    }),
  }
}

/** 投递那一拍(可选):要 wired(CC 开口那道门)起来以后才开动。 */
export function reportSweeperFeature(o: { needs: readonly string[]; speech: (ctx: ModuleCtx) => SpeechPolicy }): DaemonModule {
  return lifecycleModule('reports', (ctx) => ctx.get<ReportsFeature>('report-outbox').startSweeper(o.speech(ctx)), { needs: ['report-outbox', ...o.needs] })
}
