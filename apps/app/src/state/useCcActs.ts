import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import type { MatterT } from '../backend/types'
import { useBackendCtx } from './BackendProvider'
import { useQuery } from './hooks'

const NONE: MatterT[] = []
/** 页面开着时多久重拉一次:CC 自己做的事一天几件,一分钟够新(Codex 评审:别只靠换页才刷新)。 */
export const CC_ACTS_POLL_MS = 60_000

/**
 * 「CC 最近在忙」(M5c):点名 kind=act 拉 CC 自己做的那几件。页面获得焦点时重拉、开着时每分钟重拉(在做的那一轮做完了要看得到)。
 * 连上 / 重连不用这里管:store 看 connection.epoch 前进就重新验证全部查询。读不到(老 daemon 不认)⇒ 空,这一组就不出现。
 */
export function useCcActs(): MatterT[] {
  const { backend } = useBackendCtx()
  const q = useQuery<MatterT[]>('cc-acts', l => backend.ccActs(l))
  const { refresh } = q
  useFocusEffect(useCallback(() => {
    void refresh()
    const t = setInterval(() => { void refresh() }, CC_ACTS_POLL_MS)
    return () => clearInterval(t)
  }, [refresh]))
  return q.data ?? NONE
}
