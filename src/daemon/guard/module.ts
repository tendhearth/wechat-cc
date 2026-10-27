/**
 * 网络守护接进 daemon 的那一份:闸门 `network-gate`(最先有)和起停 `guard`(wired 之后)。只有模块表 daemon-modules.ts 引这个文件。
 */
import { log } from '../../lib/log'
import { makeMtimeCachedConfigReader } from '../../lib/agent-config'
import { providerCallTarget } from '../../app/provider-registry'
import type { WorkbenchService } from '../../features/workbench'
import type { DaemonModule } from '../modules/container'
import { lifecycleModule, type LifecycleHolder } from '../modules/lifecycle-module'
import type { Foundation } from '../foundation'
import type { Bootstrap } from '../bootstrap'
import type { WiredDeps } from '../wiring'
import { makeGuardRuntime, type GuardRuntime } from './runtime'
import { providersInUse } from './targets'
import { registerGuard, type GuardLifecycle } from './lifecycle'

/** 语音、provider registry、SessionManager、协调器、工作台都接这道闸门,所以它最先有。 */
export function networkGateModule(f: Foundation): DaemonModule<GuardRuntime> {
  const { stateDir } = f
  return {
    name: 'network-gate',
    lazy: ['guard', 'bootstrap', 'workbench'],
    init(ctx): GuardRuntime {
      const guard = ctx.late<LifecycleHolder<GuardLifecycle>>('guard')
      const boot = ctx.late<Bootstrap>('bootstrap')
      const workbench = ctx.late<WorkbenchService>('workbench')
      const readCfg = makeMtimeCachedConfigReader(stateDir)
      return makeGuardRuntime({
        stateDir, log: (t, l) => log(t, l),
        lifecycle: () => guard()?.current() ?? null,
        // 评审 #193 P1-1:按 provider / 会话自己报的实际目标,不按此刻的配置推。bootstrap 之前是空。
        providersInUse: () => {
          const b = boot()
          if (!b) return []
          return providersInUse(
            (() => { try { return readCfg() } catch { return null } })(),
            b.registry.list(),
            b.sessionManager.list().map(s => ({ id: s.providerId, model: s.model ?? null, target: b.sessionManager.effectiveTarget(s) })),
            (id) => providerCallTarget(b.registry.get(id)?.provider, id, 'session'),
          )
        },
        // 暂停在跑的任务(2026-10-03):health 的 guard 块 / `guard status` 列出被冻住的任务。
        suspendedTasks: () => workbench()?.networkSuspended() ?? [],
      })
    },
  } satisfies DaemonModule<GuardRuntime>
}

export function guardModule() {
  return lifecycleModule('guard', (ctx) => registerGuard(ctx.get<WiredDeps>('wired').guardDeps), { needs: ['wired'] })
}
