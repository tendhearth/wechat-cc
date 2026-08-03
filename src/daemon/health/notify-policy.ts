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
/** 主人做不了什么的:15 分钟。足以滤掉绝大多数会自愈的抖动。 */
export const NOTIFY_NON_ACTIONABLE_MS = 900_000
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
