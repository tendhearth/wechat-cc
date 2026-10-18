import type { ShareDraft } from '../view/share'

// 分享进来、主人还没选去处的那一份(2026-10-18)。只在内存:新的分享顶掉旧的;选了去处 / 「算了」才清。
// 不跟着换配对清 —— 没配对时分享进来,先去配对,配好回来这份还在(ShareGate 再把分享页打开)。
export type PendingShare = { seq: number; draft: ShareDraft }
let current: PendingShare | null = null
let seq = 0
const listeners = new Set<() => void>()
const notify = () => { for (const l of [...listeners]) l() }

export const getShare = (): PendingShare | null => current
export function putShare(draft: ShareDraft): PendingShare {
  current = { seq: ++seq, draft }
  notify()
  return current
}
export function clearShare(): void {
  if (!current) return
  current = null
  notify()
}
export function subscribeShare(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
