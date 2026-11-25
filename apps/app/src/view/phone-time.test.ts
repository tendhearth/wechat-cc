import { expect, it } from 'vitest'
import { phoneTime } from './phone-time'

const at = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute, 59).getTime()
const now = at(2026, 11, 22, 23, 0)

it.each([
  [at(2026, 11, 22, 19, 30), '19:30', '7:30 PM'],
  [at(2026, 11, 21, 19, 30), '昨天 19:30', 'Yesterday 7:30 PM'],
  [at(2026, 11, 18, 19, 30), '周三 19:30', 'Wed 7:30 PM'],
  [at(2026, 11, 16, 7, 5), '周一 07:05', 'Mon 7:05 AM'],
  [at(2026, 11, 15, 19, 30), '11 月 15 日', 'Nov 15'],
  [at(2025, 11, 22, 19, 30), '2025 年 11 月 22 日', 'Nov 22, 2025'],
])('formats %s in both languages using the local calendar', (value, zh, en) => {
  expect(phoneTime(value, now, 'zh-Hans')).toBe(zh)
  expect(phoneTime(value, now, 'en')).toBe(en)
})

it('uses local midnight even when only seconds elapsed, including across New Year', () => {
  const before = at(2026, 12, 31, 23, 59)
  const after = before + 1_000
  expect(phoneTime(new Date(before).toISOString(), after, 'zh-Hans')).toBe('昨天 23:59')
  expect(phoneTime(new Date(before).toISOString(), after, 'en')).toBe('Yesterday 11:59 PM')
  expect(phoneTime(after, after, 'zh-Hans')).toBe('00:00')
  expect(phoneTime(after, after, 'en')).toBe('12:00 AM')
  expect(phoneTime(at(2026, 12, 30, 12, 0), after, 'zh-Hans')).toBe('周三 12:00')
  expect(phoneTime(at(2026, 12, 30, 12, 0), after, 'en')).toBe('Wed 12:00 PM')
})

it('leaves missing or invalid timestamps blank', () => {
  for (const value of [null, undefined, '', 'unknown', NaN]) expect(phoneTime(value, now, 'en')).toBe('')
})
