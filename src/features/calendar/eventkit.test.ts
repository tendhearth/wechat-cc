import { describe, expect, it } from 'vitest'
import { readScript, requestScript, statusScript, parseRead, parseStatus, CAL_MAX_ITEMS, CAL_TITLE_MAX, dayWindow, formatAgenda } from './eventkit'

describe('scripts (只读)', () => {
  it('the read script never writes and never requests access', () => {
    const s = readScript({ startMs: 0, endMs: 1 })
    for (const bad of ['save', 'remove', 'commit', 'requestFullAccess', 'requestAccess']) expect(s, bad).not.toContain(bad)
    expect(s).toContain('eventsMatchingPredicate')
    expect(s).toContain('fetchRemindersMatchingPredicate')
  })
  it('only the request script requests, and it does not write either', () => {
    const r = requestScript()
    expect(r).toContain('requestFullAccessToEventsWithCompletion')
    expect(r).toContain('requestFullAccessToRemindersWithCompletion')
    for (const bad of ['save', 'remove', 'commit']) expect(r).not.toContain(bad)
    expect(statusScript()).not.toContain('request')
  })
  it('window values are baked in as numbers only', () => {
    expect(readScript({ startMs: 1700000000000, endMs: 1700086400000 })).toContain('1700000000000')
    expect(() => readScript({ startMs: NaN, endMs: 1 })).toThrow()
  })
})

describe('parseStatus', () => {
  it('maps EventKit codes; both must be full access for granted', () => {
    expect(parseStatus('{"events":3,"reminders":3}')).toBe('granted')
    expect(parseStatus('{"events":0,"reminders":0}')).toBe('not_determined')
    expect(parseStatus('{"events":3,"reminders":0}')).toBe('not_determined')
    expect(parseStatus('{"events":2,"reminders":3}')).toBe('denied')
    expect(parseStatus('{"events":1,"reminders":1}')).toBe('denied')   // restricted
    expect(parseStatus('nope')).toBe('unavailable')
  })
})

describe('parseRead', () => {
  it('keeps only title/time/calendar; caps counts and title length', () => {
    const many = Array.from({ length: CAL_MAX_ITEMS + 5 }, (_, i) => ({ title: 'x'.repeat(CAL_TITLE_MAX + 10), start: 1000 + i, end: 2000 + i, allDay: false, calendar: '工作', location: '会议室 A', notes: 'secret' }))
    const r = parseRead(JSON.stringify({ events: many, reminders: [{ title: '交报销', due: 5000, list: '提醒', notes: 'x' }] }))!
    expect(r.events).toHaveLength(CAL_MAX_ITEMS)
    expect(r.events[0]!.title.length).toBeLessThanOrEqual(CAL_TITLE_MAX)
    expect(Object.keys(r.events[0]!).sort()).toEqual(['allDay', 'calendar', 'end', 'start', 'title'])
    expect(r.reminders).toEqual([{ title: '交报销', due: 5000, list: '提醒' }])
  })
  it('bad output ⇒ null', () => {
    expect(parseRead('')).toBeNull()
    expect(parseRead('{"events":"x"}')).toBeNull()
    expect(parseRead('{"error":"denied"}')).toBeNull()
  })
})

describe('dayWindow / formatAgenda', () => {
  it('a local day in the owner timezone', () => {
    const w = dayWindow(Date.parse('2026-10-20T23:30:00Z'), 'Asia/Shanghai', 0)   // = 10-21 07:30 上海
    expect(new Date(w.startMs).toISOString()).toBe('2026-10-20T16:00:00.000Z')
    expect(w.endMs - w.startMs).toBe(86400000)
    expect(dayWindow(Date.parse('2026-10-20T23:30:00Z'), 'Asia/Shanghai', 1).startMs).toBe(w.endMs)
  })
  it('agenda lines: all-day first, then by time; reminders after; empty ⇒ says so', () => {
    const tz = 'Asia/Shanghai'
    const t = (h: number) => Date.parse(`2026-10-21T${String(h).padStart(2, '0')}:00:00+08:00`)
    const text = formatAgenda({ events: [{ title: '设计评审', start: t(10), end: t(11), allDay: false, calendar: '工作' }, { title: '妈妈生日', start: t(0), end: t(24 - 1), allDay: true, calendar: '家' }], reminders: [{ title: '交报销', due: t(15), list: '提醒' }] }, tz)
    expect(text.split('\n')).toEqual(['- 全天 妈妈生日(家)', '- 10:00–11:00 设计评审(工作)', '- 提醒 15:00 交报销'])
    expect(formatAgenda({ events: [], reminders: [] }, tz)).toBe('')
  })
})
