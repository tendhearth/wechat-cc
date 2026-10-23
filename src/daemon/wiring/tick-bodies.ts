/**
 * Companion scheduler tick bodies —— 四拍的组装处:ingestTick(25 分钟)、pushTick(20 分钟)、introspectTick(24 小时)、
 * runJobTurn(定时任务)。每一拍的身体在各自的 tick-*.ts 里;推送和定时共用 tick-dispatch 的那一步。
 */
import type { TickDeps } from './tick-deps'
import { JOB_PROVIDERS, makeRunJobTurn, type JobTurnResult } from './tick-job'
import type { TickTextStyle } from './tick-texts'
import { makeTickDispatch } from './tick-dispatch'
import { makeIngestTick } from './tick-ingest'
import { makePushTick } from './tick-push'
import { makeIntrospectTick } from './tick-introspect'

// 2026-10-22 按生产者拆成 tick-*.ts(第三批 3a 顺带项);这里只剩组装,原有的导出原样转出去,调用方不用改。
export type { TickDeps } from './tick-deps'
export { INGEST_BATCH_CAP, INGEST_QUIET_MS, distillAndPushOwnerKnowledge } from './tick-ingest'
export { JOB_PROVIDERS, JOB_TURN_MAX_MS, pickJobExecutor, type JobTurnResult } from './tick-job'
export { buildJobText, buildPushTickText, buildGapCheckinText, buildHuntText, type BuildPushTickTextOpts, type BuildGapCheckinTextOpts, type TickTextStyle } from './tick-texts'
export { announceNewSticker } from './tick-introspect'

export interface TickBodies {
  /** WRITE-side knowledge ingestion (25m interval + new-message nudge). */
  ingestTick: () => Promise<void>
  pushTick: (opts?: { nowIso?: string }) => Promise<void>
  // introspect/observations internal timestamps stay wall-clock (MVP); nowIso
  // is only used to seed the memory gardener's `today` (archive filename /
  // watermark date), keeping the signature symmetric with pushTick.
  introspectTick: (opts?: { nowIso?: string }) => Promise<void>
  /**
   * 定时任务的一轮(spec 2026-10-20-scheduled-jobs-design):独立会话 `job:<id>`、只读档、strict,
   * 走伙伴主动消息的出口;跑完 forget(不续接、不占位)。只给 claude / codex。
   */
  runJobTurn(args: { chatId: string; jobId: string; text: string; nowIso: string; buildText?: (style: TickTextStyle) => string; /** 主人点名哪家(换一家来审,10-20);只认 JOB_PROVIDERS,没装 ⇒ skipped:executor,不换人。 */ provider?: (typeof JOB_PROVIDERS)[number]; /** 'review' ⇒ REVIEW_PROFILE(不给网,评审 #460);缺省 JOB_PROFILE */ profile?: 'job' | 'review'; /** 这是哪一种话(SpeechPolicy)—— **必填,没有缺省**:缺省往放行的方向兜底,忘了传就悄悄成了「主人要的」(整合者评审 #524)。主人建的定时 = job、换一家来审 = review(都是 requested);晨报 = brief、周报 = recap(initiative)。 */ kind: 'job' | 'review' | 'brief' | 'recap'; /** 定时触发的(赶上免打扰的 initiative 当天记 skipped:quiet,不往后推);换一家来审不是。 */ scheduled: boolean }): Promise<JobTurnResult>
}

export function buildTickBodies(deps: TickDeps): TickBodies {
  const dispatch = makeTickDispatch(deps)
  return {
    ingestTick: makeIngestTick(deps),
    pushTick: makePushTick(deps, dispatch),
    introspectTick: makeIntrospectTick(deps),
    runJobTurn: makeRunJobTurn(deps, dispatch),
  }
}
