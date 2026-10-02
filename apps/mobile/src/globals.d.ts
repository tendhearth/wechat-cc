/** phone.html 首个 <script> 里由 daemon 填的两个全局,和公网壳页(relay/pset.html)注入的 __CC_SHELL__。 */
declare var T: string
declare var REMOTE: { relay: string; id: string } | null
interface Window { __CC_SHELL__?: { relay: string; id: string } }

/** Shared Markdown browser bundle; HTML and links are filtered before rendering. */
declare var CCM: {
  renderMarkdown(value: string): string
  markdownPlainText(value: string): string
}

/**
 * packages/protocol 打包出的 IIFE(apps/mobile/src/protocol-generated.js,
 * sources.ts 的 readMobileSource 原地换进 transport.js 顶部的占位注释)挂的
 * 全局 —— v1 隧道密封帧,跟 daemon 端(同一个包)字节级兼容。形状照抄
 * packages/protocol/src/browser.ts 的 CCP 常量,手改哪边都要带上另一边。
 */
interface CCPKeyPair { priv: Uint8Array; pub: Uint8Array }
interface CCPSealedFrame { iv: string; ct: string }
declare var CCP: {
  b64u: { encode(bytes: Uint8Array): string; decode(s: string): Uint8Array }
  x25519KeyPair(priv?: Uint8Array): CCPKeyPair
  x25519Shared(priv: Uint8Array, theirPub: Uint8Array): Uint8Array
  deriveV1Key(shared: Uint8Array, bind: string): Uint8Array
  sealV1(key: Uint8Array, plaintext: Uint8Array, iv?: Uint8Array): CCPSealedFrame
  openV1(key: Uint8Array, frame: CCPSealedFrame): Uint8Array
}
