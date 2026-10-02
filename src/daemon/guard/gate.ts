/**
 * NetworkGate 的 daemon 实现:把守护调度器的状态翻成「此刻能不能调模型」。
 *
 *   - guard.json enabled=false → 放行(source=off)。开关语义不变。
 *   - 装了 bx → 用调度器最近一次 bx 读数;读数缺失或过期(调度器还没跑第一拍 /
 *     子系统降级没起来 / 卡住)就当场读一次(单飞 + 短缓存),读不出 → 不安全。
 *   - 没装 bx → 旧语义:调度器的 reachable(初始 true,IP 变了才探测)。
 *
 * check() 永不抛。
 */
import type { NetworkGate, NetworkGateVerdict } from '../../lib/network-gate'
import type { BxVerdict } from './bx'
import type { GuardState } from './scheduler'

export interface NetworkGateDeps {
  isEnabled: () => boolean
  /** 调度器当前状态;调度器还没起来时返回 null。 */
  current: () => GuardState | null
  /** 让调度器马上跑一拍(单飞);调度器还没起来时返回 null。 */
  pokeNow?: () => Promise<GuardState> | null
  findBx: () => string | null
  readBx: (bin: string) => Promise<BxVerdict>
  /** bx 读数多旧算过期。缺省 30s(调度器每 10s 读一次)。 */
  staleMs?: number
  now?: () => number
  log?: (tag: string, msg: string) => void
}

const ON_DEMAND_CACHE_MS = 5_000

export function createNetworkGate(deps: NetworkGateDeps): NetworkGate & { lastVerdict(): NetworkGateVerdict | null } {
  const now = deps.now ?? Date.now
  const staleMs = deps.staleMs ?? 30_000
  let cached: { at: number; v: NetworkGateVerdict } | null = null
  let inFlight: Promise<NetworkGateVerdict> | null = null
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

  async function evaluate(): Promise<NetworkGateVerdict> {
    let enabled: boolean
    try { enabled = deps.isEnabled() } catch { enabled = true }
    if (!enabled) return { safe: true, source: 'off', detail: '网络守护未开启' }
    const s = deps.current()
    let bin: string | null
    try { bin = deps.findBx() } catch { bin = null }
    if (bin) {
      if (s && s.source === 'bx' && s.lastChecked && now() - Date.parse(s.lastChecked) < staleMs) return fromState(s)
      return onDemandBx(bin)
    }
    if (!s) return { safe: true, source: 'probe', detail: '尚未探测' }
    return { safe: s.reachable, source: 'probe', detail: s.detail }
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
    lastVerdict: () => last,
  }
}
