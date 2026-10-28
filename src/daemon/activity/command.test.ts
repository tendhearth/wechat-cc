import { describe, expect, it } from 'vitest'
import { makeActivityCommand, parseActivityCommand, formatActivityForWechat, ACTIVITY_WECHAT_LINES } from './command'
import type { ActivityItem } from '../../domain/cc-activity'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const item = (id: string, hoursAgo: number, title = id): ActivityItem => ({ id, kind: 'job', at: NOW - hoursAgo * 3_600_000, title })

describe('做过的事 (WeChat)', () => {
  it('parses', () => {
    expect(parseActivityCommand('做过的事')).toEqual({ days: 1 })
    expect(parseActivityCommand('做过的事 今天')).toEqual({ days: 1 })
    expect(parseActivityCommand('做过的事 本周')).toEqual({ days: 7 })
    expect(parseActivityCommand(' 做过的事  这周 ')).toEqual({ days: 7 })
    expect(parseActivityCommand('你做过的事')).toBeNull()
    expect(parseActivityCommand('做过的事情真多')).toBeNull()
  })
  it('formats newest first with times; caps lines; empty ⇒ says so; degraded ⇒ notes it', () => {
    const text = formatActivityForWechat({ items: [item('a', 1, '一起做「修测试」做完了'), item('b', 30, '早报:说了')], degraded: ['letters'] }, { now: NOW, days: 7, timeZone: 'Asia/Shanghai' })
    expect(text.split('\n')[0]).toBe('这一周 CC 替你做的事(2 件):')
    expect(text).toContain('· 10-20 19:00 一起做「修测试」做完了')
    expect(text).toContain('有一部分暂时读不到')
    const many = Array.from({ length: 40 }, (_, i) => item(`x${i}`, i * 0.1))
    const capped = formatActivityForWechat({ items: many, degraded: [] }, { now: NOW, days: 1, timeZone: 'Asia/Shanghai' })
    expect(capped.split('\n').filter(l => l.startsWith('· '))).toHaveLength(ACTIVITY_WECHAT_LINES)
    expect(capped).toContain('还有 25 件没列')
    expect(formatActivityForWechat({ items: [], degraded: [] }, { now: NOW, days: 1, timeZone: 'Asia/Shanghai' })).toBe('过去 24 小时 CC 还没替你做过什么。')
  })
  it('owner only; reads the window asked for', async () => {
    const said: string[] = []
    let asked = 0
    const cmd = makeActivityCommand({ isOwner: c => c === 'owner', say: async (_c, t) => { said.push(t) }, now: () => NOW, timeZone: () => 'Asia/Shanghai', items: (days) => { asked = days; return { items: [item('a', 2)], degraded: [] } } })
    expect(cmd.probe('做过的事', 'guest')).toBe(false)
    expect(cmd.probe('做过的事', 'owner')).toBe(true)
    await cmd.handle('做过的事 本周', 'owner')
    expect(asked).toBe(7)
    expect(said[0]).toContain('这一周')
  })
})
