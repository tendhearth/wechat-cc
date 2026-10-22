import { describe, expect, it } from 'vitest'
import { orderModules, startModules, type DaemonModule, type ModuleTimers } from './container'

/** 假定时器:记下开动 / 清掉了哪些,手动 tick。 */
function fakeTimers() {
  const live = new Map<number, () => void>()
  let next = 1
  const timers: ModuleTimers = {
    setInterval: (fn) => { const id = next++; live.set(id, fn); return id },
    clearInterval: (h) => { live.delete(h as number) },
  }
  return { timers, live, tickAll: () => { for (const fn of [...live.values()]) fn() } }
}

function run(mods: DaemonModule[], t = fakeTimers()) {
  const logs: string[] = []
  return { logs, t, started: startModules(mods, { log: (_tag, l) => logs.push(l), timers: t.timers, now: () => 0 }) }
}

describe('排序:needs ∪ wants 的拓扑序', () => {
  it('依赖先起;同层按表里的顺序', () => {
    const order = orderModules([
      { name: 'social', needs: ['speech'], init: () => {} },
      { name: 'ilink', init: () => {} },
      { name: 'speech', needs: ['ilink'], init: () => {} },
      { name: 'yi', init: () => {} },
    ]).map(m => m.name)
    expect(order).toEqual(['ilink', 'speech', 'social', 'yi'])
  })
  it('有环 / 指向不存在的模块 / 重名 / 依赖自己 ⇒ 开机就抛', () => {
    expect(() => orderModules([{ name: 'a', needs: ['b'], init: () => {} }, { name: 'b', wants: ['a'], init: () => {} }])).toThrow(/cycle a → b → a/)
    expect(() => orderModules([{ name: 'a', needs: ['nope'], init: () => {} }])).toThrow(/unknown module 'nope'/)
    expect(() => orderModules([{ name: 'a', init: () => {} }, { name: 'a', init: () => {} }])).toThrow(/duplicate/)
    expect(() => orderModules([{ name: 'a', needs: ['a'], init: () => {} }])).toThrow(/itself/)
  })
})

describe('init / start 两段(9d 评审 #541:两个真环)', () => {
  it('**init 期间调 lazy 的函数会抛**;start 段起调得到', async () => {
    let early: unknown = null
    let viaStart: unknown = null
    const { started } = run([
      { name: 'polling', init: (ctx) => {
        const pipeline = ctx.lazy<{ id: string }>('pipeline')
        try { pipeline() } catch (e) { early = e }
        ctx.onStart('pull', () => { viaStart = pipeline().id })
        return {}
      } },
      { name: 'pipeline', init: () => ({ id: 'p1' }) },
    ])
    await started
    expect(String(early)).toMatch(/before start/)
    expect(viaStart).toBe('p1')
  })
  it('**interval 在 start 之前不计时**:init 全部跑完才开动', async () => {
    const t = fakeTimers()
    let liveDuringLaterInit = -1
    const { started } = run([
      { name: 'a', init: (ctx) => { ctx.interval('tick', 1000, () => {}) } },
      { name: 'b', needs: ['a'], init: () => { liveDuringLaterInit = t.live.size } },
    ], t)
    await started
    expect(liveDuringLaterInit).toBe(0)
    expect(t.live.size).toBe(1)
  })
  it('onStart 按拓扑序 await', async () => {
    const seen: string[] = []
    const { started } = run([
      { name: 'b', needs: ['a'], init: (ctx) => { ctx.onStart('go', () => { seen.push('b') }) } },
      { name: 'a', init: (ctx) => { ctx.onStart('go', async () => { await Promise.resolve(); seen.push('a') }) } },
    ])
    await started
    expect(seen).toEqual(['a', 'b'])
  })
})

describe('停:逆序', () => {
  it('**模块逆拓扑序、模块内逆登记序**;interval 也清掉;可重复调', async () => {
    const t = fakeTimers()
    const stopped: string[] = []
    const { started } = run([
      { name: 'a', init: (ctx) => { ctx.own('conn', () => { stopped.push('a/conn') }); ctx.own('server', () => { stopped.push('a/server') }); ctx.interval('tick', 10, () => {}) } },
      { name: 'b', needs: ['a'], init: (ctx) => { ctx.own('ws', () => { stopped.push('b/ws') }) } },
    ], t)
    const app = await started
    expect(t.live.size).toBe(1)
    await app.stopAll()
    expect(stopped).toEqual(['b/ws', 'a/server', 'a/conn'])
    expect(t.live.size).toBe(0)
    await app.stopAll()
    expect(stopped).toHaveLength(3)
  })
  it('单项停失败 / 超时只记一行,不挡后面', async () => {
    const stopped: string[] = []
    const logs: string[] = []
    const app = await startModules([
      { name: 'a', init: (ctx) => { ctx.own('fine', () => { stopped.push('fine') }); ctx.own('hangs', () => new Promise(() => {})); ctx.own('throws', () => { throw new Error('boom') }) } },
    ], { log: (_t, l) => logs.push(l), timers: fakeTimers().timers, stopTimeoutMs: 20 })
    await app.stopAll()
    expect(stopped).toEqual(['fine'])
    expect(logs.some(l => /throws failed: boom/.test(l))).toBe(true)
    expect(logs.some(l => /hangs failed: stop timeout/.test(l))).toBe(true)
  })
})

describe('状态:开关、降级、上游', () => {
  it('enabled() 为 false ⇒ off,不 init、不登记', async () => {
    let inited = false
    const t = fakeTimers()
    const { started } = run([{ name: 'social', enabled: () => false, init: (ctx) => { inited = true; ctx.interval('t', 1, () => {}) } }], t)
    const app = await started
    expect(inited).toBe(false)
    expect(t.live.size).toBe(0)
    expect(app.status()).toEqual([{ name: 'social', state: 'off', sinceIso: new Date(0).toISOString() }])
  })
  it('optional 的 init 抛错 ⇒ degraded;它已经登记的 own 立刻停掉,interval 从没开始;别的照起', async () => {
    const t = fakeTimers()
    const stopped: string[] = []
    const { started } = run([
      { name: 'yi', optional: true, init: (ctx) => { ctx.own('half-open', () => { stopped.push('yi/half-open') }); ctx.interval('t', 1, () => {}); throw new Error('port in use') } },
      { name: 'other', init: () => 'ok' },
    ], t)
    const app = await started
    expect(app.status().map(s => [s.name, s.state, s.error])).toEqual([['yi', 'degraded', 'port in use'], ['other', 'ok', undefined]])
    expect(stopped).toEqual(['yi/half-open'])
    expect(t.live.size).toBe(0)
  })
  it('**needs 的上游 degraded ⇒ 下游不起,状态跟着上游**:标 degraded 并写明是上游没起(不标 off —— off 在健康页的意思是「主人关的 / 没配置」,那是假话)', async () => {
    let inited = false
    const { started } = run([
      { name: 'knowledge', optional: true, init: () => { throw new Error('db locked') } },
      { name: 'ingest', needs: ['knowledge'], init: () => { inited = true } },
    ])
    const app = await started
    expect(inited).toBe(false)
    expect(app.status()[1]).toMatchObject({ name: 'ingest', state: 'degraded', error: 'upstream knowledge not running' })
  })
  it('上游是主人关掉的(off)⇒ 下游也 off', async () => {
    const { started } = run([
      { name: 'social', enabled: () => false, init: () => {} },
      { name: 'forage', needs: ['social'], init: () => {} },
    ])
    expect((await started).status().map(s => s.state)).toEqual(['off', 'off'])
  })
  it('wants 的上游不在 ⇒ maybe 拿到 null,自己照起', async () => {
    let got: unknown = 'unset'
    const { started } = run([
      { name: 'social', enabled: () => false, init: () => 'social-api' },
      { name: 'companion', wants: ['social'], init: (ctx) => { got = ctx.maybe('social') } },
    ])
    await started
    expect(got).toBeNull()
  })
  it('非 optional 的 init 抛错 ⇒ 已经 init 的模块的资源全部停掉,再把错抛出去(开机失败)', async () => {
    const stopped: string[] = []
    const { started } = run([
      { name: 'db', init: (ctx) => { ctx.own('handle', () => { stopped.push('db/handle') }) } },
      { name: 'ilink', needs: ['db'], init: () => { throw new Error('no accounts') } },
    ])
    await expect(started).rejects.toThrow('no accounts')
    expect(stopped).toEqual(['db/handle'])
  })
  it('optional 的 onStart 抛错 ⇒ degraded,只停它自己已经开动的;非 optional ⇒ 全停再抛', async () => {
    const t = fakeTimers()
    const { started } = run([
      { name: 'a', init: (ctx) => { ctx.interval('t', 1, () => {}) } },
      { name: 'yi', optional: true, init: (ctx) => { ctx.interval('t', 1, () => {}); ctx.onStart('listen', () => { throw new Error('EADDRINUSE') }) } },
    ], t)
    const app = await started
    expect(app.status().map(s => s.state)).toEqual(['ok', 'degraded'])
    expect(t.live.size).toBe(1)

    const t2 = fakeTimers()
    const r2 = run([
      { name: 'a', init: (ctx) => { ctx.interval('t', 1, () => {}) } },
      { name: 'polling', init: (ctx) => { ctx.onStart('pull', () => { throw new Error('auth') }) } },
    ], t2)
    await expect(r2.started).rejects.toThrow('auth')
    expect(t2.live.size).toBe(0)
  })
})

describe('拿东西只能拿写明了的依赖', () => {
  it('get 没写在 needs、maybe 没写在 wants ⇒ 抛(不靠运行时碰运气)', async () => {
    const { started } = run([
      { name: 'a', init: () => 1 },
      { name: 'b', wants: ['a'], init: (ctx) => { ctx.get('a') } },
    ])
    await expect(started).rejects.toThrow(/not in its needs/)
    const r2 = run([
      { name: 'a', init: () => 1 },
      { name: 'b', needs: ['a'], init: (ctx) => { ctx.maybe('a') } },
    ])
    await expect(r2.started).rejects.toThrow(/not in its wants/)
  })
  it('interval 的 fn 抛错 / reject 只记一行,定时器照跑', async () => {
    const t = fakeTimers()
    const { started, logs } = run([{ name: 'a', init: (ctx) => { ctx.interval('sync', 1, () => { throw new Error('x') }); ctx.interval('async', 1, async () => { throw new Error('y') }) } }], t)
    await started
    t.tickAll()
    await new Promise(r => setTimeout(r, 0))
    expect(logs.filter(l => /tick failed/.test(l))).toHaveLength(2)
    expect(t.live.size).toBe(2)
  })
})
