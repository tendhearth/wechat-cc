import { describe, it, expect } from 'vitest'
import en from '../i18n/en'
import { acceptsIncomingLink, linkErrorKey, linkIntake, makeGate, pairErrorKey } from './pair'

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
