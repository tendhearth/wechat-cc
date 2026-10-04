/**
 * 能整体暂停的计时器(网络守护「暂停在跑的任务」,主人 2026-10-03 拍板)。
 *
 * 执行者被 SIGSTOP 冻住的那段时间,daemon 侧为它起的计时器(codex 的连接 / 首个事件超时、
 * RPC 请求超时……)不能照走 —— 照走就会在冻住期间到点,把一个只是在等网络的任务判成失败。
 * `pause()` 把每个计时器剩下的时间记下来、撤掉真计时器;`resume()` 按剩下的时间重新起。
 * 暂停期间新起的计时器也先挂着,恢复时才开始走。
 */
export interface PausableTimer { readonly id: number }

export interface PausableTimers {
  set(fn: () => void, ms: number, options?: { unref?: boolean }): PausableTimer
  clear(timer: PausableTimer | undefined): void
  pause(): void
  resume(): void
  readonly paused: boolean
}

interface Entry { fn: () => void; remaining: number; startedAt: number; handle?: ReturnType<typeof setTimeout>; unref: boolean }

export function makePausableTimers(): PausableTimers {
  const entries = new Map<number, Entry>()
  let paused = false, seq = 0
  const arm = (id: number, entry: Entry) => {
    entry.startedAt = Date.now()
    entry.handle = setTimeout(() => { entries.delete(id); entry.fn() }, Math.max(0, entry.remaining))
    if (entry.unref) entry.handle.unref?.()
  }
  return {
    get paused() { return paused },
    set(fn, ms, options) {
      const id = ++seq
      const entry: Entry = { fn, remaining: Math.max(0, ms), startedAt: Date.now(), unref: options?.unref === true }
      entries.set(id, entry)
      if (!paused) arm(id, entry)
      return { id }
    },
    clear(timer) {
      if (!timer) return
      const entry = entries.get(timer.id)
      if (!entry) return
      entries.delete(timer.id)
      if (entry.handle) clearTimeout(entry.handle)
    },
    pause() {
      if (paused) return
      paused = true
      const now = Date.now()
      for (const entry of entries.values()) {
        if (!entry.handle) continue
        clearTimeout(entry.handle); entry.handle = undefined
        entry.remaining = Math.max(0, entry.remaining - (now - entry.startedAt))
      }
    },
    resume() {
      if (!paused) return
      paused = false
      for (const [id, entry] of entries) if (!entry.handle) arm(id, entry)
    },
  }
}
