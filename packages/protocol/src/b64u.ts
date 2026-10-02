/**
 * base64url(RFC 4648 §5)编解码 —— 不碰任何运行时专属全局(不用 Node 的那个字节
 * 容器类型、不用 atob/btoa),纯 Uint8Array/字符串运算,好在 daemon(Bun/Node)、
 * 手机网页(浏览器)、未来的 Expo app 之间共用。
 *
 * 编码:不产出填充字符(`=`)。
 * 解码:容忍输入带填充(先剥掉尾部的 `=`),因为标准 base64 的填充版本携带的
 * 是同一段字节,跨端拼接时两种写法都可能出现。
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const DECODE_MAP: Record<string, number> = {}
for (let i = 0; i < ALPHABET.length; i++) {
  const ch = ALPHABET[i]
  if (ch !== undefined) DECODE_MAP[ch] = i
}

export function b64uEncode(bytes: Uint8Array): string {
  let out = ''
  const len = bytes.length
  let i = 0
  for (; i + 3 <= len; i += 3) {
    const b0 = bytes[i]!
    const b1 = bytes[i + 1]!
    const b2 = bytes[i + 2]!
    const n = (b0 << 16) | (b1 << 8) | b2
    out += ALPHABET[(n >> 18) & 0x3f]
    out += ALPHABET[(n >> 12) & 0x3f]
    out += ALPHABET[(n >> 6) & 0x3f]
    out += ALPHABET[n & 0x3f]
  }
  const remaining = len - i
  if (remaining === 1) {
    const b0 = bytes[i]!
    const n = b0 << 16
    out += ALPHABET[(n >> 18) & 0x3f]
    out += ALPHABET[(n >> 12) & 0x3f]
  } else if (remaining === 2) {
    const b0 = bytes[i]!
    const b1 = bytes[i + 1]!
    const n = (b0 << 16) | (b1 << 8)
    out += ALPHABET[(n >> 18) & 0x3f]
    out += ALPHABET[(n >> 12) & 0x3f]
    out += ALPHABET[(n >> 6) & 0x3f]
  }
  return out
}

export function b64uDecode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '')
  const len = clean.length
  // 每 4 个字符编 3 字节;剥掉尾部填充后合法长度模 4 只能是 0、2、3 —— 模 4 余 1
  // 只剩 6 个 bit,连一个字节都不够,是畸形输入(不可信的线上数据,必须拒绝而
  // 不是悄悄截断)。
  if (len % 4 === 1) {
    throw new Error(`b64uDecode: invalid length ${len} (mod 4 === 1 can't encode whole bytes)`)
  }
  const byteLen = Math.floor((len * 6) / 8)
  const out = new Uint8Array(byteLen)
  let outIdx = 0
  let buffer = 0
  let bits = 0
  for (let i = 0; i < len; i++) {
    const ch = clean[i]!
    const v = DECODE_MAP[ch]
    if (v === undefined) throw new Error(`b64uDecode: invalid base64url character '${ch}'`)
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[outIdx++] = (buffer >> bits) & 0xff
    }
  }
  return out
}
