import { Utf8Decoder, Utf8Encoder } from './utf8'

export type PolyfillTarget = {
  crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array; [k: string]: unknown }
  TextEncoder?: unknown
  TextDecoder?: unknown
}

/**
 * 只补缺的,已有的一律不动。必须在协议包求值之前调用(client.ts 在模块顶层就 new TextDecoder(),
 * noble 生成 X25519 密钥要 crypto.getRandomValues)—— 入口 apps/app/index.ts 先 import install-polyfills。
 * 返回补了哪几样(测试 / 开发日志用)。
 */
export function installPolyfills(g: PolyfillTarget, getRandomValues: (a: Uint8Array) => Uint8Array): string[] {
  const done: string[] = []
  if (!g.crypto) g.crypto = {}
  if (typeof g.crypto.getRandomValues !== 'function') {
    g.crypto.getRandomValues = a => getRandomValues(a)
    done.push('crypto.getRandomValues')
  }
  if (typeof g.TextEncoder !== 'function') { g.TextEncoder = Utf8Encoder; done.push('TextEncoder') }
  if (typeof g.TextDecoder !== 'function') { g.TextDecoder = Utf8Decoder; done.push('TextDecoder') }
  return done
}
