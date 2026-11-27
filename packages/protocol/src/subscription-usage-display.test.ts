import { describe, expect, it } from 'vitest'
import { usageResetTime, usageWindowDisplay } from './subscription-usage-display.js'

const local = (day: number, hour = 12, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()
const now = local(2)

describe('额度重置时间', () => {
  it.each([
    [local(2, 15, 20), '15:20', '15:20'],
    [local(2, 15, 3), '15:03', '15:03'],
    [local(3, 0), '周二', 'Tue'],
    [local(5), '周四', 'Thu'],
    [local(9, 23), '周一', 'Mon'],
    [local(10), '11月10日', 'Nov 10'],
    [new Date(2027, 0, 2).getTime(), '2027年1月2日', 'Jan 2, 2027'],
    [now, null, null],
    [local(2, 11, 59), null, null],
    [null, null, null],
    [Infinity, null, null],
  ])('本地时间 %s → %s / %s', (reset, zh, en) => {
    expect(usageResetTime(reset, now)).toBe(zh)
    expect(usageResetTime(reset, now, 'en')).toBe(en)
  })

  it.each([
    [300, 40, local(2, 15, 20), '5 小时 40% · 15:20 重置', false, 40],
    [10080, 70, local(5), '本周 70% · 周四重置', false, 70],
    [300, 80, null, '5 小时 80%', false, 80],
    [300, 81, now, '5 小时 81%', true, 81],
    [300, 99.9, null, '5 小时 99%', true, 99.9],
    [300, 101, local(2, 15, 20), '5 小时 已用完，15:20 恢复', true, 100],
    [60, 100, now, '1 小时 已用完', true, 100],
    [90, 0, null, '90 分钟 0%', false, 0],
    [null, -1, null, '额度 0%', false, 0],
  ])('窗口 %s 分钟、使用 %s%% → %s', (durationMins, usedPercent, resetsAt, label, warning, percent) => {
    expect(usageWindowDisplay({ durationMins, usedPercent, resetsAt }, now)).toEqual({ label, warning, percent })
  })
})
