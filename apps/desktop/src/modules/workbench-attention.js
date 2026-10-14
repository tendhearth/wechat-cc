// @ts-check
/// <reference lib="dom" />

/** @typedef {{id:string,title:string,providerId:string,pendingPermissionCount:number,pendingQuestionCount:number,attentionKey:string,first?:{kind:'permission'|'question',text:string}|null}} AttentionTask */
/** @typedef {{tasks:AttentionTask[],stale:boolean}} AttentionState */
/** @typedef {{invokeWorkbenchApi:(method:'GET',path:string)=>Promise<unknown>,invoke:(command:string,args:Record<string,unknown>)=>Promise<unknown>,onChange?:(state:AttentionState)=>void,getContext?:()=>{taskId:string|null,focused:boolean},intervalMs?:number,maxBackoffMs?:number,requestTimeoutMs?:number}} PollerOptions */

/**
 * 各任务的 phase(2026-10-06,回复 / 停下的系统通知)。老 daemon 没有这一项 ⇒ null(不弹,也不报错)。
 * @param {unknown} value @returns {Map<string,string>|null}
 */
export function parseProgress(value) {
  const progress = /** @type {{progress?:unknown}} */ (value)?.progress
  if (!Array.isArray(progress)) return null
  const out = new Map()
  for (const item of progress) {
    const p = /** @type {{id?:unknown,phase?:unknown}} */ (item)
    if (p && typeof p.id === 'string' && p.id && typeof p.phase === 'string') out.set(p.id, p.phase)
  }
  return out
}

/**
 * 两次之间「在做 → 回复了 / 停下了」的任务。取消不算(那是主人自己按的);消失的(归档)不算。
 * @param {Map<string,string>|null} before @param {Map<string,string>|null} after
 * @returns {{replied:string[],stopped:string[]}}
 */
export function progressTransitions(before, after) {
  /** @type {string[]} */ const replied = []
  /** @type {string[]} */ const stopped = []
  if (!before || !after) return { replied, stopped }
  for (const [id, phase] of after) {
    if (before.get(id) !== 'working') continue
    if (phase === 'replied') replied.push(id)
    else if (phase === 'failed' || phase === 'interrupted') stopped.push(id)
  }
  return { replied, stopped }
}

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
  /** @type {Map<string,string>|null} */ let lastProgress = null

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
        const progress = parseProgress(result)
        const moved = initialized ? progressTransitions(lastProgress, progress) : { replied: [], stopped: [] }
        lastProgress = progress
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
        // 回复 / 停下:窗口在前面就不弹(你正看着 CC);待处理那条优先,一次轮询最多一条通知。
        const finishNotice = !shouldNotify && !context.focused
          ? moved.stopped.length ? { title: '一起做有任务停下了', body: '打开 CC 看看发生了什么。' }
            : moved.replied.length ? { title: '一起做有回复了', body: moved.replied.length > 1 ? `${moved.replied.length} 件事回复了。打开 CC 查看。` : '有一件事回复了。打开 CC 查看。' }
            : null
          : null
        if (finishNotice && !destroyed) void Promise.resolve().then(() => options.invoke('notify_user', finishNotice)).catch(() => {})
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
