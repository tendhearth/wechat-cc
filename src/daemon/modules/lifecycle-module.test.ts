import { describe, expect, it } from 'vitest'
import { SubsystemSupervisor } from '../subsystems'
import { startLifecycleModule } from './lifecycle-module'

function host() {
  const registered: Array<[string, () => Promise<void>]> = []
  const sup = new SubsystemSupervisor(() => {})
  return { sup, registered, h: { sup, log: () => {}, register: (n: string, s: () => Promise<void>) => { registered.push([n, s]) } } }
}

describe('startLifecycleModule:一行顶以前的 sup.start + lc.register(第三批 3b 第 5 步)', () => {
  it('起得来 ⇒ 回 Lifecycle、状态 ok、登记了停法;停一次只停一次', async () => {
    const { sup, registered, h } = host()
    let stops = 0
    const lc = await startLifecycleModule(h, 'reminders', () => ({ name: 'reminders', stop: async () => { stops++ } }))
    expect(lc?.name).toBe('reminders')
    expect(sup.statuses()).toMatchObject([{ name: 'reminders', state: 'ok' }])
    expect(registered.map(r => r[0])).toEqual(['reminders'])
    await registered[0]![1](); await registered[0]![1]()
    expect(stops).toBe(1)
  })
  it('起失败 ⇒ undefined、状态 degraded 写原因(跟 sup.start 一样,不拖垮开机)', async () => {
    const { sup, h } = host()
    const lc = await startLifecycleModule(h, 'reports', () => { throw new Error('db locked') })
    expect(lc).toBeUndefined()
    expect(sup.statuses()).toMatchObject([{ name: 'reports', state: 'degraded', error: 'db locked' }])
  })
  it('**停法先登记、再起**:起到一半收到关机也停得到', async () => {
    const { registered, h } = host()
    let release: () => void = () => {}
    const p = startLifecycleModule(h, 'letters', () => new Promise<import('../../lib/lifecycle').Lifecycle>(r => { release = () => r({ name: 'letters', stop: async () => {} }) }))
    await Promise.resolve()
    expect(registered.map(r => r[0])).toEqual(['letters'])
    release(); await p
  })
  // 核心链就地搬家(设计稿 2026-10-23):搬家不改「起不来怎么办」—— 今天工作台起不来就整个开机失败,搬进来以后也一样。
  it('required: 起失败 ⇒ 往上抛(不是 undefined、不降级);停法已登记', async () => {
    const { registered, h } = host()
    await expect(startLifecycleModule(h, 'workbench', () => { throw new Error('store locked') }, { required: true })).rejects.toThrow('store locked')
    expect(registered.map(r => r[0])).toEqual(['workbench'])
  })
})
