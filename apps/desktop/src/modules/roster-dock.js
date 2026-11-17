// @ts-check
import {V1,v1} from '../daemon-client.js'
import {showWorkDetail} from './conversation-work-detail.js'
import {setWorkbenchDocked} from './workbench.js'
/** @typedef {{kind:'matter'|'terminal',id:string}} DockItem */
/** @param {{aside:HTMLElement,layer:HTMLElement,call:(method:any,path:string,body?:any)=>Promise<any>,openTask:(id:string)=>Promise<void>,wide:()=>boolean,onExpand?:(item:DockItem)=>Promise<unknown>|void,onChange?:(id:string|null)=>void,onClose?:()=>void}} o */
export function createRosterDock({aside,layer,call,openTask,wide,onExpand,onChange,onClose}) {
 const doc=aside.ownerDocument,view=doc.defaultView
 const dock=/** @type {HTMLElement} */(aside.querySelector('#roster-dock'))
 const list=/** @type {HTMLElement} */(aside.querySelector('#roster-list'))
 const home=doc.createComment('事项层原位');layer.before(home)
 const toolbar=doc.createElement('header');toolbar.className='roster-dock-toolbar'
 const back=doc.createElement('button');back.type='button';back.textContent='‹ 在做'
 const expand=doc.createElement('button');expand.type='button';expand.textContent='展开'
 toolbar.append(back,expand)
 /** @type {DockItem|null} */ let current=null
 /** @type {(()=>void)|undefined} */let dispose
 let ticket=0,alive=true,checking=false,terminalMode=false
 function close(){
  ticket++
  dispose?.();dispose=undefined
  if(layer.parentElement===dock){home.after(layer);layer.hidden=true;layer.setAttribute('aria-modal','true');layer.setAttribute('role','dialog')}
  setWorkbenchDocked(false)
  dock.replaceChildren();dock.hidden=true;list.hidden=false;delete aside.dataset.docked
  const previous=current;current=null;terminalMode=false;onChange?.(null);if(previous)onClose?.()
 }
 function missing(){close();const note=doc.createElement('p');note.role='status';note.textContent='这件事已经不在了';list.prepend(note)}
 async function unfold(){const item=current;if(!item)return;close();await onExpand?.(item)}
 async function open(/** @type {DockItem} */item){
  close();if(!alive)return
  if(!wide()){await onExpand?.(item);return}
  const generation=ticket;current=item
  list.hidden=true;dock.hidden=false;aside.dataset.docked='1';dock.append(toolbar)
  const loading=doc.createElement('p');loading.textContent='正在读取…';dock.append(loading)
  onChange?.(item.kind==='matter'?item.id:null)
  try{
   const detail=item.kind==='matter'?await v1(call,V1.matter.get,{query:{id:item.id}}):{matter:{kind:'terminal',title:'电脑上的会话'},bindings:[{surface:'cli',surfaceKey:item.id}]}
   if(!alive||generation!==ticket)return
   if(item.kind==='matter'&&detail.matter?.id!==item.id)throw Error('matter_not_found')
   loading.remove()
   terminalMode=detail.matter.kind!=='task'
   if(!terminalMode){
    dock.append(layer);layer.hidden=false;layer.setAttribute('role','region');layer.removeAttribute('aria-modal');setWorkbenchDocked(true)
    await openTask(item.id)
   }else{
    const host=doc.createElement('div');host.className='roster-terminal';dock.append(host)
    const cleanup=await showWorkDetail(call,detail,host)
    if(!alive||generation!==ticket){cleanup?.();return}dispose=cleanup
   }
   if(!alive||generation!==ticket)return
   if(item.kind==='matter')void v1(call,V1.matter.seen,{body:{id:item.id,surface:'desktop'}}).catch(()=>{})
  }catch(error){
   if(!alive||generation!==ticket)return
   if(/404|not_found/.test(String(error)))missing()
   else{loading.textContent='家里的电脑暂时连不上';const retry=doc.createElement('button');retry.textContent='重试';retry.onclick=()=>void open(item);dock.append(retry)}
  }
 }
 // Use canonical existence, never infer deletion from absence in the 24-hour roster.
 const timer=setInterval(async()=>{
  const item=current,generation=ticket
  if(!alive||checking||item?.kind!=='matter'||doc.visibilityState!=='visible')return
  checking=true
  try{await v1(call,V1.matter.get,{query:{id:item.id}})}catch(error){if(alive&&generation===ticket&&/404|not_found/.test(String(error)))missing()}finally{checking=false}
 },3000)
 const heavy=(/** @type {Event} */event)=>{
  const button=event.target instanceof Element?event.target.closest('summary,[data-action],.wb-artifact[data-artifact-id]'):null
  if(!(button instanceof HTMLElement)||!layer.contains(button)||!current)return
  const details=button.tagName==='SUMMARY'?button.parentElement:null
  const disclosure=details?.id==='wb-review'||details?.hasAttribute('data-review-disclosure')
  const action=button.dataset.action??''
  if(!disclosure&&!button.matches('.wb-artifact[data-artifact-id]')&&!['preview-artifact','show-artifacts','rewind-open','new-task','add-project','task-entry'].includes(action))return
  const data={...button.dataset},detailId=details?.id,detailData={...details?.dataset}
  event.preventDefault();event.stopImmediatePropagation()
  void unfold().then(()=>{
   if(disclosure){
    const next=[...layer.querySelectorAll('details')].find(el=>detailId?el.id===detailId:Object.entries(detailData).every(([key,value])=>el.dataset[key]===value))
    if(next)next.open=true
   }else{
    const next=[...layer.querySelectorAll('[data-action],.wb-artifact[data-artifact-id]')].find(el=>el instanceof HTMLElement&&Object.entries(data).every(([key,value])=>el.dataset[key]===value))
    if(next instanceof HTMLElement)next.click()
   }
  })
 }
 dock.addEventListener('click',heavy,true)
 const resize=()=>{if(current&&!wide())void unfold()}
 const keys=(/** @type {KeyboardEvent} */event)=>{
  if(!event.metaKey||event.altKey||event.ctrlKey)return
  const target=event.key==='1'?doc.getElementById('converse-input'):event.key==='2'&&current?dock.querySelector(terminalMode?'[data-terminal-input]':'#wb-followup-text'):null
  if(target instanceof HTMLElement){event.preventDefault();target.focus()}
 }
 back.onclick=close;expand.onclick=()=>void unfold();view?.addEventListener('resize',resize);doc.addEventListener('keydown',keys)
 return {open,close,current:()=>current?.id??null,destroy(){close();alive=false;clearInterval(timer);dock.removeEventListener('click',heavy,true);view?.removeEventListener('resize',resize);doc.removeEventListener('keydown',keys);home.remove()}}
}
