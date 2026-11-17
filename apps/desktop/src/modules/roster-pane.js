// @ts-check
import {V1,v1} from '../daemon-client.js'
import {escapeHtml} from '../view.js'
import {HOME_GROUP_WORDS,STATUS_WORDS,ROW_HINT_WORDS} from '../generated/status-table.js'
import {createAgentAvatars} from '../shared/agent-avatars.js'
/** @typedef {import('../../../../packages/protocol/src/roster').RosterItemT} RosterItem */
const avatars=createAgentAvatars()
/** @param {RosterItem['agents']} agents */
export function rosterAvatars(agents) {
  const current=agents.find(a=>a.current), previous=agents.find(a=>!a.current)
  return `<span class="roster-avatars">${[previous,current].filter(Boolean).map(a=>`<span data-current="${!!a?.current}">${avatars.agentAvatarsHtml([a?.id??''],{nameOf:()=>a?.name??a?.id??''})}</span>`).join('')}</span>`
}
/** @param {RosterItem[]} items @param {{stale:boolean,staleAt:number|null,agentAvatars?:(agents:RosterItem['agents'])=>string}} opts */
export function renderRosterHtml(items,{stale,staleAt,agentAvatars=rosterAvatars}) {
 const notice=stale?`<p role="status">家里的电脑暂时连不上${staleAt!==null?`<small>你看到的是 ${new Date(staleAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})} 的样子</small>`:''}</p>`:''
 if(!items.length)return notice+'<div class="roster-empty"><img src="./assets/pet/cc-v1/attention/lit/read-down/000.png" alt="" /><p>都歇着</p></div>'
 return notice+/** @type {const} */(['waiting','working','back']).map(group=>{
  const rows=items.filter(i=>i.group===group)
  return rows.length?`<section class="roster-group" data-group="${group}"><h2>${HOME_GROUP_WORDS[group]} <span>${rows.length}</span></h2>${rows.map(item=>`<button type="button" class="roster-row" data-roster-key="${escapeHtml(item.key)}">${agentAvatars(item.agents)}<span class="roster-copy"><span>${escapeHtml(item.title)}</span><small>${escapeHtml([item.project,group==='waiting'?`${STATUS_WORDS.waiting}${item.waiting?.summary?' · '+item.waiting.summary:''}`:STATUS_WORDS[item.status],item.relay?`第 ${item.relay.index} 棒 / ${item.relay.total}`:'',item.quiet?ROW_HINT_WORDS.quiet:'',item.unseen?'还没看':''].filter(Boolean).join(' · '))}</small></span></button>`).join('')}</section>`:''
 }).join('')
}
/** @param {{root:HTMLElement,call:(method:any,path:string,body?:any,opts?:any)=>Promise<any>,onOpen:(item:RosterItem)=>unknown,onItems?:(items:RosterItem[])=>void,now?:()=>number,intervalMs?:number}} o */
export function mountRosterPane({root,call,onOpen,onItems,now=Date.now,intervalMs=3000}) {
 /** @type {RosterItem[]} */ let items=[]
 /** @type {number|null} */ let at=null
 let version='',alive=true,busy=false,stale=false
 const draw=()=>{root.innerHTML=renderRosterHtml(items,{stale,staleAt:at})}
 async function refresh(){
  if(!alive||busy||root.ownerDocument.visibilityState!=='visible')return
  busy=true
  try{
   const data=await v1(call,V1.roster.get,undefined,version?{ifNoneMatch:version}:undefined)
   if(!alive)return
   if(data?.notModified){if(stale){stale=false;draw()}return}
   if(!Array.isArray(data?.items)||typeof data.version!=='string')throw Error('invalid_roster')
   at=now();items=data.items
   if(data.version!==version||stale){version=data.version;stale=false;draw();onItems?.(items)}
  }catch{if(alive){stale=true;draw()}}finally{busy=false}
 }
 const click=(/** @type {Event} */event)=>{
  const row=event.target instanceof Element?event.target.closest('[data-roster-key]'):null
  const item=items.find(i=>i.key===row?.getAttribute('data-roster-key'));if(item)void onOpen(item)
 }
 // 键盘直接打开,不依赖浏览器把 Enter / 空格合成 click(mini 全量 11-17:名单行按 Enter 打不开)。
 const key=(/** @type {KeyboardEvent} */event)=>{
  if(event.defaultPrevented||event.isComposing||event.altKey||event.ctrlKey||event.metaKey||(event.key!=='Enter'&&event.key!==' '))return
  const row=event.target instanceof Element?event.target.closest('[data-roster-key]'):null
  const item=items.find(i=>i.key===row?.getAttribute('data-roster-key'));if(!item)return
  event.preventDefault();void onOpen(item)
 }
 const visibility=()=>{if(root.ownerDocument.visibilityState==='visible')void refresh()}
 root.addEventListener('click',click);root.addEventListener('keydown',key);root.ownerDocument.addEventListener('visibilitychange',visibility)
 draw();void refresh()
 const timer=setInterval(()=>void refresh(),intervalMs)
 return {refresh,items:()=>items.slice(),destroy(){alive=false;clearInterval(timer);root.removeEventListener('click',click);root.removeEventListener('keydown',key);root.ownerDocument.removeEventListener('visibilitychange',visibility)}}
}
