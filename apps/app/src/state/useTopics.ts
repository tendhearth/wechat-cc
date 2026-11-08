import { useEffect } from 'react'
import type { TopicsSnapshot } from '@wechat-cc/protocol'
import type { z } from 'zod'
import { useBackendCtx } from './BackendProvider'
import { useConnection, useQuery } from './hooks'

/** Coalesce revisions, retaining a trailing read if a change arrives during an older request. */
export function useTopicsRevision(enabled: boolean, refresh: () => Promise<void>) {
  const { backend } = useBackendCtx()
  useEffect(() => {
    if (!enabled) return
    let active = true, reading = false, pending = false, revision: string | undefined
    const changed = async () => {
      pending = true
      if (reading) return
      reading = true
      try { do { pending = false; await refresh() } while (active && pending) }
      finally { reading = false }
    }
    const off = backend.subscribe<z.infer<typeof TopicsSnapshot>>('topics', data => {
      if (data.revision === revision) return
      revision = data.revision; void changed()
    })
    return () => { active = false; off() }
  }, [backend, enabled, refresh])
}
export function useTopics(p: { view?: 'recent' | 'all'; cursor?: string } = {}) {
  const { backend } = useBackendCtx()
  const connection = useConnection()
  const enabled = connection.topics === 'v1' && connection.state === 'online'
  const q = useQuery(`topics:${p.view ?? 'recent'}:${p.cursor ?? ''}`, () => backend.topics({ ...p, limit: p.view === 'all' ? 50 : 6 }), { enabled, refreshOnMount: true })
  useTopicsRevision(enabled, q.refresh)
  return { ...q, supported: connection.topics === 'v1', online: connection.state === 'online' }
}
