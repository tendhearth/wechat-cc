import { describe, it, expect } from 'vitest'
import { canSubmit, connectionNotice, formatSynced } from './connection'

const at = (h: number, m: number, day = 30) => new Date(2026, 8, day, h, m).getTime()

describe('formatSynced', () => {
  it('一分钟内 ⇒ 刚刚', () => {
    expect(formatSynced(at(14, 5), at(14, 5) + 30_000, 'zh-Hans')).toBe('刚刚')
    expect(formatSynced(at(14, 5), at(14, 5) + 30_000, 'en')).toBe('just now')
  })
  it('同一天 ⇒ HH:MM', () => { expect(formatSynced(at(9, 7), at(14, 0), 'en')).toBe('09:07') })
  it('不是同一天 ⇒ 带日期', () => {
    expect(formatSynced(at(23, 50, 29), at(8, 0), 'en')).toBe('9/29 23:50')
    expect(formatSynced(at(23, 50, 29), at(8, 0), 'zh-Hans')).toBe('9月29日 23:50')
  })
})

describe('connectionNotice', () => {
  const now = at(14, 0)
  it('在线 ⇒ 不提示', () => { expect(connectionNotice({ state: 'online', lastSyncedAt: now, epoch: 1 }, now, 'en')).toBeNull() })
  it('连接中', () => { expect(connectionNotice({ state: 'connecting', lastSyncedAt: null, epoch: 0 }, now, 'en')?.kind).toBe('connecting') })
  it('离线且同步过 ⇒ 说出上次同步时间', () => {
    const n = connectionNotice({ state: 'offline', lastSyncedAt: at(13, 42), epoch: 1 }, now, 'en')
    expect(n).toEqual({ kind: 'offline', text: expect.stringContaining('13:42') })
  })
  it('冷启动就离线(从没同步过)⇒「暂时连不上」,不提同步时间', () => {
    const n = connectionNotice({ state: 'offline', lastSyncedAt: null, epoch: 0 }, now, 'zh-Hans')
    expect(n?.kind).toBe('offline')
    expect(n?.text).toContain('暂时连不上')
    expect(n?.text).not.toContain('同步')
  })
  it('撤销与离线是两种提示', () => {
    const r = connectionNotice({ state: 'revoked', lastSyncedAt: at(13, 0), epoch: 1 }, now, 'en')
    const o = connectionNotice({ state: 'offline', lastSyncedAt: at(13, 0), epoch: 1 }, now, 'en')
    expect(r?.kind).toBe('revoked')
    expect(r?.text).not.toBe(o?.text)
  })
})

describe('canSubmit(发送 / 批准 / 回答只在在线时可点)', () => {
  it('只有 online 放行;冷启动离线、连接中、撤销一律锁住', () => {
    expect(canSubmit({ state: 'online', lastSyncedAt: 1, epoch: 1 })).toBe(true)
    expect(canSubmit({ state: 'offline', lastSyncedAt: null, epoch: 0 })).toBe(false)
    expect(canSubmit({ state: 'offline', lastSyncedAt: 5, epoch: 2 })).toBe(false)
    expect(canSubmit({ state: 'connecting', lastSyncedAt: null, epoch: 0 })).toBe(false)
    expect(canSubmit({ state: 'revoked', lastSyncedAt: 5, epoch: 2 })).toBe(false)
  })
})
