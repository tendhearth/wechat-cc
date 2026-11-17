// @ts-check
import { escapeHtml } from '../view.js'
import { workbenchTaskStatusKey, taskStatusKey, statusGlyphHtml } from './matter-status.js'
import { workbenchRuntimePresentation } from './workbench-runtime.js'
import { createAgentAvatars } from '../shared/agent-avatars.js'
import { STATUS_WORDS, TASK_DETAIL_WORDS } from '../generated/status-table.js'

/** @typedef {import('./workbench.js').Task} Task */
/** @type {Map<string, Task>} */
const tasks = new Map()
const agents = createAgentAvatars()
/** @type {Map<string,any>|null} */ let attention = null
let attentionStale = false
/** @type {string|null} */ let dockedId = null
let stale = false
/** Stable references are materialized on acceptance/search/open, never by dumping history. */
/** @param {string} id @param {string} title @param {boolean} historical */
export function matterReferenceHtml(id, title, historical = false) {
  return `<a class="converse-matter" href="#matter:${escapeHtml(id)}" data-open-matter="${escapeHtml(id)}" data-matter-id="${escapeHtml(id)}" data-docked="${dockedId===id}"><span data-matter-avatar></span><span class="converse-matter-title">${escapeHtml(title)}</span><span data-matter-state>${dockedId===id?'在右边打开着':'尚未同步'}</span><span aria-hidden="true">›</span>${historical ? '<span class="now-sr" data-matter-origin>以前交办的事 · 正在核对原始时间</span>' : ''}</a>`
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
      const key = task ? attention ? (attention.has(task.id)?'waiting':taskStatusKey(task)) : workbenchTaskStatusKey(task) : id&&attention?.has(id)?'waiting':null
      const waitingConfirmed=!!id&&!!attention?.has(id)&&!attentionStale
      state.innerHTML = (stale&&!waitingConfirmed) || attentionStale || !key ? '尚未同步' : `${statusGlyphHtml(key)}${escapeHtml(key === 'waiting' ? STATUS_WORDS.waiting : task?.status==='queued' ? TASK_DETAIL_WORDS.queued : task ? workbenchRuntimePresentation(task.status,task.runtime,task.phase,task.networkSuspended)?.label ?? STATUS_WORDS[key] : STATUS_WORDS[key])}`
    }
    node.setAttribute('data-docked',String(id===dockedId))
    if(state && id===dockedId)state.textContent='在右边打开着'
    const avatar=node.querySelector('[data-matter-avatar]')
    if(avatar&&task)avatar.innerHTML=agents.agentAvatarsHtml(task.providerId?[task.providerId]:[])
    const origin=node.querySelector('[data-matter-origin]');if(origin&&task)origin.textContent=`${task.origin==='cc'||task.origin==='companion'?'CC 自己做的事':'以前交办的事'} · ${new Date(task.createdAt).toLocaleString()}`
  }
}

/** References only navigate; live progress has one home in the detail layer.
 * @param {HTMLElement} root @param {(id:string)=>unknown} onOpenMatter */
export function mountMatterReferences(root,onOpenMatter) {
 const click=(/** @type {Event} */event)=>{
  const row=event.target instanceof Element?event.target.closest('a[data-open-matter]'):null
  const id=row?.getAttribute('data-open-matter')
  if(id){event.preventDefault();void onOpenMatter(id)}
 }
 root.addEventListener('click',click)
 return ()=>root.removeEventListener('click',click)
}
/** @param {string|null} id */
export function setDockedMatter(id){dockedId=id;updateConversationMatters([])}

/** One attention projection supplies both the locator and reference status.
 * @param {{stale:boolean,tasks:Array<{id:string,first?:{text?:string}|null}>}} snapshot */
export function updateConversationAttention(snapshot){
  attentionStale=snapshot.stale
  if(!snapshot.stale)attention=new Map(snapshot.tasks.map(task=>[task.id,task]))
  updateConversationMatters([])
}
