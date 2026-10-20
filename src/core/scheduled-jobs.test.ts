import { describe, it, expect } from 'vitest'
import { parseJobCommand, isJobDue, weekdayOf, describeSchedule, nextRunLabel } from './scheduled-jobs'

describe('parseJobCommand', () => {
  it('the three schedule forms', () => {
    expect(parseJobCommand('定时 每天 8:30 看一下天气')).toEqual({ kind: 'add', schedule: { kind: 'daily', at: '08:30' }, text: '看一下天气' })
    expect(parseJobCommand('定时 每周一 9:00 看 issue')).toEqual({ kind: 'add', schedule: { kind: 'weekly', at: '09:00', weekday: 1 }, text: '看 issue' })
    expect(parseJobCommand('定时 每周日 21:15 回顾这周')).toMatchObject({ schedule: { kind: 'weekly', weekday: 7 } })
    expect(parseJobCommand('定时 每周天 21:15 回顾这周')).toMatchObject({ schedule: { kind: 'weekly', weekday: 7 } })
    expect(parseJobCommand('定时 工作日 18:00 今天各执行者做了什么')).toEqual({ kind: 'add', schedule: { kind: 'weekdays', at: '18:00' }, text: '今天各执行者做了什么' })
    expect(parseJobCommand('定时 每天 08：30 中文冒号')).toMatchObject({ schedule: { at: '08:30' } })
  })
  it('bad forms give usage', () => {
    for (const t of ['定时 每天 25:00 x', '定时 每天 9:00', '定时 每小时 x', '定时 每周八 9:00 x', `定时 每天 9:00 ${'字'.repeat(501)}`, '定时 随便'])
      expect(parseJobCommand(t)?.kind, t).toBe('usage')
  })
  it('list / pause / resume / remove', () => {
    expect(parseJobCommand('定时')).toEqual({ kind: 'list' })
    expect(parseJobCommand('定时 列表')).toEqual({ kind: 'list' })
    expect(parseJobCommand('定时 停 j3')).toEqual({ kind: 'pause', id: 'j3' })
    expect(parseJobCommand('定时 开 J3')).toEqual({ kind: 'resume', id: 'j3' })
    expect(parseJobCommand('定时 删 j12')).toEqual({ kind: 'remove', id: 'j12' })
  })
  it('anything else is not a job command', () => {
    expect(parseJobCommand('你好')).toBeNull()
    expect(parseJobCommand('定时器坏了吗')).toBeNull()
  })
})

describe('isJobDue', () => {
  const daily = { kind: 'daily' as const, at: '09:00' }
  it('inside the 10-minute window, once a day', () => {
    expect(isJobDue(daily, { day: '2026-10-20', hhmm: '09:00' }, null)).toBe(true)
    expect(isJobDue(daily, { day: '2026-10-20', hhmm: '09:09' }, null)).toBe(true)
    expect(isJobDue(daily, { day: '2026-10-20', hhmm: '09:10' }, null)).toBe(false)
    expect(isJobDue(daily, { day: '2026-10-20', hhmm: '08:59' }, null)).toBe(false)
    expect(isJobDue(daily, { day: '2026-10-20', hhmm: '09:01' }, '2026-10-20')).toBe(false)
    expect(isJobDue({ kind: 'daily', at: '23:55' }, { day: '2026-10-20', hhmm: '23:59' }, null)).toBe(true)
  })
  it('weekly and weekdays follow the local day', () => {
    expect(weekdayOf('2026-10-19')).toBe(1)
    expect(weekdayOf('2026-10-25')).toBe(7)
    expect(isJobDue({ kind: 'weekly', at: '09:00', weekday: 1 }, { day: '2026-10-19', hhmm: '09:00' }, null)).toBe(true)
    expect(isJobDue({ kind: 'weekly', at: '09:00', weekday: 1 }, { day: '2026-10-20', hhmm: '09:00' }, null)).toBe(false)
    expect(isJobDue({ kind: 'weekdays', at: '09:00' }, { day: '2026-10-24', hhmm: '09:00' }, null)).toBe(false)
    expect(isJobDue({ kind: 'weekdays', at: '09:00' }, { day: '2026-10-23', hhmm: '09:00' }, null)).toBe(true)
  })
})

describe('labels', () => {
  it('describe and next run', () => {
    expect(describeSchedule({ kind: 'weekly', at: '09:00', weekday: 1 })).toBe('每周一 09:00')
    expect(describeSchedule({ kind: 'weekdays', at: '18:00' })).toBe('工作日 18:00')
    expect(nextRunLabel({ kind: 'daily', at: '09:00' }, { day: '2026-10-20', hhmm: '08:00' })).toBe('今天 09:00')
    expect(nextRunLabel({ kind: 'daily', at: '09:00' }, { day: '2026-10-20', hhmm: '10:00' })).toBe('明天 09:00')
    expect(nextRunLabel({ kind: 'weekly', at: '09:00', weekday: 1 }, { day: '2026-10-20', hhmm: '10:00' })).toBe('10月26日(周一)09:00')
    expect(nextRunLabel({ kind: 'weekdays', at: '09:00' }, { day: '2026-10-23', hhmm: '10:00' })).toBe('10月26日(周一)09:00')
  })
})
