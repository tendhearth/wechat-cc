// @ts-check
/// <reference lib="dom" />
// task-list-reader.js — 主页读一件件事的列表(GET /v1/workbench,最近 100 件,设计稿 2026-10-31 U4)。
// 等你的事另由 attention 全局读(workbench-attention.js),不受这 100 件的窗口限制。
import { V1, v1 } from '../daemon-client.js'

export const TASK_LIMIT = 100

// 只在「此刻」开着时读(main.js 切页时 start / stop);停了以后晚到的结果不会再写回来。
/** @typedef {{data: any, stale: boolean, loading: boolean}} TaskListState */
/**
 * @param {{ call: (method: any, path: string, body?: any, opts?: any) => Promise<unknown>, onChange: (state: TaskListState) => void, intervalMs?: number, timeoutMs?: number }} deps
 */
export function createTaskListReader({call, onChange, intervalMs = 5000, timeoutMs = 10000}) {
  let generation = 0, running = false
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let timer
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let deadline
  /** @type {(() => void) | null | undefined} */ let cancel
  /** @type {Promise<void> | null} */ let inflight = null
  /** @type {TaskListState} */
  let state = {data: null, stale: false, loading: false}
  async function refresh() {
    if (!running) return
    if (inflight) return inflight
    clearTimeout(timer)
    const ticket = generation
    state = {...state, loading: true}; onChange(state)
    inflight = (async () => {
      try {
        const interrupted = new Promise((_,reject) => { cancel = () => reject(new Error('stopped')); deadline = setTimeout(() => reject(new Error('timeout')), timeoutMs) })
        const data = /** @type {any} */ (await Promise.race([v1(call, V1.workbench.list, { query: { limit: TASK_LIMIT } }), interrupted]))
        if (ticket !== generation) return
        if (!data || !Array.isArray(data.tasks)) throw new Error('invalid_tasks')
        state = {data, stale:false, loading:false}; onChange(state)
      } catch {
        if (ticket === generation) { state = {...state, stale:true, loading:false}; onChange(state) }
      } finally {
        if (ticket === generation) {
          clearTimeout(deadline); cancel = null; inflight = null
          if (running) timer = setTimeout(() => { void refresh() }, state.stale ? intervalMs * 2 : intervalMs)
        }
      }
    })()
    return inflight
  }
  function stop() { running = false; generation++; clearTimeout(timer); clearTimeout(deadline); cancel?.(); cancel = null; inflight = null }
  return {start() { if (!running) { running = true; generation++; state = {...state, stale:state.stale || !!state.data} } return refresh() }, refresh, stop}
}

