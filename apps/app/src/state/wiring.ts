import type { ProtocolSocket } from '@wechat-cc/protocol'
import type { Backend, Unsubscribe } from '../backend/types'
import { makeDemoBackend } from '../backend/demo'
import { makeLiveBackend } from '../backend/live'
import type { Lang } from '../i18n'
import { shouldRevalidate } from '../net/connection'
import type { PairingRecord } from '../net/pairing'

// BackendProvider 与配对页的纯逻辑(不引 react / react-native,方便测试)。

/** 有配对记录 ⇒ 真后端(经中继);没有 ⇒ 演示后端。注入的优先(测试 / 预览)。log 只收错误码与路由键,从不收令牌。 */
export function backendFor(
  pairing: PairingRecord | null,
  deps: { lang: Lang; open(url: string): ProtocolSocket; log?(line: string): void; injected?: Backend },
): { backend: Backend; demo: (Backend & { reset(): void }) | null } {
  if (deps.injected) return { backend: deps.injected, demo: null }
  if (pairing) {
    const url = pairing.relayUrl
    return { backend: makeLiveBackend({ open: () => deps.open(url), token: pairing.deviceToken, ...(deps.log ? { log: deps.log } : {}) }), demo: null }
  }
  const demo = makeDemoBackend({ lang: deps.lang })
  return { backend: demo, demo }
}

/**
 * 重连(epoch 前进)⇒ store 全部查询重新验证(只重拉读,草稿与提交从不自动发);撤销 ⇒ onRevoked(只一次)。
 * 回调里只做这两件:revalidateAll 触发的读由 LiveBackend 推迟到钩子之外,onRevoked 只碰钥匙串。
 */
export function watchConnection(backend: Backend, store: { revalidateAll(): void }, onRevoked: () => void): Unsubscribe {
  let prev = backend.connection()
  let told = false
  return backend.onConnection(c => {
    if (shouldRevalidate(prev, c)) store.revalidateAll()
    if (c.state === 'revoked' && !told) { told = true; onRevoked() }
    prev = c
  })
}

/**
 * 配对页用:先配成,再存。pair 抛错(码过期 / 电脑不在线 / 设备满了……)⇒ save 根本不会被调用,钥匙串不留痕,
 * 会话的配对仍是 null(后端还是演示,不会进「已撤销」)。
 */
export async function pairAndSave(pair: () => Promise<PairingRecord>, save: (r: PairingRecord) => Promise<void>): Promise<PairingRecord> {
  const r = await pair()
  await save(r)
  return r
}
