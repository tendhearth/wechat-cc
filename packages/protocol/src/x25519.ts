/**
 * x25519.ts — X25519 ECDH, noble 实现(`@noble/curves`),纯净包内唯一允许的
 * 非对称密钥原语。跟 `src/lib/tunnel-crypto.ts`(WebCrypto 版,daemon 现在用
 * 的那份)必须字节级兼容:两份代码算出的 priv/pub/shared 对同一组输入要完全
 * 相同 —— 已配对的手机跑的是 WebCrypto 版,这里换实现不能让它们掉线。见
 * `packages/protocol/vectors/v1.json`(用 WebCrypto 生成)与 `v1.test.ts`。
 *
 * 随机数只走 `globalThis.crypto.getRandomValues`(三端通用的那一小块 Web
 * Crypto),不用 noble 自带的 `x25519.utils.randomSecretKey()` —— 后者内部
 * 是否落到同一个源不由这个包控制。
 */
import { x25519 } from '@noble/curves/ed25519.js'

export interface KeyPair {
  priv: Uint8Array // 32 字节
  pub: Uint8Array // 32 字节
}

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len)
  globalThis.crypto.getRandomValues(out)
  return out
}

/** 不传 `priv` ⇒ 用 `globalThis.crypto.getRandomValues` 现生成一个。 */
export function x25519KeyPair(priv?: Uint8Array): KeyPair {
  const secret = priv ?? randomBytes(32)
  const pub = x25519.getPublicKey(secret)
  return { priv: secret, pub }
}

/** X25519 ECDH raw 共享比特(32 字节),对应 WebCrypto 的 `deriveBits`。 */
export function x25519Shared(priv: Uint8Array, theirPub: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(priv, theirPub)
}
