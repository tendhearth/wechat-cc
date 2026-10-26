/**
 * 陪伴的四拍组装处(从 daemon/wiring/tick-bodies.ts 搬来,A5 · 陪伴):ingestTick(25 分钟)、pushTick(20 分钟)、
 * introspectTick(24 小时)、runJobTurn(定时任务)。每一拍的身体在各自的 tick-*.ts 里;推送和定时共用 tick-dispatch 那一步。
 *
 * 别的功能交来的东西(推送候选、自省的几步、记忆快照)经 `CompanionContributions` 进来:登记表在组装的地方
 * (daemon/wiring/tick-bodies.ts),这里一个功能的名字都不认识。
 */
import type { SynthesisMemory } from '../../lib/memory-synthesis'
import type { TickDeps } from './tick-deps'
import { makeRunJobTurn, type JobTurnResult, type JOB_PROVIDERS } from './tick-job'
import type { TickTextStyle } from './tick-texts'
import { makeTickDispatch, type TickDispatch } from './tick-dispatch'
import { makeIngestTick } from './tick-ingest'
import { makePushTick } from './tick-push'
import { makeIntrospectTick } from './tick-introspect'
import type { CompanionAction, IntrospectStep, MemorySnapshot } from '../../ports/companion-contributions'

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
 * 别的功能交给陪伴的东西。**顺序就是行为**(登记表那边写了为什么):
 *  - `actions`:推送那一拍的候选(以及日程判断 prompt 里候选的顺序);
 *  - `steps`:自省那一拍固定维护之后逐个跑的几步;
 *  - `memorySnapshot`:反思要的记忆快照(记忆功能做);
 *  - `synthesisMemory`:每天自动刷新总览时出口过滤要的收回名单(记忆功能从表里给;陪伴不 import 记忆,免得成环)。
 * 两张表各在造这几拍的时候问一次(同搬家前:先造 dispatch,再按推送 → 自省的顺序拿表)。
 */
export interface CompanionContributions {
  actions(deps: TickDeps, dispatch: TickDispatch): CompanionAction[]
  steps(deps: TickDeps): IntrospectStep[]
  memorySnapshot: MemorySnapshot
  synthesisMemory: (chatId: string) => SynthesisMemory
}

export function makeCompanionTicks(deps: TickDeps, contributions: CompanionContributions): TickBodies {
  const dispatch = makeTickDispatch(deps)
  return {
    ingestTick: makeIngestTick(deps),
    pushTick: makePushTick(deps, dispatch, contributions.actions(deps, dispatch)),
    introspectTick: makeIntrospectTick(deps, contributions.steps(deps), contributions.memorySnapshot, contributions.synthesisMemory),
    runJobTurn: makeRunJobTurn(deps, dispatch),
  }
}
