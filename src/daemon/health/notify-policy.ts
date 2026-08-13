/**
 * notify-policy — 该不该打扰主人(spec 2026-08-03 §2 / §5)。
 *
 * 只在状态跳变时通知,不在每次失败时通知:一次持续 10 小时的故障因此只产生
 * 一条"坏了"和一条"恢复了"。报警系统最容易死在刷屏上 —— 发多了就会被无视,
 * 那还不如不发。
 */
import type { Incident } from './incident-store'

/** 主人能动手的:3 分钟。不说就永远不会好,每拖一分钟都是白白少服务。 */
export const NOTIFY_ACTIONABLE_MS = 180_000
/**
 * 主人做不了什么的(网络/TLS/上游抖动):30 分钟。
 *
 * MEASURED, NOT GUESSED. 这个值最初拍的是 15 分钟,后来拿本机 49 天、797 次
 * 真实中断的日志重新校准过(2026-08-03):
 *
 *   中位时长 42 秒 · 67.5% 不到 1 分钟 · 3.8% 落在 15–60 分钟 · 4.0% 超过 1 小时
 *
 * 按这个分布,15 分钟阈值会产生约 2.5 条/天的打扰(含恢复通知),而这些全是
 * 主人无法采取任何行动的网络问题 —— 正是"报警发多了就会被无视"的路子。
 * 提到 30 分钟后降到约 1.8 条/天,同时 43 次 ≥30 分钟的中断(含全部 32 次
 * 超过 1 小时的)一次不漏。低于阈值的中断并没有丢失:仪表盘横幅照常显示,
 * 只是不主动弹窗。
 *
 * 换一台网络特性不同的机器,这个值应当重新按同样的方法测,而不是照搬。
 */
export const NOTIFY_NON_ACTIONABLE_MS = 1_800_000
/** 可操作的故障每 6 小时提醒一次(自上一条通知起算)。 */
export const REPEAT_ACTIONABLE_MS = 21_600_000

export function shouldNotifyDown(incident: Incident, nowMs: number): boolean {
  if (incident.endedAt !== null) return false
  const threshold = incident.actionable ? NOTIFY_ACTIONABLE_MS : NOTIFY_NON_ACTIONABLE_MS
  const startedMs = Date.parse(incident.startedAt)
  if (!Number.isFinite(startedMs)) return false

  if (incident.notifiedAt === null) return nowMs - startedMs >= threshold

  // 已经通知过:不可操作的不再重复;可操作的每 6 小时一次。
  if (!incident.actionable) return false
  const notifiedMs = Date.parse(incident.notifiedAt)
  if (!Number.isFinite(notifiedMs)) return false
  return nowMs - notifiedMs >= REPEAT_ACTIONABLE_MS
}

/** 恢复通知必须与 down 通知配对 —— 没说过坏就别说恢复。 */
export function shouldNotifyRecovery(incident: Incident): boolean {
  return incident.endedAt !== null && incident.notifiedAt !== null
}
