import { useEffect, useMemo, useRef, useState } from 'react'
import { createCCActivity, type CCPhase, type CCStream } from '@wechat-cc/protocol'

/** Consume the screen's existing stream, never start a second network reader. */
export function useCCActivity(stream: CCStream | undefined, connected: boolean, active: boolean, typing: boolean, waiting: boolean) {
  const tracker = useMemo(createCCActivity, [])
  const previous = useRef<CCStream | undefined>(undefined)
  const [phase, setPhase] = useState<CCPhase>('idle')
  useEffect(() => {
    if (!connected || !active) {
      tracker.observe(null, Date.now(), false)
      previous.current = stream
    } else if (previous.current !== stream) {
      tracker.observe(stream, Date.now(), true)
      previous.current = stream
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      const now = Date.now()
      setPhase(tracker.phase({ connected: connected && active, typing, waiting, now }))
      const at = tracker.nextChangeAt(now)
      if (connected && Number.isFinite(at)) timer = setTimeout(update, at - now)
    }
    update()
    return () => clearTimeout(timer)
  }, [tracker, stream, connected, active, typing, waiting])
  return phase
}
