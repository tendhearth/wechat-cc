import { useEffect, useRef } from 'react'
import type { PlaceT, PlacesResponseT } from '@wechat-cc/protocol'
import { useBackendCtx } from './BackendProvider'
import { useConnection, useQuery } from './hooks'
const EMPTY: PlaceT[] = []

/**
 * 「地方」:正面上半那几行(设计稿 2026-11-18-cc-two-sides-design.md §3)。
 * 和名单是同一份数据,所以跟着 roster 主题刷新(名单变了地方多半也变了);断线时保留上一份,但「在等你」要现读的才算。
 */
export function usePlaces() {
  const { backend, store } = useBackendCtx()
  const connection = useConnection()
  const online = connection.state === 'online'
  const freshness = useRef<{ state: string; epoch: number; since: number } | null>(null)
  if (!freshness.current || freshness.current.state !== connection.state || freshness.current.epoch !== connection.epoch) {
    freshness.current = { state: connection.state, epoch: connection.epoch, since: store.clock() }
  }
  const since = freshness.current.since
  const q = useQuery<PlacesResponseT>('places', () => backend.places!(), { enabled: !!backend.places && online, refreshOnMount: true })
  useEffect(() => {
    if (backend.places && online) void store.query<PlacesResponseT>('places', () => backend.places!()).revalidate(since)
  }, [backend, store, online, since])
  useEffect(() => {
    if (!backend.places || !online) return
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
  return { places: q.data?.places ?? EMPTY, stale: !online || !!q.error || q.data === undefined || (q.syncedAt ?? 0) < since, error: q.error, refresh: q.refresh }
}
