import { hintWrite } from '../../lib/write-hints'
/**
 * 工作台(「一起做」)接进 daemon 的那一份(模块清单在 index.ts):`workbench` + 微信通知 / 成果两个模块。
 * 只有 daemon-modules.ts import 这个文件。
 */
import { log } from '../../lib/log'
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import type { Bootstrap } from '../../daemon/bootstrap'
import type { WiredDeps } from '../../daemon/wiring'
import type { GuardRuntime } from '../../daemon/guard/runtime'
import type { CliUpgradeModule } from '../../daemon/cli-upgrade/start'
import { ownerChatIdOf } from '../../daemon/owner-chat'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeMatterTopics } from '../../daemon/threads/matter-topics'
import { makeMatterEventRefs } from '../../adapters/store/matter-event-refs'
import { WECHAT_PORTS as W, type WechatPermissions } from '../../ports/wechat'
import type { TerminalFeature } from '../terminal'
import type { JobsFeature } from '../jobs'
import type { ReportsFeature } from '../reports'
import { workbenchFeature, workbenchNotificationsFeature, workbenchArtifactsFeature, type WorkbenchService } from './index'

/** 桌面路由自己挂,这里只填它要的东西。 */
export function workbenchModule(f: Foundation): DaemonModule<WorkbenchService> {
  const { stateDir, db } = f
  return workbenchFeature({
    needs: ['bootstrap', 'terminal', 'jobs', W.permissions, 'internal-api', 'network-gate', 'report-outbox'],
    lazy: ['cli-upgrade'],
    resolveAdminChatId: () => ownerChatIdOf(stateDir),
    // 桌面 app 开着没有 / 在电脑上看过哪件(S3b):一件事的提议读
    desktop: { notePoll: (progress) => f.desktopSurface.notePoll(progress), seen: (id) => { f.desktopSurface.noteSeen(id); hintWrite(f.db, { kind: 'matter', matterId: id }) } },
    deps: (ctx) => {
      const boot = ctx.get<Bootstrap>('bootstrap')
      const cli = ctx.get<TerminalFeature>('terminal')
      const jobs = ctx.get<JobsFeature>('jobs')
      const wxPerm = ctx.get<WechatPermissions>(W.permissions)
      const cliUpgrade = ctx.late<CliUpgradeModule>('cli-upgrade')
      // 话题 T3:派活时从话题拣简报、做完把结论写回话题(只给主人的任务)
      const matterTopics = makeMatterTopics({ db, threads: makeThreadsStore(db), ownerChatId: () => ownerChatIdOf(stateDir), log: (t, l) => log(t, l) })
      return {
        db, stateDir, boot, matters: f.matters, reports: ctx.get<ReportsFeature>('report-outbox').sink, networkGate: ctx.get<GuardRuntime>('network-gate').gate, permissionGate: cli.permissionGate, requestReview: (r) => jobs.requestReview(r),
        onTurnError: (providerId, code, message) => {
          cliUpgrade()?.upgrader()?.onTurnError(providerId, code, message)
          // 一起做里被拒也算(只有 agy 用一起做时,大脑那一行不该落后)
          f.providerRefusals.onTurn({ provider: providerId, outcome: 'error', ...(code ? { errorCode: code } : {}), endedAt: Date.now() })
        },
        onTurnCompleted: (providerId) => f.providerRefusals.onTurn({ provider: providerId, outcome: 'completed', endedAt: Date.now() }),
        topics: {
          brief: (t) => matterTopics.briefForMatter(t),
          // 晚一拍再写:这一轮最后那条回话可能还在落 MatterLog 的路上
          turnCompleted: (taskId) => { const h = setTimeout(() => { void matterTopics.writeBack(taskId) }, 1_000); (h as { unref?: () => void }).unref?.() },
        },
        providerRefusal: (providerId) => f.providerRefusals.get(providerId),
        executionConflict: (path, providerId, nativeId) => boot.sessionManager.hasProjectConflict(path) ||
          (!!nativeId && Object.values(boot.sessionStore.all()).some(s => s.provider === providerId && s.session_id === nativeId)) ||
          cli.legacyClaims.conflicts({ owner: 'workbench', path, providerId, nativeId }) ||
          (!!nativeId && cli.cliEvents.sessions().some(s => s.source === providerId && s.session_id === nativeId && !!s.origin_agent)),
        askUser: wxPerm.askUser, permissionRegistry:wxPerm, log: (t, l) => log(t, l),
      }
    },
  })
}

/**
 * 工作台的微信通知 / 成果:**停**在 polling 之后(关机时先停入站,再把任务那几句送完,再冲 ilink);
 * **开动**却放在开机最后(startup-sweeps 那一步):补发停机期间做完的任务那几句,要排在「CC 回来了」之后。
 */
export function workbenchNotificationsModule(f: Pick<Foundation, 'db'>): DaemonModule {
  // 同一个事件的键(S3a):run 终态的通知带那个 run 的最后一轮,和 App「做完了」推送并成账上一行
  const refs = makeMatterEventRefs(f.db)
  return workbenchNotificationsFeature({ needs: ['workbench', 'wired', W.workbench], speech: (ctx) => ctx.get<WiredDeps>('wired').speech, turnRefOfRun: (taskId, runId) => refs.lastTurnOfRun(taskId, runId) })
}
export function workbenchArtifactsModule(): DaemonModule {
  return workbenchArtifactsFeature({ needs: ['workbench', W.workbench] })
}
