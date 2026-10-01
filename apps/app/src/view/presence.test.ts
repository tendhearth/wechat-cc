import { describe, it, expect } from 'vitest'
import { ccPresence, statusLine } from './presence'

const at = (h: number, m: number) => new Date(2026, 9, 1, h, m).getTime()
const conn = (state: 'online' | 'connecting' | 'offline' | 'revoked', lastSyncedAt: number | null = null) => ({ state, lastSyncedAt, epoch: 1 })

describe('CC 的明暗只看够不够得着家里的电脑', () => {
  it('online ⇒ here;其他一律 away', () => {
    expect(ccPresence(conn('online'))).toBe('here')
    for (const s of ['connecting', 'offline', 'revoked'] as const) expect(ccPresence(conn(s))).toBe('away')
  })
})

describe('顶栏状态行', () => {
  const now = at(21, 0)
  it('在线:绿点', () => expect(statusLine(conn('online'), now, 'zh-Hans')).toEqual({ dot: 'ok', text: '家里的电脑 · 在线', label: '家里的电脑 · 在线' }))
  it('离线:红点;顶栏只写短句,上次同步时间只进无障碍标签(连接页另有完整时间)', () =>
    expect(statusLine(conn('offline', at(20, 34)), now, 'zh-Hans')).toEqual({ dot: 'bad', text: '家里的电脑 · 不在线', label: '家里的电脑 · 不在线 · 20:34 同步' }))
  it('离线且从没同步过:不编时间', () => expect(statusLine(conn('offline'), now, 'zh-Hans')).toEqual({ dot: 'bad', text: '家里的电脑 · 不在线', label: '家里的电脑 · 不在线' }))
  it('连接中:灰点(不知道),绝不绿', () => expect(statusLine(conn('connecting'), now, 'en')).toEqual({ dot: 'unknown', text: 'Home computer · connecting', label: 'Home computer · connecting' }))
  it('已撤销:红点', () => expect(statusLine(conn('revoked'), now, 'zh-Hans')).toEqual({ dot: 'bad', text: '家里的电脑 · 已解除配对', label: '家里的电脑 · 已解除配对' }))
})
