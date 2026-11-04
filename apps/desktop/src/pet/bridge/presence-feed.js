// @ts-check
// presence-feed.js — 桌宠订的 presence 主题(骨架设计稿 2026-10-31 S5;以前是 pet-poller.js 的 2 / 10 秒轮询 +
// presence-poller.js 的 20 秒轮询)。
//
// 传输就是一起做详情那条长轮询(modules/workbench-live.js createLongPoll):GET /v1/subscribe/presence?since=<cursor>&wait_ms=,
// daemon 那边内容变了才回(回合起落、工具调用、待批开与了结、任务进度、入站消息都会立刻戳它),没变最多挂 wait_ms 再回一份。
// 一份消息里两样都有:presence(处境)+ pet(在做什么)。
//
// 红线照旧(不撒谎):拉不到 ⇒ presence 发 DOWN_PRESENCE、pet 发 null(上层按「联系不上」画),不保留上一次的好状态;
// 某一半 daemon 算不出来(journal 没接 / 桌宠闭包没接)⇒ 那一半同样是 DOWN / null。
// 兜底:start() 先要一份现成的(窗口重新可见 = 醒来);断了按 1 / 2 / 5 / 10 秒重连,连上第一份马上回;
// 每次长轮询最多挂 wait_ms 就回一份当前内容 —— 等于一个 20 秒的慢心跳(连接还活着);cursor 没变就不再发一遍。
import { V1, v1 } from '../../daemon-client.js'
import { DOWN_PRESENCE } from '../../presence-poller.js'
import { createLongPoll } from '../../modules/workbench-live.js'

/** @typedef {import('../../presence-poller.js').Presence} Presence */
/** @typedef {{ owner_last_contact_at: string|null, turn: { phase: 'idle'|'thinking'|'working'|'permission', since: string|null }, last_done_at: string|null, pending_permissions: Array<{ hash: string, prompt: string, since: string, expires_at: string }>, activities?:import('../../pet-activities.js').PetTaskActivity[] }} PetTurn */
/** @typedef {{ presence: Presence, pet: PetTurn | null }} PresenceFacts */

const TOPIC = 'presence'

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 线上的一份 → 桌宠用的两样。形状不对就当拉不到(抛错,走重连),不猜。
 * @param {unknown} r @returns {PresenceFacts & { cursor: number }}
 */
export function readPresenceTopic(r) {
  if (!isObject(r) || typeof r.cursor !== 'number' || !Number.isFinite(r.cursor)) throw new Error('presence topic: unexpected response')
  const presence = isObject(r.presence) && typeof r.presence.presence === 'string' ? /** @type {Presence} */ (/** @type {unknown} */ (r.presence)) : DOWN_PRESENCE
  const pet = isObject(r.pet) ? /** @type {PetTurn} */ (/** @type {unknown} */ (r.pet)) : null
  return { cursor: r.cursor, presence, pet }
}

/** @type {PresenceFacts} */
export const DOWN_FACTS = Object.freeze({ presence: DOWN_PRESENCE, pet: null })

/**
 * @param {{ invokeApi: (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>, waitMs?: number, backoff?: number[] }} opts
 */
export function createPresenceFeed({ invokeApi, waitMs = 20_000, backoff }) {
  /** @type {PresenceFacts | null} */
  let current = null
  /** @type {Set<(f: PresenceFacts) => void>} */
  const subscribers = new Set()
  let running = false
  // 上一份发出去的 cursor。长轮询挂满 wait_ms 原样回来(cursor 没变)= daemon 那边什么都没变 ⇒ 不发:
  // 不然每 20 秒一次的心跳会把画面按旧事实重画一遍,盖掉中间本地已经开始的动作。
  /** @type {number | null} */ let lastCursor = null

  /** @param {PresenceFacts} f */
  function publish(f) {
    current = f
    for (const cb of Array.from(subscribers)) {
      try { cb(f) } catch (err) { console.error('presence feed subscriber threw', err) }
    }
  }

  /** @param {number | undefined} since @param {number} wait */
  const fetchTopic = async (since, wait) => readPresenceTopic(await v1(invokeApi, V1.subscribe.presence,
    { query: since === undefined ? { wait_ms: 0 } : { since, wait_ms: wait } }, { timeoutMs: wait + 5_000 }))

  const poll = createLongPoll({
    // createLongPoll 按 version 接着问:这里 version 就是主题的 cursor。
    fetchDetail: async (_id, since, wait) => { const r = await fetchTopic(since, wait); return { ...r, version: r.cursor } },
    onDetail: detail => { if (detail.cursor === lastCursor) return; lastCursor = detail.cursor; publish({ presence: detail.presence, pet: detail.pet }) },
    onError: () => { lastCursor = null; publish(DOWN_FACTS) },
    waitMs,
    ...(backoff ? { backoff } : {}),
  })

  return {
    /** 开始订(先马上拿一份)。已经在订 ⇒ 不动。 */
    start() {
      if (running) return
      running = true
      lastCursor = null   // 醒来那一份一定要观察一次,哪怕停订期间什么都没变
      poll.start(TOPIC, 0)
    },
    stop() {
      running = false
      poll.stop()
    },
    /**
     * 现在就要一份(拍板之后、安静 / 减少动作刚结束 —— 那一拍要观察一次当下,不能等下一次变化)。
     * 在订着就从这份的 cursor 接着订。
     * @returns {Promise<PresenceFacts>}
     */
    async refresh() {
      /** @type {PresenceFacts} */ let facts = DOWN_FACTS
      /** @type {number | undefined} */ let cursor
      try { const r = await fetchTopic(undefined, 0); facts = { presence: r.presence, pet: r.pet }; cursor = r.cursor } catch { /* 拉不到就是拉不到 */ }
      // 主动要的这一份总要观察一次(拍板之后、安静刚结束那一拍靠它消化),内容没变也发。
      lastCursor = cursor ?? null
      publish(facts)
      if (running) poll.start(TOPIC, cursor ?? 0)
      return facts
    },
    /** @param {(f: PresenceFacts) => void} cb */
    subscribe(cb) {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
    current() { return current },
  }
}
