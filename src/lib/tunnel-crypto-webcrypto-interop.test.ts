/**
 * tunnel-crypto-webcrypto-interop.test.ts — 回归钉子(2026-09-29,Task 3:
 * `tunnel-crypto.ts` 从 node:crypto.webcrypto 换成 `@wechat-cc/protocol`
 * 的 noble 实现)。
 *
 * 证明的事:换了实现之后,daemon 这一端(`tunnel-crypto.ts` 的公开函数)还能
 * 跟一个**真的跑 WebCrypto**、按 `apps/mobile/src/transport.js` 那套顺序算
 * 密钥/加密的「手机」互通 —— 已配对的真机在外面跑的就是 transport.js,这份
 * 测试不过,换实现就是在悄悄弄丢它们。
 *
 * 「手机」这一端不直接手写 `crypto.subtle` 调用,而是复用
 * `scripts/legacy-webcrypto-v1.ts`(冻结的 WebCrypto 原始实现)——那正是
 * `tunnel-crypto.ts` 换实现之前的样子,而 `tunnel-crypto.ts` 的设计初衷就是
 * "跟浏览器 WebCrypto 字节级兼容,transport.js 抄的就是这份算法"(见它的文件
 * 头注释与 transport.js 的 onopen/onmessage 里那段 `crypto.subtle` 调用序列:
 * X25519 generateKey → deriveBits(256) → HKDF importKey → deriveKey(salt=
 * utf8(token), info='wechat-cc/tunnel/v1') → AES-GCM encrypt,随机 12 字节
 * iv,帧 `{iv,ct}` base64url)。用同一份冻结代码代表"WebCrypto 那一端"是把两
 * 件事分开验证:v1.test.ts 已经证明 legacy 版跟 transport.js 的线格式描述
 * 一致(向量),这里只再证明"daemon 新实现 ⇄ 一个真跑 WebCrypto 的对端"能连上。
 *
 * 跑法(R-c 裁决):
 *   1. 这份测试先在 `tunnel-crypto.ts` 还是 WebCrypto 实现时跑一遍,记录绿
 *      (task-3-report.md 里有那次命令与输出)。
 *   2. 换成 noble 实现后原样重跑,必须还是绿 —— 这就是回归钉子本身。
 */
import { describe, expect, it } from 'vitest'
import {
  generateTunnelKeypair, exportPublicKeyB64, importPublicKeyB64,
  deriveSharedBits, hkdfAesKey, sealFrame, openFrame,
} from './tunnel-crypto'
import {
  legacyGenerateTunnelKeypair, legacyExportPublicKeyB64, legacyImportPublicKeyB64,
  legacyDeriveSharedBits, legacyHkdfAesKey, legacySealFrame, legacyOpenFrame,
} from '../../scripts/legacy-webcrypto-v1'

// legacy-webcrypto-v1.ts 只包一层 node:crypto.webcrypto —— 这个断言确认它
// 真的在用浏览器同款 WebCrypto 原语,不是随便什么"看起来像"的东西("确认它
// 确实跑的是 WebCrypto 一端")。
it('sanity: the "phone" side of this file is really WebCrypto (node:crypto.webcrypto), not a stand-in', async () => {
  const kp = await legacyGenerateTunnelKeypair()
  // globalThis.CryptoKey is the same class node:crypto.webcrypto's generateKey
  // returns instances of (verified against node:crypto directly, not assumed).
  expect(kp.publicKey).toBeInstanceOf(globalThis.CryptoKey)
  expect(kp.privateKey).toBeInstanceOf(globalThis.CryptoKey)
})

/** 完整走一遍 transport.js 的握手 + 一问一答,手机端全程用冻结的 WebCrypto
 *  实现,daemon 端全程用 `tunnel-crypto.ts` 的公开函数(不碰内部实现)。*/
async function roundTrip(token: string): Promise<void> {
  // 1) phone → daemon: 手机发明文 { hs: 手机公钥 }(transport.js ws.onopen)。
  const phone = await legacyGenerateTunnelKeypair()
  const phonePubB64 = await legacyExportPublicKeyB64(phone.publicKey)

  // 2) daemon: 每条流现生成一次性密钥对,回明文 { hs: daemon公钥 }
  //    (tunnel-client.ts onStreamFrame 的握手分支)。
  const daemon = await generateTunnelKeypair()
  const daemonPub = await importPublicKeyB64(phonePubB64)
  const daemonBits = await deriveSharedBits(daemon.privateKey, daemonPub)
  const daemonPubB64 = await exportPublicKeyB64(daemon.publicKey)

  // 3) phone: 收到 daemon 公钥,按 transport.js 的顺序派生密钥 —— ECDH →
  //    HKDF-SHA256(salt=utf8(token), info='wechat-cc/tunnel/v1') → AES-256-GCM。
  const daemonPubForPhone = await legacyImportPublicKeyB64(daemonPubB64)
  const phoneBits = await legacyDeriveSharedBits(phone.privateKey, daemonPubForPhone)
  const phoneKey = await legacyHkdfAesKey(phoneBits, new TextEncoder().encode(token))

  // 4) phone → daemon: 手机用设备令牌绑定的密钥密封一个请求,随机 12 字节 iv
  //    (transport.js send())。
  const reqPlain = JSON.stringify({ path: '/m/api/state', method: 'GET', rid: 'r0' })
  const reqFrame = await legacySealFrame(phoneKey, new TextEncoder().encode(reqPlain))
  expect(reqFrame.iv).toMatch(/^[A-Za-z0-9_-]+$/) // base64url,无填充
  expect(reqFrame.ct).toMatch(/^[A-Za-z0-9_-]+$/)

  // 5) daemon: 试解密(tunnel-client.ts onStreamFrame 的"用已知令牌逐个试"那
  //    一段——这里只有一个候选令牌,直接算再 openFrame)。
  const daemonKey = await hkdfAesKey(daemonBits, new TextEncoder().encode(token))
  const opened = await openFrame(daemonKey, reqFrame)
  expect(JSON.parse(new TextDecoder().decode(opened))).toEqual(JSON.parse(reqPlain))

  // 6) daemon → phone: daemon 密封回包。
  const replyPlain = JSON.stringify({ rid: 'r0', status: 200, body: '{"ok":true}' })
  const replyFrame = await sealFrame(daemonKey, new TextEncoder().encode(replyPlain))

  // 7) phone: 用自己那把(WebCrypto 派生的)密钥解开 daemon 的回包。
  const decoded = await legacyOpenFrame(phoneKey, replyFrame)
  expect(JSON.parse(new TextDecoder().decode(decoded))).toEqual(JSON.parse(replyPlain))
}

describe('WebCrypto 一端(冻结,模拟手机 transport.js) ⇄ tunnel-crypto.ts 新实现一端 —— 互通回归钉子', () => {
  it('设备令牌非空:握手 → 手机发请求 → daemon 解开回包 → 手机解开', async () => {
    await roundTrip('dtest-device-token-0123456789abcdef')
  })

  it('空字符串令牌(未配对/仅链接握手场景, salt 为空):同样能握手 + 一问一答', async () => {
    await roundTrip('')
  })
})
