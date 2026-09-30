// 纯 TS,不引 react / react-native,node 下可测。
import { BackendError, type Backend, type Connection, type Unsubscribe } from '../backend/types'

export type QueryState<T> = { data?: T; error?: string; loading: boolean; syncedAt?: number }
export type SubmitResult = 'ok' | 'busy' | { error: string }
type Listener = () => void

export interface Query<T> {
  get(): QueryState<T>
  subscribe(cb: Listener): Unsubscribe
  refresh(): Promise<void>
}

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
  const queries = new Map<string, Query<any>>()
  function query<T>(key: string, load: () => Promise<T>): Query<T> {
    const hit = queries.get(key)
    if (hit) return hit as Query<T>
    let state: QueryState<T> = { loading: false }
    let inflight: Promise<void> | null = null
    const ls = listeners()
    const set = (s: QueryState<T>) => { state = s; ls.emit() }
    const q: Query<T> = {
      get: () => state,
      subscribe: ls.add,
      refresh() {
        if (inflight) return inflight
        set({ ...state, loading: true })
        inflight = load().then(
          data => set({ data, loading: false, syncedAt: Date.now() }),
          e => set({ ...state, loading: false, error: e instanceof BackendError ? e.code : 'unknown' }),
        ).finally(() => { inflight = null })
        return inflight
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

  // ── 连接状态 ──
  let conn: Connection | null = null
  let offConn: Unsubscribe | null = null
  const connLs = listeners()
  const same = (a: Connection, b: Connection) => a.state === b.state && a.lastSyncedAt === b.lastSyncedAt
  function connection() {
    return {
      get(): Connection {
        if (!offConn) {
          const cur = backend.connection()
          if (!conn || !same(conn, cur)) conn = cur // 保持快照引用稳定(useSyncExternalStore)
        }
        return conn!
      },
      subscribe(cb: Listener): Unsubscribe {
        const removeListener = connLs.add(cb)
        if (!offConn) {
          offConn = backend.onConnection(c => { conn = c; connLs.emit() })
          conn = conn ?? backend.connection()
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
  }

  return { query, submit, topic, connection }
}

export type Store = ReturnType<typeof makeStore>
