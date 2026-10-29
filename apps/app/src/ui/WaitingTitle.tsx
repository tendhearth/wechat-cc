import { useBackendCtx } from '../state/BackendProvider'
import { useQuery } from '../state/hooks'
import { Txt } from './Txt'

/** Reuse the cached human explanation. Only the first home entry may request generation. */
export function WaitingTitle({ taskId, requestId, fallback, fetch = false }: { taskId: string; requestId: string; fallback: string; fetch?: boolean }) {
  const { backend } = useBackendCtx()
  const insight = useQuery(`insight:${taskId}`, lang => backend.insight(taskId, lang), { enabled: fetch })
  return <Txt role="item" content="user" numberOfLines={2}>{insight.data?.explanations[requestId]?.title || fallback}</Txt>
}
