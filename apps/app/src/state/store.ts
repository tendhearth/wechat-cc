// 纯 TS,不引 react / react-native,node 下可测。
import type { Lang } from '../i18n'
import { BackendError, type Backend, type Connection, type Unsubscribe } from '../backend/types'

/** syncedAt:产出这份 data 的那次加载**发出**的时刻(store 时钟)。按发出时刻记,才能判断「是不是挂载之后拉的」。 */
export type QueryState<T> = { data?: T; error?: string; loading: boolean; syncedAt?: number }
export type SubmitResult = 'ok' | 'busy' | { error: string }
type Listener = () => void

export interface Query<T> {
  get(): QueryState<T>
  subscribe(cb: Listener): Unsubscribe
  refresh(): Promise<void>
  /** 挂载时调用:没数据(且不在 30 秒失败退避里)或数据已过期才加载;手动 refresh() 不受限。 */
  mount(): Promise<void>
  /**
   * 打开页面必拉新(批准页、进展页):data 不是 since 之后发出的加载拿到的 ⇒ 重拉;
   * since 之前就在飞的加载不算,等它落地后再拉一次。不受失败退避限制(退避只管自动的 mount())。
   */
  revalidate(since: number): Promise<void>
}

/** data 是不是 since(页面挂载时刻,取自 store.clock())之后发出的加载拿到的。 */
export function isFresh(s: QueryState<unknown>, since: number): boolean {
  return s.data !== undefined && s.syncedAt !== undefined && s.syncedAt >= since
}

export const ERROR_BACKOFF_MS = 30_000

function listeners() {
  const set = new Set<Listener>()
  return {
    add(cb: Listener): Unsubscribe { set.add(cb); return () => { set.delete(cb) } },
    emit() { for (const cb of [...set]) cb() },
    get size() { return set.size },
  }
}

export function makeStore(backend: Backend, opts: { lang?: Lang } = {}) {
  let lang: Lang = opts.lang ?? 'en'
  // 严格递增的时钟(毫秒,同一毫秒内 +1),挂载时刻与加载发出时刻比先后不会打平。
  let last = 0
  const clock = () => (last = Math.max(Date.now(), last + 1))

  // ── 查询缓存:同 key 共用一份,refresh 在飞复用 ──
  // key 编码 load 的全部输入**除了语言**:语言是 store 级输入,load 收到当下的 lang;换语言走 setLang ⇒ 判过期。
  type Slot = { q: Query<any>; invalidate(): void }
  const queries = new Map<string, Slot>()
  function query<T>(key: string, load: (lang: Lang) => Promise<T>): Query<T> {
    const hit = queries.get(key)
    if (hit) return hit.q as Query<T>
    let state: QueryState<T> = { loading: false }
    let inflight: Promise<void> | null = null
    let inflightAt = 0
    let failedAt = 0
    let gen = 0          // 每判一次过期 +1
    let freshGen = -1    // 最近一次成功落地时的 gen;!== gen ⇒ 过期
    const ls = listeners()
    const set = (s: QueryState<T>) => { state = s; ls.emit() }
    const q: Query<T> = {
      get: () => state,
      subscribe: ls.add,
      refresh() {
        if (inflight) return inflight
        set({ ...state, loading: true })
        const at = (inflightAt = clock())
        const g = gen, l = lang
        inflight = Promise.resolve().then(() => load(l)).then(
          data => { freshGen = g; failedAt = 0; set({ data, loading: false, syncedAt: at }) },
          e => { if (g === gen) failedAt = Date.now(); set({ ...state, loading: false, error: e instanceof BackendError ? e.code : 'unknown' }) },
        ).finally(() => {
          inflight = null
          // 在飞期间被判过期(换语言 / 重连):有人在看就再拉一次
          if (g !== gen && ls.size > 0) void q.refresh()
        })
        return inflight
      },
      mount() {
        if (state.loading) return Promise.resolve()
        if (state.data !== undefined) return freshGen === gen ? Promise.resolve() : q.refresh()
        if (failedAt && Date.now() - failedAt < ERROR_BACKOFF_MS) return Promise.resolve()
        return q.refresh()
      },
      revalidate(since) {
        if (isFresh(state, since)) return Promise.resolve()
        if (inflight && inflightAt >= since) return inflight
        if (inflight) return inflight.then(() => q.revalidate(since))
        return q.refresh()
      },
    }
    const invalidate = () => {
      gen++
      failedAt = 0
      if (ls.size > 0 && !inflight) void q.refresh()
    }
    queries.set(key, { q, invalidate })
    return q
  }

  /** 重连 / 回到前台 / 换语言:全部判过期;有人在看的立刻重拉(连首次失败还在退避里的也拉),其余等下次挂载。只重拉读,从不重发提交。 */
  function revalidateAll(): void {
    for (const s of queries.values()) s.invalidate()
  }
  function setLang(l: Lang): void {
    if (l === lang) return
    lang = l
    revalidateAll()
  }

  // ── 提交锁:同 key 在飞 ⇒ busy ──
  const inFlight = new Set<string>()
  async function submit(key: string, run: () => Promise<void>): Promise<SubmitResult> {
    if (inFlight.has(key)) return 'busy'
    inFlight.add(key)
    try {
      await run()
      return 'ok'
    } catch (e) {
      if (e instanceof BackendError) return { error: e.code === 'timeout' ? 'uncertain' : e.code }
      return { error: 'unknown' }
    } finally {
      inFlight.delete(key)
    }
  }

  // ── 主题:引用计数,最后一个退订才退订后端;保留最新值 ──
  type TopicName = Parameters<Backend['subscribe']>[0]
  const topics = new Map<string, { get(): unknown; subscribe(cb: Listener): Unsubscribe }>()
  function topic<T>(name: TopicName): { get(): T | undefined; subscribe(cb: Listener): Unsubscribe } {
    const hit = topics.get(name)
    if (hit) return hit as any
    let value: T | undefined
    let off: Unsubscribe | null = null
    const ls = listeners()
    const t = {
      get: () => value,
      subscribe(cb: Listener): Unsubscribe {
        const removeListener = ls.add(cb)
        if (!off) off = backend.subscribe<T>(name, d => { value = d; ls.emit() })
        let done = false
        return () => {
          if (done) return
          done = true
          removeListener()
          if (ls.size === 0 && off) { const o = off; off = null; o() }
        }
      },
    }
    topics.set(name, t)
    return t
  }

  // ── 连接状态:句柄整个 store 只建一次;快照只由 onConnection 回调更新 ──
  let conn: Connection | null = null
  let offConn: Unsubscribe | null = null
  const connLs = listeners()
  const same = (a: Connection, b: Connection) => a.state === b.state && a.lastSyncedAt === b.lastSyncedAt && a.epoch === b.epoch
  const connHandle = {
    get(): Connection {
      if (!conn) conn = backend.connection() // 只初始化一次
      return conn
    },
    subscribe(cb: Listener): Unsubscribe {
      const removeListener = connLs.add(cb)
      if (!offConn) {
        conn = conn ?? backend.connection()
        offConn = backend.onConnection(c => {
          if (conn && same(conn, c)) return // 相同值不通知、不换引用
          conn = c
          connLs.emit()
        })
      }
      let done = false
      return () => {
        if (done) return
        done = true
        removeListener()
        if (connLs.size === 0 && offConn) { const o = offConn; offConn = null; o() }
      }
    },
  }
  const connection = () => connHandle

  return { query, submit, topic, connection, clock, setLang, revalidateAll }
}

export type Store = ReturnType<typeof makeStore>
