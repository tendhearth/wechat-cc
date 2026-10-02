import { describe, it, expect } from 'vitest'
import { INITIAL_CONNECTION, reduceConnection, shouldRevalidate, SYNC_THROTTLE_MS, type ConnEvent } from './connection'
import type { Connection } from '../backend/types'

const run = (evs: ConnEvent[], from: Connection = INITIAL_CONNECTION) => evs.reduce(reduceConnection, from)

describe('连接状态机', () => {
  it('初始是 connecting;ready ⇒ online,epoch 1', () => {
    expect(INITIAL_CONNECTION).toEqual({ state: 'connecting', lastSyncedAt: null, epoch: 0 })
    expect(run([{ t: 'status', s: 'ready' }])).toEqual({ state: 'online', lastSyncedAt: null, epoch: 1 })
  })
  it('第一次就连不上 ⇒ offline(不会一直显示连接中)', () => {
    expect(run([{ t: 'status', s: 'down' }]).state).toBe('offline')
  })
  it('离线后的每次重试 connecting 不改状态(不闪「连接中」);再 ready ⇒ online,epoch 前进', () => {
    const c = run([{ t: 'status', s: 'ready' }, { t: 'status', s: 'down' }, { t: 'status', s: 'connecting' }])
    expect(c.state).toBe('offline')
    expect(run([{ t: 'status', s: 'ready' }], c)).toMatchObject({ state: 'online', epoch: 2 })
  })
  it('revoked 是终态:之后 ready / down / connecting 都不改', () => {
    const c = run([{ t: 'status', s: 'ready' }, { t: 'revoked' }, { t: 'status', s: 'ready' }, { t: 'status', s: 'down' }])
    expect(c.state).toBe('revoked')
  })
  it('synced 记最近同步时间,但 5 秒内的重复不换对象(省渲染)', () => {
    const a = run([{ t: 'synced', at: 1_000 }])
    expect(a.lastSyncedAt).toBe(1_000)
    expect(reduceConnection(a, { t: 'synced', at: 1_000 + SYNC_THROTTLE_MS - 1 })).toBe(a)
    expect(reduceConnection(a, { t: 'synced', at: 1_000 + SYNC_THROTTLE_MS }).lastSyncedAt).toBe(1_000 + SYNC_THROTTLE_MS)
  })
  it('没变化返回同一个对象', () => {
    const off = run([{ t: 'status', s: 'down' }])
    expect(reduceConnection(off, { t: 'status', s: 'down' })).toBe(off)
    expect(reduceConnection(off, { t: 'status', s: 'connecting' })).toBe(off)
  })
  it('shouldRevalidate:只在变成 online 且 epoch 前进时(首次连上、每次重连)', () => {
    const on1 = run([{ t: 'status', s: 'ready' }])
    expect(shouldRevalidate(INITIAL_CONNECTION, on1)).toBe(true)
    expect(shouldRevalidate(on1, reduceConnection(on1, { t: 'synced', at: 9_999_999 }))).toBe(false)
    const off = reduceConnection(on1, { t: 'status', s: 'down' })
    expect(shouldRevalidate(on1, off)).toBe(false)
    expect(shouldRevalidate(off, reduceConnection(off, { t: 'status', s: 'ready' }))).toBe(true)
  })
})
