import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import type { CliSessionRowT } from '../backend/types'
import { useBackendCtx } from './BackendProvider'
import { useConnection, useQuery } from './hooks'

/**
 * 终端里的会话没有推送主题(它们的事件只经 hooks 进 daemon),所以看得见的页面自己拉:
 * 获得焦点拉一次,在前台时每 TERMINAL_POLL_MS 再拉一次;够不着电脑就不拉(省得报错刷屏)。
 * 标签栏只读缓存(poll=false),不额外起定时器。
 */
export const TERMINAL_POLL_MS = 15_000
const NONE: CliSessionRowT[] = []

export function useTerminalSessions(opts: { poll?: boolean } = {}) {
  const { backend } = useBackendCtx()
  const conn = useConnection()
  const online = backend.mode === 'demo' || conn.state === 'online'
  const q = useQuery<CliSessionRowT[]>('cli:sessions', () => backend.cliSessions())
  const { refresh } = q
  const poll = opts.poll !== false
  useFocusEffect(useCallback(() => {
    if (!poll || !online) return
    void refresh()
    const h = setInterval(() => { void refresh() }, TERMINAL_POLL_MS)
    return () => clearInterval(h)
  }, [poll, online, refresh]))
  return { sessions: q.data ?? NONE, loaded: q.data !== undefined, error: q.error, refresh, online }
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
    say: (sessionId: string, text: string) => run(`cli:say:${sessionId}`, () => backend.cliSay(sessionId, text)),
  }
}
