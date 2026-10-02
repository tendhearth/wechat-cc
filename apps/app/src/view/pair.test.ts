import { describe, it, expect } from 'vitest'
import en from '../i18n/en'
import zh from '../i18n/zh-Hans'
import type { PairingRecord } from '../net/pairing'
import { acceptsIncomingLink, confirmCard, confirmCheckCode, intakeIncomingLink, linkErrorKey, linkIntake, makeGate, pairBackTarget, pairErrorKey } from './pair'

describe('配对错误 → 文案键', () => {
  it('每种链接错误、配对错误都有自己的一句话,键都在文案表里', () => {
    const keys = [
      ...(['not_a_link', 'remote_off', 'bad_link'] as const).map(linkErrorKey),
      ...(['expired', 'device_limit', 'offline', 'too_old', 'unknown'] as const).map(pairErrorKey),
    ]
    for (const k of keys) expect(en[k]).toBeTruthy()
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('配对单飞闸', () => {
  it('同一帧内第二次进入被挡;leave 后才能再进', () => {
    const g = makeGate()
    expect(g.enter()).toBe(true)
    expect(g.enter()).toBe(false)
    expect(g.busy()).toBe(true)
    g.leave()
    expect(g.busy()).toBe(false)
    expect(g.enter()).toBe(true)
  })
})

describe('linkIntake(系统链接 → 确认卡)', () => {
  const OK = `https://relay.tendhearth.com/pset/#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`
  it('第一个能解析的胜出', () => {
    const r = linkIntake([null, 'https://relay.tendhearth.com/pset/', OK])
    expect(r.ok && r.link.relayHost).toBe('relay.tendhearth.com')
  })
  it('都没锚点 / 都是空 ⇒ 「没带全」', () => {
    expect(linkIntake(['https://relay.tendhearth.com/pset/', null])).toEqual({ ok: false, key: 'pair.errLinkIncomplete' })
    expect(linkIntake([null, undefined])).toEqual({ ok: false, key: 'pair.errLinkIncomplete' })
  })
  it('锚点在但内容坏了 ⇒ 坏链接', () => {
    expect(linkIntake(['https://relay.tendhearth.com/pset/#id=nope&t=x'])).toEqual({ ok: false, key: 'pair.errBadLink' })
  })
})

describe('acceptsIncomingLink(Review Focus 5)', () => {
  it('正在配对时不接新链接;其余都接', () => {
    expect(acceptsIncomingLink('working')).toBe(false)
    for (const k of ['intro', 'scan', 'confirm', 'error'] as const) expect(acceptsIncomingLink(k)).toBe(true)
  })
})

describe('intakeIncomingLink(配对页收到系统链接;Task 9 fix round 1)', () => {
  const OK = `https://relay.tendhearth.com/pset/#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`
  const deps = (pending: string | null, native: string | null) => {
    const calls: string[] = []
    let slot = pending
    let cache = native
    return {
      calls,
      cache: () => cache,
      slot: () => slot,
      d: {
        take: () => { calls.push('take'); const p = slot; slot = null; return p },
        readNative: () => { calls.push('read'); return cache },
        clearNative: () => { calls.push('clear'); cache = null },
        dev: true,
      },
    }
  }
  it('正在配对 ⇒ 不接,但暂存格取走、原生缓存清掉、缓存一眼都不读', () => {
    const x = deps(OK, 'tendhearth://relay.tendhearth.com/pset/#id=x')
    expect(intakeIncomingLink('working', false, x.d)).toEqual({ k: 'ignore' })
    expect(x.slot()).toBeNull()
    expect(x.cache()).toBeNull()
    expect(x.calls).toEqual(['take', 'clear'])
  })
  it('闸门忙(同一帧刚点了连接)⇒ 同样不接、同样清干净', () => {
    const x = deps(OK, OK)
    expect(intakeIncomingLink('confirm', true, x.d)).toEqual({ k: 'ignore' })
    expect(x.slot()).toBeNull()
    expect(x.cache()).toBeNull()
  })
  it('接的时候:先读兜底再清;暂存格优先,锚点丢了才用缓存', () => {
    const x = deps('https://relay.tendhearth.com/pset/', `tendhearth://relay.tendhearth.com/pset/${OK.slice(OK.indexOf('#'))}`)
    const r = intakeIncomingLink('intro', false, x.d)
    expect(r.k === 'confirm' && r.link.relayHost).toBe('relay.tendhearth.com')
    expect(x.calls).toEqual(['take', 'read', 'clear'])
    expect(x.cache()).toBeNull()
  })
  it('缓存里是发布构建不认的链接 ⇒ 不当兜底;都没有 ⇒ 「没带全」', () => {
    const x = deps(null, `tendhearth://relay.tendhearth.com/pset/${OK.slice(OK.indexOf('#'))}`)
    expect(intakeIncomingLink('error', false, { ...x.d, dev: false })).toEqual({ k: 'error', key: 'pair.errLinkIncomplete' })
  })
  it('读 / 清原生缓存抛错不影响结果', () => {
    const r = intakeIncomingLink('scan', false, { take: () => OK, readNative: () => { throw new Error('x') }, clearNative: () => { throw new Error('y') }, dev: false })
    expect(r.k).toBe('confirm')
  })
})

describe('confirmCheckCode(确认卡核对码;与桌面同一个派生)', () => {
  it('由链接里的 daemon id 算:与桌面 / daemon 用的 protocol pairCheckCode 一致', () => {
    const r = linkIntake([`https://relay.tendhearth.com/pset/#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`])
    if (!r.ok) throw new Error('expected ok')
    expect(confirmCheckCode(r.link)).toBe('USZ-YAY')
  })
})

describe('confirmCard(I2:点开的链接不能一下就换掉现在连着的电脑)', () => {
  const linkOf = (id: string) => {
    const r = linkIntake([`https://relay.tendhearth.com/pset/#id=${id}&t=t${'0'.repeat(32)}&p=%2Fset`])
    if (!r.ok) throw new Error('expected ok')
    return r.link
  }
  const A = `r${'a'.repeat(26)}`, B = `r${'b'.repeat(26)}`
  const paired = (daemonId: string): PairingRecord => ({ v: 1, daemonId, relayHost: 'relay.tendhearth.com', relayUrl: 'wss://relay.tendhearth.com/v2/phone', deviceToken: 'x', deviceId: 'd', pairedAt: 1 })
  it('没配过 ⇒ 不提示「换掉」;核对码照显示', () => {
    expect(confirmCard(linkOf(A), null)).toEqual({ checkCode: 'USZ-YAY', replaces: false })
  })
  it('已连着同一台电脑 ⇒ 不提示', () => {
    expect(confirmCard(linkOf(A), paired(A)).replaces).toBe(false)
  })
  it('已连着另一台电脑 ⇒ 提示「这会换掉现在连着的那台电脑」', () => {
    expect(confirmCard(linkOf(B), paired(A))).toEqual({ checkCode: 'VH9-L6H', replaces: true })
    expect(zh['pair.replaces']).toBe('这会换掉现在连着的那台电脑')
    expect(en['pair.replaces']).toBe('This replaces the computer this phone is connected to')
  })
  it('卡片正文不再断定「你的电脑」:改成先核对', () => {
    expect(zh['pair.checkFirst']).toBe('核对码和你电脑上显示的一致再连')
    expect(en['pair.checkFirst']).toBe('Only connect if the check code matches the one shown on your computer')
    for (const k of ['pair.confirmTitle', 'pair.confirmBody'] as const) {
      expect(zh[k], k).not.toMatch(/连到你的电脑|连接你的电脑/)
      expect(en[k], k).not.toMatch(/your computer/)
    }
  })
})

describe('pairBackTarget —— 配对页没有上一页时的返回', () => {
  it('已配对(系统链接冷启动进来的)⇒ 此刻;没配对 ⇒ 欢迎页', () => {
    expect(pairBackTarget(true)).toBe('/')
    expect(pairBackTarget(false)).toBe('/welcome')
  })
})
