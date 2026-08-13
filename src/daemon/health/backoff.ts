/**
 * backoff — 重试间隔(spec 2026-08-03 §3)。
 *
 * 封顶 60s 的依据:正常工作时长轮询就是 35 秒一次
 * (LONG_POLL_TIMEOUT_MS)。故障时每 2 秒打一次、比正常还密集,既无意义
 * 又是触发风控的形状 —— 2026-08-02 那次 10.5 小时故障因此产生了 4211 次
 * 连续失败请求,还把 10MB 日志刷爆触发轮转。
 *
 * 抖动防止多账号/多实例在恢复瞬间同时冲上去。
 */

export const BACKOFF_BASE_MS = 2_000
export const BACKOFF_CAP_MS = 60_000
export const BACKOFF_JITTER = 0.2

/** attempt 从 0 开始:0→2s, 1→4s, 2→8s … 封顶 60s,再叠 ±20% 抖动。 */
export function nextBackoffMs(
  attempt: number,
  opts: { baseMs?: number; capMs?: number; jitter?: number; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? BACKOFF_BASE_MS
  const cap = opts.capMs ?? BACKOFF_CAP_MS
  const jitter = opts.jitter ?? BACKOFF_JITTER
  const random = opts.random ?? Math.random
  const n = Math.max(0, Math.floor(attempt))
  // 2^n 在 n 很大时会溢出成 Infinity,先封顶再算抖动。
  const raw = Math.min(cap, base * 2 ** Math.min(n, 30))
  const factor = 1 + (random() * 2 - 1) * jitter
  return Math.round(raw * factor)
}
