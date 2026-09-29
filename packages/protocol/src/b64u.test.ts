import { describe, it, expect } from 'vitest'
import { b64uEncode, b64uDecode } from './b64u'

/**
 * b64u 是 RFC 4648 §5(base64url,无填充)的编解码;解码要容忍带填充的输入
 * (相同字节的另一种合法表示,跨端拼接时常见)。用 Buffer 的 base64url 编码
 * 对照实现是否一致 —— 只在测试里允许出现 Buffer,包本身不许依赖它。
 */
describe('b64u', () => {
  const lengths = [0, 1, 2, 3, 4, 5, 6, 7, 8, 16, 255]

  it('round-trips arbitrary byte sequences of varying lengths', () => {
    for (const len of lengths) {
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) % 256
      const encoded = b64uEncode(bytes)
      const decoded = b64uDecode(encoded)
      expect(decoded).toEqual(bytes)
    }
  })

  it('round-trips all-zero and all-0xff sequences', () => {
    for (const len of lengths) {
      const zeros = new Uint8Array(len)
      const ones = new Uint8Array(len).fill(0xff)
      expect(b64uDecode(b64uEncode(zeros))).toEqual(zeros)
      expect(b64uDecode(b64uEncode(ones))).toEqual(ones)
    }
  })

  it('matches Buffer.from(x).toString("base64url") for the encoded form', () => {
    for (const len of lengths) {
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) bytes[i] = (i * 89 + 3) % 256
      const expected = Buffer.from(bytes).toString('base64url')
      expect(b64uEncode(bytes)).toBe(expected)
    }
  })

  it('produces no padding characters', () => {
    for (const len of lengths) {
      const bytes = new Uint8Array(len).fill(0xab)
      expect(b64uEncode(bytes)).not.toContain('=')
    }
  })

  it('decodes a padded base64url string the same as an unpadded one', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const unpadded = b64uEncode(bytes)
    const padded = Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
    expect(padded.endsWith('=')).toBe(true)
    expect(b64uDecode(padded)).toEqual(bytes)
    expect(b64uDecode(unpadded)).toEqual(bytes)
  })

  it('decodes an empty string to an empty Uint8Array', () => {
    expect(b64uDecode('')).toEqual(new Uint8Array(0))
  })
})
