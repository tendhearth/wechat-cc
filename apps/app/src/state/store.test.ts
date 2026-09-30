import { describe, it, expect, vi } from 'vitest'
import { isFresh, makeStore } from './store'
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
  it('失败后 30 秒内重新挂载不重载;之后可以;手动 refresh 不受限', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    try {
      const s = makeStore({} as any)
      const load = vi.fn(async () => { throw new BackendError('offline') })
      const q = s.query('bo', load)
      await q.mount()
      expect(load).toHaveBeenCalledTimes(1)
      await q.mount()
      expect(load).toHaveBeenCalledTimes(1)
      vi.setSystemTime(1000 + 31_000)
      await q.mount()
      expect(load).toHaveBeenCalledTimes(2)
      await q.mount()
      expect(load).toHaveBeenCalledTimes(2)
      await q.refresh()
      expect(load).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })
  describe('打开页面必拉新(revalidate / isFresh)', () => {
    it('syncedAt 记的是这次加载发出的时刻(store 时钟,严格递增)', async () => {
      const s = makeStore({} as any)
      const q = s.query('t1', async () => 1)
      const before = s.clock()
      await q.refresh()
      const after = s.clock()
      expect(q.get().syncedAt).toBeGreaterThan(before)
      expect(q.get().syncedAt).toBeLessThan(after)
    })
    it('isFresh:syncedAt ≥ 挂载时刻才算新', () => {
      expect(isFresh({ loading: false }, 5)).toBe(false)
      expect(isFresh({ loading: false, data: 1, syncedAt: 4 }, 5)).toBe(false)
      expect(isFresh({ loading: false, data: 1, syncedAt: 5 }, 5)).toBe(true)
      expect(isFresh({ loading: false, data: 1, syncedAt: 6 }, 5)).toBe(true)
    })
    it('已有缓存也要重拉:缓存早于挂载 ⇒ 加载;之后再 revalidate 同一时刻 ⇒ 不重复加载', async () => {
      const s = makeStore({} as any)
      let n = 0
      const load = vi.fn(async () => ++n)
      const q = s.query('t2', load)
      await q.refresh()
      const mountedAt = s.clock()
      expect(isFresh(q.get(), mountedAt)).toBe(false)
      await q.revalidate(mountedAt)
      expect(load).toHaveBeenCalledTimes(2)
      expect(q.get().data).toBe(2)
      expect(isFresh(q.get(), mountedAt)).toBe(true)
      await q.revalidate(mountedAt)
      expect(load).toHaveBeenCalledTimes(2)
    })
    it('挂载前就在飞的加载不算新:等它落地后再拉一次', async () => {
      const s = makeStore({} as any)
      let release!: () => void
      let n = 0
      const load = vi.fn(() => { n++; return n === 1 ? new Promise<number>(r => { release = () => r(1) }) : Promise.resolve(n) })
      const q = s.query('t3', load)
      const old = q.refresh()
      const mountedAt = s.clock()
      const p = q.revalidate(mountedAt)
      await Promise.resolve() // load 在下一个微任务里才被调用
      release()
      await old; await p
      expect(load).toHaveBeenCalledTimes(2)
      expect(q.get().data).toBe(2)
      expect(isFresh(q.get(), mountedAt)).toBe(true)
    })
    it('挂载后发出的在飞加载直接复用', async () => {
      const s = makeStore({} as any)
      const load = vi.fn(async () => 7)
      const q = s.query('t4', load)
      const mountedAt = s.clock()
      const a = q.refresh()
      const b = q.revalidate(mountedAt)
      await Promise.all([a, b])
      expect(load).toHaveBeenCalledTimes(1)
      expect(isFresh(q.get(), mountedAt)).toBe(true)
    })
    it('打开页面的拉新不受失败退避限制;自动 mount() 仍退避;失败时保留旧数据但不算新', async () => {
      vi.useFakeTimers(); vi.setSystemTime(1000)
      try {
        const s = makeStore({} as any)
        let fail = false
        const load = vi.fn(async () => { if (fail) throw new BackendError('offline'); return 'old' })
        const q = s.query('t5', load)
        await q.refresh()
        fail = true
        await q.refresh() // 失败,进入退避
        expect(load).toHaveBeenCalledTimes(2)
        const m1 = s.clock()
        await q.revalidate(m1)
        expect(load).toHaveBeenCalledTimes(3)
        expect(q.get().data).toBe('old')
        expect(q.get().error).toBe('offline')
        expect(isFresh(q.get(), m1)).toBe(false)
        // 自动路径:有数据 ⇒ mount 不加载;没数据的 key 失败后 30 秒内 mount 也不加载
        const e = s.query('t5e', load)
        await e.mount(); await e.mount()
        expect(load).toHaveBeenCalledTimes(4)
      } finally { vi.useRealTimers() }
    })
    it('拉新成功后清掉旧错误', async () => {
      const s = makeStore({} as any)
      let fail = true
      const q = s.query('t6', async () => { if (fail) throw new BackendError('offline'); return 1 })
      await q.refresh()
      fail = false
      const m = s.clock()
      await q.revalidate(m)
      expect(q.get().error).toBeUndefined()
      expect(isFresh(q.get(), m)).toBe(true)
    })
  })

  it('load 收到 store 当前语言;setLang 后有人在看的查询按新语言重拉', async () => {
    const s = makeStore({} as any, { lang: 'en' })
    const load = vi.fn(async (l: string) => l)
    const q = s.query('k', load)
    q.subscribe(() => {})
    await q.refresh()
    expect(q.get().data).toBe('en')
    s.setLang('zh-Hans')
    await vi.waitFor(() => expect(q.get().data).toBe('zh-Hans'))
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('setLang 同语言不重拉', async () => {
    const s = makeStore({} as any, { lang: 'en' })
    const load = vi.fn(async (l: string) => l)
    const q = s.query('k', load); q.subscribe(() => {})
    await q.refresh()
    s.setLang('en')
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('没人在看的查询只判过期:下次 mount 才拉(有旧数据也拉),拉完就不再拉', async () => {
    const s = makeStore({} as any)
    const load = vi.fn(async (l: string) => l)
    const q = s.query('k', load)
    await q.refresh()
    s.revalidateAll()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    await q.mount()
    expect(load).toHaveBeenCalledTimes(2)
    await q.mount()
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('首次加载失败、还在 30 秒退避里:mount 不拉;revalidateAll(重连)清掉退避立刻重拉', async () => {
    const s = makeStore({} as any)
    let fail = true
    const load = vi.fn(async () => { if (fail) throw new BackendError('offline'); return 1 })
    const q = s.query('k', load); q.subscribe(() => {})
    await q.mount()
    expect(q.get().error).toBe('offline')
    await q.mount()
    expect(load).toHaveBeenCalledTimes(1)
    fail = false
    s.revalidateAll()
    await vi.waitFor(() => expect(q.get().data).toBe(1))
    expect(q.get().error).toBeUndefined()
  })
  it('在飞期间被判过期 ⇒ 落地后(有人在看)按新语言再拉一次', async () => {
    const s = makeStore({} as any, { lang: 'en' })
    const resolvers: Array<() => void> = []
    const load = vi.fn((l: string) => new Promise<string>(r => { resolvers.push(() => r(l)) }))
    const q = s.query('k', load); q.subscribe(() => {})
    const p = q.refresh()
    await vi.waitFor(() => expect(resolvers.length).toBe(1)) // load 在微任务里才被调用
    s.setLang('zh-Hans')
    resolvers[0]!()
    await p
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(resolvers.length).toBe(2))
    resolvers[1]!()
    await vi.waitFor(() => expect(q.get().data).toBe('zh-Hans'))
  })
})
