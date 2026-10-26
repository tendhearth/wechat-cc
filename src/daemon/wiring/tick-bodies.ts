/**
 * 陪伴四拍的组装处(组合根这一层):ingestTick(25 分钟)、pushTick(20 分钟)、introspectTick(24 小时)、runJobTurn(定时任务)。
 * A5 · 陪伴起,四拍的身体和引擎在 src/features/companion(`makeCompanionTicks`);这里只剩**登记表** —— 哪些功能交了什么候选、
 * 什么步子 —— 和那几样功能自己要的东西(贴纸库、小像、画室,`IntrospectStepExtras`)。陪伴不认识任何一个功能,认识它们的是这里。
 */
import { makeCompanionTicks, gapAction, type TickBodies, type TickDeps as CompanionTickDeps, type TickDispatch, type CompanionAction, type IntrospectStep } from '../../features/companion'
import { visitAction } from './companion-actions'
import { huntAction } from '../../features/hunt'
import { portraitArtistStep, memoryGardenStep, atelierStep, type IntrospectStepExtras } from './introspect-steps'
import { stickerArtistStep } from '../../features/stickers'
import { buildMemorySnapshot, memoryFactsFor, synthesisMemoryFor } from '../../features/memory'

// 原有的导出原样转出去(都来自陪伴功能的 index.ts),调用方不用改。
export { INGEST_BATCH_CAP, INGEST_QUIET_MS, distillAndPushOwnerKnowledge, JOB_PROVIDERS, JOB_TURN_MAX_MS, pickJobExecutor, type JobTurnResult } from '../../features/companion'
export { buildJobText, buildPushTickText, buildGapCheckinText, buildHuntText, type BuildPushTickTextOpts, type BuildGapCheckinTextOpts, type TickTextStyle, type TickBodies } from '../../features/companion'

/** 组装这一层看到的依赖 = 陪伴引擎要的 + 交步子的功能要的。 */
export type TickDeps = CompanionTickDeps & IntrospectStepExtras

/**
 * 「陪伴候选」登记表(A5,ports/companion-contributions.ts):陪伴的两拍只认这两张表,不认识任何一个功能。
 * 拿掉一个功能 = 删掉这里的一行。**顺序就是行为**:
 *  - 推送:候选(以及日程判断 prompt 里候选)的顺序;回退顺序在 domain/companion-plan 的 pickFallback(同为打猎 → 串门 → 问候)。
 *  - 自省:固定维护之后逐个跑的顺序(园丁夹在小像和画室之间,是搬家前的原样)。
 */
export function companionActions(deps: TickDeps, dispatch: TickDispatch): CompanionAction[] {
  return [huntAction(deps, dispatch), visitAction(deps), gapAction(deps, dispatch)]
}
export function introspectSteps(deps: TickDeps): IntrospectStep[] {
  return [stickerArtistStep(deps), portraitArtistStep(deps), memoryGardenStep(deps), atelierStep(deps)]
}

/**
 * 交给陪伴的就是同一个 deps 对象(不拷贝):搬家前四拍、各个候选和步子拿的都是这一份,测试也会在造好之后改它。
 */
export function buildTickBodies(deps: TickDeps): TickBodies {
  return makeCompanionTicks(deps, {
    actions: (_d, dispatch) => companionActions(deps, dispatch),
    steps: () => introspectSteps(deps),
    memorySnapshot: (stateDir, chatId) => buildMemorySnapshot(stateDir, chatId, memoryFactsFor(deps.db, stateDir)),
    synthesisMemory: (chatId) => synthesisMemoryFor(deps.db, deps.stateDir, chatId),
  })
}
