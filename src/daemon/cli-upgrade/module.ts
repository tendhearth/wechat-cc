/**
 * 外部 agent CLI 自动升级接进 daemon 的那一份(主人 2026-10-04,docs/maintainer/cli-auto-upgrade.md):空闲时升、升完自检、不过就退回。
 * 只有模块表 daemon-modules.ts 引这个文件。
 */
import { log } from '../../lib/log'
import { notifyDesktop } from '../../lib/desktop-notify'
import type { Lifecycle } from '../../lib/lifecycle'
import type { DaemonModule } from '../modules/container'
import type { Foundation } from '../foundation'
import type { GuardRuntime } from '../guard/runtime'
import type { Bootstrap } from '../bootstrap'
import type { InternalApiLifecycle } from '../internal-api/lifecycle'
import type { WiredDeps } from '../wiring'
import { ownerChatIdOf } from '../owner-chat'
import type { CliUpgrader } from './engine'
import { startCliUpgrade, type CliUpgradeModule } from './start'

export function cliUpgradeModule(f: Foundation): DaemonModule<CliUpgradeModule> {
  const { stateDir } = f
  const ownerChatId = () => ownerChatIdOf(stateDir)
  return {
    name: 'cli-upgrade',
    optional: true,
    needs: ['bootstrap', 'wired', 'internal-api', 'network-gate'],
    init(ctx): CliUpgradeModule {
      const boot = ctx.get<Bootstrap>('bootstrap')
      const wired = ctx.get<WiredDeps>('wired')
      const internalApi = ctx.get<InternalApiLifecycle>('internal-api')
      let upgrader: CliUpgrader | null = null
      let lc: Lifecycle | null = null
      ctx.onStart('start', () => {
        const started = startCliUpgrade({
          stateDir, sessionManager: boot.sessionManager, busyLabels: () => boot.busyLabels(), holdBusy: (l) => boot.holdBusy(l),
          registry: boot.registry, networkGate: ctx.get<GuardRuntime>('network-gate').gate,
          // 开机探测失败、正在重探的 provider:升完立刻重探一次,注册上再自检(#211)。
          reprobeProvider: (id) => boot.reprobeProvider?.(id) ?? Promise.resolve(null),
          mintSessionToken: (tier, key, o) => internalApi.mintSessionToken(tier, key, o),
          invalidateSession: (key) => internalApi.invalidateSession(key),
          sendOwner: async (text) => {
            const o = ownerChatId()
            if (!o) return false
            // 经 CC 开口那道门(upgrade_notice 归 report);被推后 / 没发出去 ⇒ false,调用方照旧发桌面通知
            return wired.speech.tell('upgrade_notice', o, text)
          },
          notifyDesktop: (t, b) => notifyDesktop(t, b),
          log: (t, l) => log(t, l),
        })
        upgrader = started.upgrader; lc = started.lifecycle
        internalApi.provide({ cliUpgrade: started.upgrader })
      })
      ctx.own('stop', () => lc?.stop())
      return { upgrader: () => upgrader }
    },
  } satisfies DaemonModule<CliUpgradeModule>
}
