// Hermes 缺 TextEncoder / TextDecoder 时的最小 UTF-8 实现(只做 utf-8、无 stream 选项)。
// 协议包(zod + noble + client.ts)只用到这两样的 encode / decode。已有就不装(polyfills.ts)。
export class Utf8Encoder {
  readonly encoding = 'utf-8'
  encode(s = ''): Uint8Array {
    const out: number[] = []
    for (let i = 0; i < s.length; i++) {
      let cp = s.charCodeAt(i)
      if (cp >= 0xd800 && cp <= 0xdbff) {
        const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
        if (lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); i++ } else cp = 0xfffd
      } else if (cp >= 0xdc00 && cp <= 0xdfff) cp = 0xfffd
      if (cp < 0x80) out.push(cp)
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    }
    return Uint8Array.from(out)
  }
}

export class Utf8Decoder {
  readonly encoding = 'utf-8'
  decode(input?: ArrayBufferView | ArrayBuffer): string {
    if (!input) return ''
    const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    const cont = (k: number) => k < b.length && (b[k]! & 0xc0) === 0x80
    let s = ''
    const units: number[] = []
    const flush = () => { s += String.fromCharCode(...units); units.length = 0 }
    for (let i = 0; i < b.length;) {
      const x = b[i]!
      let cp = 0xfffd, n = 1
      if (x < 0x80) cp = x
      else if (x >= 0xc2 && x < 0xe0 && cont(i + 1)) { cp = ((x & 31) << 6) | (b[i + 1]! & 63); n = 2 }
      else if (x >= 0xe0 && x < 0xf0 && cont(i + 1) && cont(i + 2)) {
        const c = ((x & 15) << 12) | ((b[i + 1]! & 63) << 6) | (b[i + 2]! & 63)
        if (c >= 0x800 && (c < 0xd800 || c > 0xdfff)) { cp = c; n = 3 }
      } else if (x >= 0xf0 && x < 0xf5 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
        const c = ((x & 7) << 18) | ((b[i + 1]! & 63) << 12) | ((b[i + 2]! & 63) << 6) | (b[i + 3]! & 63)
        if (c >= 0x10000 && c <= 0x10ffff) { cp = c; n = 4 }
      }
      if (cp > 0xffff) { const v = cp - 0x10000; units.push(0xd800 + (v >> 10), 0xdc00 + (v & 1023)) } else units.push(cp)
      if (units.length >= 4096) flush() // String.fromCharCode(...大数组) 会爆栈
      i += n
    }
    flush()
    return s
  }
}
