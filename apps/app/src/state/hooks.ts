import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { Connection } from '../backend/types'
import type { Lang } from '../i18n'
import { useBackendCtx } from './BackendProvider'
import { isFresh, type QueryState } from './store'

type TopicName = Parameters<ReturnType<typeof useBackendCtx>['backend']['subscribe']>[0]

/**
 * refreshOnMount:打开页面就拉新,有缓存也拉(批准页、进展页)。fresh = 当前 data 是挂载之后发出的加载拿到的;
 * 不带 refreshOnMount 时走自动 mount()(有缓存不拉、失败退避 30 秒)。
 */
export function useQuery<T>(
  key: string,
  load: (lang: Lang) => Promise<T>,
  opts?: { enabled?: boolean; refreshOnMount?: boolean },
): QueryState<T> & { refresh(): Promise<void>; fresh: boolean } {
  const { store } = useBackendCtx()
  const [mountedAt] = useState(() => store.clock())
  const q = store.query<T>(key, load)
  const state = useSyncExternalStore(q.subscribe, q.get, q.get)
  const enabled = opts?.enabled !== false
  const refreshOnMount = opts?.refreshOnMount === true
  useEffect(() => {
    if (!enabled) return
    void (refreshOnMount ? q.revalidate(mountedAt) : q.mount())
  }, [q, enabled, refreshOnMount, mountedAt])
  return { ...state, refresh: q.refresh, fresh: isFresh(state, mountedAt) }
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
