import { useEffect, useSyncExternalStore } from 'react'
import type { MatterInputT } from '../backend/types'
import { allMatterInputs, matterInputRecovery, matterInputState, matterInputs, observeMatterInputs, subscribeMatterInputs } from './matter-inputs'
import { useBackendCtx } from './BackendProvider'
import { useConnection } from './hooks'

/** 页面卸载不丢本机快照;重连后只核对电脑返回的真实回执。 */
export function useMatterInputs(taskId: string, remote: readonly MatterInputT[]) {
  const { backend } = useBackendCtx()
  const conn = useConnection()
  const recovery = useInputRecovery()
  const local = useSyncExternalStore(subscribeMatterInputs, () => matterInputs(taskId), () => matterInputs(taskId))
  useEffect(() => { void observeMatterInputs(taskId, remote).then(() => { if (conn.state === 'online') return matterInputState.reconcile(backend, taskId) }).catch(() => {}) }, [taskId, remote, backend, conn.state])
  useEffect(() => { if (taskId && conn.state === 'online' && recovery.phase === 'ready') void matterInputState.reconcile(backend, taskId) }, [taskId, backend, conn.state, conn.epoch, recovery.phase])
  return local
}
export const useInputRecovery = () => useSyncExternalStore(subscribeMatterInputs, matterInputRecovery, matterInputRecovery)
export const useAllMatterInputs = () => useSyncExternalStore(subscribeMatterInputs, allMatterInputs, allMatterInputs)
