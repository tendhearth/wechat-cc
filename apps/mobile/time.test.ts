import { expect, it } from 'vitest'
import { readMobileSource } from './sources'

const { mobileTime, ago } = new Function(readMobileSource('time.js') + ';return {mobileTime, ago}')() as {
  mobileTime: (value: string | number, now: number) => string
  ago: (value: string | number, now: number) => string
}
const now = new Date(2026, 5, 8, 17).getTime()

it.each([
  ['2026-06-08T16:00:00', '16:00'],
  ['2026-06-07T16:00:00', '昨天 16:00'],
  ['2026-06-03T16:00:00', '周三 16:00'],
  ['2026-06-01T00:05:00', '周一 00:05'],
  ['2026-01-31T16:00:00', '1 月 31 日'],
  ['2025-12-31T16:00:00', '2025 年 12 月 31 日'],
])('formats %s in the local calendar', (value, expected) => {
  expect(mobileTime(value, now)).toBe(expected)
})

it('keeps relative times through thirty days, then uses the shared date format', () => {
  const thirtyDaysAgo = now - 30 * 864e5
  expect(ago(now - 30_000, now)).toBe('刚刚')
  expect(ago(thirtyDaysAgo, now)).toBe('30 天前')
  expect(ago(thirtyDaysAgo - 1, now)).toBe('5 月 9 日')
  expect(ago('2025-12-31T16:00:00', now)).toBe('2025 年 12 月 31 日')
  expect(ago('invalid', now)).toBe('')
})
