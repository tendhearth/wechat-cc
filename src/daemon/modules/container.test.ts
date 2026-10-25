import { describe, expect, it } from 'vitest'
import { createModules, orderModules, startModules, type DaemonModule, type ModuleTimers } from './container'

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
    expect(() => orderModules([{ name: 'opt', optional: true, init: () => {} }, { name: 'core', needs: ['opt'], init: () => {} }])).toThrow(/required 'core' needs optional 'opt'/)
    expect(() => orderModules([{ name: 'opt', optional: true, init: () => {} }, { name: 'core', wants: ['opt'], init: () => {} }])).not.toThrow()
  })
})

describe('init / start 两段(整合者评审 #541:两个真环)', () => {
  it('**init 期间调 lazy 的函数会抛**;start 段起调得到', async () => {
    let early: unknown = null
    let viaStart: unknown = null
    const { started } = run([
      { name: 'polling', lazy: ['pipeline'], init: (ctx) => {
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
  it('late:目标还没 init 完 ⇒ null(不抛);它一 init 完就拿得到(不等 start 段);它降级了 ⇒ null', async () => {
    let early: unknown = 'unset'
    let duringLaterInit: unknown = 'unset'
    let get: (() => { id: string } | null) | null = null
    let getBroken: (() => unknown) | null = null
    const { started } = run([
      { name: 'api', lazy: ['boot', 'broken'], init: (ctx) => {
        get = ctx.late<{ id: string }>('boot')
        getBroken = ctx.late('broken')
        early = get()
        return {}
      } },
      { name: 'boot', init: () => ({ id: 'b1' }) },
      { name: 'later', needs: ['boot'], init: () => { duringLaterInit = get!() } },
      { name: 'broken', optional: true, init: () => { throw new Error('nope') } },
    ])
    await started
    expect(early).toBeNull()
    expect(duringLaterInit).toEqual({ id: 'b1' })
    expect(get!()).toEqual({ id: 'b1' })
    expect(getBroken!()).toBeNull()
  })
  it('enabled 能读上游的值;上游没起来 ⇒ 跟着上游(不抛、不 init)', async () => {
    let inited = 0
    const { started } = run([
      { name: 'base', init: () => ({ on: true }) },
      { name: 'feat', needs: ['base'], enabled: (c) => c.get<{ on: boolean }>('base').on, init: () => { inited++ } },
      { name: 'base2', optional: true, init: () => { throw new Error('x') } },
      { name: 'feat2', optional: true, needs: ['base2'], enabled: (c) => c.get<{ on: boolean }>('base2').on, init: () => { inited++ } },
      { name: 'feat3', needs: ['base'], enabled: (c) => !c.get<{ on: boolean }>('base').on, init: () => { inited++ } },
    ])
    const mods = await started
    expect(inited).toBe(1)
    expect(mods.status()).toMatchObject([
      { name: 'base', state: 'ok' }, { name: 'feat', state: 'ok' },
      { name: 'base2', state: 'degraded' }, { name: 'feat2', state: 'degraded', error: 'upstream base2 not running' },
      { name: 'feat3', state: 'off' },
    ])
  })
  it('late 也只能拿 lazy 里声明了的', async () => {
    await expect(startModules([{ name: 'a', init: () => {} }, { name: 'b', init: (ctx) => { ctx.late('a') } }], { log: () => {} })).rejects.toThrow(/not in its lazy/)
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
      { name: 'ingest', optional: true, needs: ['knowledge'], init: () => { inited = true } },
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

describe('上游在 start 段才坏(整合者评审 #542)', () => {
  it('needs 的上游 onStart 抛错 ⇒ 下游不开动、跟着 degraded,并停掉它 init 时登记的 own', async () => {
    const t = fakeTimers()
    const stopped: string[] = []
    let downstreamStarted = false
    const { started } = run([
      { name: 'yi', optional: true, init: (ctx) => { ctx.onStart('listen', () => { throw new Error('EADDRINUSE') }); return { port: 1 } } },
      { name: 'hand', optional: true, needs: ['yi'], init: (ctx) => {
        ctx.own('client', () => { stopped.push('hand/client') })
        ctx.interval('ping', 1, () => {})
        ctx.onStart('connect', () => { downstreamStarted = true })
      } },
    ], t)
    const app = await started
    expect(app.status().map(s => [s.name, s.state, s.error])).toEqual([['yi', 'degraded', 'EADDRINUSE'], ['hand', 'degraded', 'upstream yi not running']])
    expect(downstreamStarted).toBe(false)
    expect(stopped).toEqual(['hand/client'])
    expect(t.live.size).toBe(0)
  })
  it('wants:init 时真拿到了的,上游后来坏了也跟着;没拿的不受影响', async () => {
    const { started } = run([
      { name: 'social', optional: true, init: (ctx) => { ctx.onStart('go', () => { throw new Error('relay down') }); return 'api' } },
      { name: 'forage', wants: ['social'], init: (ctx) => { ctx.maybe('social') } },
      { name: 'companion', wants: ['social'], init: () => {} },
    ])
    expect((await started).status().map(s => [s.name, s.state])).toEqual([['social', 'degraded'], ['forage', 'degraded'], ['companion', 'ok']])
  })
})

describe('小处(整合者评审 #542)', () => {
  it('interval 上一次还没跑完 ⇒ 这一拍跳过,不叠;跑完了下一拍照常', async () => {
    const t = fakeTimers()
    let calls = 0
    let finish: () => void = () => {}
    const { started } = run([{ name: 'a', init: (ctx) => { ctx.interval('slow', 1, () => { calls++; return new Promise<void>(r => { finish = r }) }) } }], t)
    await started
    t.tickAll(); t.tickAll(); t.tickAll()
    expect(calls).toBe(1)
    finish()
    await new Promise(r => setTimeout(r, 0))
    t.tickAll()
    expect(calls).toBe(2)
  })
  it('lazy 只能拿 lazy 里声明了的;同一个名字既在 lazy 又在 needs ⇒ 开机就抛', async () => {
    const { started } = run([
      { name: 'a', init: () => 1 },
      { name: 'b', init: (ctx) => { ctx.lazy('a') } },
    ])
    await expect(started).rejects.toThrow(/not in its lazy/)
    expect(() => orderModules([{ name: 'a', init: () => {} }, { name: 'b', needs: ['a'], lazy: ['a'], init: () => {} }])).toThrow(/cycle edge, pick one/)
  })
  it('真环写成 lazy 就不进排序:ilink ↔ speech 两边互相 lazy 也排得出来', () => {
    expect(orderModules([
      { name: 'ilink', lazy: ['speech'], init: () => {} },
      { name: 'speech', needs: ['ilink'], init: () => {} },
    ]).map(m => m.name)).toEqual(['ilink', 'speech'])
  })
})

describe('开机途中也能停(第 2 步:SIGTERM 落在开机途中)', () => {
  it('init 途中 stopAll ⇒ 后面的模块不再 init;已经 init 的资源停掉;start 正常返回', async () => {
    const t = fakeTimers()
    const stopped: string[] = []
    const inited: string[] = []
    let release: () => void = () => {}
    const group = createModules([
      { name: 'a', init: (ctx) => { inited.push('a'); ctx.own('conn', () => { stopped.push('a/conn') }) } },
      { name: 'b', needs: ['a'], init: async (ctx) => { inited.push('b'); ctx.own('ws', () => { stopped.push('b/ws') }); await new Promise<void>(r => { release = r }) } },
      { name: 'c', needs: ['b'], init: () => { inited.push('c') } },
    ], { log: () => {}, timers: t.timers })
    const starting = group.start()
    await Promise.resolve(); await Promise.resolve()
    const stopping = group.stopAll()
    release()
    await starting
    await stopping
    expect(inited).toEqual(['a', 'b'])
    expect(stopped).toEqual(['b/ws', 'a/conn'])
    expect(t.live.size).toBe(0)
  })
  it('start 段途中 stopAll ⇒ 不再开动后面的;已经开动的 interval 清掉', async () => {
    const t = fakeTimers()
    let release: () => void = () => {}
    let laterStarted = false
    const group = createModules([
      { name: 'a', init: (ctx) => { ctx.interval('tick', 1, () => {}); ctx.onStart('slow', () => new Promise<void>(r => { release = r })) } },
      { name: 'b', init: (ctx) => { ctx.onStart('go', () => { laterStarted = true }) } },
    ], { log: () => {}, timers: t.timers })
    const starting = group.start()
    await new Promise(r => setTimeout(r, 0))
    expect(t.live.size).toBe(1)
    const stopping = group.stopAll()
    release()
    await starting
    await stopping
    expect(laterStarted).toBe(false)
    expect(t.live.size).toBe(0)
  })
  it('卡住的 onStart 不会让 stopAll 一直等:最多等一个停止超时', async () => {
    const stopped: string[] = []
    const group = createModules([
      { name: 'a', init: (ctx) => { ctx.own('conn', () => { stopped.push('a/conn') }); ctx.onStart('hangs', () => new Promise(() => {})) } },
    ], { log: () => {}, timers: fakeTimers().timers, stopTimeoutMs: 20 })
    void group.start()
    await new Promise(r => setTimeout(r, 0))
    await group.stopAll()
    expect(stopped).toEqual(['a/conn'])
  })
  it('start() 只能调一次', async () => {
    const group = createModules([{ name: 'a', init: () => {} }], { log: () => {}, timers: fakeTimers().timers })
    await group.start()
    expect(() => group.start()).toThrow(/twice/)
  })
})

describe('窄口(架构终态 A6):模块交出几样「我的值里的一小块」', () => {
  const ilink = (): DaemonModule<{ send: () => string; voice: { say: () => string } }> => ({
    name: 'ilink',
    init: () => ({ send: () => 'sent', voice: { say: () => 'said' } }),
    ports: { 'wechat.send': (v) => ({ send: v.send }), 'wechat.voice': (v) => v.voice },
  })
  it('needs 口名 = needs 交出它的模块:排序、拿到的是那一块;口不进 status', async () => {
    const seen: unknown[] = []
    const mods: DaemonModule[] = [
      { name: 'letters', needs: ['wechat.send'], init: (ctx) => { seen.push(ctx.get<{ send: () => string }>('wechat.send').send()) } },
      ilink(),
      { name: 'tts', wants: ['wechat.voice'], lazy: [], init: (ctx) => { seen.push(ctx.maybe<{ say: () => string }>('wechat.voice')?.say()) } },
    ]
    expect(orderModules(mods).map(m => m.name)).toEqual(['ilink', 'letters', 'tts'])
    const { started } = run(mods)
    const s = await started
    expect(seen).toEqual(['sent', 'said'])
    expect(s.status().map(x => x.name)).toEqual(['ilink', 'letters', 'tts'])
    expect(s.provided<{ say: () => string }>('wechat.voice')?.say()).toBe('said')
  })
  it('只能拿写明了的口;拿整个模块要 needs 模块名', async () => {
    const { started } = run([ilink(), { name: 'x', needs: ['wechat.send'], init: (ctx) => { ctx.get('ilink') } }])
    await expect(started).rejects.toThrow(/'ilink' is not in its needs/)
  })
  it('交出口的模块没起来 ⇒ needs 口的下游跟着它的状态', async () => {
    const { started } = run([
      { ...ilink(), optional: true, init: () => { throw new Error('boom') } },
      { name: 'letters', optional: true, needs: ['wechat.send'], init: () => {} },
    ])
    const s = await started
    expect(s.status().find(x => x.name === 'letters')).toMatchObject({ state: 'degraded', error: 'upstream ilink not running' })
  })
  it('口和模块重名 / 依赖自己的口 / 同一个模块既 lazy 又 needs(经口) ⇒ 开机就抛', () => {
    expect(() => orderModules([ilink(), { name: 'wechat.send', init: () => {} }])).toThrow(/clashes/)
    expect(() => orderModules([{ ...ilink(), needs: ['wechat.send'] }])).toThrow(/itself/)
    expect(() => orderModules([ilink(), { name: 'b', needs: ['wechat.send'], lazy: ['ilink'], init: () => {} }])).toThrow(/cycle edge, pick one/)
    expect(() => orderModules([{ ...ilink(), optional: true }, { name: 'core', needs: ['wechat.voice'], init: () => {} }])).toThrow(/required 'core' needs optional 'wechat.voice'/)
  })
})
