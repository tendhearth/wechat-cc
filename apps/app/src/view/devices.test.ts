import { describe, it, expect } from 'vitest'
import { devicesView } from './devices'

const now = new Date(2026, 8, 30, 14, 0).getTime()
const iso = (h: number, day = 30) => new Date(2026, 8, day, h, 0).toISOString()

describe('devicesView', () => {
  it('本机单列;其它设备按最近出现倒序,没名字的叫「未命名设备」', () => {
    const v = devicesView([
      { id: 'a', created_at: iso(1), last_seen_at: iso(13), label: 'Tendhearth · iPhone', current: true },
      { id: 'b', created_at: iso(1), last_seen_at: iso(9, 28), current: false },
      { id: 'c', created_at: iso(1), last_seen_at: iso(12), label: '  ', current: false },
    ], now, 'zh-Hans')
    expect(v.me).toEqual({ id: 'a', label: 'Tendhearth · iPhone' })
    expect(v.others.map(o => o.id)).toEqual(['c', 'b'])
    expect(v.others[0]?.label).toBe('未命名设备')
    expect(v.others[0]?.lastSeen).toContain('12:00')
    expect(v.others[1]?.lastSeen).toContain('9月28日')
  })
  it('列表里没有本机(刚被撤)⇒ me 为 null;坏时间 ⇒ 不显示最近出现', () => {
    const v = devicesView([{ id: 'b', created_at: 'x', last_seen_at: 'not a date', current: false }], now, 'en')
    expect(v.me).toBeNull()
    expect(v.others[0]?.lastSeen).toBe('')
  })
})
