import { describe, expect, it } from 'vitest'
import type { Lifecycle } from '../../lib/lifecycle'
import { createModules, startModules } from './container'
import { lifecycleModule, type LifecycleHolder } from './lifecycle-module'

const quiet = { log: () => {} }

describe('lifecycleModule:现成的 register*() 进容器', () => {
  it('start 段才起;起来以后 current() 是那个 Lifecycle;停一次只停一次', async () => {
    let stops = 0
    let startedDuringInit = false
    const mods = createModules([
      lifecycleModule('reminders', () => ({ name: 'reminders', stop: async () => { stops++ } })),
      { name: 'later', needs: ['reminders'], init: (ctx) => { startedDuringInit = ctx.get<LifecycleHolder<Lifecycle>>('reminders').current() !== null } },
    ], quiet)
    await mods.start()
    expect(startedDuringInit).toBe(false)
    expect(mods.provided<LifecycleHolder<Lifecycle>>('reminders')?.current()?.name).toBe('reminders')
    expect(mods.status()).toMatchObject([{ name: 'reminders', state: 'ok' }, { name: 'later', state: 'ok' }])
    await mods.stopAll(); await mods.stopAll()
    expect(stops).toBe(1)
  })
  it('起失败 ⇒ degraded 写原因,不拖垮开机', async () => {
    const mods = await startModules([lifecycleModule('reports', () => { throw new Error('db locked') })], quiet)
    expect(mods.status()).toMatchObject([{ name: 'reports', state: 'degraded', error: 'db locked' }])
  })
  it('required: 起失败 ⇒ 往上抛(不降级)', async () => {
    await expect(startModules([lifecycleModule('workbench', () => { throw new Error('store locked') }, { required: true })], quiet)).rejects.toThrow('store locked')
  })
  it('start 拿得到 ctx(needs 里写了的)', async () => {
    let seen: unknown = null
    await startModules([
      { name: 'wired', init: () => ({ deps: 7 }) },
      lifecycleModule('polling', (ctx) => { seen = ctx.get<{ deps: number }>('wired').deps; return { name: 'polling', stop: async () => {} } }, { needs: ['wired'] }),
    ], quiet)
    expect(seen).toBe(7)
  })
  it('**起到一半收到关机也停得到**:停法在 init 段就登记了', async () => {
    let release: () => void = () => {}
    let stops = 0
    const mods = createModules([lifecycleModule('letters', () => new Promise<Lifecycle>(r => { release = () => r({ name: 'letters', stop: async () => { stops++ } }) }))], { ...quiet, stopTimeoutMs: 50 })
    const starting = mods.start()
    await Promise.resolve()
    const stopping = mods.stopAll()
    release(); await starting; await stopping
    expect(stops).toBe(1)
  })
})
