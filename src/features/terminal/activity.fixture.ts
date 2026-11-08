/**
 * activity.fixture.ts —— 测试用的整段解析(只给 *.test.ts 用)。
 *
 * M6d 以前出口有一份 parseActivity:整段记录喂进 feedActivity、放进内存数组。出口已经只读步(terminal-steps.ts),
 * 这一份留在测试里当「对照」:增量读不管分几次、从哪断开,读出来的步都要和整段解析一遍逐字段一样。
 */
import type { CliSource } from '../../app/cli-events'
import type { TerminalStepPayload } from '../../ports/terminal-steps'
import { ACTIVITY_MAX_ITEMS, feedActivity } from './cli-activity'

/** 整段记录解析一遍,最近 max 步(旧 → 新)。口径 = M6d 以前的 parseActivity。 */
export function parseAll(jsonl: string, source: CliSource, max = ACTIVITY_MAX_ITEMS): TerminalStepPayload[] {
  const items: TerminalStepPayload[] = []
  const byCall = new Map<string, { ref: number; keepOutput: boolean }>()
  feedActivity<number>(jsonl, source, {
    last: () => (items.length ? { ref: items.length - 1, item: items[items.length - 1]! } : null),
    push: (item) => items.push(item) - 1,
    update: () => { /* 同一个对象,改了就是改了 */ },
    claim: (callId, ref, keepOutput) => { byCall.set(callId, { ref, keepOutput }) },
    take: (callId) => {
      const hit = byCall.get(callId)
      if (!hit) return null
      byCall.delete(callId)
      return { ref: hit.ref, item: items[hit.ref]!, keepOutput: hit.keepOutput }
    },
  })
  return items.slice(-max)
}
