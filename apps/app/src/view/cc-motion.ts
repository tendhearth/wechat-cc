export type CCMotionEvent = { behavior: 'receive' | 'done' | 'wait' | 'look'; eventKey: string }
type TimedEvent = { id: string; at: number }
type Snapshot = { active: boolean; received?: readonly TimedEvent[]; done?: readonly TimedEvent[]; outcomes?: readonly { id: string; at: number; status: string }[]; waiting?: readonly string[]; topics?: readonly string[] }

/** 每路第一次可读的数据只作基线。旧历史、重复轮询和恢复焦点不重播动作。 */
export function makeCCMotionTracker() {
  let active = false
  let received: number | undefined, done: number | undefined
  const receivedIds = new Set<string>(), doneIds = new Set<string>()
  let waiting: Set<string> | undefined
  let topicKnown = false, lastLook = -Infinity
  const topicIds = new Set<string>()
  let outcomesKnown = false, waitingKnown = false
  const outcomes = new Map<string, string>()
  return {
    read(snapshot: Snapshot): CCMotionEvent | undefined {
      if (!snapshot.active || !active) { topicKnown = false; outcomesKnown = false; waitingKnown = false; received = undefined; done = undefined }
      const canAnimate = active && snapshot.active
      active = snapshot.active
      let event: CCMotionEvent | undefined
      if (snapshot.topics !== undefined) {
        const id = snapshot.topics.find(id => !topicIds.has(id))
        if (canAnimate && topicKnown && id && !topicIds.has(id) && Date.now() - lastLook >= 12000) {
          event = { behavior: 'look', eventKey: `topic:${id}` }; lastLook = Date.now()
        }
        snapshot.topics.forEach(id => topicIds.add(id))
        topicKnown = true
      }
      const newest = (rows: readonly TimedEvent[]) => rows.reduce<TimedEvent | undefined>((last, row) => !last || row.at >= last.at ? row : last, undefined)
      const identity = (row: TimedEvent) => `${row.id}:${row.at}`
      if (snapshot.received) {
        const fresh = newest(snapshot.received.filter(row => row.at >= (received ?? Infinity) && !receivedIds.has(identity(row))))
        if (canAnimate && fresh) event = { behavior: 'receive', eventKey: `receive:${identity(fresh)}` }
        received = Math.max(received ?? -Infinity, newest(snapshot.received)?.at ?? -Infinity)
        snapshot.received.forEach(row => receivedIds.add(identity(row)))
      }
      if (snapshot.done) {
        const fresh = newest(snapshot.done.filter(row => row.at >= (done ?? Infinity) && !doneIds.has(identity(row))))
        if (canAnimate && fresh) event = { behavior: 'done', eventKey: `done:${identity(fresh)}` }
        done = Math.max(done ?? -Infinity, newest(snapshot.done)?.at ?? -Infinity)
        snapshot.done.forEach(row => doneIds.add(identity(row)))
      }
      if (snapshot.outcomes) {
        const completed = successfulCCResults(snapshot.outcomes).find(row => ['working', 'waiting'].includes(outcomes.get(row.id) ?? ''))
        if (canAnimate && outcomesKnown && completed) event = { behavior: 'done', eventKey: `done:${completed.id}:${completed.at}` }
        snapshot.outcomes.forEach(row => outcomes.set(row.id, row.status))
        outcomesKnown = snapshot.active
      }
      if (snapshot.waiting) {
        const fresh = snapshot.waiting.find(id => !waiting?.has(id))
        if (canAnimate && waitingKnown && fresh) event = { behavior: 'wait', eventKey: `wait:${fresh}` }
        // 保留已见身份,同一个请求消失后再读到也不提醒两次。
        waiting = new Set([...(waiting ?? []), ...snapshot.waiting])
        waitingKnown = snapshot.active
        if (snapshot.waiting.length && event?.behavior !== 'wait') event = undefined
      }
      return event
    },
  }
}
import { successfulCCResults } from '@wechat-cc/protocol'
