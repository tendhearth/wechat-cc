/**
 * Companion scheduler tick bodies —— 四拍的组装处:ingestTick(25 分钟)、pushTick(20 分钟)、introspectTick(24 小时)、
 * runJobTurn(定时任务)。每一拍的身体在各自的 tick-*.ts 里;推送和定时共用 tick-dispatch 的那一步。
 */
import type { TickDeps } from './tick-deps'
import { JOB_PROVIDERS, makeRunJobTurn, type JobTurnResult } from './tick-job'
import type { TickTextStyle } from './tick-texts'
import { makeTickDispatch, type TickDispatch } from './tick-dispatch'
import { makeIngestTick } from './tick-ingest'
import { makePushTick } from './tick-push'
import { makeIntrospectTick } from './tick-introspect'
import type { CompanionAction, IntrospectStep } from '../companion/contributions'
import { visitAction, gapAction } from './companion-actions'
import { huntAction } from '../../features/hunt'
import { portraitArtistStep, memoryGardenStep, atelierStep } from './introspect-steps'
import { stickerArtistStep } from '../../features/stickers'

// 2026-10-22 按生产者拆成 tick-*.ts(第三批 3a 顺带项);这里只剩组装,原有的导出原样转出去,调用方不用改。
export type { TickDeps } from './tick-deps'
export { INGEST_BATCH_CAP, INGEST_QUIET_MS, distillAndPushOwnerKnowledge } from './tick-ingest'
export { JOB_PROVIDERS, JOB_TURN_MAX_MS, pickJobExecutor, type JobTurnResult } from './tick-job'
export { buildJobText, buildPushTickText, buildGapCheckinText, buildHuntText, type BuildPushTickTextOpts, type BuildGapCheckinTextOpts, type TickTextStyle } from './tick-texts'

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
  runJobTurn(args: { chatId: string; jobId: string; text: string; nowIso: string; buildText?: (style: TickTextStyle) => string; /** 交付之前改一下模型写好的最后那段(早报接上要主人拍板的候选,§4.8);NO_REPLY 由调用方自己判。 */ transformFinal?: (finalText: string) => string; /** 主人点名哪家(换一家来审,10-20);只认 JOB_PROVIDERS,没装 ⇒ skipped:executor,不换人。 */ provider?: (typeof JOB_PROVIDERS)[number]; /** 'review' ⇒ REVIEW_PROFILE(不给网,评审 #460);缺省 JOB_PROFILE */ profile?: 'job' | 'review'; /** 这是哪一种话(SpeechPolicy)—— **必填,没有缺省**:缺省往放行的方向兜底,忘了传就悄悄成了「主人要的」(整合者评审 #524)。主人建的定时 = job、换一家来审 = review(都是 requested);晨报 = brief、周报 = recap(initiative)。 */ kind: 'job' | 'review' | 'brief' | 'recap'; /** 定时触发的(赶上免打扰的 initiative 当天记 skipped:quiet,不往后推);换一家来审不是。 */ scheduled: boolean }): Promise<JobTurnResult>
}

/**
 * 「陪伴候选」登记表(A5,daemon/companion/contributions.ts):陪伴的两拍只认这两张表,不认识任何一个功能。
 * 拿掉一个功能 = 删掉这里的一行。**顺序就是行为**:
 *  - 推送:候选(以及日程判断 prompt 里候选)的顺序;回退顺序在 core/companion-plan 的 pickFallback(同为打猎 → 串门 → 问候)。
 *  - 自省:固定维护之后逐个跑的顺序(园丁夹在小像和画室之间,是搬家前的原样)。
 */
export function companionActions(deps: TickDeps, dispatch: TickDispatch): CompanionAction[] {
  return [huntAction(deps, dispatch), visitAction(deps), gapAction(deps, dispatch)]
}
export function introspectSteps(deps: TickDeps): IntrospectStep[] {
  return [stickerArtistStep(deps), portraitArtistStep(deps), memoryGardenStep(deps), atelierStep(deps)]
}

export function buildTickBodies(deps: TickDeps): TickBodies {
  const dispatch = makeTickDispatch(deps)
  return {
    ingestTick: makeIngestTick(deps),
    pushTick: makePushTick(deps, dispatch, companionActions(deps, dispatch)),
    introspectTick: makeIntrospectTick(deps, introspectSteps(deps)),
    runJobTurn: makeRunJobTurn(deps, dispatch),
  }
}
