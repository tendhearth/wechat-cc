import { describe, expect, it } from 'vitest'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import { activityDayLabel, activityGroups, activityHref, activityView, mergeActivity } from './activity'
import { makeDemoBackend } from '../backend/demo'
import type { ActivityItemT } from '../backend/types'

// 本地时间造时刻:测试不依赖跑测试那台机器的时区
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()
const NOW = at(20, 15)
const item = (over: Partial<ActivityItemT> & { id: string }): ActivityItemT => ({ kind: 'proactive', at: NOW, title: '主动跟你说了一句', ...over })

describe('CC 做过的事 视图', () => {
  it('组名:今天 / 昨天 / M月D日;英文 Today / Yesterday / M/D', () => {
    expect(activityDayLabel(at(20, 0, 1), NOW, 'zh-Hans')).toBe('今天')
    expect(activityDayLabel(at(19, 23, 59), NOW, 'zh-Hans')).toBe('昨天')
    expect(activityDayLabel(at(18, 9), NOW, 'zh-Hans')).toBe('10月18日')
    expect(activityDayLabel(at(19, 9), NOW, 'en')).toBe('Yesterday')
    expect(activityDayLabel(at(6, 9), NOW, 'en')).toBe('10/6')
    // 跨月的「昨天」
    expect(activityDayLabel(new Date(2026, 9, 31, 22).getTime(), new Date(2026, 10, 1, 8).getTime(), 'zh-Hans')).toBe('昨天')
  })
  it('按天分组、新的在前;一行 = 本地 HH:MM + 电脑那句原样', () => {
    const g = activityGroups([
      item({ id: 'a', at: at(18, 9, 5), title: '整理了记忆:新增 2 条' }),
      item({ id: 'b', at: at(20, 8, 0), title: '早报:说了' }),
      item({ id: 'c', at: at(20, 14, 30), title: '想跟你说一句,没发出去' }),
      item({ id: 'd', at: at(19, 21, 7), title: '提醒了你:给妈妈打电话' }),
    ], NOW, 'zh-Hans')
    expect(g.map(x => x.label)).toEqual(['今天', '昨天', '10月18日'])
    expect(g[0]!.rows.map(r => [r.time, r.title])).toEqual([['14:30', '想跟你说一句,没发出去'], ['08:00', '早报:说了']])
    expect(g[2]!.rows[0]!.time).toBe('09:05')
  })
  it('没发出去的主动说话照原话显示,不改写成「说了」', () => {
    const g = activityGroups([item({ id: 'p', title: '想跟你说一句,没发出去' })], NOW, 'zh-Hans')
    expect(g[0]!.rows[0]!.title).toBe('想跟你说一句,没发出去')
  })
  it('能点的:一起做 ⇒ 那件事;终端 ⇒ 那条会话;信 ⇒ 那封信;别的不能点', () => {
    expect(activityHref({ type: 'task', id: 'e5f6a7b8' })).toBe('/matter/e5f6a7b8')
    expect(activityHref({ type: 'terminal', id: 's 1/x' })).toBe('/terminal/s%201%2Fx')
    expect(activityHref({ type: 'letter', id: '2026-10-16-a1b2c3' })).toBe('/letters/2026-10-16-a1b2c3')
    expect(activityHref(undefined)).toBeNull()
    expect(activityHref({ type: 'task', id: '' })).toBeNull()
    const rows = activityGroups([item({ id: 'x', kind: 'decision', title: '按规则替你批了 Bash:ls' })], NOW, 'zh-Hans')[0]!.rows
    expect(rows[0]!.href).toBeNull()
  })
  it('翻页拼接:按 id 去重、重新按时间倒序', () => {
    const m = mergeActivity([[item({ id: 'a', at: 3 }), item({ id: 'b', at: 2 })], [item({ id: 'b', at: 2 }), item({ id: 'c', at: 1 }), item({ id: 'z', at: 5 })]])
    expect(m.map(i => i.id)).toEqual(['z', 'a', 'b', 'c'])
  })
  it('空 ⇒ 一句;有来源读不到 ⇒ 灰字一句(其余照出)', () => {
    expect(activityView({ items: [], degraded: [] }, NOW, 'zh-Hans')).toMatchObject({ groups: [], empty: '这两周 CC 还没替你做过什么。', partial: null })
    const v = activityView({ items: [item({ id: 'a' })], degraded: ['letters'] }, NOW, 'en')
    expect(v.empty).toBeNull()
    expect(v.partial).toBe("Some of it can't be read right now.")
    expect(v.groups).toHaveLength(1)
  })
})

describe('CC 做过的事 演示后端', () => {
  it('九类都有、过 GET /m/api/activity schema;有一条没发出去的主动说话;ref 指向演示里真有的东西', async () => {
    const b = makeDemoBackend({ lang: 'zh-Hans' })
    const v = await b.activity()
    expect(PHONE_API_SCHEMAS['GET /m/api/activity']!.safeParse({ ok: true, ...v }).success).toBe(true)
    expect(new Set(v.items.map(i => i.kind))).toEqual(new Set(['decision', 'together', 'terminal', 'letter', 'memory', 'proactive', 'job', 'reminder', 'cli_upgrade']))
    expect(v.items.some(i => i.kind === 'proactive' && i.title.includes('没发出去'))).toBe(true)
    const letters = await b.letters()
    for (const i of v.items) {
      if (i.ref?.type === 'letter') expect(letters.some(l => l.id === i.ref!.id)).toBe(true)
      if (i.ref?.type === 'task') expect((await b.matter(i.ref.id, 'zh-Hans')).matter.id).toBe(i.ref.id)
    }
    expect((await makeDemoBackend({ lang: 'en' }).activity()).items[0]!.title).not.toMatch(/[一-鿿]/)
  })
})
