/**
 * main.ts 调的那一个入口:把 daemon 现成的零件(会话管理、busy 登记处、provider registry、网络守护、
 * 自检、微信 / 桌面通知)拼成 CLI 自动升级。main.ts 只登记,不写逻辑(bootstrap 拆分的规矩)。
 */
import type { NetworkGate } from '../../lib/network-gate'
import { decideCall } from '../../lib/network-gate'
import { providerCallTarget, type ProviderRegistry } from '../../core/provider-registry'
import type { UserTier } from '../../core/user-tier'
import { runSelftestConverse } from '../selftest'
import { defaultSelftestDeps, runWorkbenchSelftest } from '../../cli/selftest'
import { verifyCliProvider } from './verify'
import { wireCliUpgrade } from './wire'
import type { CliUpgrader } from '../../core/cli-upgrade/engine'
import type { Lifecycle } from '../../lib/lifecycle'

export interface StartCliUpgradeDeps {
  stateDir: string
  sessionManager: { anyInFlight(): boolean; list(): Array<{ providerId: string }> }
  busyLabels: () => string[]
  holdBusy: (label: string) => () => void
  registry: Pick<ProviderRegistry, 'get' | 'has'>
  /** 开机探测失败、正在退避重探的那家:立刻重探一次(bootstrap 的 reprobeProvider)。没接 ⇒ 不重探。 */
  reprobeProvider?: (providerId: string) => Promise<boolean | null>
  networkGate?: NetworkGate
  mintSessionToken: (tier: UserTier, key: string, opts?: { routeAllow?: ReadonlySet<string>; ttlMs?: number }) => string
  invalidateSession: (key: string) => void
  /** 发给主人(微信);返回 false = 没发出去。 */
  sendOwner: (text: string) => Promise<boolean>
  notifyDesktop: (title: string, body: string) => Promise<boolean>
  log: (tag: string, line: string) => void
}

export function startCliUpgrade(d: StartCliUpgradeDeps): { upgrader: CliUpgrader; lifecycle: Lifecycle } {
  return wireCliUpgrade({
    stateDir: d.stateDir,
    anyInFlight: () => d.sessionManager.anyInFlight(),
    liveSessionProviders: () => d.sessionManager.list().map(s => s.providerId),
    busyLabels: d.busyLabels,
    holdBusy: d.holdBusy,
    log: d.log,
    notify: async (text) => {
      const [wx, desk] = await Promise.all([
        d.sendOwner(text).catch(() => false),
        d.notifyDesktop('Tendhearth CC', text).catch(() => false),
      ])
      if (!wx && !desk) d.log('CLI_UPGRADE', `通知没发出去(微信、桌面都失败):${text}`)
    },
    verify: (spec) => verifyCliProvider(spec, {
      hasProvider: (id) => d.registry.has(id),
      ...(d.reprobeProvider ? { reprobe: d.reprobeProvider } : {}),
      guardAllows: async (id) => {
        const entry = d.registry.get(id)
        const decision = await decideCall(d.networkGate, providerCallTarget(entry?.provider, id, 'spawn'))
        return decision.allowed ? { allowed: true } : { allowed: false, ...(decision.verdict ? { detail: decision.verdict.detail } : {}) }
      },
      converse: (input) => runSelftestConverse({
        registry: d.registry,
        mintSessionToken: d.mintSessionToken,
        invalidateSession: d.invalidateSession,
        log: d.log,
      }, input),
      // 与 `wechat-cc selftest workbench --executor <id> --resume` 同一段代码,走本机回环的内部 API。
      workbench: (id) => runWorkbenchSelftest(
        { ...defaultSelftestDeps(d.stateDir), log: (line) => d.log('CLI_UPGRADE', `workbench selftest: ${line}`) },
        { executor: id, resume: true },
      ),
      log: d.log,
    }),
  })
}
