/**
 * 陪伴(CC 主动的那一面)—— 一个功能一个目录(架构终态 A5,最后一个功能)。CC 不等主人开口:到点的跟进、安静久了问一句、
 * 每天反省一次、把聊过的话慢慢沉成知识。
 *
 *  - 四拍:`tick-ingest`(25 分钟,知识入库)、`tick-push`(20 分钟,到期跟进 → 日程判断 → 来访叙述)、
 *    `tick-introspect`(24 小时,反思 / 线索 / 总览 / 备份 + 登记进来的几步)、`tick-job`(定时任务那一轮,走同一个出口);
 *    组装在 `ticks.ts`(`makeCompanionTicks`),起停在 `lifecycle.ts`(三个定时器模块 companion.push / introspect / ingest);
 *  - 判断:`calibration`(care 档、该不该开口)、`care-ledger`(主动说话的台账)、`agenda`、`plan-memory`(日程判断留痕)、
 *    `guest-visits`、`offer-eligibility`;反思 `introspect*`;知识入库 `ingest/*`、`knowledge-distill`、`hearth-*`;
 *  - 贡献点:`src/ports/companion-contributions.ts`(CompanionAction / IntrospectStep / MemorySnapshot,交东西的功能只引它)
 *    + `ticks.ts` 的 `CompanionContributions`。
 *    陪伴自己只有一个候选「问候」(`gap-action.ts`);打猎、串门、贴纸、小像、园丁、画室都是别人交的,
 *    **登记表在组装的地方**(daemon/wiring/tick-bodies.ts),这里一个功能都不 import;
 *  - `routes.ts`:`/v1/companion/status|enable|disable|snooze|import-local|thoughts`,路由表标了 `module: 'companion'`;
 *  - 这个文件:模块清单 + 对外的窄口。外面只经这里用它(depcheck 管着)。
 *
 * 不在这里的(都不是陪伴独有的):
 *  - companion 配置(`lib/companion-config.ts`):主人那条对话 `default_chat_id`、时区、画室档、信 / 打猎开关……
 *    全 daemon、CLI 都在读,是 daemon 级的配置,早就在 lib(原来 daemon/companion/config.ts、paths.ts 两个转发删掉了);
 *  - `daemon/companion/` 剩下的几样:主动开口的出口 `proactive-channel` / `app-channel`(SpeechPolicy 和信都走它)、
 *    媒体镜像 `media-mirror`(ilink 发送路径上的)、抖动定时器 `scheduler`(信、每晚整理、信箱也用)、
 *    认主人 `resolve-admin`(bootstrap、工作台也用)、邻居家 `neighbor-memory`(社交串门的);
 *  - 开关的实现 `daemon/ilink/companion.ts`(改配置;开的时候要 ilink 的账号表和最近活跃的 chat 定主人那条对话),
 *    对外只交窄口 `wechat.companion`(`WechatCompanionControls`,src/ports/wechat.ts;A6),这个功能 needs 的就是那一口;
 *  - 桌宠两条 `/v1/companion/presence`、`/v1/companion/pet` 和「跟 CC 说」`/v1/companion/converse`:前者是
 *    internal-api 的共用视图(手机页也经 getPresence 读),后两者是对话那一层的(回合串行入口),路径里带 companion 只是历史。
 */
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
// 只要 mount 这一口(同画室 / 日志):不引 internal-api/lifecycle。
import type { InternalApi } from '../../daemon/internal-api/types'
import { companionRoutes, type CompanionRoutesDeps } from './routes'

// —— 引擎:四拍、贡献点、起停 ——
export { makeCompanionTicks, type TickBodies, type CompanionContributions } from './ticks'
export type { CompanionAction, CompanionTickCtx, IntrospectStep, IntrospectStepCtx, MemorySnapshot } from '../../ports/companion-contributions'
export type { TickDeps } from './tick-deps'
export type { TickDispatch } from './tick-dispatch'
export { gapAction } from './gap-action'
export { registerCompanionPush, registerCompanionIntrospect, registerIngest, type CompanionPushDeps, type CompanionIntrospectDeps, type CompanionIngestDeps } from './lifecycle'
export { INGEST_BATCH_CAP, INGEST_QUIET_MS, distillAndPushOwnerKnowledge } from './tick-ingest'
export { JOB_PROVIDERS, JOB_TURN_MAX_MS, pickJobExecutor, type JobTurnResult } from './tick-job'
// 提示文字:打猎的那份也在这里(和推送 / 问候 / 定时共用一套口吻常量和对照测试),打猎经这里拿。
export { buildJobText, buildPushTickText, buildGapCheckinText, buildHuntText, type BuildPushTickTextOpts, type BuildGapCheckinTextOpts, type TickTextStyle } from './tick-texts'

// —— 别处也读的判断与台账(提示词的关心档、SpeechPolicy、记忆通知、定时、设置面板)——
export { careLevel, shouldSpeak, type CareLevel, type CareKind, type CareLedgerEntry } from './calibration'
export { makeCareLedger, type CareLedger, type CareClaim } from './care-ledger'
export { parseAgenda, selectDue, type AgendaItem } from './agenda'
export { readPlanLogDays } from './plan-memory'
export { companionOfferEligible } from './offer-eligibility'
export { maxDecryptedMtime } from './ingest/cycle'

export type CompanionFeatureDeps = CompanionRoutesDeps

/**
 * 陪伴的模块:只挂路由(四拍的定时器是 lifecycle.ts 的三个模块,由组装的地方按原来的名字和位置放,关机顺序不变)。
 * 必需:搬家前这几条随 internal-api 一起就在,MCP 的 companion_* 工具开机就来。
 */
export function companionFeature(o: { needs: readonly string[]; deps: (ctx: ModuleCtx) => CompanionFeatureDeps }): DaemonModule<void> {
  return {
    name: 'companion',
    needs: ['internal-api', ...o.needs],
    init(ctx) {
      ctx.get<Pick<InternalApi, 'mount'>>('internal-api').mount('companion', companionRoutes(o.deps(ctx)))
    },
  }
}
