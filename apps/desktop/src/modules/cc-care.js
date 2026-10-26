// @ts-check
/// <reference lib="dom" />
import { currentActivity } from './cc-life.js'
import { workbenchRuntimePresentation } from './workbench-runtime.js'
import { V1, v1 } from '../daemon-client.js'

/** @param {unknown} value */
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => /** @type {Record<string, string>} */ ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c] ?? c)
/** @param {any} value @returns {number} */
const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0
const TASK_LIMIT = 100
/** @typedef {Pick<import('./workbench.js').Task,'id'|'title'|'providerId'> & Partial<import('./workbench.js').Task> & {label:string,project:string,provider:string}} CareRow */

// A task's retained session is not evidence of active work, or of completion.
/** @param {any} data @param {{tasks:any[],stale:boolean}|null} [attention] */
export function careSections(data, attention = null) {
  const tasks = new Map((data?.tasks ?? []).filter((/** @type {any} */ t) => !t.archivedAt).map((/** @type {any} */ t) => [t.id, {...t}]))
  if (attention && !attention.stale) {
    for (const task of tasks.values()) { task.pendingPermissionCount = 0; task.pendingQuestionCount = 0 }
    for (const task of attention.tasks) tasks.set(task.id, {...tasks.get(task.id), ...task})
  }
  const names = new Map((data?.projects ?? []).map((/** @type {any} */ p) => [p.path, p.name]))
  // 执行者叫什么只读 daemon 给的(收敛清单 ⑥):列表的 agentNames,再是执行者列表;都没有 ⇒ id。
  const providers = new Map((data?.providers ?? []).map((/** @type {any} */ p) => [p.id, p.displayName]))
  /** @type {{attention:CareRow[],working:CareRow[],recent:CareRow[],truncated:boolean}} */
  const result = { attention: [], working: [], recent: [], truncated: !!data?.page?.hasMore }
  for (const task of [...tasks.values()].sort((a,b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))) {
    const pending = count(task.pendingPermissionCount) + count(task.pendingQuestionCount)
    const runtime = workbenchRuntimePresentation(task.status, task.runtime, task.phase, task.networkSuspended)
    const status = runtime?.status ?? task.status
    const label = pending ? [count(task.pendingPermissionCount) ? `${task.pendingPermissionCount} 项权限` : '', count(task.pendingQuestionCount) ? `${task.pendingQuestionCount} 个问题` : ''].filter(Boolean).join(' · ')
      : task.importedOnly ? '尚未执行' : task.waitingFor ? '等待前项任务'
      : runtime?.label ?? (/** @type {Record<string, string>} */ ({running:'执行中',queued:'排队中',completed:'已结束',failed:'执行遇到问题',cancelled:'已停止',interrupted:'执行已中断',pending_permission:'等待确认'})[status] ?? '打开查看状态')
    const row = {...task, label, project: names.get(task.path) || task.path?.split(/[\\/]/).filter(Boolean).at(-1) || '', provider: data?.agentNames?.[task.providerId] || providers.get(task.providerId) || task.providerId || ''}
    if (pending) result.attention.push(row)
    else if (!task.importedOnly && ['running','queued','pending_permission','paused'].includes(status)) result.working.push(row)
    else result.recent.push(row)
  }
  result.recent = result.recent.slice(0, 5)
  return result
}

// Only polls while the sheet is open and visible. Late reads cannot repopulate it.
/** @typedef {{data: any, stale: boolean, loading: boolean}} CareState */
/**
 * @param {{ call: (method: any, path: string, body?: any, opts?: any) => Promise<unknown>, onChange: (state: CareState) => void, intervalMs?: number, timeoutMs?: number }} deps
 */
export function createCareReader({call, onChange, intervalMs = 5000, timeoutMs = 10000}) {
  let generation = 0, running = false
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let timer
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let deadline
  /** @type {(() => void) | null | undefined} */ let cancel
  /** @type {Promise<void> | null} */ let inflight = null
  /** @type {CareState} */
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

/**
 * One small sheet, linking to original task records rather than duplicating them.
 * @param {{ call: (method: any, path: string, body?: any, opts?: any) => Promise<unknown>, presencePoller: { subscribe: (fn: (p: any) => void) => () => void }, openTask: (id: string) => unknown, openWorkbench: () => void, navigate: (pane: string) => void, documentTarget?: Document }} deps
 */
export function mountCareSheet({call, presencePoller, openTask, openWorkbench, navigate, documentTarget = document}) {
  const dialog = documentTarget.createElement('dialog')
  dialog.className = 'cc-care-sheet'
  dialog.setAttribute('aria-labelledby','cc-care-title')
  dialog.innerHTML = '<header><div><span class="cc-life-kicker">这一会儿</span><h2 id="cc-care-title">CC 正在照看什么</h2></div><button type="button" data-care-close aria-label="关闭">×</button></header><p class="cc-care-presence"></p><div class="cc-care-body"></div><p class="cc-care-error" role="status"></p><footer><button type="button" data-care-all>打开一起做</button><button type="button" data-care-memory>CC 记得的你</button></footer>'
  documentTarget.body.append(dialog)
  const body = /** @type {HTMLElement} */ (dialog.querySelector('.cc-care-body')), activity = /** @type {HTMLElement} */ (dialog.querySelector('.cc-care-presence')), error = /** @type {HTMLElement} */ (dialog.querySelector('.cc-care-error'))
  /** @type {{tasks:any[],stale:boolean}|null} */ let attention = null
  /** @type {CareState} */ let state = {data:null,loading:true,stale:false}
  /** @type {Element | null} */ let opener = null
  let previous = '', disposed = false, opening = false, visit = 0
  function render() {
    if (!dialog.open) return
    const groups = careSections(state.data, attention)
    const signature = JSON.stringify([groups,state.stale,state.loading,attention?.stale])
    if (signature === previous) return
    previous = signature
    const focusedId = documentTarget.activeElement?.getAttribute('data-care-task')
    const scrollTop = body.scrollTop
    const sections = /** @type {Array<['attention'|'working'|'recent', string]>} */ ([['attention','等你回应'],['working','正在进行'],['recent','最近的任务']]).map(([key,title]) => {
      const rows = groups[key]
      return rows.length ? `<section><h3>${title} <span>${rows.length}</span></h3>${rows.map(row => `<button type="button" class="cc-care-task" data-care-task="${esc(row.id)}"><span class="cc-care-task-title">${esc(row.title || '未命名任务')}</span><span class="cc-care-task-meta">${esc([row.project,row.provider,row.label].filter(Boolean).join(' · '))}</span></button>`).join('')}</section>` : ''
    }).join('')
    const notice = state.stale || attention?.stale ? `<p class="cc-care-note" role="status">${state.loading ? '正在更新' : '连接暂未更新'}，以下是上次读取的记录。<button type="button" data-care-retry>重新读取</button></p>`
      : state.loading && !state.data ? '<p class="cc-care-note" role="status">正在看看…</p>' : ''
    body.innerHTML = `${notice}${sections || (!state.loading && !state.stale ? '<p class="cc-care-note">暂时没有在这里交办的事。想做什么，可以在此刻写下来交给 CC。</p>' : '')}${groups.truncated ? `<p class="cc-care-note">这里只显示最近 ${TASK_LIMIT} 项记录，待处理请求单独汇总。更早的任务可在一起做中查找。</p>` : ''}`
    body.scrollTop = scrollTop
    if (focusedId) {
      const row = [...body.querySelectorAll('[data-care-task]')].find(el => el.getAttribute('data-care-task') === focusedId)
      ;/** @type {HTMLElement} */ (row ?? dialog.querySelector('[data-care-close]')).focus({preventScroll:true})
    }
  }
  const reader = createCareReader({call,onChange(/** @type {CareState} */ next) {state = next; render()}})
  const unsubscribe = presencePoller.subscribe(p => { activity.textContent = currentActivity(p).title })
  function endVisit() {visit++; opening = false; reader.stop(); previous = ''}
  function close() { if (dialog.open) {endVisit(); dialog.close()} }
  function closed() {
    // The native close event may arrive after a new visit has already opened.
    if (dialog.open) return
    endVisit()
    const returnTo = /** @type {HTMLElement | null} */ (opener?.isConnected ? opener : documentTarget.querySelector('[data-life-care]'))
    returnTo?.focus({preventScroll:true})
  }
  /** @param {MouseEvent} event */
  async function click(event) {
    const target = /** @type {any} */ (event.target).closest?.('button')
    if (!target) {
      if (event.target === dialog) {
        const bounds = dialog.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close()
      }
      return
    }
    if (target.hasAttribute('data-care-close')) {close();return}
    if (target.hasAttribute('data-care-retry')) {void reader.refresh();return}
    if (target.hasAttribute('data-care-memory')) {close();navigate('memory');return}
    if (target.hasAttribute('data-care-all')) {close();openWorkbench();return}
    const id = target.getAttribute('data-care-task')
    if (id && !opening) {
      const ticket = visit
      opening = true; target.disabled = true; error.textContent = ''
      try { await openTask(id); if (ticket === visit && dialog.open) close() }
      catch { if (ticket === visit && dialog.open) error.textContent = '暂时打不开这件事，请重试。' }
      finally { if (ticket === visit) opening = false; target.disabled = false }
    }
  }
  const visibility = () => { if (!dialog.open) return; if (documentTarget.visibilityState === 'hidden') reader.stop(); else void reader.start() }
  dialog.addEventListener('click',click); dialog.addEventListener('close',closed)
  documentTarget.addEventListener('visibilitychange',visibility)
  return {
    open() {if (disposed || dialog.open) return; visit++; opening = false; opener = documentTarget.activeElement; previous = ''; error.textContent = ''; dialog.showModal(); void reader.start()},
    /** @param {{tasks:any[],stale:boolean}|null} value */
    setAttention(value) {attention = value;render()},
    close,
    destroy() {disposed = true;close();reader.stop();unsubscribe();documentTarget.removeEventListener('visibilitychange',visibility);dialog.remove()},
  }
}
