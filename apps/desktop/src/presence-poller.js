// @ts-check
// presence-poller.js — 桌宠状态的轮询(spec 2026-09-03-companion-presence §3.1)。
//
// 契约照 doctor-poller.js:单例、去重、subscribe 回放、无 DOM 依赖。
// 一点不同:拉不到时**发布 DOWN_PRESENCE**,不保留上一次的好状态 —— 灯该灭
// 就灭,daemon 挂了还挥手的熊是在撒谎。

/** @typedef {{ presence: string, activity: { kind: string, label: string, since: string | null }, news: { unread: number, latest_kind: string | null, latest_title: string | null } }} Presence */

/** @type {Presence} */
export const DOWN_PRESENCE = Object.freeze({
  presence: 'down',
  activity: Object.freeze({ kind: 'idle', label: '', since: null }),
  news: Object.freeze({ unread: 0, latest_kind: null, latest_title: null }),
})

/**
 * @param {{ invokeApi: (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>, intervalMs?: number }} opts
 */
export function createPresencePoller({ invokeApi, intervalMs = 20_000 }) {
  /** @type {Presence | null} */
  let current = null
  /** @type {Set<(p: Presence) => void>} */
  const subscribers = new Set()
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null
  /** @type {Promise<Presence> | null} */
  let inflight = null

  /** @param {Presence} p */
  function notify(p) {
    for (const cb of Array.from(subscribers)) {
      try { cb(p) } catch (err) { console.error('presence subscriber threw', err) }
    }
  }

  function refresh() {
    if (inflight) return inflight
    inflight = (async () => {
      let next = DOWN_PRESENCE
      try {
        const r = /** @type {Presence | null} */ (await invokeApi('GET', '/v1/companion/presence', undefined, { timeoutMs: 5_000 }))
        if (r && typeof r === 'object' && typeof r.presence === 'string') next = r
      } catch { /* down */ }
      current = next
      notify(next)
      return next
    })().finally(() => { inflight = null })
    return inflight
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => { refresh() }, intervalMs)
      refresh()
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null }
    },
    refresh,
    /** @param {(p: Presence) => void} cb */
    subscribe(cb) {
      subscribers.add(cb)
      if (current) { try { cb(current) } catch (err) { console.error('presence subscriber threw', err) } }
      return () => subscribers.delete(cb)
    },
    get current() { return current },
  }
}
