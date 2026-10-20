import { describe, expect, it } from 'vitest'
import { buildActivity, activityTitle, ACTIVITY_WINDOW_MS, ACTIVITY_TITLE_MAX, type ActivityItem } from './cc-activity'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const item = (id: string, minsAgo: number, kind: ActivityItem['kind'] = 'job'): ActivityItem => ({ id, kind, at: NOW - minsAgo * 60_000, title: id })

describe('buildActivity', () => {
  it('merges sources newest first; ties by id; pages with a cursor without dupes or gaps', () => {
    const a = [item('a1', 1), item('a2', 30), item('a3', 30)]
    const b = [item('b1', 5), item('b2', 60)]
    const p1 = buildActivity({ jobs: a, decisions: b }, { now: NOW, limit: 2 })
    expect(p1.items.map(i => i.id)).toEqual(['a1', 'b1'])
    const p2 = buildActivity({ jobs: a, decisions: b }, { now: NOW, limit: 2, cursor: p1.next })
    expect(p2.items.map(i => i.id)).toEqual(['a2', 'a3'])
    const p3 = buildActivity({ jobs: a, decisions: b }, { now: NOW, limit: 2, cursor: p2.next })
    expect(p3.items.map(i => i.id)).toEqual(['b2'])
    expect(p3.next).toBeNull()
  })
  it('a failed source (null) is reported as degraded; others still show', () => {
    const r = buildActivity({ jobs: [item('a', 1)], letters: null }, { now: NOW })
    expect(r.items).toHaveLength(1)
    expect(r.degraded).toEqual(['letters'])
  })
  it('drops items outside the 14-day window and in the future; caps limit at 100', () => {
    const r = buildActivity({ jobs: [item('old', ACTIVITY_WINDOW_MS / 60_000 + 1), item('future', -10), item('ok', 1)] }, { now: NOW, limit: 1000 })
    expect(r.items.map(i => i.id)).toEqual(['ok'])
    const many = Array.from({ length: 150 }, (_, i) => item(`x${String(i).padStart(3, '0')}`, i))
    expect(buildActivity({ jobs: many }, { now: NOW, limit: 1000 }).items).toHaveLength(100)
  })
  it('a bad cursor is ignored (first page)', () => {
    expect(buildActivity({ jobs: [item('a', 1)] }, { now: NOW, cursor: '%%%' }).items).toHaveLength(1)
  })
})

describe('activityTitle', () => {
  it('one line, no absolute paths, capped', () => {
    expect(activityTitle('在 /Users/nate/work/wechat-cc 里\n做完了')).toBe('在 wechat-cc 里 做完了')
    expect(activityTitle('C:\\Users\\nate\\proj\\x 好了')).toBe('x 好了')
    expect([...activityTitle('字'.repeat(500))].length).toBe(ACTIVITY_TITLE_MAX)
  })
})
