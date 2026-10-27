import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeOutboundTaps } from './outbound-taps'

describe('makeOutboundTaps', () => {
  it('旁听期间的文本都收得到,按发送顺序', () => {
    const t = makeOutboundTaps()
    const h = t.tap('c')
    t.observe('c', '第一条'); t.observe('c', '第二条')
    expect(h.close()).toEqual(['第一条', '第二条'])
  })

  it('**observe 不改变发送行为** —— 它没有返回值可以让调用方据此不发', () => {
    const t = makeOutboundTaps()
    expect(t.observe('c', 'x')).toBeUndefined()
  })

  it('没人旁听时 observe 是空操作(发送路径可以无条件调)', () => {
    const t = makeOutboundTaps()
    expect(() => t.observe('nobody', 'x')).not.toThrow()
  })

  it('close 之后不再收', () => {
    const t = makeOutboundTaps()
    const h = t.tap('c'); h.close()
    t.observe('c', '晚到的')
    expect(h.close()).toEqual([])
  })

  it('只旁听自己那个 chat', () => {
    const t = makeOutboundTaps()
    const h = t.tap('a')
    t.observe('b', '别人的')
    expect(h.close()).toEqual([])
  })

  it('**重复 tap 返回空壳而不是抛** —— 抛会打断一次真实的打猎发送', () => {
    const t = makeOutboundTaps()
    const first = t.tap('c')
    const second = t.tap('c')
    t.observe('c', 'x')
    expect(second.close()).toEqual([])   // 空壳
    expect(first.close()).toEqual(['x']) // 第一个照收
  })
})

describe('daemon 的接线(源码守卫)', () => {
  // 「两个实例」是这条链最阴的死法:tap 开在 A 上、发送写进 B,
  // 收不到任何东西,而且**不会有任何报错**。replySinks 的注释里为同一件事
  // 叮嘱过两遍(「MUST share this one instance」),但没有东西在守它。
  // 架构终态 A1 起:实例在地基(foundation.ts)里造一次,模块把同一个 f.outboundTaps 交给两边 ——
  // 2026-10-26 起两边各在自己的 module.ts(internal-api/module.ts、wiring/module.ts),模块表 daemon-modules.ts 只列模块。
  const here = dirname(fileURLToPath(import.meta.url))
  const read = (f: string) => readFileSync(join(here, f), 'utf8')
  const [foundation, modules, main] = [read('foundation.ts'), read('daemon-modules.ts'), read('main.ts')]
  const [apiModule, wiredModule] = [read('internal-api/module.ts'), read('wiring/module.ts')]

  it('makeOutboundTaps 只构造一次(在地基里)', () => {
    expect(foundation.match(/makeOutboundTaps\(\)/g) ?? []).toHaveLength(1)
    expect(modules.match(/makeOutboundTaps\(/g) ?? []).toHaveLength(0)
    expect(main.match(/makeOutboundTaps\(/g) ?? []).toHaveLength(0)
    for (const src of [apiModule, wiredModule]) expect(src.match(/makeOutboundTaps\(/g) ?? []).toHaveLength(0)
  })

  it('同一个实例同时给到 internal-api(写)和 wireMain(读)', () => {
    // 缺任何一边这个功能就是死的:少了写端永远收不到文本,少了读端
    // 打猎那一拍根本不开 tap。
    const api = apiModule.indexOf('registerInternalApi(')
    const wire = wiredModule.indexOf('wireMain(')
    expect(api).toBeGreaterThan(-1)
    expect(wire).toBeGreaterThan(-1)
    expect(apiModule.slice(api)).toContain('outboundTaps: f.outboundTaps')        // internal-api 那一侧
    expect(wiredModule.slice(wire)).toContain('outboundTaps: f.outboundTaps')     // wireMain 那一侧
  })
})
