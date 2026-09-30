import { describe, it, expect, vi } from 'vitest'
import { installPolyfills } from './polyfills'
import { Utf8Decoder, Utf8Encoder } from './utf8'

describe('installPolyfills', () => {
  it('空环境:三样都补上,随机数走注入的实现', () => {
    const g: Record<string, any> = {}
    const rand = vi.fn((a: Uint8Array) => a.fill(7))
    expect(installPolyfills(g, rand)).toEqual(['crypto.getRandomValues', 'TextEncoder', 'TextDecoder'])
    expect([...g.crypto.getRandomValues(new Uint8Array(3))]).toEqual([7, 7, 7])
    expect(g.TextEncoder).toBe(Utf8Encoder)
    expect(g.TextDecoder).toBe(Utf8Decoder)
  })
  it('已有的一律不动', () => {
    const own = { getRandomValues: (a: Uint8Array) => a }
    const g: Record<string, any> = { crypto: own, TextEncoder, TextDecoder }
    expect(installPolyfills(g, a => a)).toEqual([])
    expect(g.crypto).toBe(own)
    expect(g.TextEncoder).toBe(TextEncoder)
  })
  it('有 crypto 对象但没有 getRandomValues ⇒ 只补这一个方法,保留对象', () => {
    const cryptoObj: Record<string, unknown> = { randomUUID: () => 'x' }
    const g: Record<string, any> = { crypto: cryptoObj, TextEncoder, TextDecoder }
    expect(installPolyfills(g, a => a)).toEqual(['crypto.getRandomValues'])
    expect(g.crypto).toBe(cryptoObj)
  })
})
