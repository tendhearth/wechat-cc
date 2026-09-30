import { describe, it, expect } from 'vitest'
import { Utf8Decoder, Utf8Encoder } from './utf8'

const samples = ['', 'hello', '中文与 English 混排', 'emoji 🔥👩‍💻', '\u0000\u007f\u0080߿ࠀ￿', '𝄞 surrogate', 'x'.repeat(100_000) + '尾']

describe('UTF-8 兜底实现', () => {
  it('与平台 TextEncoder 逐字节一致', () => {
    for (const s of samples) expect([...new Utf8Encoder().encode(s)]).toEqual([...new TextEncoder().encode(s)])
  })
  it('往返不变(含长串,不爆栈)', () => {
    for (const s of samples) expect(new Utf8Decoder().decode(new Utf8Encoder().encode(s))).toBe(s)
  })
  it('解码接受 ArrayBuffer 与带偏移的视图', () => {
    const bytes = new TextEncoder().encode('ab中c')
    const buf = new Uint8Array(bytes.length + 2); buf.set(bytes, 1)
    expect(new Utf8Decoder().decode(buf.subarray(1, 1 + bytes.length))).toBe('ab中c')
    expect(new Utf8Decoder().decode(bytes.buffer.slice(0))).toBe('ab中c')
  })
  it('坏字节 ⇒ U+FFFD,不抛', () => {
    expect(new Utf8Decoder().decode(Uint8Array.from([0x61, 0xff, 0x62]))).toBe('a�b')
    expect(new Utf8Decoder().decode(Uint8Array.from([0xe4, 0xb8]))).toBe('��')
  })
  it('孤立代理项编码成 U+FFFD', () => {
    expect([...new Utf8Encoder().encode('\ud800')]).toEqual([0xef, 0xbf, 0xbd])
  })
})
