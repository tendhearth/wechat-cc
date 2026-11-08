// @ts-check
import { escapeHtml } from '../view.js'
import { workbenchTaskStatusKey, taskStatusKey, statusGlyphHtml } from './matter-status.js'
import { V1, v1 } from '../daemon-client.js'
import { workbenchRuntimePresentation } from './workbench-runtime.js'
import { createAgentAvatars } from '../shared/agent-avatars.js'
import { STATUS_WORDS } from '../generated/status-table.js'

/** @typedef {import('./workbench.js').Task} Task */
/** @type {Map<string, Task>} */
const tasks = new Map()
const agents = createAgentAvatars()
/** @type {Map<string,{at:number,text:string}>} */
const results = new Map()
/** @type {Map<string,any>|null} */ let attention = null
let attentionStale = false
const detailStale = new Set()
let stale = false
/** Stable references are materialized on acceptance/search/open, never by dumping history. */
/** @param {string} id @param {string} title @param {boolean} historical */
export function matterReferenceHtml(id, title, historical = false) {
  return `<details class="converse-matter" data-matter-id="${escapeHtml(id)}"><summary><span>${escapeHtml(title)}</span><span data-matter-state>尚未同步</span></summary><div data-matter-progress></div><button type="button" data-open-matter="${escapeHtml(id)}">看过程、成果与回应</button>${historical ? '<small data-matter-origin>以前交办的事 · 正在核对原始时间</small>' : ''}</details>`
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
      state.innerHTML = (stale&&!waitingConfirmed) || attentionStale || (id && detailStale.has(id)) || !key ? '尚未同步' : `${statusGlyphHtml(key)}${escapeHtml(key === 'waiting' ? '等你决定' : task?.status==='queued' ? '排队中' : task ? workbenchRuntimePresentation(task.status,task.runtime,task.phase,task.networkSuspended)?.label ?? STATUS_WORDS[key] : STATUS_WORDS[key])}`
    }
    const progress = node.querySelector('[data-matter-progress]')
    if(progress&&!task&&id)progress.textContent=attention?.get(id)?.first?.text??''
    const origin=node.querySelector('[data-matter-origin]');if(origin&&task)origin.textContent=`${task.origin==='cc'||task.origin==='companion'?'CC 自己做的事':'以前交办的事'} · ${new Date(task.createdAt).toLocaleString()}`
    if (progress && task) { progress.textContent = [task.providerId, new Date(task.updatedAt).toLocaleString(), task.error, attention?.get(task.id)?.first?.text, results.get(task.id)?.at === task.updatedAt ? results.get(task.id)?.text : null].filter(Boolean).join(' · '); progress.insertAdjacentHTML('afterbegin',agents.agentAvatarsHtml(task.providerId?[task.providerId]:[],{cls:'converse-agents'})) }
  }
}

/** Expanded references read the original event/result projection; no generated progress.
 * @param {HTMLElement} root @param {(method:any,path:string,body?:any)=>Promise<any>} call */
export function mountMatterProgress(root,call) {
  let alive=true
  const inflight=new WeakSet()
  const loadCard = async (/** @type {HTMLDetailsElement} */ card) => {
    if (!alive || !card.matches?.('.converse-matter') || !card.open) return
    const id = card.dataset.matterId
    const progress = card.querySelector('[data-matter-progress]')
    if (!id || !progress || inflight.has(card)) return
    inflight.add(card)
    try {
      const canonical = await v1(call,V1.matter.get,{query:{id}})
      if (!alive || !card.isConnected || !card.open || canonical.matter?.id !== id) return
      detailStale.delete(id)
      if(canonical.matter.kind!=='task'){progress.textContent=canonical.matter.title;return}
      const detail=await v1(call,V1.workbench.task,{query:{id}})
      if(!alive||!card.isConnected||!card.open||detail.task?.id!==id)return
      const latest = (detail.events ?? []).filter((/** @type {any} */ event) => event.kind === 'text' || event.kind === 'error').at(-1)
      const result = detail.artifacts?.length ? `成果：${detail.artifacts.map((/** @type {any} */ item) => item.name).join('、')}` : ''
      results.set(id,{at:detail.task.updatedAt,text:[latest?.text,result].filter(Boolean).join('\n')})
      updateConversationMatters([detail.task])
    } catch { if (alive && card.isConnected) {detailStale.add(id);updateConversationMatters([]);progress.textContent = '尚未同步 · 正在重新连接'} }
    finally {inflight.delete(card)}
  }
  const load=(/** @type {Event} */ event)=>{void loadCard(/** @type {HTMLDetailsElement} */(event.target))}
  const timer=setInterval(()=>{if(root.closest?.('[hidden],[inert]'))return;for(const card of root.querySelectorAll?.('.converse-matter[open]')??[])void loadCard(/** @type {HTMLDetailsElement} */(card))},5000)
  root.addEventListener('toggle',load,true)
  return () => {alive=false;clearInterval(timer);root.removeEventListener('toggle',load,true)}
}

/** One attention projection supplies both the locator and reference status.
 * @param {{stale:boolean,tasks:Array<{id:string,first?:{text?:string}|null}>}} snapshot */
export function updateConversationAttention(snapshot){
  attentionStale=snapshot.stale
  if(!snapshot.stale)attention=new Map(snapshot.tasks.map(task=>[task.id,task]))
  updateConversationMatters([])
}
