/**
 * 外发送不出去时的重试节奏(提醒、任务回报共用;原在 reminders/sweeper.ts,架构终态 A5 挪到底层)。
 * 断线时的指数退避是硬规矩(微信风控:不许重试风暴)。
 */

/** How long after due_at we keep retrying a failing delivery before giving up. */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * Exponential retry backoff: 1min, 2min, 4min, … capped at 60min. June's
 * flat every-sweep retry meant a disconnected hour produced 60 send attempts
 * per reminder — the no-retry-storm rule requires exponential spacing
 * (WeChat risk control). `attempts` is the count of failures so far (>=1).
 */
export function backoffMs(attempts: number): number {
  return Math.min(3_600_000, 60_000 * 2 ** (attempts - 1))
}
