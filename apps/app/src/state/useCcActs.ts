import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import type { MatterT } from '../backend/types'
import { useBackendCtx } from './BackendProvider'
import { useQuery } from './hooks'

const NONE: MatterT[] = []

/** 「CC 最近在忙」(M5c):点名 kind=act 拉 CC 自己做的那几件;页面获得焦点时重拉。读不到(老 daemon 不认)⇒ 空,这一组就不出现。 */
export function useCcActs(): MatterT[] {
  const { backend } = useBackendCtx()
  const q = useQuery<MatterT[]>('cc-acts', l => backend.ccActs(l))
  const { refresh } = q
  useFocusEffect(useCallback(() => { void refresh() }, [refresh]))
  return q.data ?? NONE
}
