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

  /**
   * 协议包解的是不可信的线上数据。base64(url) 每组 4 个字符编 3 字节;剥掉尾部
   * 填充后,合法长度模 4 只能是 0、2、3 —— 模 4 余 1 意味着只剩 6 个 bit,连一个
   * 字节都不够,是畸形输入,必须拒绝而不是悄悄截断。
   */
  it('rejects a decoded length whose stripped-padding length is 1 mod 4', () => {
    // 'AQIDB' 长度 5,5 % 4 === 1;修复前会悄悄截断成 [1,2,3]。
    expect(() => b64uDecode('AQIDB')).toThrow()
    // 更广地扫一遍:任何 len % 4 === 1 的字符串都必须被拒绝。
    for (const len of [1, 5, 9, 13]) {
      const s = 'A'.repeat(len)
      expect(() => b64uDecode(s)).toThrow()
    }
  })

  it('rejects characters outside the base64url alphabet', () => {
    expect(() => b64uDecode('A!QI')).toThrow()
    expect(() => b64uDecode('AQI+')).toThrow() // 标准 base64 的 '+',不是 url 版的
    expect(() => b64uDecode('AQI/')).toThrow() // 标准 base64 的 '/'
  })

  it('rejects padding that appears anywhere but the end', () => {
    expect(() => b64uDecode('AQ=D')).toThrow()
    expect(() => b64uDecode('=AQD')).toThrow()
  })
})
