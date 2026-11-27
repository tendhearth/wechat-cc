import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import { useBackendCtx } from './BackendProvider'
import { useQuery } from './hooks'

export const CONNECTIONS_POLL_MS = 30_000

/** Codex confirmation happens on the computer. Refresh while this page is visible. */
export function useConnections() {
  const { backend } = useBackendCtx()
  const q = useQuery('connections', () => backend.connections(), { enabled: false })
  const { refresh } = q
  useFocusEffect(useCallback(() => {
    const online = () => backend.mode === 'demo' || backend.connection().state === 'online'
    if (online()) void refresh(() => backend.connections(true))
    else void refresh()
    const timer = setInterval(() => { if (online()) void refresh() }, CONNECTIONS_POLL_MS)
    return () => clearInterval(timer)
  }, [backend, refresh]))
  return q
}
