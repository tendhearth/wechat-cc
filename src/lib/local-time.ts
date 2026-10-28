/**
 * 某个 IANA 时区里的「哪天、几点」(纯函数,时钟由调用方传)。每晚整理记忆、CC 的信、定时任务都按主人的时区算;
 * 原来在 daemon/memory/nightly-schedule.ts,记忆搬进 src/features/memory 时挪到这里(架构终态 A5),
 * 免得信和定时为了一个时间函数伸进记忆功能。时区写错 ⇒ 按 UTC。
 */
function formatter(tz: string): Intl.DateTimeFormat {
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  try { return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz }) } catch { return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'UTC' }) }
}

export function localParts(ms: number, tz: string): { day: string; hhmm: string } {
  const p: Record<string, string> = {}
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value
  return { day: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` }
}
