// @ts-check
import { STATUS_WORDS } from './generated/status-table.js'
/** @typedef {{taskId:string,title:string,phase:'needs_input'|'failed'|'interrupted'|'paused'|'replied'|'working'|'queued'|'stopping',detail:string|null,updatedAt:number}} PetTaskActivity */
/** @typedef {{page:'workbench',taskId:string}} TaskDestination */
const labels={needs_input:STATUS_WORDS.waiting,failed:STATUS_WORDS.failed,interrupted:STATUS_WORDS.stopped,paused:'已暂停',replied:STATUS_WORDS.replied,working:STATUS_WORDS.working,queued:'排队中',stopping:'正在停下'}
const line=(/** @type {string} */ text,/** @type {number} */ max)=>{const s=text.replace(/\s+/g,' ').trim();return s.length>max?s.slice(0,max-1)+'…':s}
/** Defensive boundary for both older daemons and untrusted task text.
 * @param {unknown} input @returns {PetTaskActivity[]}
 */
export function normalizePetActivities(input) {
  if(!Array.isArray(input))return[]
  const seen=new Set(),result=[]
  for(const item of input) {
    if(!item||typeof item!=='object'||typeof item.taskId!=='string'||!/^[a-f0-9]{8}$/.test(item.taskId)||seen.has(item.taskId)||typeof item.title!=='string'||typeof item.phase!=='string'||!Object.hasOwn(labels,item.phase)||!Number.isFinite(item.updatedAt)||item.updatedAt<0||(item.detail!==null&&typeof item.detail!=='string'))continue
    seen.add(item.taskId)
    result.push({taskId:item.taskId,title:line(item.title,80),phase:item.phase,detail:item.detail===null?null:line(item.detail,120),updatedAt:item.updatedAt})
    if(result.length===8)break
  }
  return result
}
/** @param {{host:HTMLElement,primary:HTMLElement,toggle:HTMLElement,list:HTMLElement,onOpen:(target:TaskDestination)=>unknown,onExpand?:()=>void}} options */
export function mountPetActivities({host,primary,toggle,list,onOpen,onExpand}) {
  /** @type {PetTaskActivity[]} */ let rows=[]
  const buttons=new Map()
  const phaseNode=document.createElement('span'),titleNode=document.createElement('span'),detailNode=document.createElement('span')
  phaseNode.className='pet-task-phase';titleNode.className='pet-task-title';detailNode.className='pet-task-detail'
  primary.replaceChildren(phaseNode,titleNode,detailNode)
  const destination=(/** @type {string} */ taskId)=>/** @type {TaskDestination} */({page:'workbench',taskId})
  const closeList=(returnFocus=false)=>{
    const wasOpen=!list.hidden
    list.hidden=true;toggle.setAttribute('aria-expanded','false')
    if(returnFocus&&wasOpen&&!host.hidden)toggle.focus()
    return wasOpen
  }
  const open=(/** @type {string|undefined} */ id)=>{
    if(host.hidden||!id||!rows.some(row=>row.taskId===id))return
    closeList();void onOpen(destination(id))
  }
  primary.addEventListener('click',()=>open(rows[0]?.taskId))
  toggle.addEventListener('click',()=>{
    if(host.hidden||rows.length<2)return
    if(closeList())return
    onExpand?.();list.hidden=false;toggle.setAttribute('aria-expanded','true')
  })
  host.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&closeList(true)){event.preventDefault();event.stopPropagation()}
  })
  return {
    /** @param {unknown} input @param {boolean} available */
    update(input,available) {
      const focused=document.activeElement
      const restoreFocus=!list.hidden&&focused instanceof HTMLElement&&list.contains(focused)&&document.hasFocus()
      const focusedId=restoreFocus?focused.dataset.taskId:null
      rows=available?normalizePetActivities(input):[]
      host.hidden=rows.length===0
      if(host.hidden){closeList();phaseNode.textContent='';titleNode.textContent='';detailNode.textContent='';list.replaceChildren();buttons.clear();return}
      const first=rows[0]
      if(!first)return
      // Keep button identity (and keyboard focus) stable across every poll.
      const primaryText=`${labels[first.phase]} · ${first.title}${first.detail?'\n'+first.detail:''}`
      if(phaseNode.textContent!==labels[first.phase])phaseNode.textContent=labels[first.phase]
      if(titleNode.textContent!==first.title)titleNode.textContent=first.title
      if(detailNode.textContent!==first.detail)detailNode.textContent=first.detail
      detailNode.hidden=!first.detail
      primary.title=primaryText;primary.setAttribute('aria-label',primaryText)
      toggle.hidden=rows.length<2;toggle.textContent=`另外 ${rows.length-1} 件`;toggle.setAttribute('aria-label',`查看另外 ${rows.length-1} 件事`)
      if(toggle.hidden)closeList()
      const ids=new Set(rows.map(row=>row.taskId))
      for(const [id,button] of buttons)if(!ids.has(id)){button.remove();buttons.delete(id)}
      for(const row of rows) {
        let button=buttons.get(row.taskId)
        if(!button){button=document.createElement('button');button.type='button';button.dataset.taskId=row.taskId;button.addEventListener('click',()=>open(row.taskId));buttons.set(row.taskId,button)}
        const text=`${labels[row.phase]} · ${row.title}`
        if(button.textContent!==text)button.textContent=text
        button.title=row.detail?`${text}\n${row.detail}`:text
      }
      if(Array.from(list.children).map(node=>/** @type {HTMLElement} */(node).dataset.taskId).join(',')!==rows.map(row=>row.taskId).join(','))list.replaceChildren(...rows.map(row=>buttons.get(row.taskId)))
      if(restoreFocus&&document.hasFocus()) {
        const target=!list.hidden&&focusedId?buttons.get(focusedId):null
        const next=target??(toggle.hidden?primary:toggle)
        if(document.activeElement!==next)next.focus()
      }
    },
    current(){return rows[0]&&!host.hidden?destination(rows[0].taskId):null},
    closeList,
  }
}
