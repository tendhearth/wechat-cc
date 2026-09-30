import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { Connection } from '../backend/types'
import { useBackendCtx } from './BackendProvider'
import type { QueryState } from './store'

type TopicName = Parameters<ReturnType<typeof useBackendCtx>['backend']['subscribe']>[0]

export function useQuery<T>(key: string, load: () => Promise<T>): QueryState<T> & { refresh(): Promise<void> } {
  const { store } = useBackendCtx()
  const q = store.query<T>(key, load)
  const state = useSyncExternalStore(q.subscribe, q.get, q.get)
  useEffect(() => { if (q.get().data === undefined && !q.get().loading) void q.refresh() }, [q])
  return { ...state, refresh: q.refresh }
}

export function useTopic<T>(name: TopicName): T | undefined {
  const { store } = useBackendCtx()
  const t = store.topic<T>(name)
  return useSyncExternalStore(t.subscribe, t.get, t.get)
}

export function useConnection(): Connection {
  const { store } = useBackendCtx()
  const c = store.connection()
  return useSyncExternalStore(c.subscribe, c.get, c.get)
}

export function useSubmit() {
  const { store } = useBackendCtx()
  return useCallback((key: string, run: () => Promise<void>) => store.submit(key, run), [store])
}
