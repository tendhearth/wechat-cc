import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import type { CliActivityItemT, CliSessionRowT } from '../backend/types'
import { useBackendCtx } from './BackendProvider'
import { useConnection, useQuery } from './hooks'

/**
 * 终端里的会话没有推送主题(它们的事件只经 hooks 进 daemon),所以看得见的页面自己拉:
 * 获得焦点拉一次,在前台时每 TERMINAL_POLL_MS 再拉一次;够不着电脑就不拉(省得报错刷屏)。
 * 标签栏只读缓存(poll=false),不额外起定时器。
 */
export const TERMINAL_POLL_MS = 15_000
const NONE: CliSessionRowT[] = []

export function useTerminalSessions(opts: { poll?: boolean; fastMs?: number } = {}) {
  const { backend } = useBackendCtx()
  const conn = useConnection()
  const online = backend.mode === 'demo' || conn.state === 'online'
  const q = useQuery<CliSessionRowT[]>('cli:sessions', () => backend.cliSessions())
  const { refresh } = q
  const poll = opts.poll !== false
  // fastMs:刚说的一句还在送进窗口时,页面临时要快拉(有上限,由页面收)
  const every = opts.fastMs ?? TERMINAL_POLL_MS
  useFocusEffect(useCallback(() => {
    if (!poll || !online) return
    void refresh()
    const h = setInterval(() => { void refresh() }, every)
    return () => clearInterval(h)
  }, [poll, online, refresh, every]))
  return { sessions: q.data ?? NONE, loaded: q.data !== undefined, error: q.error, refresh, online }
}

/**
 * 看着它跑(2026-10-17):一条终端会话最近几步。页面看得见、够得着电脑时每 TERMINAL_ACTIVITY_POLL_MS 拉一次。
 * 读不了(老电脑没有这条路由、会话在别的电脑上)⇒ items 为空、error 带码,页面退回「最后一句」。
 */
export const TERMINAL_ACTIVITY_POLL_MS = 4_000
const NO_ITEMS: CliActivityItemT[] = []
export function useTerminalActivity(sessionId: string) {
  const { backend } = useBackendCtx()
  const conn = useConnection()
  const online = backend.mode === 'demo' || conn.state === 'online'
  const q = useQuery<CliActivityItemT[]>(`cli:activity:${sessionId}`, () => backend.cliActivity(sessionId))
  const { refresh } = q
  useFocusEffect(useCallback(() => {
    if (!online || !sessionId) return
    void refresh()
    const h = setInterval(() => { void refresh() }, TERMINAL_ACTIVITY_POLL_MS)
    return () => clearInterval(h)
  }, [online, sessionId, refresh]))
  return { items: q.data ?? NO_ITEMS, error: q.error }
}

/**
 * 拍板 / 说一句:同一个提交锁(连点只发一次),成败都重拉列表。
 * 返回 null = 成功;'busy' = 同一条已在飞;否则是错误码(timeout 已译成 uncertain)。
 */
export function useTerminalActions() {
  const { backend, store } = useBackendCtx()
  const [pending, setPending] = useState<string | null>(null)
  const reload = () => { void store.query<CliSessionRowT[]>('cli:sessions', () => backend.cliSessions()).refresh() }
  const run = useCallback(async (key: string, fn: () => Promise<void>): Promise<string | null> => {
    setPending(key)
    const r = await store.submit(key, fn)
    setPending(p => (p === key ? null : p))
    reload()
    return r === 'ok' ? null : r === 'busy' ? 'busy' : r.error
  }, [store, backend])
  return {
    pending,
    decide: (s: Pick<CliSessionRowT, 'session_id' | 'pending'>, decision: 'allow' | 'deny') =>
      run(`cli:decide:${s.session_id}`, () => backend.cliPermission({ sessionId: s.session_id, ...(s.pending?.hash ? { hash: s.pending.hash } : {}), decision })),
    /** 说一句:error 同上;sayId 只在送进开着的窗口时有(对上会话行的 last_say 才知道送没送到)。 */
    say: async (sessionId: string, text: string): Promise<{ error: string | null; sayId: string | null }> => {
      let sayId: string | null = null
      const error = await run(`cli:say:${sessionId}`, async () => { sayId = (await backend.cliSay(sessionId, text)).sayId })
      return { error, sayId: error === null ? sayId : null }
    },
  }
}
