// 纯 TS,不引 react / react-native,node 下可测。
import { BackendError, type Backend, type Connection, type Unsubscribe } from '../backend/types'

export type QueryState<T> = { data?: T; error?: string; loading: boolean; syncedAt?: number }
export type SubmitResult = 'ok' | 'busy' | { error: string }
type Listener = () => void

export interface Query<T> {
  get(): QueryState<T>
  subscribe(cb: Listener): Unsubscribe
  refresh(): Promise<void>
  /** 挂载时调用:没数据、没在飞、且最近 30 秒内没失败过才加载;手动 refresh() 不受限。 */
  mount(): Promise<void>
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

export function makeStore(backend: Backend) {
  // ── 查询缓存:同 key 共用一份,refresh 在飞复用 ──
  // 注意:key 必须编码 load 的全部输入;已存在的 key 再传入的 load 会被忽略。
  const queries = new Map<string, Query<any>>()
  function query<T>(key: string, load: () => Promise<T>): Query<T> {
    const hit = queries.get(key)
    if (hit) return hit as Query<T>
    let state: QueryState<T> = { loading: false }
    let inflight: Promise<void> | null = null
    let failedAt = 0
    const ls = listeners()
    const set = (s: QueryState<T>) => { state = s; ls.emit() }
    const q: Query<T> = {
      get: () => state,
      subscribe: ls.add,
      refresh() {
        if (inflight) return inflight
        set({ ...state, loading: true })
        inflight = Promise.resolve().then(load).then(
          data => set({ data, loading: false, syncedAt: Date.now() }),
          e => { failedAt = Date.now(); set({ ...state, loading: false, error: e instanceof BackendError ? e.code : 'unknown' }) },
        ).finally(() => { inflight = null })
        return inflight
      },
      mount() {
        if (state.data !== undefined || state.loading) return Promise.resolve()
        if (failedAt && Date.now() - failedAt < ERROR_BACKOFF_MS) return Promise.resolve()
        return q.refresh()
      },
    }
    queries.set(key, q)
    return q
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
  const same = (a: Connection, b: Connection) => a.state === b.state && a.lastSyncedAt === b.lastSyncedAt
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

  return { query, submit, topic, connection }
}

export type Store = ReturnType<typeof makeStore>
