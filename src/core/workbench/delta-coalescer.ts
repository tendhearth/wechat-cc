import type { AgentEvent } from '../agent-provider'
/** 逐字增量 150ms 合一次再落库(spec §4):每个 token 一次 SQLite UPDATE 太贵,而人眼 150ms 看不出差别。 */
export interface DeltaCoalescer { push(event: AgentEvent): void; flush(): void; dispose(): void }
type Append = Extract<AgentEvent, { kind: 'text' }> & { itemId: string; textMode: 'append' }
export function makeDeltaCoalescer(sink: (event: AgentEvent) => void, opts: { windowMs?: number; now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout; onError?: (error: unknown) => void } = {}): DeltaCoalescer {
  const windowMs = opts.windowMs ?? 150
  const setTimer = opts.setTimer ?? setTimeout
  const clearTimer = opts.clearTimer ?? clearTimeout
  const buffers = new Map<string, string>()      // 插入顺序 = 先后
  let timer: ReturnType<typeof setTimeout> | null = null
  // sink 可能是落库(SQLite 出错、磁盘满……):这条 flush 路径常年挂在裸 setTimeout 下,
  // 抛出去没有调用方接得住,会一路冒到 process.on('uncaughtException') 把守护进程带走。
  const guardedSink = (event: AgentEvent) => { try { sink(event) } catch (error) { try { opts.onError?.(error) } catch { /* onError 本身别再抛 */ } } }
  const flushOne = (itemId: string) => {
    const text = buffers.get(itemId)
    if (text === undefined) return
    buffers.delete(itemId)
    // 若这一刀把缓冲清空了,别留一个孤儿计时器——它会在下一条不相干 itemId 的
    // append 上顶班,偷走它本该有的完整 windowMs(见评审:replace 触发的局部 flush
    // 曾让旧倒计时"续命",下一个 itemId 提前拿到不完整的窗口)。
    if (buffers.size === 0 && timer) { clearTimer(timer); timer = null }
    guardedSink({ kind: 'text', text, itemId, textMode: 'append' })
  }
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
      guardedSink(event)
    },
    flush,
    dispose() { flush() },
  }
}
