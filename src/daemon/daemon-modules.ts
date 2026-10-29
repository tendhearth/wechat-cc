/**
 * daemon 的全部模块(架构终态 A1,docs/architecture-end-state-2026-10-25.md;核心链设计稿 PR 6)。
 *
 * 一张表、一个容器(modules/container.ts):`needs` 定开机先后,关机严格倒过来;晚到的东西(环的那一头)
 * 只有一种拿法 —— `lazy` 里写明,经 `ctx.lazy` / `ctx.late` 现取。
 *
 * 表的顺序就是开机顺序(同层按表里的顺序),也就是关机顺序的倒序;关机顺序由
 * `__e2e__/shutdown-order.e2e.test.ts` 的快照钉住。挪一行 = 改关机顺序,快照会红。
 *
 * 每个模块怎么接(它要的从地基 / 上游模块里怎么填、needs / lazy)写在它那块代码旁边的 `module.ts`:
 * 功能在 `src/features/<名>/module.ts`,平台在 `src/daemon/<块>/module.ts`。这张表只管「有哪些、按什么顺序」。
 * 地基(锁、db、几个共享单例)不是模块,见 foundation.ts。
 */
import type { DaemonModule } from './modules/container'
import type { Foundation } from './foundation'
import { networkGateModule, guardModule } from './guard/module'
import { ilinkAdapterModule, replyDeliveryModule, ilinkModule, pollingModule } from './ilink/module'
import { internalApiModule } from './internal-api/module'
import { bootstrapGroupModules, bootApiModule, providerProbesModule } from './bootstrap/module'
import { activityModule } from './activity/module'
import { ownerCommandsModule } from './commands/module'
import { wiredModule, pipelineModule, sessionsModule, startupSweepsModule } from './wiring/module'
import { cliUpgradeModule } from './cli-upgrade/module'
import { huntModule } from '../features/hunt/module'
import { memoryModule, memoryNightlyModule } from '../features/memory/module'
import { consoleModule } from '../features/console/module'
import { atelierModule } from '../features/atelier/module'
import { journalModule } from '../features/journal/module'
import { companionModule, companionPushModule, companionIntrospectModule, companionIngestModule } from '../features/companion/module'
import { voiceModule } from '../features/voice/module'
import { phoneModule } from '../features/phone/module'
import { stickersModule } from '../features/stickers/module'
import { terminalModule } from '../features/terminal/module'
import { calendarModule } from '../features/calendar/module'
import { jobsModule, scheduledJobsModule } from '../features/jobs/module'
import { reportOutboxModule, reportsModule } from '../features/reports/module'
import { workbenchModule, workbenchNotificationsModule, workbenchArtifactsModule } from '../features/workbench/module'
import { lettersModule } from '../features/letters/module'
import { remindersModule } from '../features/reminders/module'
import { outputEvalModule } from '../features/output-eval/module'

export function daemonModules(f: Foundation): DaemonModule[] {
  return [
    // —— 微信那一侧和网络守护:别的几乎都接它们,所以最先有 ——
    networkGateModule(f),
    ilinkAdapterModule(f),           // 只造,不拉消息;别的模块只 needs 它交出的窄口(src/ports/wechat.ts)
    replyDeliveryModule(f),
    huntModule(f),                   // 打猎「默认关」那次的一次性开机步骤:排在 internal-api 开门、任何伙伴那一拍之前

    // —— internal API 在 init 段就监听;下面这些只挂路由,紧跟着它(桌面 / MCP 工具开机就来)——
    internalApiModule(f),
    memoryModule(f),                 // bootstrap 的提示词要它的素材
    consoleModule(f),
    atelierModule(f),
    journalModule(f),
    companionModule(f),
    voiceModule(),
    phoneModule(),
    stickersModule(f),               // 表情库全 daemon 一份,bootstrap(提示词)和 wired 都要它

    // —— bootstrap:provider registry / 会话管理 / 协调器 + 可选的知识库 / 社交 / A2A / 配对 / 乙(一组模块)——
    ...bootstrapGroupModules(f),
    bootApiModule(f),

    // —— 功能 ——
    terminalModule(f),
    calendarModule(f),
    activityModule(f),
    jobsModule(f),
    ownerCommandsModule(f),
    reportOutboxModule(f),           // 工作台入队要它,所以排在工作台前面;投递那一拍在下面 `reports`
    workbenchModule(f),
    outputEvalModule(f),             // 输出评测(只有整合者手动跑):要 bootstrap 的提示词组装 / registry,可选

    // —— wireMain 和入站管道 ——
    wiredModule(f),
    pipelineModule(),

    // —— 起了就跑的那些(start 段按这个顺序起,关机倒过来)——
    companionPushModule(),
    companionIntrospectModule(),
    companionIngestModule(),
    guardModule(),
    providerProbesModule(),
    sessionsModule(),
    ilinkModule(),
    workbenchNotificationsModule(),  // 工作台的微信通知 / 成果:停在 polling 之后,开动却在开机最后(startup-sweeps)
    workbenchArtifactsModule(),
    pollingModule(),
    memoryNightlyModule(),
    lettersModule(f),
    cliUpgradeModule(f),
    remindersModule(f),
    scheduledJobsModule(),
    reportsModule(),
    startupSweepsModule(f),          // 开机的最后一步:一次性清扫(含「CC 回来了」),然后才开动工作台的通知 / 成果
  ]
}
