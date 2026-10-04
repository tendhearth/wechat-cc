/**
 * 网络守护的 daemon 侧接线(守护 v2,2026-10-02):一个 Ref 装调度器(guard 生命周期起来后
 * 才有)、一个网络闸门(分类 + 信号)、一个 /v1/health 快照、一个给后台任务用的包装。
 *
 * main.ts 在最前面建它(早于 internal-api / bootstrap),因为 provider registry、
 * SessionManager、协调器都在 bootstrap 里建,而 guard 生命周期在很后面才 start。
 * 闸门在调度器还没起来时会自己读 bx / 等第一次探测(见 gate.ts),所以这段空窗不会放行。
 */
import { Ref } from '../../lib/lifecycle'
import { UNDER_TEST_RUNNER } from '../../lib/config'
import { isNetworkUnprotectedError, type NetworkGate, type NetworkGateVerdict } from '../../lib/network-gate'
import type { CallClass, CallTarget } from '../../lib/call-classifier'
import { makeMtimeCachedConfigReader, type AgentConfig } from '../../lib/agent-config'
import { findBx, readBxStatus } from './bx'
import { createNetworkGate } from './gate'
import type { GuardLifecycle } from './lifecycle'
import { probeReachable } from './probe'
import { DEFAULT_PROBE_TTL_MS } from './scheduler'
import { loadGuardConfig, type GuardConfig } from './store'
import { makeResolveTarget, type ProviderInUse } from './targets'
import type { GuardHealth } from '../internal-api/types'

export interface GuardRuntime {
  ref: Ref<GuardLifecycle>
  gate: NetworkGate & { classify(t: CallTarget): CallClass }
  health(): GuardHealth
  /** main.ts 在 bootstrap 之后接上:此刻配置 / 在用的 provider(health、后台任务判断用)。 */
  setProvidersInUse(fn: () => ProviderInUse[]): void
  /** main.ts 在工作台起来之后接上:此刻被网络守护冻住的任务(health / `guard status`)。 */
  setSuspendedTasks(fn: () => SuspendedTask[]): void
  /** 已配置 / 在用的 provider 各自的分类。 */
  classifyInUse(): Array<ProviderInUse & { cls: CallClass }>
  /**
   * 后台 / 定时任务包装(守护 v2):
   *   - 信号安全 → 照跑。
   *   - 信号不安全、但在用的 provider 里**有不需要保护的** → 照跑:里面需要保护的那几次调用
   *     会被各自的闸门单独拒掉,不需要保护的照常(Claude 聊天暂停不该连累 DeepSeek 的后台判断)。
   *   - 信号不安全、在用的全都需要保护 → 这一拍安静跳过。
   *   - 任务里冒出来的「网络未受保护」不当成失败:同一段不安全期同一个任务只记一行日志。
   *   - 评审 #193 P2-3:这层只兜底**逃出来的**拒绝。任务内部被拒的那一次调用必须由任务自己按「这一拍
   *     跳过」处理 —— 不打勾、不登记、不前移时间戳(isNetworkUnprotectedError / NETWORK_UNPROTECTED_REASON
   *     是那个专门的结果类型;见 tick-bodies、introspect、sticker-artist、atelier-runtime、wire-visit、
   *     social-judge、memory/nightly)。
   * 不抛、不重试。
   */
  skipWhenUnsafe(name: string, fn: () => Promise<void>): () => Promise<void>
}

/** 被网络守护冻住(暂停)的工作台任务(主人 2026-10-03)。 */
export interface SuspendedTask { taskId: string; title: string; providerId: string; since: number }

export interface GuardRuntimeDeps {
  stateDir: string
  log: (tag: string, line: string) => void
  /** 测试注入;缺省读 guard.json / 找真的 bx。 */
  isEnabled?: () => boolean
  config?: () => GuardConfig
  findBx?: () => string | null
  readBx?: typeof readBxStatus
  probeOnce?: () => Promise<{ reachable: boolean; error?: string }>
  agentConfig?: () => AgentConfig | null
  env?: NodeJS.ProcessEnv
  firstProbeWaitMs?: number
}

export function makeGuardRuntime(deps: GuardRuntimeDeps): GuardRuntime {
  const ref = new Ref<GuardLifecycle>('guard')
  const config = deps.config ?? (() => loadGuardConfig(deps.stateDir))
  const isEnabled = deps.isEnabled ?? (() => config().enabled)
  // guard.json signal_source='probe' ⇒ 装着 bx 也改用探测(「装了 bx 但在用别的 VPN」)。
  const rawFind = deps.findBx ?? (() => findBx())
  const find = () => (config().signal_source === 'probe' ? null : rawFind())
  const read = deps.readBx ?? ((bin: string) => readBxStatus(bin))
  const agentConfig = deps.agentConfig ?? (() => {
    const r = makeMtimeCachedConfigReader(deps.stateDir)
    return () => { try { return r() } catch { return null } }
  })()
  const gate = createNetworkGate({
    isEnabled,
    current: () => ref.current?.current() ?? null,
    pokeNow: () => ref.current?.pokeNow() ?? null,
    findBx: find,
    readBx: (bin) => read(bin),
    // 单测进程里绝不真探 google(没注入就当没结果 → 按失败算)。
    ...(deps.probeOnce ? { probeOnce: deps.probeOnce } : UNDER_TEST_RUNNER ? {} : { probeOnce: () => probeReachable(config().probe_url) }),
    ...(deps.firstProbeWaitMs !== undefined ? { firstProbeWaitMs: deps.firstProbeWaitMs } : {}),
    policy: () => { const c = config(); return { protect: c.protect, trust: c.trust, protectCustomGateways: c.protect_custom_gateways } },
    resolveTarget: makeResolveTarget(agentConfig, deps.env ?? process.env),
    log: deps.log,
  })
  let providersInUse: () => ProviderInUse[] = () => []
  let suspendedTasks: () => SuspendedTask[] = () => []
  const skipLogged = new Set<string>()

  function classifyInUse(): Array<ProviderInUse & { cls: CallClass }> {
    let list: ProviderInUse[] = []
    try { list = providersInUse() } catch { list = [] }
    return list.map(p => ({ ...p, cls: gate.classify(p.target ?? { provider: p.id, model: p.model ?? null, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), purpose: 'turn' }) }))
  }

  function health(): GuardHealth {
    let cfg: GuardConfig | null = null
    try { cfg = config() } catch { cfg = null }
    let enabled = true
    try { enabled = isEnabled() } catch { /* 读不出配置按开着算 */ }
    const s = ref.current?.current() ?? null
    const last: NetworkGateVerdict | null = gate.lastVerdict()
    const inUse = classifyInUse()
    const providers = inUse.map(p => ({ id: p.id, model: p.model ?? null, host: p.cls.host, protected: p.cls.protected, kind: p.cls.kind, label: p.cls.label, reason: p.cls.reason }))
    const protectedInUse = providers.some(p => p.protected)
    const extra = { signal_source: cfg?.signal_source ?? 'auto', protected_in_use: protectedInUse, providers } as const
    let base: Omit<GuardHealth, 'signal_source' | 'protected_in_use' | 'providers' | 'paused'>
    if (!enabled) base = { enabled: false, source: 'off', safe: true, detail: '网络守护未开启', ip: s?.ip ?? null, checked_at: s?.lastChecked ?? null }
    else if (s && s.lastChecked && s.source === 'probe' && Date.now() - Date.parse(s.lastChecked) >= DEFAULT_PROBE_TTL_MS + 60_000) {
      // 过期的探测结果 = 不知道(评审 #193 P1-2),和闸门同一口径。
      base = { enabled: true, source: 'probe', safe: false, detail: '探测结果已过期,等待重新探测', ip: s.ip, checked_at: s.lastChecked }
    } else if (s && s.lastChecked) base = { enabled: true, source: s.source, safe: s.safe, detail: s.detail, ip: s.ip, checked_at: s.lastChecked }
    else if (last && last.source !== 'off') base = { enabled: true, source: last.source, safe: last.safe, detail: last.detail, ip: null, checked_at: null }
    else base = { enabled: true, source: 'probe', safe: false, detail: '尚未探测', ip: null, checked_at: null }
    let suspended: SuspendedTask[] = []
    try { suspended = suspendedTasks() } catch { suspended = [] }
    return {
      ...base, ...extra, paused: base.enabled && !base.safe && protectedInUse,
      suspended: suspended.length,
      suspended_tasks: suspended.map(t => ({ task_id: t.taskId, title: t.title, provider: t.providerId, since: new Date(t.since).toISOString() })),
    }
  }

  function skipWhenUnsafe(name: string, fn: () => Promise<void>): () => Promise<void> {
    const quiet = (why: string) => {
      if (skipLogged.has(name)) return
      skipLogged.add(name)
      deps.log('GUARD', `${name}: ${why}(恢复后下一拍自动继续)`)
    }
    return async () => {
      const v = await gate.check()
      if (!v.safe) {
        const anyUnprotected = classifyInUse().some(p => !p.cls.protected)
        if (!anyUnprotected) { quiet(`skipped — network unprotected [${v.source}] ${v.detail}`); return }
      } else if (skipLogged.delete(name)) deps.log('GUARD', `${name}: network protected again — resuming`)
      try { await fn() } catch (err) {
        if (isNetworkUnprotectedError(err)) { quiet(`protected calls paused — network unprotected [${v.source}]`); return }
        throw err
      }
    }
  }

  return {
    ref,
    gate: { check: () => gate.check(), classify: (t) => gate.classify(t) },
    health,
    setProvidersInUse(fn) { providersInUse = fn },
    setSuspendedTasks(fn) { suspendedTasks = fn },
    classifyInUse,
    skipWhenUnsafe,
  }
}
