// @ts-check
import { escapeHtml } from '../view.js'
import { workbenchTaskStatusKey, statusGlyphHtml } from './matter-status.js'
import { V1, v1 } from '../daemon-client.js'
import { STATUS_WORDS } from '../generated/status-table.js'

/** @typedef {import('./workbench.js').Task} Task */
/** @type {Map<string, Task>} */
const tasks = new Map()
/** @type {Map<string,{at:number,text:string}>} */
const results = new Map()
let stale = false
/** Stable references are materialized on acceptance/search/open, never by dumping history. */
/** @param {string} id @param {string} title @param {boolean} historical */
export function matterReferenceHtml(id, title, historical = false) {
  return `<details class="converse-matter" data-matter-id="${escapeHtml(id)}"><summary><span>${escapeHtml(title)}</span><span data-matter-state>尚未同步</span></summary><div data-matter-progress></div><button type="button" data-open-matter="${escapeHtml(id)}">看过程、成果与回应</button>${historical ? '<small>以前交办的事 · 原始时间见过程</small>' : ''}</details>`
}
/** Update only the projection, preserving open disclosures, focus and reading position.
 * @param {Task[]} values @param {boolean} disconnected */
export function updateConversationMatters(values, disconnected = stale) {
  stale = disconnected
  for (const task of values) { if (!tasks.has(task.id) || task.updatedAt >= (tasks.get(task.id)?.updatedAt ?? 0)) tasks.set(task.id, task) }
  for (const node of document.querySelectorAll('[data-matter-id]')) {
    const id = /** @type {HTMLElement} */ (node).dataset.matterId
    const task = id ? tasks.get(id) : null
    const state = node.querySelector('[data-matter-state]')
    if (state) {
      const key = task ? workbenchTaskStatusKey(task) : null
      state.innerHTML = stale || !key ? '尚未同步' : `${statusGlyphHtml(key)}${escapeHtml(key === 'waiting' ? '等你决定' : STATUS_WORDS[key])}`
    }
    const progress = node.querySelector('[data-matter-progress]')
    if (progress && task) progress.textContent = [task.providerId, new Date(task.updatedAt).toLocaleString(), task.error, results.get(task.id)?.at === task.updatedAt ? results.get(task.id)?.text : null].filter(Boolean).join(' · ')
  }
}

/** Expanded references read the original event/result projection; no generated progress.
 * @param {HTMLElement} root @param {(method:any,path:string,body?:any)=>Promise<any>} call */
export function mountMatterProgress(root,call) {
  const load = async (/** @type {Event} */ event) => {
    const card = /** @type {HTMLDetailsElement} */ (event.target)
    if (!card.matches?.('.converse-matter') || !card.open) return
    const id = card.dataset.matterId
    const progress = card.querySelector('[data-matter-progress]')
    if (!id || !progress) return
    try {
      const detail = await v1(call,V1.workbench.task,{query:{id}})
      if (!card.isConnected || !card.open || detail.task?.id !== id) return
      const latest = (detail.events ?? []).filter((/** @type {any} */ event) => event.kind === 'text' || event.kind === 'error').at(-1)
      const result = detail.artifacts?.length ? `成果：${detail.artifacts.map((/** @type {any} */ item) => item.name).join('、')}` : ''
      results.set(id,{at:detail.task.updatedAt,text:[latest?.text,result].filter(Boolean).join('\n')})
      updateConversationMatters([detail.task])
    } catch { if (card.isConnected) progress.textContent = '尚未同步 · 看过程后可重试' }
  }
  root.addEventListener('toggle',load,true)
  return () => root.removeEventListener('toggle',load,true)
}
