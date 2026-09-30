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
 *
 * 来源超时:source.snapshot() 超过 snapshotTimeoutMs(缺省 10s)还没返回 ⇒ 当抛错处理
 * (记日志、本轮跳过、computing 复位),永不返回的来源不会把主题永远卡在 computing。
 * 超时只是不等了,那次调用还在飞:之后的重算(poke / 轮询)复用同一个在飞的 promise
 * (`pendingSnapshots`,按主题,跨 TopicState 重建)再等一个超时,不再另起 snapshot() ——
 * 否则每 2 秒一轮就会给一个已经卡住的来源再堆一个调用。它一落定就从表里摘掉;落定时
 * 正好有一轮在等就直接用它的结果。真的永不返回的调用,挂满 snapshotAbandonMs(缺省
 * 6× 超时)就放弃,下一轮重新调用,免得一次泄漏的 promise 让主题永远算不出来。
 *
 * 评审第一轮(2026-09-29)修的五处:
 *  1. 主题没人订阅了就把它的内部状态(TopicState)从 `topics` 表里摘掉,不然常驻
 *     daemon 里每个来过一次的 `matter/<id>` 都会永远占一份内存、每 2s 还被 poke 扫一遍。
 *     代价是「摘掉又长回来」会丢掉那份主题本地的 seq 计数,所以 seq 改成整个 hub 共用
 *     一个单调计数器(`globalSeq`)—— 同一个 epoch 里发出去的号码永远不会被两份不同的
 *     快照复用,哪怕中间那个主题被摘掉又重建过,旧 since 也不会误判成「跟当下一样」。
 *  2. dispose() 之后还在飞的一轮(source.snapshot() 还没 resolve)落地时不许再发送:
 *     dispose 时把每个 state 的 subs 原地清空(哪怕 recomputeTopic 手里攥着的是旧引用,
 *     flush 到的还是同一个 Map),recomputeTopic 的几个关键点也补了 `disposed` 检查。
 *  3. 快照序列化失败(循环引用让 sortKeysDeep 自己栈溢出、BigInt 让 JSON.stringify 抛)
 *     以前发生在 try/catch 之外,顺着 `void recomputeTopic(topic)` 这条没人 catch 的
 *     promise 链变成未处理的 rejection。现在挪进 try/catch,按「来源抛错」同一个待遇:
 *     记一条日志、这个主题这一轮跳过,别的主题不受影响。
 *  4. sortKeysDeep 以前直接枚举对象自身的可枚举属性,Date 这类靠内部槽位存数据、没有
 *     自身可枚举属性的对象会被序列化成 `{}`,变了也测不出来。改成跟 JSON.stringify 一样
 *     先认 `toJSON`(覆盖 Date)。Map/Set 同样没有自身可枚举属性、也没有 toJSON,这里
 *     选择明确拒绝(交给上面第 3 条的「本轮跳过」处理),不做成 tagged array —— 手机端
 *     的快照本来就该是 JSON 安全的普通对象/数组,含 Map/Set 大概率是上游给错了数据。
 *  5. 轮询定时器以前在 hub 一创建就起,零订阅者时也空转。改成惰性:第一个订阅者来了才
 *     起,最后一个订阅者走了就停(还是 unref 的)。
 */
import { randomUUID } from 'node:crypto'

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 10_000
const ABANDON_TIMEOUTS = 6

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

/**
 * 稳定序列化:对象键递归排序后再 JSON.stringify;数组保持原有顺序。
 *
 * 会抛的情况(循环引用 ⇒ 栈溢出;BigInt/Map/Set ⇒ 下面这两步之一会抛)全部交给调用方
 * 当成「这份快照这一轮算不出来」处理(修 3),这里不吞任何错误。
 */
function stableSerialize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value instanceof Map || value instanceof Set) {
    // 明确拒绝(修 4):手机端的快照该是 JSON 安全的普通对象/数组,Map/Set 没有自身可
    // 枚举属性也没有 toJSON,不拒的话会被序列化成 `{}`、变了也测不出来。
    throw new Error(`phone-events: 快照序列化不支持 ${value.constructor.name}`)
  }
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown> & { toJSON?: () => unknown }
    // 跟 JSON.stringify 同一个规矩:先认 toJSON(覆盖 Date —— 它自身没有可枚举属性,
    // 不认 toJSON 的话会被序列化成 `{}`,值变了也侦测不出来,见修 4)。
    if (typeof src.toJSON === 'function') return sortKeysDeep(src.toJSON())
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
  /** 单次 source.snapshot() 的超时(缺省 10s);超时按「来源抛错」处理。 */
  snapshotTimeoutMs?: number
  /** 一次挂住的 snapshot() 被复用多久后放弃、允许另起调用(缺省 6× snapshotTimeoutMs)。 */
  snapshotAbandonMs?: number
  now?: () => number
  log?: (tag: string, line: string) => void
}): PhoneEvents {
  const epoch = randomUUID()
  const now = opts.now ?? (() => Date.now())
  const clock = () => Date.now() // 放弃期按真实(可被假定时器驱动的)时钟算,跟 setTimeout 同源
  const log = opts.log ?? (() => {})
  const pollMs = opts.pollMs ?? 2000
  const snapshotTimeoutMs = opts.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS
  const snapshotAbandonMs = opts.snapshotAbandonMs ?? snapshotTimeoutMs * ABANDON_TIMEOUTS
  const topics = new Map<string, TopicState>()
  /** 每个主题至多一个在飞的 source.snapshot();超时后还没落定的留着给下一轮复用。 */
  const pendingSnapshots = new Map<string, { promise: Promise<unknown>; startedAt: number }>()
  let nextSubId = 1
  let disposed = false
  let pokeScheduled = false
  /** 整个 hub 共用一个单调计数器(修 1):topic state 被摘掉又重建也不会重发已经用过的号码。 */
  let globalSeq = 0
  let timer: ReturnType<typeof setInterval> | undefined

  function stateFor(topic: string): TopicState {
    let s = topics.get(topic)
    if (!s) {
      s = { subs: new Map(), seq: 0, serialized: undefined, data: undefined, computing: false, dirty: false }
      topics.set(topic, s)
    }
    return s
  }

  /** 第一个订阅者来了才起定时器(修 5);幂等,已经在跑或已 dispose 就什么都不做。 */
  function ensureTimer(): void {
    if (timer || disposed) return
    timer = setInterval(poke, pollMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** 主题表空了(没有任何订阅者)就停掉定时器(修 5);幂等。 */
  function maybeStopTimer(): void {
    if (timer && topics.size === 0) {
      clearInterval(timer)
      timer = undefined
    }
  }

  /**
   * 摘掉一个订阅(显式 unsubscribe,或者 flush 里 send 抛错)。摘完这个主题没人订阅了
   * 就把 TopicState 整个从 `topics` 表里删掉(修 1 的内存泄漏)——`topics.get(topic) ===
   * state` 这一步是防止摘的是一份已经被替换掉的旧 state(这份主题在此期间被重新订阅、
   * 建了新的 TopicState)时,误删了当下这份活的。
   */
  function dropSubscriber(topic: string, state: TopicState, id: number): void {
    state.subs.delete(id)
    if (state.subs.size === 0 && topics.get(topic) === state) {
      topics.delete(topic)
      maybeStopTimer()
    }
  }

  /** 把 state 当下的 {epoch, seq, data} 发给所有「还没收到这一版」的订阅者。 */
  function flush(topic: string, state: TopicState): void {
    if (disposed) return // 修 2:dispose 之后落地的一轮不许再发
    if (state.serialized === undefined) return // 从没成功算出过快照,没什么可发的
    for (const [id, sub] of [...state.subs]) {
      if (sub.lastSent && sub.lastSent.epoch === epoch && sub.lastSent.seq === state.seq) continue
      try {
        sub.send({ epoch, seq: state.seq, data: state.data })
        sub.lastSent = { epoch, seq: state.seq }
      } catch {
        // send 抛错 ⇒ 只移除这一个订阅,其它订阅者不受影响。
        dropSubscriber(topic, state, id)
      }
    }
  }

  /**
   * 对一个主题跑一轮:找来源要快照、稳定序列化后跟上一份比较,变了就整个 hub 的
   * globalSeq 加一(修 1)、赋给这个主题的 seq,最后一律 flush 一次(哪怕没变 —— 好让
   * 刚订阅、还没收到过数据的新订阅者补上)。跟同一主题上一轮不重叠:进行中再被喊到
   * 就只标脏,轮到 finally 里再补一轮。
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
      let snapTimer: ReturnType<typeof setTimeout> | undefined
      try {
        let pending = pendingSnapshots.get(topic)
        if (pending && clock() - pending.startedAt >= snapshotAbandonMs) {
          log('phone-events', `t=${now()} 主题 ${topic} 的来源挂了 ${snapshotAbandonMs}ms 仍未返回,放弃那次调用`)
          pendingSnapshots.delete(topic)
          pending = undefined
        }
        if (!pending) {
          let promise: Promise<unknown>
          try { promise = Promise.resolve(source.snapshot(topic)) } catch (e) { promise = Promise.reject(e) }
          const entry = { promise, startedAt: clock() }
          pendingSnapshots.set(topic, entry)
          const clear = () => { if (pendingSnapshots.get(topic) === entry) pendingSnapshots.delete(topic) }
          promise.then(clear, clear)
          pending = entry
        }
        data = await Promise.race([
          pending.promise,
          new Promise<never>((_, reject) => {
            snapTimer = setTimeout(() => reject(new Error('snapshot timeout')), snapshotTimeoutMs)
            if (typeof snapTimer.unref === 'function') snapTimer.unref()
          }),
        ]).finally(() => { if (snapTimer) clearTimeout(snapTimer) })
      } catch (err) {
        if (disposed) return // 修 2
        log('phone-events', `t=${now()} 主题 ${topic} 的来源抛错,本轮跳过:${String(err)}`)
        return
      }
      if (disposed) return // 修 2:await 期间 dispose 了,不再处理这份数据

      let serialized: string
      try {
        serialized = stableSerialize(data)
      } catch (err) {
        // 修 3:循环引用(栈溢出)、BigInt/Map/Set(JSON.stringify 或 sortKeysDeep 自己
        // 抛)—— 按来源失败同一个待遇,记一条日志、本轮跳过,绝不让它顺着这条没人 catch
        // 的 promise 链变成未处理的 rejection。
        log('phone-events', `t=${now()} 主题 ${topic} 的快照序列化失败,本轮跳过:${String(err)}`)
        return
      }
      if (state.serialized === undefined || serialized !== state.serialized) {
        globalSeq += 1
        state.serialized = serialized
        state.data = data
        state.seq = globalSeq
      }
    } finally {
      state.computing = false
      flush(topic, state)
      if (state.dirty && !disposed) {
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
    ensureTimer()
    void recomputeTopic(topic)
    return () => {
      dropSubscriber(topic, state, id)
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

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    // 原地清空每个 state 的 subs(修 2):就算某一轮 recomputeTopic 还攥着旧的 state
    // 引用在 await 来源,它 await 完之后 flush 到的还是这同一个 Map,自然发不出去。
    for (const state of topics.values()) state.subs.clear()
    topics.clear()
    pendingSnapshots.clear()
  }

  // `topicCount` 不在 PHONE_TOPICS interface 里(公开契约就是三个方法,跟需求原样一致);
  // 挂在返回对象上仅供测试用类型断言拿到,验证「没有订阅者的主题会被回收」(修 1)。
  // 用变量中转而非字面量直接 return,躲开 TS 对字面量的多余属性检查。
  const hub = {
    subscribe,
    poke,
    dispose,
    topicCount: () => topics.size,
  }
  return hub
}
