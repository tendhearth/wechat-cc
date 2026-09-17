import type { AgentEvent } from '../agent-provider'
/** 逐字增量 150ms 合一次再落库(spec §4):每个 token 一次 SQLite UPDATE 太贵,而人眼 150ms 看不出差别。 */
export interface DeltaCoalescer { push(event: AgentEvent): void; flush(): void; dispose(): void }
type Append = Extract<AgentEvent, { kind: 'text' }> & { itemId: string; textMode: 'append' }
export function makeDeltaCoalescer(sink: (event: AgentEvent) => void, opts: { windowMs?: number; now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {}): DeltaCoalescer {
  const windowMs = opts.windowMs ?? 150
  const setTimer = opts.setTimer ?? setTimeout
  const clearTimer = opts.clearTimer ?? clearTimeout
  const buffers = new Map<string, string>()      // 插入顺序 = 先后
  let timer: ReturnType<typeof setTimeout> | null = null
  const flushOne = (itemId: string) => { const text = buffers.get(itemId); if (text === undefined) return; buffers.delete(itemId); sink({ kind: 'text', text, itemId, textMode: 'append' }) }
  const flush = () => { if (timer) { clearTimer(timer); timer = null } for (const id of [...buffers.keys()]) flushOne(id) }
  const isAppend = (e: AgentEvent): e is Append => e.kind === 'text' && e.textMode === 'append' && typeof e.itemId === 'string'
  return {
    push(event) {
      if (isAppend(event)) {
        buffers.set(event.itemId, (buffers.get(event.itemId) ?? '') + event.text)
        if (!timer) { timer = setTimer(() => { timer = null; flush() }, windowMs); (timer as { unref?: () => void }).unref?.() }
        return
      }
      if (event.kind === 'text' && event.textMode === 'replace' && typeof event.itemId === 'string') flushOne(event.itemId)
      else flush()
      sink(event)
    },
    flush,
    dispose() { flush() },
  }
}
