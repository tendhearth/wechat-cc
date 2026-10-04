/**
 * Guard scheduler — IP-change-triggered probing, bx-first (2026-10-02).
 *
 *   bx installed (findBx() non-null): every `bxPollMs` (default 10s) read
 *     `bx status --json` (local socket, read-only, ~70ms); safe iff
 *     protection_state=protected AND tunnel_healthy=true; anything
 *     unreadable = unsafe (fail closed). Public IP is still fetched every
 *     `pollMs` for display — an IP change lands in the same tick right
 *     before the bx read, so it is re-judged immediately. The google probe
 *     is not used in bx mode.
 *
 *   bx not installed — unchanged legacy behaviour below:
 *
 *   Every `pollMs` (default 30s):
 *     1. Fetch public IP via ipify (display + change detection only).
 *     2. Probe the canary URL when ANY of: first poll / IP changed (only
 *        detectable when ipify answered) / last result unsafe (every tick
 *        while down) / last result older than probeTtlMs (default 5 min).
 *        The probe never depends on ipify succeeding (review #193 P1-2).
 *     3. Otherwise keep the previous (still fresh) result. Fire
 *        onStateChange iff the reachable bit flipped.
 *
 * Why IP-triggered (not time-triggered): probing google.com on a fixed
 * cadence is wasteful and potentially noticeable (China firewall logs).
 * Public IP is the real state signal — VPN drops/reconnects always
 * change egress IP. Outside that signal, status is stable.
 *
 * The scheduler is config-aware (calls isEnabled() each tick) so the
 * dashboard toggle takes effect on the next tick — no restart needed.
 */

import { fetchPublicIp, probeReachable } from './probe'
import { readBxStatus, type BxVerdict } from './bx'

export interface GuardState {
  ip: string | null
  /** 兼容旧字段:= safe。onStateChange 按它的翻转关会话。 */
  reachable: boolean
  lastChecked: string | null  // ISO timestamp of last probe / bx read (NOT IP poll)
  lastError: string | null
  /** bx:装了 bx,按 `bx status --json` 判;probe:没装,按 ipify+探测判。 */
  source: 'bx' | 'probe'
  safe: boolean
  detail: string
}

/**
 * 守护 v2:**初始不安全**(v1 是 reachable=true —— 开机头一拍之前一律放行,是 fail-open)。
 * 还没有任何读数时,闸门会等一小会儿第一次结果(gate.ts),等不到按失败算。
 */
export function initialState(): GuardState {
  return { ip: null, reachable: false, lastChecked: null, lastError: null, source: 'probe', safe: false, detail: '尚未探测' }
}

/** 装了 bx 时每拍都读一次 bx(本机 socket,~70ms);公网 IP 仍按 pollMs 查。 */
export const DEFAULT_BX_POLL_MS = 10_000

export interface SchedulerDeps {
  pollMs: number
  isEnabled: () => boolean
  probeUrl: () => string
  ipifyUrl: () => string
  fetchPublicIp?: typeof fetchPublicIp        // injectable for tests
  probeReachable?: typeof probeReachable      // injectable for tests
  onStateChange?: (prev: GuardState, next: GuardState) => void | Promise<void>
  /** 每次真读到一次(bx 读一次 / probe 探一次)都调用,不管翻没翻转。停执行者的防抖靠它。 */
  onReading?: (state: GuardState) => void | Promise<void>
  log?: (tag: string, msg: string) => void
  /** 返回 bx 可执行文件路径;null = 没装 → 走旧的 ipify+探测。缺省视为没装。 */
  findBx?: () => string | null
  readBx?: (bin: string) => Promise<BxVerdict>   // injectable for tests
  bxPollMs?: number
  /** probe 模式下一次探测结果的有效期;过期就重探(不管 IP 查没查到)。缺省 DEFAULT_PROBE_TTL_MS。 */
  probeTtlMs?: number
  now?: () => number
}

/**
 * probe 模式下探测结果的有效期(评审 #193 P1-2)。换 IP 时立刻重探只是**加速**,不是唯一触发:
 * 公网 IP 查不到(ipify 被墙 / 网络本身断了)时它根本不会触发 —— 第一次失败就一直卡在不安全,
 * 第一次成功就在断网后一直放行。所以结果必须会过期:过期了就重探;不通期间每拍都探。
 */
export const DEFAULT_PROBE_TTL_MS = 5 * 60_000

export interface SchedulerHandle {
  current(): GuardState
  /** Force a poll right now (used by CLI `guard status` and tests). */
  pokeNow(): Promise<GuardState>
  stop(): Promise<void>
}

export function startGuardScheduler(deps: SchedulerDeps): SchedulerHandle {
  const log = deps.log ?? (() => {})
  const fIp = deps.fetchPublicIp ?? fetchPublicIp
  const fProbe = deps.probeReachable ?? probeReachable
  let state = initialState()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // Concurrent calls (auto-tick + pokeNow + a second pokeNow) share one
  // physical poll. Without this, the auto-tick on construction would
  // race against pokeNow() in tests (and against admin CLI in prod).
  let inFlightPromise: Promise<GuardState> | null = null
  const rBx = deps.readBx ?? ((bin: string) => readBxStatus(bin))
  const now = deps.now ?? Date.now
  let lastIpAt = -Infinity
  let bxMode = false

  async function commit(next: GuardState, prevIp: string | null): Promise<GuardState> {
    const flipped = state.reachable !== next.reachable || state.ip !== next.ip || state.source !== next.source
    const prev = state
    state = next
    try { await deps.onReading?.(next) }
    catch (err) { log('GUARD', `onReading threw: ${err instanceof Error ? err.message : String(err)}`) }
    if (flipped) {
      log('GUARD', `state[${next.source}] ip=${prevIp ?? '?'} → ${next.ip ?? '?'} safe=${prev.reachable} → ${next.reachable} (${next.detail})${next.lastError && next.source === 'probe' ? ` err=${next.lastError}` : ''}`)
      try { await deps.onStateChange?.(prev, next) }
      catch (err) { log('GUARD', `onStateChange threw: ${err instanceof Error ? err.message : String(err)}`) }
    }
    return next
  }

  async function bxTick(bin: string): Promise<GuardState> {
    // 公网 IP 只按 pollMs 查(展示 + 换 IP 时这一拍正好紧接着读 bx);bx 每拍都读。
    let ip = state.ip
    if (now() - lastIpAt >= deps.pollMs) {
      lastIpAt = now()
      const ipRes = await fIp({ url: deps.ipifyUrl() })
      if (ipRes.ip !== null) ip = ipRes.ip
    }
    const v = await rBx(bin)
    return commit({
      ip,
      reachable: v.safe,
      lastChecked: new Date(now()).toISOString(),
      lastError: v.safe ? null : v.detail,
      source: 'bx',
      safe: v.safe,
      detail: v.detail,
    }, state.ip)
  }

  async function tick(): Promise<GuardState> {
    if (stopped || !deps.isEnabled()) return state
    if (inFlightPromise) return inFlightPromise
    inFlightPromise = (async () => {
      // Never let tick() REJECT. Both schedule paths await it — the startup
      // `void tick().then(schedule)` and the recurring `await tick(); schedule()`
      // — so a rejection (an injected probe or a dep thunk like ipifyUrl/
      // isEnabled throwing) would skip schedule() and silently kill the guard
      // forever. Swallow any unexpected error and resolve with the current state
      // so polling continues to the next tick.
      try {
        const bxBin = deps.findBx?.() ?? null
        bxMode = bxBin !== null
        if (bxBin) return await bxTick(bxBin)
        const ipRes = await fIp({ url: deps.ipifyUrl() })
        const prevIp = state.ip
        // 换 IP(只在查得到 IP 时成立)= 立刻重探,加速;探测本身**不依赖** IP 查询成功。
        const ipChanged = ipRes.ip !== null && ipRes.ip !== prevIp
        // First poll after enable / restart (or leaving bx mode) always probes.
        // 守护 v2:ipify 失败也要探 —— 否则没有第一次结果,闸门会一直按失败算。
        const firstPoll = state.lastChecked === null || state.source !== 'probe'
        // 不通的时候每拍都再探一次(不管 IP 查没查到):恢复不必等换 IP,停执行者的
        // 「连续两次不安全」防抖也才有第二次读数。
        const stillDown = !state.reachable && state.source === 'probe'
        // 结果过期(评审 #193 P1-2):通着的时候也得隔一阵重探,否则 IP 查不到时断网永远发现不了。
        const expired = state.lastChecked !== null && now() - Date.parse(state.lastChecked) >= (deps.probeTtlMs ?? DEFAULT_PROBE_TTL_MS)
        if (!ipChanged && !firstPoll && !stillDown && !expired) return state
        const probe = await fProbe(deps.probeUrl())
        return await commit({
          ip: ipRes.ip ?? prevIp,
          reachable: probe.reachable,
          lastChecked: new Date(now()).toISOString(),
          lastError: probe.error ?? ipRes.error ?? null,
          source: 'probe',
          safe: probe.reachable,
          detail: probe.reachable ? '探测可达' : `探测失败${probe.error ? `(${probe.error})` : ''}`,
        }, prevIp)
      } catch (err) {
        log('GUARD', `tick failed (keeping prior state, will retry next poll): ${err instanceof Error ? err.message : String(err)}`)
        return state
      }
    })()
    try { return await inFlightPromise }
    finally { inFlightPromise = null }
  }

  function schedule() {
    if (stopped) return
    timer = setTimeout(async () => {
      await tick()
      schedule()
    }, bxMode ? (deps.bxPollMs ?? DEFAULT_BX_POLL_MS) : deps.pollMs)
  }

  // Kick off immediately so daemon startup learns its state in <3s.
  // Schedule the recurring tick AFTER the first one resolves so we don't
  // double-fire on slow networks.
  void tick().then(schedule)

  return {
    current: () => state,
    pokeNow: tick,
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
