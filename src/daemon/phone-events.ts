/**
 * phone-events.ts — 手机隧道订阅的事件集线器(v2 协议第 9 步,2026-09-29)。
 *
 * 手机订阅一个主题(`home` / `approvals` / `agents` / `matter/<id>`,见 phone-routes.ts 的
 * `PHONE_TOPICS`),集线器从注入的 `TopicSource[]` 里找到匹配的来源要一份快照,稳定序列化
 * 后跟上一份比较,变了就把该主题的 `seq` 加一、推给它所有订阅者。
 *
 * 事件是状态快照(前置裁决 1):没有环形缓冲,补发漏掉的事件不是这里的工作 —— 订阅时
 * 只发「当下」这一份,调用方带来的 `since` 跟当下的 `{epoch, seq}` 完全相同才省一次发送。
 * `epoch` 是这个 hub 实例的随机字符串,daemon 一重启就变 —— 手机端认出 epoch 变了,就知道
 * 该扔掉本地缓存的 seq、当成全新订阅处理,而不是去凑一份「续接」。
 *
 * 隧道怎么接进来是第 10 步,真实的 TopicSource(home/approvals/agents/matter)在第 11 步
 * 注册进 `sources` —— 这一步只管集线器本身,测试里的来源全是假的。
 *
 * 重入(继承自第 8 步的教训):poke() 会被工作台 `changes.onChange` 回调捅一下,不能在
 * 调用者的栈里同步重算再发送(那样可能反过来在工作台的调用栈里递归进工作台的 hub)。
 * 所以 poke() 只是设一个标记、排到微任务里执行,同一拍内连续调用多少次都合并成一轮。
 * 单个主题的重算本身也不能跟上一轮重叠(来源是异步的、随时可能还没返回) —— 见下面
 * `recomputeTopic` 的 computing/dirty 两个标记:进行中再来一次就只标脏,轮到 finally
 * 里再补一轮,不会并发起两个 snapshot() 调用。
 */
import { randomUUID } from 'node:crypto'

export interface TopicSource {
  match(topic: string): boolean
  snapshot(topic: string): Promise<unknown>
}

export interface PhoneEvents {
  /**
   * 订阅一个主题;返回取消订阅函数。订阅会立即触发一次这个主题的重算,算完之后
   * (除非 `since` 已经等于当下的 `{epoch, seq}`)把当下的快照发给这一个新订阅者 ——
   * 如果这一轮算出来的数据跟别的订阅者手上的不一样,该主题所有订阅者都会收到广播,
   * 这个新订阅者只是顺带被包含在内,不会被重复发送两次。
   */
  subscribe(
    topic: string,
    since: { epoch: string; seq: number } | undefined,
    send: (ev: { epoch: string; seq: number; data: unknown }) => void,
  ): () => void
  /** 所有有订阅者的主题立即重算一轮(排到微任务,同一拍内多次调用合并成一轮)。 */
  poke(): void
  /** 清掉轮询定时器与全部订阅;之后的 subscribe / poke / dispose 都是空操作。 */
  dispose(): void
}

/** 稳定序列化:对象键递归排序后再 JSON.stringify;数组保持原有顺序。 */
function stableSerialize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) out[key] = sortKeysDeep(src[key])
    return out
  }
  return value
}

interface Subscriber {
  send: (ev: { epoch: string; seq: number; data: unknown }) => void
  /** 这个订阅者上一次收到的 {epoch, seq};初始值取自它订阅时带来的 `since`(用来去重)。 */
  lastSent: { epoch: string; seq: number } | undefined
}

interface TopicState {
  subs: Map<number, Subscriber>
  seq: number
  /** 上一次成功算出的稳定序列化结果;undefined = 这个主题从没成功算出过快照。 */
  serialized: string | undefined
  data: unknown
  /** 这个主题是不是正有一轮 recomputeTopic 在跑(await 来源期间)。 */
  computing: boolean
  /** computing 期间又被 poke/subscribe 捅了一下 —— 当前这轮跑完之后要再补一轮。 */
  dirty: boolean
}

export function makePhoneEvents(opts: {
  sources: TopicSource[]
  pollMs?: number
  now?: () => number
  log?: (tag: string, line: string) => void
}): PhoneEvents {
  const epoch = randomUUID()
  const now = opts.now ?? (() => Date.now())
  const log = opts.log ?? (() => {})
  const topics = new Map<string, TopicState>()
  let nextSubId = 1
  let disposed = false
  let pokeScheduled = false

  function stateFor(topic: string): TopicState {
    let s = topics.get(topic)
    if (!s) {
      s = { subs: new Map(), seq: 0, serialized: undefined, data: undefined, computing: false, dirty: false }
      topics.set(topic, s)
    }
    return s
  }

  /** 把 state 当下的 {epoch, seq, data} 发给所有「还没收到这一版」的订阅者。 */
  function flush(state: TopicState): void {
    if (state.serialized === undefined) return // 从没成功算出过快照,没什么可发的
    for (const [id, sub] of [...state.subs]) {
      if (sub.lastSent && sub.lastSent.epoch === epoch && sub.lastSent.seq === state.seq) continue
      try {
        sub.send({ epoch, seq: state.seq, data: state.data })
        sub.lastSent = { epoch, seq: state.seq }
      } catch {
        // send 抛错 ⇒ 只移除这一个订阅,其它订阅者不受影响。
        state.subs.delete(id)
      }
    }
  }

  /**
   * 对一个主题跑一轮:找来源要快照、稳定序列化后跟上一份比较,变了就 seq+1,最后
   * 一律 flush 一次(哪怕没变 —— 好让刚订阅、还没收到过数据的新订阅者补上)。
   * 跟同一主题上一轮不重叠:进行中再被喊到就只标脏,轮到 finally 里再补一轮。
   */
  async function recomputeTopic(topic: string): Promise<void> {
    const state = topics.get(topic)
    if (!state || state.subs.size === 0) return // 没有订阅者的主题不计算
    if (state.computing) {
      state.dirty = true
      return
    }
    state.computing = true
    try {
      const source = opts.sources.find(s => s.match(topic))
      if (!source) {
        log('phone-events', `t=${now()} 没有来源匹配主题 ${topic}`)
        return
      }
      let data: unknown
      try {
        data = await source.snapshot(topic)
      } catch (err) {
        log('phone-events', `t=${now()} 主题 ${topic} 的来源抛错,本轮跳过:${String(err)}`)
        return
      }
      const serialized = stableSerialize(data)
      if (state.serialized === undefined || serialized !== state.serialized) {
        state.serialized = serialized
        state.data = data
        state.seq += 1
      }
    } finally {
      state.computing = false
      flush(state)
      if (state.dirty) {
        state.dirty = false
        void recomputeTopic(topic)
      }
    }
  }

  function subscribe(
    topic: string,
    since: { epoch: string; seq: number } | undefined,
    send: (ev: { epoch: string; seq: number; data: unknown }) => void,
  ): () => void {
    if (disposed) return () => {}
    const state = stateFor(topic)
    const id = nextSubId++
    state.subs.set(id, { send, lastSent: since })
    void recomputeTopic(topic)
    return () => {
      state.subs.delete(id)
    }
  }

  function poke(): void {
    if (disposed || pokeScheduled) return
    pokeScheduled = true
    // 不在调用者的栈里同步重算 —— 排到微任务,同一拍内连续多次 poke() 只排一次。
    queueMicrotask(() => {
      pokeScheduled = false
      if (disposed) return
      for (const [topic, state] of topics) {
        if (state.subs.size > 0) void recomputeTopic(topic)
      }
    })
  }

  const pollMs = opts.pollMs ?? 2000
  const timer = setInterval(poke, pollMs)
  if (typeof timer.unref === 'function') timer.unref()

  function dispose(): void {
    if (disposed) return
    disposed = true
    clearInterval(timer)
    topics.clear()
  }

  return { subscribe, poke, dispose }
}
