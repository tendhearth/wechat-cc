import { useEffect, useSyncExternalStore } from 'react'
import type { MatterInputT } from '../backend/types'
import { matterInputs, observeMatterInputs, subscribeMatterInputs } from './matter-inputs'

/** 页面卸载不丢本机快照;重连后只核对电脑返回的真实回执。 */
export function useMatterInputs(taskId: string, remote: readonly MatterInputT[]) {
  const local = useSyncExternalStore(subscribeMatterInputs, () => matterInputs(taskId), () => matterInputs(taskId))
  useEffect(() => { observeMatterInputs(taskId, remote) }, [taskId, remote])
  return local
}
