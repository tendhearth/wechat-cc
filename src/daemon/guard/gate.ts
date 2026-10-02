/**
 * NetworkGate 的 daemon 实现(守护 v2,2026-10-02)。两件事:
 *
 * 一、分类(classify):这一次调用要不要保护。补齐端点(claude 的 ANTHROPIC_BASE_URL、openai 的
 *     openaiBaseUrl……)和 Cursor 的默认模型,再套 guard.json 的 protect / trust 覆盖。
 *     判定本身在 lib/call-classifier.ts。
 *
 * 二、信号(check):只有需要保护的调用才问。
 *   - guard.json enabled=false → 放行(source=off)。开关语义不变。
 *   - 装了 bx(且 signal_source 不是 'probe')→ **bx 是唯一权威**:用调度器最近一次 bx 读数;
 *     读数缺失或过期就当场读一次(单飞 + 短缓存),读不出 → 不安全。不回落到 google。
 *   - 没装 bx(或 guard.json 明确 signal_source='probe')→ daemon 自己的 google 探测。
 *     **还没有第一次探测结果时**:等一小会儿(有上限,缺省 4s)让它出来;还没有 → 按失败算。
 *     (修掉 v1 的 fail-open:调度器初始 reachable=true,开机头一拍之前一律放行。)
 *
 * check() / classify() 永不抛。
 */
import type { NetworkGate, NetworkGateVerdict } from '../../lib/network-gate'
import { classifyCall, type CallClass, type CallTarget, type ClassifyPolicy } from '../../lib/call-classifier'
import type { BxVerdict } from './bx'
import type { GuardState } from './scheduler'

export interface NetworkGateDeps {
  isEnabled: () => boolean
  /** 调度器当前状态;调度器还没起来时返回 null。 */
  current: () => GuardState | null
  /** 让调度器马上跑一拍(单飞);调度器还没起来时返回 null。 */
  pokeNow?: () => Promise<GuardState> | null
  /** bx 路径;null = 没装,或 guard.json 指定了 signal_source='probe'。 */
  findBx: () => string | null
  readBx: (bin: string) => Promise<BxVerdict>
  /** 调度器还没起来时,闸门自己探一次 google(daemon 进程内 fetch)。缺省 = 不探(按没结果处理)。 */
  probeOnce?: () => Promise<{ reachable: boolean; error?: string }>
  /** 还没有第一次探测结果时最多等多久。缺省 4s。 */
  firstProbeWaitMs?: number
  /** bx 读数多旧算过期。缺省 30s(调度器每 10s 读一次)。 */
  staleMs?: number
  /** guard.json 的覆盖。缺省无覆盖。 */
  policy?: () => ClassifyPolicy
  /** 补齐这一次调用的端点 / 默认模型。缺省原样。 */
  resolveTarget?: (t: CallTarget) => CallTarget
  now?: () => number
  log?: (tag: string, msg: string) => void
}

const ON_DEMAND_CACHE_MS = 5_000
export const FIRST_PROBE_WAIT_MS = 4_000

export function createNetworkGate(deps: NetworkGateDeps): NetworkGate & { classify(t: CallTarget): CallClass; lastVerdict(): NetworkGateVerdict | null } {
  const now = deps.now ?? Date.now
  const staleMs = deps.staleMs ?? 30_000
  const waitMs = deps.firstProbeWaitMs ?? FIRST_PROBE_WAIT_MS
  let cached: { at: number; v: NetworkGateVerdict } | null = null
  let inFlight: Promise<NetworkGateVerdict> | null = null
  let probeCached: { at: number; v: NetworkGateVerdict } | null = null
  let probeInFlight: Promise<NetworkGateVerdict> | null = null
  let last: NetworkGateVerdict | null = null

  const fromState = (s: GuardState): NetworkGateVerdict => ({ safe: s.safe, source: s.source, detail: s.detail })

  async function onDemandBx(bin: string): Promise<NetworkGateVerdict> {
    if (cached && now() - cached.at < ON_DEMAND_CACHE_MS) return cached.v
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const poked = deps.pokeNow?.() ?? null
        if (poked) {
          const s = await poked
          if (s.source === 'bx' && s.lastChecked) return fromState(s)
        }
        const r = await deps.readBx(bin)
        return { safe: r.safe, source: 'bx' as const, detail: r.detail }
      } catch (err) {
        return { safe: false, source: 'bx' as const, detail: `bx 状态读取失败(${err instanceof Error ? err.message : String(err)})` }
      }
    })()
    try {
      const v = await inFlight
      cached = { at: now(), v }
      return v
    } finally { inFlight = null }
  }

  /** 还没有第一次探测结果:等调度器那一拍(或自己探一次),有上限;等不到 → 不安全。 */
  async function firstProbe(): Promise<NetworkGateVerdict> {
    if (probeCached && now() - probeCached.at < ON_DEMAND_CACHE_MS) return probeCached.v
    if (probeInFlight) return probeInFlight
    const noResult: NetworkGateVerdict = { safe: false, source: 'probe', detail: '还没拿到 VPN 探测结果(按失败处理)' }
    probeInFlight = (async () => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), waitMs) })
      try {
        const poked = deps.pokeNow?.() ?? null
        const attempt: Promise<NetworkGateVerdict | null> = poked
          ? poked.then(s => (s.source === 'probe' && s.lastChecked ? fromState(s) : null))
          : deps.probeOnce
            ? deps.probeOnce().then(r => ({ safe: r.reachable, source: 'probe' as const, detail: r.reachable ? '探测可达' : `探测失败${r.error ? `(${r.error})` : ''}` }))
            : Promise.resolve(null)
        const r = await Promise.race([attempt.catch(() => null), timeout])
        if (r === 'timeout' || r === null) {
          // 调度器那一拍可能没赶上探测(比如 ipify 失败没触发);再看一眼当前状态。
          const s = deps.current()
          if (s && s.source === 'probe' && s.lastChecked) return fromState(s)
          return noResult
        }
        return r
      } catch { return noResult } finally { if (timer) clearTimeout(timer) }
    })()
    try {
      const v = await probeInFlight
      probeCached = { at: now(), v }
      return v
    } finally { probeInFlight = null }
  }

  async function evaluate(): Promise<NetworkGateVerdict> {
    let enabled: boolean
    try { enabled = deps.isEnabled() } catch { enabled = true }
    if (!enabled) return { safe: true, source: 'off', detail: '网络守护未开启' }
    const s = deps.current()
    let bin: string | null
    try { bin = deps.findBx() } catch { bin = null }
    if (bin) {
      // bx 是唯一权威:关着 / 恢复中 / 读不出 → 不安全,不回落到 google。
      if (s && s.source === 'bx' && s.lastChecked && now() - Date.parse(s.lastChecked) < staleMs) return fromState(s)
      return onDemandBx(bin)
    }
    if (s && s.source === 'probe' && s.lastChecked) return { safe: s.reachable, source: 'probe', detail: s.detail }
    return firstProbe()
  }

  function classify(t: CallTarget): CallClass {
    let target = t
    try { if (deps.resolveTarget) target = deps.resolveTarget(t) } catch { /* 补不齐就按原样判 */ }
    let policy: ClassifyPolicy = {}
    try { policy = deps.policy?.() ?? {} } catch { /* 读不出覆盖就按默认判 */ }
    return classifyCall(target, policy)
  }

  return {
    async check() {
      let v: NetworkGateVerdict
      try { v = await evaluate() } catch (err) {
        v = { safe: false, source: 'bx', detail: `守护自检出错(${err instanceof Error ? err.message : String(err)})` }
      }
      last = v
      return v
    },
    classify,
    lastVerdict: () => last,
  }
}
