import { describe, it, expect, vi } from 'vitest'
import { makeStore } from './store'
import { BackendError } from '../backend/types'

describe('store', () => {
  it('同一 key 的查询共用、refresh 在飞复用', async () => {
    const s = makeStore({} as any)
    const load = vi.fn(async () => 42)
    const q1 = s.query('k', load), q2 = s.query('k', load)
    await Promise.all([q1.refresh(), q2.refresh()])
    expect(load).toHaveBeenCalledTimes(1)
    expect(q1.get().data).toBe(42)
  })
  it('submit:在飞时再点 ⇒ busy,只提交一次', async () => {
    const s = makeStore({} as any)
    let release!: () => void
    const run = vi.fn(() => new Promise<void>(r => { release = r }))
    const a = s.submit('approve:p1', run)
    expect(await s.submit('approve:p1', run)).toBe('busy')
    release()
    expect(await a).toBe('ok')
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('submit:超时 ⇒ uncertain;其它错误 ⇒ 错误码', async () => {
    const s = makeStore({} as any)
    expect(await s.submit('x', async () => { throw new BackendError('timeout') })).toEqual({ error: 'uncertain' })
    expect(await s.submit('y', async () => { throw new BackendError('stale') })).toEqual({ error: 'stale' })
    expect(await s.submit('z', async () => { throw new Error('boom') })).toEqual({ error: 'unknown' })
  })
  it('submit 结束后同 key 可再提交', async () => {
    const s = makeStore({} as any)
    expect(await s.submit('k', async () => {})).toBe('ok')
    expect(await s.submit('k', async () => {})).toBe('ok')
  })
  it('query 失败记录 error,并通知订阅者', async () => {
    const s = makeStore({} as any)
    const q = s.query('e', async () => { throw new BackendError('offline') })
    const cb = vi.fn(); q.subscribe(cb)
    await q.refresh()
    expect(q.get().error).toBe('offline')
    expect(q.get().loading).toBe(false)
    expect(cb).toHaveBeenCalled()
  })
  it('topic 引用计数:最后一个退订才退订后端', () => {
    const unsub = vi.fn()
    const backend = { subscribe: vi.fn((_t: string, cb: (d: unknown) => void) => { cb(1); return unsub }) } as any
    const s = makeStore(backend)
    const t = s.topic('agents')
    const off1 = t.subscribe(() => {}), off2 = t.subscribe(() => {})
    expect(backend.subscribe).toHaveBeenCalledTimes(1)
    off1(); expect(unsub).not.toHaveBeenCalled()
    off2(); expect(unsub).toHaveBeenCalledTimes(1)
  })
  it('topic 保留最新值,晚来的监听者立刻拿到', () => {
    let push!: (d: unknown) => void
    const backend = { subscribe: vi.fn((_t: string, cb: (d: unknown) => void) => { push = cb; return () => {} }) } as any
    const s = makeStore(backend)
    const t = s.topic<number>('home')
    const off = t.subscribe(() => {})
    push(7)
    expect(t.get()).toBe(7)
    expect(s.topic<number>('home').get()).toBe(7)
    off()
  })
  it('connection 转发后端状态与订阅', () => {
    let cb!: (c: any) => void
    const backend = { connection: () => ({ state: 'online', lastSyncedAt: 1 }), onConnection: (f: any) => { cb = f; return () => {} } } as any
    const s = makeStore(backend)
    const c = s.connection()
    const seen = vi.fn(); c.subscribe(seen)
    cb({ state: 'offline', lastSyncedAt: 1 })
    expect(c.get().state).toBe('offline')
    expect(seen).toHaveBeenCalled()
  })
  it('connection 句柄稳定;get() 引用稳定,不随 backend.connection() 新对象漂移', () => {
    const backend = { connection: () => ({ state: 'online', lastSyncedAt: Date.now() }), onConnection: () => () => {} } as any
    const s = makeStore(backend)
    expect(s.connection()).toBe(s.connection())
    const c = s.connection()
    const a = c.get()
    expect(c.get()).toBe(a)
    const off = c.subscribe(() => {})
    expect(c.get()).toBe(a)
    off()
  })
  it('onConnection 订阅期间同步回调相等值 ⇒ 不通知', () => {
    const backend = {
      connection: () => ({ state: 'online', lastSyncedAt: 5 }),
      onConnection: (f: any) => { f({ state: 'online', lastSyncedAt: 5 }); return () => {} },
    } as any
    const s = makeStore(backend)
    const c = s.connection()
    const before = c.get()
    const seen = vi.fn()
    c.subscribe(seen)
    expect(seen).not.toHaveBeenCalled()
    expect(c.get()).toBe(before)
  })
  it('topic / query 句柄跨调用相同', () => {
    const backend = { subscribe: () => () => {} } as any
    const s = makeStore(backend)
    expect(s.topic('home')).toBe(s.topic('home'))
    expect(s.query('k', async () => 1)).toBe(s.query('k', async () => 2))
    const q = s.query('k', async () => 1)
    expect(q.get()).toBe(q.get())
  })
  it('load 同步抛错 ⇒ 状态仍落定', async () => {
    const s = makeStore({} as any)
    const q = s.query('sync', (() => { throw new BackendError('offline') }) as any)
    await q.refresh()
    expect(q.get().loading).toBe(false)
    expect(q.get().error).toBe('offline')
  })
})
