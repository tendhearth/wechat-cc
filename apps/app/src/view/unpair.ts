import { BackendError } from '../backend/types'

export type UnpairNotice = 'none' | 'computerStillLists' | 'neutral'

/** 解除配对时 backend.unpair() 的结果 ⇒ 本机清掉之后要不要、说什么。err = null 表示成功。 */
export function unpairNotice(err: unknown): UnpairNotice {
  if (err === null) return 'none'
  if (err instanceof BackendError) {
    if (err.code === 'revoked') return 'none' // 电脑那边已经撤了
    if (err.code === 'offline' || err.code === 'timeout') return 'computerStillLists'
  }
  return 'neutral'
}
