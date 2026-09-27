/** 每晚整理的时间判断,全部按主人的 IANA 时区(companion config.timezone)。纯函数,时钟由调用方传。 */
export const NOTICE_EARLIEST = '09:00'
export const NOTICE_TTL_MS = 24 * 3_600_000

function formatter(tz: string): Intl.DateTimeFormat {
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  try { return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz }) } catch { return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'UTC' }) }
}

export function localParts(ms: number, tz: string): { day: string; hhmm: string } {
  const p: Record<string, string> = {}
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value
  return { day: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` }
}

export function isDue(o: { nowMs: number; tz: string; at: string; lastRunDay: string | null }): boolean {
  const { day, hhmm } = localParts(o.nowMs, o.tz)
  return hhmm >= o.at && o.lastRunDay !== day
}

export function noticeTiming(o: { nowMs: number; tz: string; createdAtMs: number }): 'send' | 'wait' | 'expire' {
  if (o.nowMs - o.createdAtMs > NOTICE_TTL_MS) return 'expire'
  return localParts(o.nowMs, o.tz).hhmm >= NOTICE_EARLIEST ? 'send' : 'wait'
}
