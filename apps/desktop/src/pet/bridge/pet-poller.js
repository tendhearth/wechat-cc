// @ts-check
// pet-poller.js — 桌宠 pet 端点的轮询(spec 2026-09-05-cc-desktop-pet Phase B §3)。
//
// 结构照 presence-poller.js:单例、去重、subscribe 回放、无 DOM 依赖。
// 不同:拉不到时发布 **null**(不是一个假状态,由上层 runtime-events.mergeIntent
// 的「端点没接线」分支原样透传 presence);setFast(fast) 在 fastMs(前台活跃,默认
// 2 s)和 slowMs(后台,默认 10 s)两档轮询间切换 —— 切换即清掉旧计时器重排一个
// 新的,不额外触发一次立即刷新。

/** @typedef {{ owner_last_contact_at: string|null, turn: { phase: 'idle'|'thinking'|'working'|'permission', since: string|null }, last_done_at: string|null, pending_permissions: Array<{ hash: string, prompt: string, since: string, expires_at: string }> }} PetTurn */

/**
 * @param {{ invokeApi: (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>, fastMs?: number, slowMs?: number }} opts
 */
export function createPetPoller({ invokeApi, fastMs = 2_000, slowMs = 10_000 }) {
  /** @type {PetTurn | null} */
  let current = null
  /** @type {Set<(t: PetTurn | null) => void>} */
  const subscribers = new Set()
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null
  /** @type {Promise<PetTurn | null> | null} */
  let inflight = null
  let intervalMs = slowMs

  /** @param {PetTurn | null} t */
  function notify(t) {
    for (const cb of Array.from(subscribers)) {
      try { cb(t) } catch (err) { console.error('pet subscriber threw', err) }
    }
  }

  function refresh() {
    if (inflight) return inflight
    inflight = (async () => {
      /** @type {PetTurn | null} */
      let next = null
      try {
        const r = await invokeApi('GET', '/v1/companion/pet', undefined, { timeoutMs: 4_000 })
        if (r && typeof r === 'object' && !Array.isArray(r)) next = /** @type {PetTurn} */ (r)
      } catch { /* down / timeout → null, never a fake payload */ }
      current = next
      notify(next)
      return next
    })().finally(() => { inflight = null })
    return inflight
  }

  function arm() {
    if (timer) clearInterval(timer)
    timer = setInterval(() => { refresh() }, intervalMs)
  }

  return {
    start() {
      if (timer) return
      arm()
      refresh()
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null }
    },
    refresh,
    /** @param {(t: PetTurn | null) => void} cb */
    subscribe(cb) {
      subscribers.add(cb)
      if (current) { try { cb(current) } catch (err) { console.error('pet subscriber threw', err) } }
      return () => subscribers.delete(cb)
    },
    /** @param {boolean} fast */
    setFast(fast) {
      intervalMs = fast ? fastMs : slowMs
      if (timer) arm()
    },
    current() { return current },
  }
}
