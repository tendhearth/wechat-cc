/**
 * 读日历和提醒(只读,spec 2026-10-20-calendar-read-design,对标 #8):`osascript -l JavaScript` 经 ObjC 桥调 EventKit。
 * 这里只有脚本文本与纯函数(解析、时间窗、成文);跑 osascript、开关与授权在 daemon/calendar。
 * 规矩:读的脚本里没有任何写操作,也从不请求授权;请求授权只有 requestScript 一处,由主人亲口「日历 开」触发。
 */

export const CAL_MAX_ITEMS = 50
export const CAL_TITLE_MAX = 120

export type CalendarStatus = 'granted' | 'not_determined' | 'denied' | 'unavailable'
export interface CalEvent { title: string; start: number; end: number; allDay: boolean; calendar: string }
export interface CalReminder { title: string; due: number | null; list: string }
export interface CalRead { events: CalEvent[]; reminders: CalReminder[] }

const STATUS_JS = `JSON.stringify({events:Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent)),reminders:Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeReminder))})`

/** 只看授权状态,不弹框。 */
export function statusScript(): string {
  return `ObjC.import('EventKit');\n${STATUS_JS}`
}

/** 请求事件 + 提醒两项完全访问(Mac 上弹框),等主人点完(最多 120 秒),回授权状态。只在主人说「日历 开」时跑。 */
export function requestScript(): string {
  return [
    `ObjC.import('EventKit');`,
    `const store = $.EKEventStore.alloc.init;`,
    `let pending = 2;`,
    `store.requestFullAccessToEventsWithCompletion(function () { pending--; });`,
    `store.requestFullAccessToRemindersWithCompletion(function () { pending--; });`,
    `const until = Date.now() + 120000;`,
    `while (pending > 0 && Date.now() < until) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));`,
    STATUS_JS,
  ].join('\n')
}

/** 读一个时间窗:事件(标题、起止、全天、日历名)+ 未完成且到期 ≤ 窗口末的提醒(标题、到期、列表名)。不取备注 / 参会人 / 地点。 */
export function readScript(w: { startMs: number; endMs: number }): string {
  if (!Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) throw new Error('invalid_window')
  const start = Math.round(w.startMs), end = Math.round(w.endMs)
  return [
    `ObjC.import('EventKit');`,
    `const store = $.EKEventStore.alloc.init;`,
    `const s = $.NSDate.dateWithTimeIntervalSince1970(${start} / 1000), e = $.NSDate.dateWithTimeIntervalSince1970(${end} / 1000);`,
    `const str = function (x) { try { const v = ObjC.unwrap(x); return typeof v === 'string' ? v : ''; } catch (_) { return ''; } };`,
    `const ms = function (d) { return d && !d.isNil() ? Math.round(d.timeIntervalSince1970 * 1000) : null; };`,
    `const events = [];`,
    `const evs = store.eventsMatchingPredicate(store.predicateForEventsWithStartDateEndDateCalendars(s, e, $()));`,
    `for (let i = 0; i < evs.count && i < ${CAL_MAX_ITEMS}; i++) { const ev = evs.objectAtIndex(i); events.push({ title: str(ev.title), start: ms(ev.startDate), end: ms(ev.endDate), allDay: !!ev.allDay, calendar: str(ev.calendar.title) }); }`,
    `const reminders = []; let done = false;`,
    `store.fetchRemindersMatchingPredicateCompletion(store.predicateForIncompleteRemindersWithDueDateStartingEndingCalendars($(), e, $()), function (rs) {`,
    `  try { for (let i = 0; rs && i < rs.count && i < ${CAL_MAX_ITEMS}; i++) { const r = rs.objectAtIndex(i); const c = r.dueDateComponents; const d = c && !c.isNil() ? $.NSCalendar.currentCalendar.dateFromComponents(c) : null; reminders.push({ title: str(r.title), due: ms(d), list: str(r.calendar.title) }); } } catch (_) {}`,
    `  done = true; });`,
    `const until = Date.now() + 15000;`,
    `while (!done && Date.now() < until) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));`,
    `JSON.stringify({ events: events, reminders: reminders })`,
  ].join('\n')
}

/** EventKit 授权码:0 未决定 / 1 受限 / 2 拒绝 / 3 完全访问 / 4 只写。两项都是完全访问才算授权了。 */
export function parseStatus(out: string): CalendarStatus {
  let o: { events?: unknown; reminders?: unknown }
  try { o = JSON.parse(out.trim()) } catch { return 'unavailable' }
  const ev = Number(o?.events), re = Number(o?.reminders)
  if (!Number.isInteger(ev) || !Number.isInteger(re)) return 'unavailable'
  if (ev === 3 && re === 3) return 'granted'
  if ([1, 2].includes(ev) || [1, 2].includes(re)) return 'denied'
  return 'not_determined'
}

const clip = (s: unknown) => (typeof s === 'string' ? s : '').replace(/[\r\n]+/g, ' ').trim().slice(0, CAL_TITLE_MAX)
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null)

/** 读脚本的输出 ⇒ 只留标题 / 时间 / 日历名,数量和长度封顶;不是这个形状 ⇒ null(当读失败)。 */
export function parseRead(out: string): CalRead | null {
  let o: { events?: unknown; reminders?: unknown }
  try { o = JSON.parse(out.trim()) } catch { return null }
  if (!o || !Array.isArray(o.events) || !Array.isArray(o.reminders)) return null
  const events: CalEvent[] = []
  for (const e of o.events.slice(0, CAL_MAX_ITEMS) as Array<Record<string, unknown>>) {
    const start = num(e?.start), end = num(e?.end)
    if (start === null || end === null) continue
    events.push({ title: clip(e.title), start, end, allDay: e.allDay === true, calendar: clip(e.calendar) })
  }
  const reminders: CalReminder[] = (o.reminders.slice(0, CAL_MAX_ITEMS) as Array<Record<string, unknown>>)
    .map(r => ({ title: clip(r?.title), due: num(r?.due), list: clip(r?.list) }))
    .filter(r => r.title)
  return { events, reminders }
}

/** 主人时区里某一天的 [0 点, 次日 0 点)。offsetDays:0 今天、1 明天。 */
export function dayWindow(nowMs: number, timeZone: string, offsetDays: number): { startMs: number; endMs: number } {
  const ymd = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t)).map(x => [x.type, x.value]))
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day) }
  }
  // 那一刻在 tz 里的墙上时间 - 那一刻 = 偏移
  const offset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)).map(x => [x.type, x.value]))
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(t / 1000) * 1000
  }
  const midnight = (y: number, m: number, d: number) => {
    const guess = Date.UTC(y, m - 1, d)
    const first = guess - offset(guess)
    return guess - offset(first)
  }
  const today = ymd(nowMs)
  const base = new Date(Date.UTC(today.y, today.m - 1, today.d + offsetDays))
  const next = new Date(Date.UTC(today.y, today.m - 1, today.d + offsetDays + 1))
  return { startMs: midnight(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()), endMs: midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) }
}

/** 成文(早报素材 / 「日历」命令):全天的在前,再按开始时间;提醒在后。什么都没有 ⇒ 空串。 */
export function formatAgenda(r: CalRead, timeZone: string): string {
  const hm = (t: number) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t))
  const cal = (c: string) => (c ? `(${c})` : '')
  const events = [...r.events].sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1))
  const lines = events.map(e => e.allDay ? `- 全天 ${e.title}${cal(e.calendar)}` : `- ${hm(e.start)}–${hm(e.end)} ${e.title}${cal(e.calendar)}`)
  const reminders = [...r.reminders].sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity))
  for (const x of reminders) lines.push(x.due === null ? `- 提醒 ${x.title}` : `- 提醒 ${hm(x.due)} ${x.title}`)
  return lines.join('\n')
}
