/**
 * 「CC 的连接」与「CC 现在怎么样」的能力四态(重构第二批步 6c,从 pipeline-deps.ts 搬出来):插件快照、解密库时间、
 * 知识库、工作台,加上现有信号拼成的能力表。缓存 10s、最多 3 次 detail()(裁定 8);任何一路读不到就当没有。
 */
import { hostname } from 'node:os'
import type { Bootstrap } from '../bootstrap'
import type { IlinkAdapter } from '../ilink-glue'
import { buildConnections, cacheConnections } from '../connections'
import { buildCapabilities } from '../capabilities'
import { hasFullDiskAccess } from '../../lib/fs-access'
import { readNightlyState } from '../../features/memory'
import { relayV2Configured } from '../../features/phone'
import { maxDecryptedMtime } from '../companion/ingest/cycle'
import { APP_VERSION } from '../../lib/app-version'
import { loadAgentConfig } from '../../lib/agent-config'
import { loadCompanionConfig } from '../companion/config'

export interface WireConnectionsDeps {
  stateDir: string
  boot: Bootstrap
  ilink: Pick<IlinkAdapter, 'outboundHealth' | 'sessionState' | 'proactiveClosedSince'>
  ownerChatId(): string | null
  /** 配对过的手机数(设置面板在后面才建,被问时才读;抛 ⇒ 当 0)。 */
  phoneDevices(): number
  workbench?: import('../../core/workbench/service').WorkbenchService
  guardRuntime?: import('../guard/runtime').GuardRuntime
  terminalHooks?: Pick<import('../../features/terminal').TerminalHooksService, 'capabilityInput'>
  subsystems?: () => Array<{ name: string; state: 'ok' | 'degraded' | 'off'; error?: string }>
  /** 真回合里被拒着的执行者(provider-refusals.ts)。 */
  providerRefusals?: () => Record<string, import('../provider-refusals').ProviderRefusal>
}

export function wireConnections(d: WireConnectionsDeps) {
  const { stateDir, boot, ilink, ownerChatId } = d
// 「CC 的连接」(spec 2026-10-01):插件快照 / 解密库时间 / 知识库 / 工作台。裁定 8:缓存 10 s、最多 3 次 detail()。
// wechatSyncedAt = wxvault 解密库的最近落盘时间(同步时间),不是最新微信消息时间。
const startedAt = Date.now() - Math.round(process.uptime() * 1000)
return cacheConnections(() => buildConnections({
  plugins: () => boot.pluginsHealth ?? null,
  wechatSyncedAt: () => { const m = maxDecryptedMtime(stateDir); return m > 0 ? m : null },
  knowledge: () => ({ enabled: (loadAgentConfig(stateDir) as { knowledge_enabled?: boolean }).knowledge_enabled === true, built: !!boot.knowledge, latestAt: boot.knowledge?.store.latestMessageAtMs() ?? null, syncedAt: boot.knowledge?.store.lastSyncAtMs() ?? null }),
  computer: () => ({ label: hostname().replace(/\.local$/, ''), since: startedAt, version: APP_VERSION }),
  detailLimit: 3,
  ...(d.workbench ? { workbench: d.workbench } : {}),
  // 「CC 现在怎么样」(2026-10-06):现有信号拼成四态能力表(capabilities.ts);任何一路读不到就当没有,不让整张卡挂掉。
  capabilities: () => {
    const cfg = loadAgentConfig(stateDir) as { provider?: string; knowledge_enabled?: boolean }
    const provider = cfg.provider ?? 'claude'
    const probe = (boot.providerProbes?.() ?? []).find(p => p.id === provider)
    const outbound = ilink.outboundHealth()
    const guard = d.guardRuntime?.health()
    const fda = process.platform === 'darwin' ? hasFullDiskAccess() : null
    const nightly = readNightlyState(stateDir)
    let devices = 0
    try { devices = d.phoneDevices() } catch { /* 读不到就当没配对 */ }
    return buildCapabilities({
      wechat: { outbound: outbound.state, expired: ilink.sessionState.listExpired().length, lastError: outbound.lastError ?? null, ownerWindowClosedSince: (() => { const o = ownerChatId(); return o ? ilink.proactiveClosedSince(o) : null })() },
      brain: { provider, name: boot.registry.namesOf(provider).name, registered: boot.registry.has(provider), retrying: probe?.state === 'retrying', lastError: probe?.last_error ?? null, refused: d.providerRefusals?.()[provider] ?? null },
      guard: guard?.enabled ? { safe: guard.safe, paused: !!guard.paused, detail: guard.detail ?? null } : null,
      fullDiskAccess: fda === null ? null : { granted: fda, settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles' },
      knowledge: cfg.knowledge_enabled === true ? { built: !!boot.knowledge, embed: boot.knowledge?.embedStatus?.() ?? (boot.knowledge?.embedder ? 'python' : 'none') } : null,
      memory: loadCompanionConfig(stateDir).memory_nightly_enabled ? { failures: nightly.failures, firstRunDone: nightly.firstRunDone } : null,
      background: (() => { const h = boot.registry.cheapEvalHealth?.(); return h ? { failures: h.consecutiveFailures, lastError: h.lastError } : null })(),
      phone: { relay: relayV2Configured(stateDir), devices },
      terminal: (() => { try { return d.terminalHooks?.capabilityInput() ?? null } catch { return null } })(),
      subsystems: d.subsystems?.() ?? [],
    })
  },
}))
}
