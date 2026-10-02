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
 *     1. Fetch public IP via ipify.
 *     2. If IP unchanged → no probe; previous reachable state stays.
 *     3. If IP changed (or first poll, or transitioning enabled) →
 *        probe canary URL. Update state. Fire onStateChange iff the
 *        reachable bit flipped.
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

export function initialState(): GuardState {
  return { ip: null, reachable: true, lastChecked: null, lastError: null, source: 'probe', safe: true, detail: '尚未探测' }
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
  log?: (tag: string, msg: string) => void
  /** 返回 bx 可执行文件路径;null = 没装 → 走旧的 ipify+探测。缺省视为没装。 */
  findBx?: () => string | null
  readBx?: (bin: string) => Promise<BxVerdict>   // injectable for tests
  bxPollMs?: number
  now?: () => number
}

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
        const ipChanged = ipRes.ip !== null && ipRes.ip !== prevIp
        // First successful poll after enable / restart counts as a change
        // so we always know reachable status before any inbound arrives.
        // Leaving bx mode (bx uninstalled) also forces a fresh probe.
        const firstPoll = (state.lastChecked === null || state.source !== 'probe') && ipRes.ip !== null
        if (!ipChanged && !firstPoll) return state
        const probe = await fProbe(deps.probeUrl())
        return await commit({
          ip: ipRes.ip,
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
