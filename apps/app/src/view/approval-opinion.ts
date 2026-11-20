import type { PlaceT, PlaceWaitingT } from '@wechat-cc/protocol'

export type ApprovalOpinion = Pick<PlaceWaitingT, 'ccOpinion' | 'questionReason'>

export function approvalOpinion(places: readonly PlaceT[], requestId: string | undefined): ApprovalOpinion {
  const waiting = requestId ? places.find(place => place.waiting?.requestId === requestId)?.waiting : undefined
  return { ccOpinion: waiting?.ccOpinion, questionReason: waiting?.questionReason }
}

export function scheduleOpinionReads(canRead: () => boolean, read: () => void): () => void {
  const timers = [3_000, 8_000, 20_000].map(delay => setTimeout(() => {
    if (canRead()) read()
  }, delay))
  return () => timers.forEach(timer => clearTimeout(timer))
}
