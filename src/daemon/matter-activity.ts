/**
 * matter-activity.ts — 把「这件事刚有动静」节流地写成 matters.updated_at(spec 2026-10-01 §3)。
 *
 * 为什么:微信入站只刷绑定的露面时间、任务事件只在状态变化时才动 updated_at ⇒ 天天在微信聊,
 * 聊天 matter 排不上来;一直开着的长任务往下沉(真机调查 C)。
 * 重入:工作台 changes.onChange 回调里会调 note() —— note 只记一笔、排 defer / 定时器,从不同步写库。
 */
export const MATTER_TOUCH_MIN_MS = 5_000

export interface MatterActivity { note(id: string): void; dispose(): void }

export function makeMatterActivity(d: {
  touch(id: string): void
  minIntervalMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  defer?: (fn: () => void) => void
  log?: (tag: string, line: string) => void
}): MatterActivity {
  const min = d.minIntervalMs ?? MATTER_TOUCH_MIN_MS
  const now = d.now ?? (() => Date.now())
  const setTimer = d.setTimer ?? ((fn: () => void, ms: number) => { const h = setTimeout(fn, ms); (h as { unref?: () => void }).unref?.(); return h })
  const clearTimer = d.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const defer = d.defer ?? ((fn: () => void) => queueMicrotask(fn))
  const last = new Map<string, number>()
  const timers = new Map<string, unknown>()
  let disposed = false
  const write = (id: string) => {
    if (disposed) return
    last.set(id, now())
    try { d.touch(id) } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (m !== 'matter_not_found') d.log?.('MATTER', `touch ${id} failed: ${m}`)
    }
  }
  const prune = () => {
    if (last.size <= 1000) return
    const cutoff = now() - min
    for (const [id, at] of last) if (at < cutoff && !timers.has(id)) last.delete(id)
  }
  return {
    note(id) {
      if (disposed || timers.has(id)) return
      const prev = last.get(id)
      const since = prev === undefined ? Infinity : now() - prev
      if (since >= min) {
        last.set(id, now())          // 先占位:同一拍里后面的 note 走 trailing,不再排第二次 defer
        defer(() => write(id))
        prune()
        return
      }
      timers.set(id, setTimer(() => { timers.delete(id); write(id) }, min - since))
    },
    dispose() {
      disposed = true
      for (const h of timers.values()) clearTimer(h)
      timers.clear()
    },
  }
}

/** 微信入站:ensureChat 之后顺手记一笔(mw-matter 的依赖形状不变)。 */
export function ensureChatAndNote<M extends { id: string }>(ensure: (chatId: string) => M, activity: Pick<MatterActivity, 'note'> | null): (chatId: string) => M {
  return chatId => { const m = ensure(chatId); activity?.note(m.id); return m }
}
