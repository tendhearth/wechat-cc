/** 每晚整理的时间判断,全部按主人的 IANA 时区(companion config.timezone)。纯函数,时钟由调用方传。 */
import { localParts } from '../../lib/local-time'

export { localParts }

export const NOTICE_EARLIEST = '09:00'
export const NOTICE_TTL_MS = 24 * 3_600_000

export function isDue(o: { nowMs: number; tz: string; at: string; lastRunDay: string | null }): boolean {
  const { day, hhmm } = localParts(o.nowMs, o.tz)
  return hhmm >= o.at && o.lastRunDay !== day
}

export function noticeTiming(o: { nowMs: number; tz: string; createdAtMs: number }): 'send' | 'wait' | 'expire' {
  if (o.nowMs - o.createdAtMs > NOTICE_TTL_MS) return 'expire'
  return localParts(o.nowMs, o.tz).hhmm >= NOTICE_EARLIEST ? 'send' : 'wait'
}
