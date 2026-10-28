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
    // 窗口里建的:马上就会跑,别说「明天」(终审 minor)
    expect(nextRunLabel({ kind: 'daily', at: '09:00' }, { day: '2026-10-20', hhmm: '09:05' })).toBe('马上(今天 09:00 这次)')
    expect(nextRunLabel({ kind: 'weekly', at: '09:00', weekday: 1 }, { day: '2026-10-20', hhmm: '10:00' })).toBe('10月26日(周一)09:00')
    expect(nextRunLabel({ kind: 'weekdays', at: '09:00' }, { day: '2026-10-23', hhmm: '10:00' })).toBe('10月26日(周一)09:00')
  })
})

describe('时区标在回显里(10-20 真机核对踩到:--at 按主人时区)', () => {
  it('tzLabel and describeSchedule with a timezone', async () => {
    const { tzLabel } = await import('./scheduled-jobs')
    expect(tzLabel('Asia/Shanghai')).toBe('上海')
    expect(tzLabel('America/Los_Angeles')).toBe('Los Angeles')
    expect(tzLabel('UTC')).toBe('UTC')
    expect(describeSchedule({ kind: 'daily', at: '18:10' }, 'Asia/Shanghai')).toBe('每天 18:10(上海)')
    expect(describeSchedule({ kind: 'daily', at: '18:10' })).toBe('每天 18:10')
  })
})

describe('早报(对标 #7)', () => {
  it('定时 早报 [工作日] HH:MM is a brief job', () => {
    expect(parseJobCommand('定时 早报 8:00')).toEqual({ kind: 'add', schedule: { kind: 'daily', at: '08:00' }, text: '早报', brief: true })
    expect(parseJobCommand('定时 早报 工作日 7:30')).toEqual({ kind: 'add', schedule: { kind: 'weekdays', at: '07:30' }, text: '早报', brief: true })
    expect(parseJobCommand('定时 早报')?.kind).toBe('usage')
    expect(parseJobCommand('定时 早报 25:00')?.kind).toBe('usage')
  })
  it('早报 口味 commands', async () => {
    const { parseBriefPref } = await import('./scheduled-jobs')
    expect(parseBriefPref('早报 少点 技术细节')).toEqual({ kind: 'add', line: '少点:技术细节' })
    expect(parseBriefPref('早报 多点 天气')).toEqual({ kind: 'add', line: '多点:天气' })
    expect(parseBriefPref('早报 偏好')).toEqual({ kind: 'show' })
    expect(parseBriefPref('早报 偏好 清空')).toEqual({ kind: 'clear' })
    expect(parseBriefPref('早报')).toEqual({ kind: 'show' })
    expect(parseBriefPref('早报 少点')).toEqual({ kind: 'usage' })
    expect(parseBriefPref(`早报 少点 ${'字'.repeat(81)}`)).toEqual({ kind: 'usage' })
    expect(parseBriefPref('早报来了吗')).toBeNull()
    expect(parseBriefPref('今天早报呢')).toBeNull()
  })
})

describe('周报(定时 周报 [周X] HH:MM)', () => {
  it('defaults to Sunday; a weekday can be given; bad time ⇒ usage', () => {
    expect(parseJobCommand('定时 周报 20:00')).toEqual({ kind: 'add', schedule: { kind: 'weekly', at: '20:00', weekday: 7 }, text: '周报', recap: true })
    expect(parseJobCommand('定时 周报 周五 18:30')).toEqual({ kind: 'add', schedule: { kind: 'weekly', at: '18:30', weekday: 5 }, text: '周报', recap: true })
    expect(parseJobCommand('定时 周报')).toMatchObject({ kind: 'usage' })
    expect(parseJobCommand('定时 周报 周八 9:00')).toMatchObject({ kind: 'usage' })
  })
})
