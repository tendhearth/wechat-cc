import type { ProtocolSocket } from '@wechat-cc/protocol'
import type { Backend, Connection, Unsubscribe } from '../backend/types'
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
 * 这次启动还没连上过就被拒(恢复回来的旧配对,D8)⇒ onStale(给了的话)。回调里只碰钥匙串 / 会话。
 */
export function watchConnection(backend: Backend, store: { revalidateAll(): void }, onRevoked: () => void, onStale?: () => void): Unsubscribe {
  let prev = backend.connection()
  let told = false
  let everOnline = prev.state === 'online'
  return backend.onConnection(c => {
    if (shouldRevalidate(prev, c)) store.revalidateAll()
    if (c.state === 'online') everOnline = true
    if (c.state === 'revoked' && !told) {
      told = true
      if (!everOnline && onStale) onStale()
      else onRevoked()
    }
    prev = c
  })
}

/** 启动核验(spec §7、D8):「这台」的 id 必须就是记录里的 deviceId。对不上 / 没有「这台」⇒ stale;读失败 ⇒ unknown(不下结论)。 */
export async function verifyLaunch(backend: Pick<Backend, 'devices'>, deviceId: string): Promise<'ok' | 'stale' | 'unknown'> {
  let list
  try { list = await backend.devices() } catch { return 'unknown' }
  const me = list.find(d => d.current)
  return me && me.id === deviceId ? 'ok' : 'stale'
}

/** 这次启动第一次 online 时核对一次;对不上 ⇒ onStale。电脑不在线不核对(分不清关机还是失效)。取消订阅后在飞的结果作废。 */
export function watchLaunch(backend: Pick<Backend, 'connection' | 'onConnection' | 'devices'>, deviceId: string, onStale: () => void): Unsubscribe {
  let checked = false
  let cancelled = false
  const check = (c: Connection) => {
    if (checked || c.state !== 'online') return
    checked = true
    void verifyLaunch(backend, deviceId).then(v => { if (v === 'stale' && !cancelled) onStale() })
  }
  check(backend.connection())
  const off = backend.onConnection(check)
  return () => { cancelled = true; off() }
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
