/**
 * v1.test.ts — noble 版手机隧道 v1 对 WebCrypto 版(`src/lib/tunnel-crypto.ts`)
 * 的字节级兼容性回归。向量在 `packages/protocol/vectors/v1.json`,用**现有**
 * WebCrypto 实现生成(见 `scripts/gen-tunnel-vectors.ts`)—— 这份测试反过来验
 * 证 noble 版跟它完全一致:已配对的手机在真机上跑的是 WebCrypto 那份,这里
 * 换成 noble 不能改变任何一个字节。
 */
import { describe, it, expect } from 'vitest'
import { b64uDecode } from './b64u'
import { x25519KeyPair, x25519Shared } from './x25519'
import { deriveV1Key, sealV1, openV1 } from './v1'
import vectorsFile from '../vectors/v1.json'

interface Vector {
  id: string
  privA: string
  pubA: string
  privB: string
  pubB: string
  shared: string
  bind: string
  iv: string
  plaintext: string
  ct: string
}

const vectors = vectorsFile.vectors as Vector[]

describe('v1 隧道协议:noble 实现 vs WebCrypto 生成的向量', () => {
  it('向量文件本身不是空的(守卫没有对着空数组自我感觉良好)', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(8)
  })

  for (const v of vectors) {
    describe(v.id, () => {
      it('x25519KeyPair(privA).pub === pubA / privB → pubB', () => {
        expect(x25519KeyPair(b64uDecode(v.privA)).pub).toEqual(b64uDecode(v.pubA))
        expect(x25519KeyPair(b64uDecode(v.privB)).pub).toEqual(b64uDecode(v.pubB))
      })

      it('x25519Shared(privA, pubB) === shared(也应等于反过来算的)', () => {
        const shared = b64uDecode(v.shared)
        expect(x25519Shared(b64uDecode(v.privA), b64uDecode(v.pubB))).toEqual(shared)
        expect(x25519Shared(b64uDecode(v.privB), b64uDecode(v.pubA))).toEqual(shared)
      })

      it('sealV1(deriveV1Key(shared, bind), plaintext, iv).ct === ct', () => {
        const key = deriveV1Key(b64uDecode(v.shared), v.bind)
        const sealed = sealV1(key, b64uDecode(v.plaintext), b64uDecode(v.iv))
        expect(sealed.iv).toBe(v.iv)
        expect(sealed.ct).toBe(v.ct)
      })

      it('openV1 还原明文', () => {
        const key = deriveV1Key(b64uDecode(v.shared), v.bind)
        const pt = openV1(key, { iv: v.iv, ct: v.ct })
        expect(pt).toEqual(b64uDecode(v.plaintext))
      })

      it('篡改密文一位 ⇒ openV1 抛错', () => {
        const key = deriveV1Key(b64uDecode(v.shared), v.bind)
        const ctBytes = b64uDecode(v.ct)
        // base64url 无 padding 的 ct 至少含 16 字节 tag,篡改最后一个字节必然
        // 落在 tag 里(空明文时 ct 就是 tag 本身)。
        ctBytes[ctBytes.length - 1] = (ctBytes[ctBytes.length - 1]! ^ 0xff) & 0xff
        const tamperedCt = Buffer.from(ctBytes).toString('base64url')
        expect(() => openV1(key, { iv: v.iv, ct: tamperedCt })).toThrow()
      })

      it('篡改 iv 一位 ⇒ openV1 抛错(除非明文为空且... 不,GCM 认证覆盖 iv 隐含在 tag 里)', () => {
        const key = deriveV1Key(b64uDecode(v.shared), v.bind)
        const ivBytes = b64uDecode(v.iv)
        ivBytes[0] = (ivBytes[0]! ^ 0xff) & 0xff
        const tamperedIv = Buffer.from(ivBytes).toString('base64url')
        expect(() => openV1(key, { iv: tamperedIv, ct: v.ct })).toThrow()
      })
    })
  }

  it('x25519KeyPair() 不传 priv 时生成随机密钥对,可用于往返', () => {
    const a = x25519KeyPair()
    const b = x25519KeyPair()
    expect(a.priv).toHaveLength(32)
    expect(a.pub).toHaveLength(32)
    expect(x25519Shared(a.priv, b.pub)).toEqual(x25519Shared(b.priv, a.pub))
  })

  it('sealV1() 不传 iv 时随机生成,openV1 仍能还原', () => {
    const shared = x25519Shared(x25519KeyPair().priv, x25519KeyPair().pub)
    const key = deriveV1Key(shared, 'some-bind-token')
    const pt = new TextEncoder().encode('hello')
    const frame = sealV1(key, pt)
    expect(openV1(key, frame)).toEqual(pt)
  })
})
