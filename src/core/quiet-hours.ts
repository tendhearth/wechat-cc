/**
 * 免打扰时段(第二轮对标 #5,对标 alfred_ 的 quiet hours):主人设的一段时间里,CC 不主动找他
 * (问候 / 关心 / 打猎 / 串门 / 记忆 / 信);主人自己定的(提醒、定时、早报)和一起做的通知照常。
 * 默认没设 = 不拦(默认窗口由主人定)。按主人时区算,跨午夜的窗口(23:00–08:00)照常。
 */
export interface QuietWindow { from: string; to: string }

const OFF = /^(关|off|无|没有|不要|取消)$/i
const pad = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
function hm(s: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2] ?? '0')
  return h <= 23 && mi <= 59 ? pad(h, mi) : null
}

/** 「23:00-8:00」「23-8」「22:30~7:15」「23:00至8:00」;「关 / off / 无」⇒ 不设。前后一样 ⇒ 不算。 */
export function parseQuietHours(raw: string): { ok: true; window: QuietWindow | null } | { ok: false; error: string } {
  const t = raw.trim()
  if (OFF.test(t)) return { ok: true, window: null }
  const m = /^(\S+?)\s*(?:-|~|～|—|–|至|到)\s*(\S+)$/.exec(t)
  const from = m ? hm(m[1]!) : null, to = m ? hm(m[2]!) : null
  if (!from || !to || from === to) return { ok: false, error: '免打扰的写法:/set 免打扰 23:00-8:00(关掉:/set 免打扰 关)' }
  return { ok: true, window: { from, to } }
}

const minutesOf = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
function localMinutes(nowMs: number, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs)).map(x => [x.type, x.value]))
  return Number(p.hour) * 60 + Number(p.minute)
}

export function inQuietHours(w: QuietWindow | undefined, nowMs: number, timeZone: string): boolean {
  if (!w) return false
  const now = localMinutes(nowMs, timeZone), a = minutesOf(w.from), b = minutesOf(w.to)
  return a < b ? now >= a && now < b : now >= a || now < b
}

export function quietLabel(w: QuietWindow | undefined): string {
  return w ? `${w.from}–${w.to}` : '没设'
}

/** 在窗口里时,窗口在什么时候结束(毫秒);不在窗口里 ⇒ null。 */
export function quietEndsAt(w: QuietWindow | undefined, nowMs: number, timeZone: string): number | null {
  if (!w || !inQuietHours(w, nowMs, timeZone)) return null
  const now = localMinutes(nowMs, timeZone), end = minutesOf(w.to)
  const left = (end - now + 24 * 60) % (24 * 60) || 24 * 60
  return Math.floor(nowMs / 60_000) * 60_000 + left * 60_000
}
