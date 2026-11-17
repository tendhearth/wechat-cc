import { useEffect } from 'react'
import type { RosterItemT, RosterResponseT } from '@wechat-cc/protocol'
import { useBackendCtx } from './BackendProvider'
import { useConnection, useQuery } from './hooks'
const EMPTY: RosterItemT[] = []

/** Preserve the last successful projection while disconnected; waiting emphasis requires a current read. */
export function useRoster() {
  const { backend } = useBackendCtx()
  const connection = useConnection()
  const online = connection.state === 'online'
  const q = useQuery<RosterResponseT>('roster', () => backend.roster!(), { enabled: !!backend.roster && online, refreshOnMount: true })
  useEffect(() => {
    if (!backend.roster || !online) return
    let active = true, reading = false, pending = false
    const refresh = async () => {
      pending = true
      if (reading) return
      reading = true
      try { do { pending = false; await q.refresh() } while (active && pending) }
      finally { reading = false }
    }
    const off = backend.subscribe('roster', () => { void refresh() })
    return () => { active = false; off() }
  }, [backend, online, q.refresh])
  return { items: q.data?.items ?? EMPTY, stale: !online || !!q.error || !q.fresh, error: q.error, refresh: q.refresh }
}
