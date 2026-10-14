import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import type { OverseerTodayT } from '../backend/types'
import { useBackendCtx } from './BackendProvider'
import { useConnection, useQuery } from './hooks'
import { TERMINAL_POLL_MS } from './useTerminal'

/**
 * 「今天」(GET /m/api/today):终端那一路没有推送主题,所以和终端列表一样 —— 此刻页获得焦点拉一次,
 * 在前台时按同一个节奏再拉;够不着电脑就不拉。只读,不会让电脑主动发任何东西。
 */
export function useToday() {
  const { backend } = useBackendCtx()
  const conn = useConnection()
  const online = backend.mode === 'demo' || conn.state === 'online'
  const q = useQuery<OverseerTodayT>('overseer:today', () => backend.today())
  const { refresh } = q
  useFocusEffect(useCallback(() => {
    if (!online) return
    void refresh()
    const h = setInterval(() => { void refresh() }, TERMINAL_POLL_MS)
    return () => clearInterval(h)
  }, [online, refresh]))
  return { today: online ? q.data : undefined, error: q.error }
}
