import { useEffect, useState } from 'react'
import type { Backend } from '../backend/types'

type Stream = Awaited<ReturnType<NonNullable<Backend['conversationEvents']>>>

/** Scope both cached text and in-flight polls to the paired backend. */
export function useConversationStream(backend: Backend, online: boolean): Stream | undefined {
  const [snapshot, setSnapshot] = useState<{ backend: Backend; data: Stream }>()
  useEffect(() => {
    setSnapshot(undefined)
    if (!online || !backend.conversationEvents) return
    let active = true, busy = false, cursor = 0, scope: string | undefined
    const events = new Map<string, Stream['events'][number]>()
    const poll = async () => {
      if (busy) return
      busy = true
      try {
        const next = await backend.conversationEvents!(cursor)
        if (!active) return
        if(next.scope && scope && next.scope !== scope){events.clear();cursor=0;scope=next.scope;setSnapshot(undefined);return}
        scope=next.scope??scope
        cursor = next.cursor
        for (const event of next.events) events.set(event.id, event)
        // Old turns are already in the durable conversation; do not retain their text in memory.
        for (const [id, event] of events) if (event.turnId !== next.running?.turnId) events.delete(id)
        setSnapshot({ backend, data: { ...next, events: [...events.values()] } })
      } catch { /* The next poll or reconnect retries this read. */ }
      finally { busy = false }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1000)
    return () => { active = false; clearInterval(timer) }
  }, [backend, online])
  return snapshot?.backend === backend && online ? snapshot.data : undefined
}
