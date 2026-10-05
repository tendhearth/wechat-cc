// @ts-check
/// <reference lib="dom" />

/** @typedef {{id:string,title:string,providerId:string,pendingPermissionCount:number,pendingQuestionCount:number,attentionKey:string,first?:{kind:'permission'|'question',text:string}|null}} AttentionTask */
/** @typedef {{tasks:AttentionTask[],stale:boolean}} AttentionState */
/** @typedef {{invokeWorkbenchApi:(method:'GET',path:string)=>Promise<unknown>,invoke:(command:string,args:Record<string,unknown>)=>Promise<unknown>,onChange?:(state:AttentionState)=>void,getContext?:()=>{taskId:string|null,focused:boolean},intervalMs?:number,maxBackoffMs?:number,requestTimeoutMs?:number}} PollerOptions */

/** The key is the exact JSON array of active request IDs, not a task revision.
 * @param {unknown} value @returns {{task:AttentionTask,requestIds:string[]}[]} */
function parseAttention(value) {
  const tasks = /** @type {{tasks?:unknown}} */ (value)?.tasks
  if (!Array.isArray(tasks)) throw new Error('Invalid attention response')
  const ids = new Set()
  return tasks.map(value => {
    const task = /** @type {AttentionTask} */ (value)
    if (!task || typeof task.id !== 'string' || !task.id || ids.has(task.id)
      || typeof task.title !== 'string' || typeof task.providerId !== 'string'
      || !Number.isSafeInteger(task.pendingPermissionCount) || task.pendingPermissionCount < 0
      || !Number.isSafeInteger(task.pendingQuestionCount) || task.pendingQuestionCount < 0
      || typeof task.attentionKey !== 'string') throw new Error('Invalid attention task')
    const requestIds = JSON.parse(task.attentionKey)
    if (!Array.isArray(requestIds) || requestIds.some(id => typeof id !== 'string' || !id)
      || requestIds.length !== task.pendingPermissionCount + task.pendingQuestionCount
      || new Set(requestIds).size !== requestIds.length) throw new Error('Invalid attention requests')
    ids.add(task.id)
    return { task, requestIds: /** @type {string[]} */ (requestIds) }
  }).filter(({ requestIds }) => requestIds.length > 0)
}

/** One application-wide reader; no dependency on a mounted workbench page.
 * @param {PollerOptions} options */
export function createWorkbenchAttentionPoller(options) {
  const intervalMs = options.intervalMs ?? 3000
  const maxBackoffMs = Math.max(intervalMs, options.maxBackoffMs ?? 30000)
  const requestTimeoutMs = options.requestTimeoutMs ?? 10000
  const seen = new Set()
  /** @type {AttentionTask[]} */ let tasks = []
  /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null
  /** @type {ReturnType<typeof setTimeout>|null} */ let deadline = null
  /** @type {Promise<AttentionTask[]|null>|null} */ let inflight = null
  /** @type {(()=>void)|null} */ let cancelRequest = null
  let running = false, destroyed = false, initialized = false, retryMs = intervalMs

  function refresh() {
    if (destroyed) return Promise.resolve(null)
    if (inflight) return inflight
    if (timer !== null) { clearTimeout(timer); timer = null }
    inflight = (async () => {
      try {
        const stopped = new Promise((_, reject) => {
          cancelRequest = () => reject(new Error('Attention stopped'))
          deadline = setTimeout(() => reject(new Error('Attention timed out')), requestTimeoutMs)
        })
        const result = await Promise.race([options.invokeWorkbenchApi('GET', '/v1/workbench/attention'), stopped])
        if (destroyed) return null
        const entries = parseAttention(result)
        const context = options.getContext?.() ?? { taskId: null, focused: false }
        let shouldNotify = false
        const activeIds = new Set()
        for (const { task, requestIds } of entries) {
          for (const requestId of requestIds) {
            const key = `${task.id}:${requestId}`
            activeIds.add(key)
            if (initialized && !seen.has(key) && (!context.focused || context.taskId !== task.id)) shouldNotify = true
            // Seeing a request in its task also consumes its notice. Leaving the
            // page later must never turn that same request into a new notice.
            seen.add(key)
          }
        }
        // Retain all active requests plus recent resolved IDs; long-lived windows
        // do not accumulate an unlimited history just for notification dedup.
        for (const id of seen) {
          if (seen.size <= Math.max(4096, activeIds.size)) break
          if (!activeIds.has(id)) seen.delete(id)
        }
        initialized = true
        retryMs = intervalMs
        tasks = entries.map(({ task }) => task)
        options.onChange?.({ tasks, stale: false })
        if (shouldNotify && !destroyed) {
          // No task title, prompt, command, path, or request ID crosses into OS
          // notifications. Denied or uncertain delivery is intentionally final.
          void Promise.resolve().then(() => options.invoke('notify_user', {
            title: '一起做需要你回应',
            body: '有新的问题或权限请求。打开 CC 查看待处理事项。',
          })).catch(() => {})
        }
        return tasks
      } catch {
        if (!destroyed) {
          retryMs = Math.min(maxBackoffMs, retryMs * 2)
          options.onChange?.({ tasks, stale: true })
        }
        return null
      } finally {
        if (deadline !== null) { clearTimeout(deadline); deadline = null }
        cancelRequest = null
        inflight = null
        if (running && !destroyed) timer = setTimeout(() => { void refresh() }, retryMs)
      }
    })()
    return inflight
  }

  return {
    start() { if (destroyed) return Promise.resolve(null); running = true; return refresh() },
    refresh,
    destroy() {
      destroyed = true
      running = false
      if (timer !== null) { clearTimeout(timer); timer = null }
      if (deadline !== null) { clearTimeout(deadline); deadline = null }
      cancelRequest?.()
    },
  }
}
