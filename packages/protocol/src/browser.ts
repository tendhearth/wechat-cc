/**
 * browser.ts — packages/protocol 的经典脚本入口。打包成一份自包含 IIFE,挂到
 * `globalThis.CCP`,给不能 `import` 的手写脚本用:手机网页
 * `apps/mobile/src/transport.js`、公网中继壳页 `relay/pset.src.html`。
 *
 * 构建产物:`apps/mobile/src/protocol-generated.js`(`bun run build:mobile`
 * 用 `Bun.build({ entrypoints:['packages/protocol/src/browser.ts'],
 * format:'iife', minify:true })` 写出,`apps/mobile/build.test.ts` 守着跟
 * 这份源码同步)。文件名故意不叫 `protocol.generated.js`(内层带点):
 * `apps/mobile/src/transport.js` 顶部那行占位注释由
 * `apps/mobile/sources.ts` 的 `readMobileSource` 原地替换成这份文件的内
 * 容,不走 `apps/mobile/assemble.ts` 的 `{{>file.js}}` 构建期包含语法(那套
 * 标记本身不是合法 JS——见 transport.js 的头注释——而且只认单个点的扩展名,
 * `protocol.generated.js` 这种名字也匹配不上它)。
 *
 * 只碰 `globalThis.crypto.getRandomValues`(见 x25519.ts / v1.ts 的随机数来
 * 源)—— 不碰 Web Crypto 的 subtle 那一块,调用方(浏览器沙箱、中继壳页)
 * 可以没有它。
 */
import { b64uEncode, b64uDecode } from './b64u'
import { x25519KeyPair, x25519Shared } from './x25519'
import { deriveV1Key, sealV1, openV1 } from './v1'

const CCP = {
  b64u: { encode: b64uEncode, decode: b64uDecode },
  x25519KeyPair,
  x25519Shared,
  deriveV1Key,
  sealV1,
  openV1,
}

;(globalThis as unknown as { CCP: typeof CCP }).CCP = CCP

export default CCP
