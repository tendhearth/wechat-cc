import { useEffect } from 'react'
import type { TopicsSnapshot } from '@wechat-cc/protocol'
import type { z } from 'zod'
import { useBackendCtx } from './BackendProvider'
import { useConnection, useQuery } from './hooks'

/** Subscribe only with explicit topics:v1. A routes:v1 hello alone is insufficient. */
export function useTopicsRevision(enabled: boolean, refresh: () => Promise<void>) {
  const { backend } = useBackendCtx()
  const { store } = useBackendCtx()
  useEffect(() => {
    if (!enabled) return
    return backend.subscribe<z.infer<typeof TopicsSnapshot>>('topics', () => { void refresh() })
  }, [backend, enabled, refresh, store])
}
export function useTopics(p: { view?: 'recent' | 'all'; cursor?: string } = {}) {
  const { backend } = useBackendCtx()
  const connection = useConnection()
  const enabled = connection.topics === 'v1' && connection.state === 'online'
  const q = useQuery(`topics:${p.view ?? 'recent'}:${p.cursor ?? ''}`, () => backend.topics({ ...p, limit: p.view === 'all' ? 50 : 6 }), { enabled, refreshOnMount: true })
  useTopicsRevision(enabled, q.refresh)
  return { ...q, supported: connection.topics === 'v1', online: connection.state === 'online' }
}
