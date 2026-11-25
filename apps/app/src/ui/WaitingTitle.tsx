import { useBackendCtx } from '../state/BackendProvider'
import { useQuery } from '../state/hooks'
import { Txt } from './Txt'

/** Reuse the cached human explanation. Only the first home entry may request generation. */
export function useWaitingTitle(taskId: string, requestId: string, fallback: string, fetch = false): string {
  const { backend } = useBackendCtx()
  const insight = useQuery(`insight:${taskId}`, lang => backend.insight(taskId, lang), { enabled: fetch })
  return insight.data?.explanations[requestId]?.title || fallback
}

export function WaitingTitle({ taskId, requestId, fallback, fetch = false }: { taskId: string; requestId: string; fallback: string; fetch?: boolean }) {
  const title = useWaitingTitle(taskId, requestId, fallback, fetch)
  return <Txt role="item" content="user" numberOfLines={2}>{title}</Txt>
}
