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
    deps: (ctx) => {
      const boot = ctx.get<Bootstrap>('bootstrap')
      const cli = ctx.get<TerminalFeature>('terminal')
      const jobs = ctx.get<JobsFeature>('jobs')
      const wxPerm = ctx.get<WechatPermissions>(W.permissions)
      const cliUpgrade = ctx.late<CliUpgradeModule>('cli-upgrade')
      return {
        db, stateDir, boot, matters: f.matters, reports: ctx.get<ReportsFeature>('report-outbox').sink, networkGate: ctx.get<GuardRuntime>('network-gate').gate, permissionGate: cli.permissionGate, requestReview: (r) => jobs.requestReview(r),
        onTurnError: (providerId, code, message) => {
          cliUpgrade()?.upgrader()?.onTurnError(providerId, code, message)
          // 一起做里被拒也算(只有 agy 用一起做时,大脑那一行不该落后)
          f.providerRefusals.onTurn({ provider: providerId, outcome: 'error', ...(code ? { errorCode: code } : {}), endedAt: Date.now() })
        },
        onTurnCompleted: (providerId) => f.providerRefusals.onTurn({ provider: providerId, outcome: 'completed', endedAt: Date.now() }),
        providerRefusal: (providerId) => f.providerRefusals.get(providerId),
        executionConflict: (path, providerId, nativeId) => boot.sessionManager.hasProjectConflict(path) ||
          (!!nativeId && Object.values(boot.sessionStore.all()).some(s => s.provider === providerId && s.session_id === nativeId)) ||
          cli.legacyClaims.conflicts({ owner: 'workbench', path, providerId, nativeId }) ||
          (!!nativeId && cli.cliEvents.sessions().some(s => s.source === providerId && s.session_id === nativeId && !!s.origin_agent)),
        askUser: wxPerm.askUser, log: (t, l) => log(t, l),
      }
    },
  })
}

/**
 * 工作台的微信通知 / 成果:**停**在 polling 之后(关机时先停入站,再把任务那几句送完,再冲 ilink);
 * **开动**却放在开机最后(startup-sweeps 那一步):补发停机期间做完的任务那几句,要排在「CC 回来了」之后。
 */
export function workbenchNotificationsModule(): DaemonModule {
  return workbenchNotificationsFeature({ needs: ['workbench', 'wired', W.workbench], speech: (ctx) => ctx.get<WiredDeps>('wired').speech })
}
export function workbenchArtifactsModule(): DaemonModule {
  return workbenchArtifactsFeature({ needs: ['workbench', W.workbench] })
}
