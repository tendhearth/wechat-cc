/**
 * v2.test.ts — 手机隧道 v2:双向密钥 + 计数器 nonce + 防重放。
 *
 * 向量在 `packages/protocol/vectors/v2.json`:不是跟别的实现比对字节兼容
 * (v1 那份是跟 WebCrypto 对齐),而是**这份 noble 实现自己生成的回归钉子**
 * ——固定 shared/bind,记录两把方向密钥和头 3 帧密文,以后改动这份代码如果
 * 悄悄改变了输出,这里就会红。生成方式见 vectors/v2.json 里的 `_generatedBy`
 * 字段说明。
 */
import { describe, it, expect } from 'vitest'
import { b64uEncode, b64uDecode } from './b64u'
import { deriveV2Keys, makeV2Channel } from './v2'
import type { SealedFrameV2 } from './v2'
import vectorsFile from '../vectors/v2.json'

interface VectorFrame {
  c: string
  plaintext: string
  ct: string
}

interface VectorFile {
  shared: string
  bind: string
  c2s: string
  s2c: string
  frames: VectorFrame[]
}

const vector = vectorsFile as VectorFile

describe('deriveV2Keys', () => {
  it('c2s 与 s2c 是两把不同的 32 字节密钥', () => {
    const shared = b64uDecode(vector.shared)
    const keys = deriveV2Keys(shared, vector.bind)
    expect(keys.c2s).toHaveLength(32)
    expect(keys.s2c).toHaveLength(32)
    expect(keys.c2s).not.toEqual(keys.s2c)
  })

  it('回归向量:固定 shared/bind 推出的两把密钥跟提交的 vectors/v2.json 一致', () => {
    const shared = b64uDecode(vector.shared)
    const keys = deriveV2Keys(shared, vector.bind)
    expect(b64uEncode(keys.c2s)).toBe(vector.c2s)
    expect(b64uEncode(keys.s2c)).toBe(vector.s2c)
  })

  it('bind 为空串 ⇒ HKDF salt 为空(不是抛错,也不是拿 bind 本身当 salt)', () => {
    const shared = b64uDecode(vector.shared)
    const withEmptyBind = deriveV2Keys(shared, '')
    const again = deriveV2Keys(shared, '')
    expect(b64uEncode(withEmptyBind.c2s)).toBe(b64uEncode(again.c2s))
  })
})

describe('makeV2Channel:往返、方向、计数器', () => {
  function pair() {
    const shared = b64uDecode(vector.shared)
    const keys = deriveV2Keys(shared, vector.bind)
    const client = makeV2Channel(keys, 'client')
    const server = makeV2Channel(keys, 'server')
    return { client, server }
  }

  it('客户端 seal → 服务端 open 还原明文,反过来也一样', () => {
    const { client, server } = pair()
    const fromClient = new TextEncoder().encode('hello from client')
    const sealedByClient = client.seal(fromClient)
    expect(server.open(sealedByClient)).toEqual(fromClient)

    const fromServer = new TextEncoder().encode('hello from server')
    const sealedByServer = server.seal(fromServer)
    expect(client.open(sealedByServer)).toEqual(fromServer)
  })

  it('c 是十进制字符串,从 "0" 开始按帧递增', () => {
    const { client } = pair()
    const f0 = client.seal(new TextEncoder().encode('a'))
    const f1 = client.seal(new TextEncoder().encode('b'))
    const f2 = client.seal(new TextEncoder().encode('c'))
    expect(f0.c).toBe('0')
    expect(f1.c).toBe('1')
    expect(f2.c).toBe('2')
  })

  it('同一帧投递两次 ⇒ 第二次抛 replay', () => {
    const { client, server } = pair()
    const sealed = client.seal(new TextEncoder().encode('once'))
    expect(server.open(sealed)).toBeDefined()
    expect(() => server.open(sealed)).toThrow('replay')
  })

  it('乱序:先接受 c=2,再来 c=1 ⇒ c=1 抛 replay', () => {
    const { client, server } = pair()
    client.seal(new TextEncoder().encode('c0')) // c=0
    client.seal(new TextEncoder().encode('c1')) // c=1
    const f2 = client.seal(new TextEncoder().encode('c2')) // c=2
    server.open(f2)
    const replayed: SealedFrameV2 = { c: '1', ct: f2.ct }
    expect(() => server.open(replayed)).toThrow('replay')
  })

  it('方向反了(拿客户端发的帧给客户端自己 open,而不是服务端)⇒ 抛 auth', () => {
    const { client } = pair()
    const sealedByClient = client.seal(new TextEncoder().encode('wrong direction'))
    expect(() => client.open(sealedByClient)).toThrow('auth')
  })

  it('c 不是合法十进制(前导零、负号、十六进制、空串)⇒ 抛 auth', () => {
    const { client, server } = pair()
    const sealed = client.seal(new TextEncoder().encode('x'))
    for (const badC of ['01', '-1', '0x1', '', '1.0', '1e1', ' 0', '0 ']) {
      expect(() => server.open({ c: badC, ct: sealed.ct })).toThrow('auth')
    }
  })

  it('帧形状不对(c 是数字/数组、缺 c、ct 是数字、整帧是 null/字符串)⇒ 抛 auth,不是 TypeError,也不推进计数器', () => {
    const { client, server } = pair()
    const sealed = client.seal(new TextEncoder().encode('shape-guard'))

    const malformed: unknown[] = [
      { c: 0, ct: sealed.ct }, // c 是 number,不是 string
      { c: [5], ct: sealed.ct }, // c 是数组
      { ct: sealed.ct }, // 缺 c
      { c: sealed.c, ct: 12345 }, // ct 是 number
      null, // 整帧是 null
      'not-a-frame', // 整帧是字符串
    ]

    for (const bad of malformed) {
      expect(() => server.open(bad as unknown as SealedFrameV2)).toThrow('auth')
    }

    // 上面几帧全没被“接受”:合法帧的 c 之后还能正常开,没被畸形输入偷跑计数器。
    expect(server.open(sealed)).toBeDefined()
  })

  it('ct 被篡改 ⇒ 抛 auth,且不推进接收计数器(后续合法帧仍能开)', () => {
    const { client, server } = pair()
    const sealed = client.seal(new TextEncoder().encode('tamper me'))
    const ctBytes = b64uDecode(sealed.ct)
    ctBytes[ctBytes.length - 1] = (ctBytes[ctBytes.length - 1]! ^ 0xff) & 0xff
    const tampered: SealedFrameV2 = { c: sealed.c, ct: b64uEncode(ctBytes) }
    expect(() => server.open(tampered)).toThrow('auth')

    // 篡改帧没有被“接受”,同一个 c 的正确帧后面还能正常开
    expect(server.open(sealed)).toBeDefined()
  })

  it('计数器到 2^53-1(Number.MAX_SAFE_INTEGER)⇒ seal 抛,不回绕', () => {
    const shared = b64uDecode(vector.shared)
    const keys = deriveV2Keys(shared, vector.bind)
    const client = makeV2Channel(keys, 'client', { startSendCounter: Number.MAX_SAFE_INTEGER - 1 })
    const ok = client.seal(new TextEncoder().encode('last valid'))
    expect(ok.c).toBe(String(Number.MAX_SAFE_INTEGER - 1))
    expect(() => client.seal(new TextEncoder().encode('overflow'))).toThrow()
  })

  it('回归向量:头 3 帧密文跟 vectors/v2.json 一致', () => {
    const shared = b64uDecode(vector.shared)
    const keys = deriveV2Keys(shared, vector.bind)
    const client = makeV2Channel(keys, 'client')
    for (const frame of vector.frames) {
      const sealed = client.seal(b64uDecode(frame.plaintext))
      expect(sealed.c).toBe(frame.c)
      expect(sealed.ct).toBe(frame.ct)
    }
  })
})
