/**
 * task-changes — 任务详情"变了"的信号(docs/superpowers/specs/2026-09-17-workbench-live-stream-design.md §1)。
 * 持久化的 seq 在 workbench_tasks.seq(store 负责 +1);这里只缓存最新值并让长轮询挂着等。
 * 不是事件总线:只有 publish / wait,照抄 cli-permission-relay 的 waiters 写法。
 */
export interface TaskChangeHub {
  publish(taskId: string, seq: number): void
  seq(taskId: string): number
  wait(taskId: string, since: number, maxMs: number): Promise<number>
  dispose(): void
}
type Waiter = () => void
export function makeTaskChangeHub(opts: { maxWaitersPerTask?: number } = {}): TaskChangeHub {
  const max = opts.maxWaitersPerTask ?? 8
  const seqs = new Map<string, number>()
  const waiters = new Map<string, Set<Waiter>>()
  const wake = (taskId: string) => { const list = waiters.get(taskId); if (!list) return; waiters.delete(taskId); for (const w of list) w() }
  return {
    publish(taskId, seq) { if (seq > (seqs.get(taskId) ?? 0)) seqs.set(taskId, seq); wake(taskId) },
    seq: taskId => seqs.get(taskId) ?? 0,
    wait(taskId, since, maxMs) {
      const current = seqs.get(taskId) ?? 0
      if (current > since) return Promise.resolve(current)
      const list = waiters.get(taskId) ?? new Set<Waiter>()
      if (list.size >= max) return Promise.resolve(current)
      return new Promise(resolve => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          clearTimeout(t)
          list.delete(finish)
          resolve(seqs.get(taskId) ?? 0)
        }
        const t = setTimeout(finish, maxMs)
        ;(t as { unref?: () => void }).unref?.()
        list.add(finish); waiters.set(taskId, list)
      })
    },
    dispose() { for (const id of [...waiters.keys()]) wake(id); seqs.clear() },
  }
}
