import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import { useBackendCtx } from './BackendProvider'
import { useConnection, useQuery } from './hooks'

export const CONNECTIONS_POLL_MS = 30_000

/** Codex confirmation happens on the computer. Refresh while this page is visible. */
export function useConnections() {
  const { backend } = useBackendCtx()
  const conn = useConnection()
  const q = useQuery('connections', () => backend.connections(), { refreshOnMount: true })
  const { refresh } = q
  const online = backend.mode === 'demo' || conn.state === 'online'
  useFocusEffect(useCallback(() => {
    if (!online) return
    void refresh()
    const timer = setInterval(() => { void refresh() }, CONNECTIONS_POLL_MS)
    return () => clearInterval(timer)
  }, [refresh, online]))
  return q
}
