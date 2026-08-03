/**
 * connection-health — 按依赖分别维护的两态健康机(spec 2026-08-03 §1)。
 *
 * 状态由 REAL CALLS 的成败驱动,不由探活驱动:真实调用是最准的探针,而且免费。
 * 探活(guard/probe.ts)只用于诊断文案,永不参与这里的判定 —— 大陆用户
 * google.com 本就不通,而用 Kimi/DeepSeek 的用户无需代理、LLM 完全正常,
 * 拿探活门控会把他们的 bot 静默锁死。
 *
 * 只有两个状态。degraded 期间该停什么由调用方决定,这里只回答"是否已确认坏了"。
 */

/** 各自独立:两者坏掉时该做的事正好相反(见 spec §1 的表)。 */
export type Dependency = 'wechat' | 'llm'

export type HealthStatus = 'healthy' | 'degraded'

export interface HealthState {
  status: HealthStatus
  /** 当前这轮连续失败的第一次失败时刻(ms);healthy 时为 null。 */
  firstFailureAt: number | null
  consecutiveFailures: number
  lastError: string | null
}

/**
 * 连续失败持续这么久才算"确认坏了"。用时间而非次数 —— 加了退避之后
 * "N 次失败"的实际时长会随参数漂移,而 60 秒始终可理解,且足以跨过
 * WiFi 切换 / VPN 重连 / 笔记本唤醒。
 */
export const SUSPEND_AFTER_MS = 60_000

export interface ConnectionHealth {
  recordSuccess(dep: Dependency): void
  recordFailure(dep: Dependency, err: unknown): void
  get(dep: Dependency): HealthState
  /** true ⇒ 调用方应停止该依赖上的外发 / LLM 轮次。 */
  shouldSuspend(dep: Dependency): boolean
}

function fresh(): HealthState {
  return { status: 'healthy', firstFailureAt: null, consecutiveFailures: 0, lastError: null }
}

function messageOf(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err)
  } catch {
    // Guard against malicious toString() or message property that throws.
    // Health machine must never become a failure vector itself.
    return '<error>'
  }
}

export function makeConnectionHealth(deps: { now: () => number }): ConnectionHealth {
  const states = new Map<Dependency, HealthState>()

  function stateOf(dep: Dependency): HealthState {
    let s = states.get(dep)
    if (!s) { s = fresh(); states.set(dep, s) }
    return s
  }

  return {
    recordSuccess(dep) {
      states.set(dep, fresh())
    },
    recordFailure(dep, err) {
      const s = stateOf(dep)
      const now = deps.now()
      if (s.firstFailureAt === null) s.firstFailureAt = now
      s.consecutiveFailures += 1
      s.lastError = messageOf(err)
      if (now - s.firstFailureAt >= SUSPEND_AFTER_MS) s.status = 'degraded'
    },
    get(dep) {
      return { ...stateOf(dep) }
    },
    shouldSuspend(dep) {
      return stateOf(dep).status === 'degraded'
    },
  }
}
