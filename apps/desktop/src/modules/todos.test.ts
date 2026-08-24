import { describe, expect, it, vi } from 'vitest'

vi.mock('../view.js', () => ({ escapeHtml: (s: string) => s }))
vi.mock('../api.js', () => ({ invokeApi: vi.fn() }))

// @ts-expect-error minimal DOM stub before import (module shape parity with memory.test.ts)
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] }

const { groupObligations, reminderSlots, recentSettled } = await import('./todos.js')

function row(id: number, contact: string, value: string, updated: number) {
  return { id, contact, kind: 'obligation', predicate: 'p', value, time_ref: null, confidence: 'med', updated_at: updated }
}

describe('groupObligations', () => {
  it('groups by contact with display names, newest activity first', () => {
    const names = new Map([['wx_a', '张三']])
    const groups = groupObligations([
      row(1, 'wx_a', '旧的', 100),
      row(2, 'wx_b', '中间的', 200),
      row(3, 'wx_a', '新的', 300),
    ] as never, names)
    expect(groups.map(g => g.display)).toEqual(['张三', 'wx_b'])   // wx_a 有 300 → 排前;wx_b 无 display → 回退 username
    expect(groups[0]!.items.map(i => i.value)).toEqual(['新的', '旧的'])
  })
})

describe('recentSettled', () => {
  const now = 1_756_000_000
  const day = 86400
  it('keeps only the last 7 days, newest first, capped at 20', () => {
    const rows = [
      row(1, 'wx_a', '三天前了结', now - 3 * day),
      row(2, 'wx_a', '刚了结', now - 60),
      row(3, 'wx_a', '八天前了结', now - 8 * day),   // outside window
    ]
    expect(recentSettled(rows as never, now).map((r: { value: string }) => r.value))
      .toEqual(['刚了结', '三天前了结'])
    const many = Array.from({ length: 30 }, (_, i) => row(i, 'wx_a', `v${i}`, now - i * 60))
    expect(recentSettled(many as never, now)).toHaveLength(20)
  })
})

describe('reminderSlots', () => {
  it('offers tonight only while tonight is still ahead', () => {
    const morning = reminderSlots(new Date('2026-08-24T10:00:00'))
    expect(morning.map(s => s.label)).toEqual(['今晚 21:00', '明早 9:30'])
    const late = reminderSlots(new Date('2026-08-24T22:30:00'))
    expect(late.map(s => s.label)).toEqual(['明早 9:30'])
  })
})
