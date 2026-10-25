import { useEffect, useRef } from 'react'
import { useTopic } from './hooks'

/** 首页与对话页共用版本订阅。只重读最新页,不提交或重发消息。 */
export function useChatUpdates(matterId: string | undefined, refresh: () => Promise<void>) {
  const topicName = matterId ? (`matter/${matterId}` as const) : ('home' as const)
  const topic = useTopic<{ version?: unknown; phase?: unknown }>(topicName)
  const topicKey = topic === undefined ? undefined : JSON.stringify(topic)
  const seen = useRef<{ name: string; key: string } | null>(null)
  useEffect(() => {
    if (topicKey === undefined) return
    const prev = seen.current
    seen.current = { name: topicName, key: topicKey }
    if (prev && prev.name === topicName && prev.key !== topicKey) void refresh()
  }, [topicName, topicKey, refresh])
}
