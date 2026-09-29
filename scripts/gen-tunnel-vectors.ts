/**
 * gen-tunnel-vectors.ts — 一次性脚本,用**现有** `src/lib/tunnel-crypto.ts`
 * (node:crypto.webcrypto,daemon 真机在跑的那份)生成手机隧道 v1 协议的跨
 * 实现测试向量,写到 `packages/protocol/vectors/v1.json`。
 *
 * `packages/protocol/src/v1.ts` 是同一协议的 noble 版(给不能用 node:crypto
 * 的运行时,比如手机网页)。两份实现必须字节级兼容 —— 已配对的手机在真机上
 * 跑的还是 WebCrypto 版,换成 noble 不能让它们掉线。这份向量就是证据:
 * `v1.test.ts` 拿它们喂 noble 版,断言算出来的每一步都跟 WebCrypto 算出来
 * 的完全一样。
 *
 * 保留在仓库里以便复核(改了 tunnel-crypto.ts 或怀疑向量过期时重跑一遍):
 *   bun scripts/gen-tunnel-vectors.ts
 *
 * 8 组向量覆盖:
 *   - 两对 X25519 密钥(A、B),JWK 导出 `d`(私钥)/`x`(公钥) —— WebCrypto
 *     导出的 JWK base64url 字段没有 padding,跟本仓库的 b64u 格式一致,可以
 *     直接喂 x25519KeyPair()/x25519Shared() 复核。
 *   - 4 种 bind token:空串(无认证)、't'+32 hex、'd'+48 hex(真实设备/隧道
 *     token 的两种前缀形状)、含中文的串(salt 走 UTF-8,不能只测 ASCII)。
 *   - 3 种明文长度:空、短 JSON、4 KiB 随机字节。
 *   - 固定 iv(12 字节),所有向量共用同一个 —— 只是为了让 `ct` 可预测好复
 *     核,不代表真实协议允许复用 nonce。
 */
import { webcrypto } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveSharedBits, hkdfAesKey } from '../src/lib/tunnel-crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'packages', 'protocol', 'vectors', 'v1.json')

type CryptoKey = webcrypto.CryptoKey
const subtle = webcrypto.subtle as unknown as {
  generateKey(algo: object, extractable: boolean, uses: string[]): Promise<webcrypto.CryptoKeyPair>
  exportKey(fmt: string, key: CryptoKey): Promise<{ d?: string; x?: string }>
  encrypt(algo: object, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>
}

function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return Buffer.from(b).toString('base64url')
}

interface GeneratedKeypair {
  privateKey: CryptoKey
  publicKey: CryptoKey
  privB64: string // JWK 'd'
  pubB64: string // JWK 'x'
}

async function genKeypair(): Promise<GeneratedKeypair> {
  const kp = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  const jwkPriv = await subtle.exportKey('jwk', kp.privateKey)
  const jwkPub = await subtle.exportKey('jwk', kp.publicKey)
  if (!jwkPriv.d || !jwkPub.x) throw new Error('JWK export missing d/x')
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, privB64: jwkPriv.d, pubB64: jwkPub.x }
}

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

async function sealFixedIv(key: CryptoKey, plaintext: Uint8Array, iv: Uint8Array): Promise<string> {
  // sealFrame() 内部自己生成随机 iv;这里要固定 iv 才能让向量可复核,所以直接
  // 复刻它的 subtle.encrypt 调用,不经过 sealFrame。
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return b64u(ct)
}

async function main() {
  const kpA = await genKeypair()
  const kpB = await genKeypair()

  const sharedBits = await deriveSharedBits(kpA.privateKey, kpB.publicKey)
  const sharedB64 = b64u(sharedBits)

  const iv = Uint8Array.from({ length: 12 }, (_, i) => i) // 固定、可读,不是真实协议的用法

  // 32 hex = 't' + 16 字节(短命令令牌那一路真实前缀形状);48 hex = 'd' + 24
  // 字节(隧道 device token 那一路)。
  const emptyToken = ''
  const shortDeviceToken = 't' + '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'
  const tunnelDeviceToken = 'd' + 'f1e2d3c4b5a697887766554433221100aabbccdd11223344'
  const chineseToken = '设备令牌-厨房的老张-🍵'

  const plaintexts = {
    empty: new Uint8Array(0),
    shortJson: new TextEncoder().encode(JSON.stringify({ type: 'ping', seq: 7, ok: true })),
    bigRandom: webcrypto.getRandomValues(new Uint8Array(4096)),
  }

  const specs: Array<{ id: string; bind: string; pt: Uint8Array }> = [
    { id: 'empty-token_empty-pt', bind: emptyToken, pt: plaintexts.empty },
    { id: 'empty-token_short-json', bind: emptyToken, pt: plaintexts.shortJson },
    { id: 'short-device-token_empty-pt', bind: shortDeviceToken, pt: plaintexts.empty },
    { id: 'short-device-token_short-json', bind: shortDeviceToken, pt: plaintexts.shortJson },
    { id: 'tunnel-device-token_short-json', bind: tunnelDeviceToken, pt: plaintexts.shortJson },
    { id: 'tunnel-device-token_big-random', bind: tunnelDeviceToken, pt: plaintexts.bigRandom },
    { id: 'chinese-token_short-json', bind: chineseToken, pt: plaintexts.shortJson },
    { id: 'chinese-token_big-random', bind: chineseToken, pt: plaintexts.bigRandom },
  ]

  const vectors: Vector[] = []
  for (const spec of specs) {
    const bindBytes = new TextEncoder().encode(spec.bind)
    const key = await hkdfAesKey(sharedBits, bindBytes)
    const ct = await sealFixedIv(key, spec.pt, iv)
    vectors.push({
      id: spec.id,
      privA: kpA.privB64,
      pubA: kpA.pubB64,
      privB: kpB.privB64,
      pubB: kpB.pubB64,
      shared: sharedB64,
      bind: spec.bind,
      iv: b64u(iv),
      plaintext: b64u(spec.pt),
      ct,
    })
  }

  writeFileSync(OUT, JSON.stringify({ vectors }, null, 2) + '\n', 'utf8')
  console.log(`wrote ${vectors.length} vectors to ${OUT}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
