import type { Connection } from '../backend/types'

export type ConnEvent =
  | { t: 'status'; s: 'connecting' | 'ready' | 'down' }
  | { t: 'revoked' }
  | { t: 'synced'; at: number }

export const INITIAL_CONNECTION: Connection = { state: 'connecting', lastSyncedAt: null, epoch: 0 }
/** 最近同步时间最多每 5 秒换一次对象:每条事件都换会让整棵树跟着重渲染。 */
export const SYNC_THROTTLE_MS = 5_000

/**
 * 连接状态机(spec §3)。connecting 只出现在「第一次还没连上也没失败」;失败过之后的重试一律显示离线,
 * 不在「连接中 / 离线」之间来回闪。revoked 是终态。没变化返回同一个对象(useSyncExternalStore 要稳定引用)。
 */
export function reduceConnection(c: Connection, e: ConnEvent): Connection {
  if (c.state === 'revoked') return c
  if (e.t === 'revoked') return { ...c, state: 'revoked' }
  if (e.t === 'synced') {
    if (c.lastSyncedAt !== null && e.at - c.lastSyncedAt < SYNC_THROTTLE_MS) return c
    return { ...c, lastSyncedAt: e.at }
  }
  if (e.s === 'ready') return { ...c, state: 'online', epoch: c.epoch + 1 }
  if (e.s === 'down') return c.state === 'offline' ? c : { ...c, state: 'offline' }
  return c
}

/** 变成 online 且 epoch 前进(首次连上、每次重连、回到前台的新握手)⇒ 全部查询重新验证。 */
export function shouldRevalidate(prev: Connection, next: Connection): boolean {
  return next.state === 'online' && next.epoch !== prev.epoch
}
