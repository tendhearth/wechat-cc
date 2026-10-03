// @ts-check
/** @typedef {import('../../../../src/core/workbench/service/quota-handoff').QuotaHandoffView} Offer */
/** @typedef {{id:string,title:string,path:string}} Source */
/** @typedef {{id:string,displayName:string}} Provider */
/** @typedef {{requestId:string,providerId:string}} Attempt */
/** @typedef {(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>} Invoke */
const esc=(/** @type {unknown} */v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]??c)
const TASK=/^[a-f0-9]{8}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const PROVIDER=/^[a-z][a-z0-9._-]{0,63}$/
const key=(/** @type {string} */id)=>`cc.workbench.quota-handoff.v1:${id}`
/** @param {Pick<Storage,'getItem'|'setItem'|'removeItem'>|null} [storage] */
export function createQuotaHandoffAttempts(storage=null){
 /** @type {Map<string,Attempt>} */const memory=new Map()
 return{
  get(/** @type {string} */id){
   if(!TASK.test(id))return null
   if(memory.has(id))return structuredClone(memory.get(id))
   try{const raw=storage?.getItem(key(id)),a=raw?JSON.parse(raw):null;if(a&&UUID.test(a.requestId)&&typeof a.providerId==='string'&&PROVIDER.test(a.providerId)){memory.set(id,a);return structuredClone(a)}}catch{/* Optional per-window recovery. */}
   return null
  },
  set(/** @type {string} */id,/** @type {Attempt} */attempt){memory.set(id,structuredClone(attempt));try{storage?.setItem(key(id),JSON.stringify(attempt))}catch{/* Keep the in-memory request identity. */}},
  delete(/** @type {string} */id){memory.delete(id);try{storage?.removeItem(key(id))}catch{/* Optional persistence. */}},
 }
}
/** @typedef {ReturnType<typeof createQuotaHandoffAttempts>} Attempts */
const name=(/** @type {string} */id,/** @type {Provider[]} */providers)=>providers.find(p=>p.id===id)?.displayName??({claude:'Claude',codex:'Codex',cursor:'Cursor',gemini:'Gemini'}[id]??id)
/** @param {Offer|null|undefined} offer @param {Provider[]} providers */
export function quotaHandoffCopy(offer,providers){
 if(!offer)return ''
 const from=name(offer.from,providers)
 if(offer.state==='handed')return `已交给 ${name(offer.to,providers)} 继续。原任务仍然保留。`
 const reset=Number.isFinite(offer.resetAt)&&offer.resetAt>Date.now()?`预计 ${new Date(offer.resetAt).toLocaleString()} 恢复。`:''
 return `${from} ${offer.kind==='rate_limit'?'暂时被限流':'的额度已用完'}。${reset}${offer.state==='none'?'目前没有可接手的执行者。':''}`
}
/** @param {{task:Source,quotaHandoff?:Offer|null}|null} detail @param {Provider[]} providers @param {Attempt|null} [attempt] */
export function renderQuotaHandoff(detail,providers,attempt=null){
 const offer=detail?.quotaHandoff
 if(!detail||(!offer&&!attempt))return ''
 const action=offer?.state==='handed'?`<button class="wb-btn" type="button" data-action="quota-handoff-open" data-quota-task="${esc(offer.matterId)}">打开接手的任务</button>`:offer?.state==='offer'||attempt?`<button class="wb-btn" type="button" data-action="quota-handoff">${attempt?'检查交接状态':`交给 ${esc(name(offer?.state==='offer'?offer.to:'',providers))} 继续…`}</button>`:''
 return `<section class="wb-quota-handoff" aria-label="执行者额度与交接"><p>${esc(quotaHandoffCopy(offer,providers)||'请检查上次交接是否已经完成。')}</p>${attempt&&offer?.state!=='handed'?'<p role="status">上次交接的结果还未确认，请先检查状态。</p>':''}${action}</section>`
}
/** @param {unknown} raw @param {string} id @returns {Offer|null} */
function readOffer(raw,id){
 if(!raw||typeof raw!=='object')throw Error('quota_handoff_unknown_response')
 const d=/** @type {{task?:{id?:string},quotaHandoff?:Offer|null}} */(raw),q=d.quotaHandoff
 if(d.task?.id!==id)throw Error('quota_handoff_unknown_response')
 if(q==null)return null
 if(typeof q.from!=='string'||!PROVIDER.test(q.from))throw Error('quota_handoff_unknown_response')
 if(q.state==='handed'&&typeof q.to==='string'&&PROVIDER.test(q.to)&&TASK.test(q.matterId))return q
 if((q.state==='offer'||q.state==='none')&&(q.kind==='quota'||q.kind==='rate_limit')&&Number.isFinite(q.resetAt)&&(q.state==='none'||PROVIDER.test(q.to)))return q
 throw Error('quota_handoff_unknown_response')
}
const signature=(/** @type {Offer|null} */q)=>q?.state==='offer'?JSON.stringify([q.state,q.from,q.to,q.kind]):q?.state??'none'
const definite=(/** @type {unknown} */e)=>/^(quota_handoff_(changed|not_needed|unavailable)|workbench_busy|workbench_stopping|unavailable_provider|invalid_[a-z_]+|creation_conflict|matter_not_found|unattended_ack_required|network_unprotected|native_session_busy)$/.test(e instanceof Error?e.message:String(e))
const errorCopy=(/** @type {unknown} */e)=>({workbench_busy:'原任务正在执行，结束后再交接。',quota_handoff_changed:'接手人已变化，请重新检查并确认。',quota_handoff_not_needed:'原执行者的额度已恢复，请重新查看任务。',quota_handoff_unavailable:'目前没有可接手的执行者，请稍后检查。',invalid_entry_owner:'这项任务不属于当前主人，无法交接。',unattended_ack_required:'这位执行者需要先在工作台确认执行权限，完成后再交接。',network_unprotected:'网络保护暂未就绪，请恢复连接后再检查交接状态。',native_session_busy:'这个文件夹仍有执行在进行，请结束后再交接。'}[e instanceof Error?e.message:String(e)]??'交接暂未完成，请先检查最新状态。')
/** @param {{invoke:Invoke,source:Source,initial:Offer|null,attempts:Attempts,changed:()=>void,opened:(id:string)=>Promise<void>|void,current:()=>boolean}} deps */
export function createQuotaHandoffController(deps){
 const {invoke,source,attempts,changed,current,opened}=deps
 const state={offer:deps.initial,busy:false,ready:false,unknown:!!attempts.get(source.id),attempt:attempts.get(source.id),error:'',done:false}
 let alive=true
 const valid=()=>alive&&current()
 const notify=()=>{if(valid())changed()}
 const complete=async(/** @type {string} */id)=>{attempts.delete(source.id);state.attempt=null;state.unknown=false;state.done=true;if(valid())await opened(id)}
 const check=async()=>{
  const offer=readOffer(await invoke('GET',`/v1/workbench/task?id=${encodeURIComponent(source.id)}`),source.id)
  if(!valid())return null
  state.offer=offer;state.ready=true
  if(offer?.state==='handed')await complete(offer.matterId)
  return offer
 }
 return{state,
  async refresh(){
   if(!valid()||state.busy)return
   state.busy=true;state.error='';notify()
   try{await check()}catch{if(valid()){state.ready=false;state.error='暂时没能确认最新状态。重新连接后，请手动检查；不会自动重发。'}}
   finally{state.busy=false;notify()}
  },
  async submit(){
   if(!valid()||state.busy||!state.ready||(!state.unknown&&state.offer?.state!=='offer')||state.done)return
   const confirmed=state.offer
   state.busy=true;state.error='';notify()
   try{
    const latest=await check()
    if(!valid()||state.done)return
    const old=attempts.get(source.id)
    if(!old&&signature(latest)!==signature(confirmed)){state.error='额度或接手人已变化，请查看上面的最新说明，再确认一次。';return}
    if(!old&&latest?.state!=='offer')return
    // Absence of a handed receipt in GET does not prove an earlier POST was rejected.
    // Unknown submissions keep their exact identity until handOff returns a definite outcome.
    const attempt=old??{requestId:crypto.randomUUID(),providerId:/** @type {Extract<Offer,{state:'offer'}>} */(latest).to}
    attempts.set(source.id,attempt);state.attempt=attempt;state.unknown=true
    const raw=await invoke('POST','/v1/workbench/quota-handoff',{id:source.id,...attempt})
    const result=/** @type {{taskId?:string,created?:boolean}|null} */(raw)
    if(!result||typeof result.taskId!=='string'||!TASK.test(result.taskId)||typeof result.created!=='boolean')throw Error('quota_handoff_unknown_response')
    await complete(result.taskId)
   }catch(e){
    if(definite(e)){attempts.delete(source.id);state.attempt=null;state.unknown=false;state.ready=false;if(valid())state.error=errorCopy(e)}
    else{state.ready=false;state.unknown=!!attempts.get(source.id);if(valid())state.error=state.unknown?'交接的结果还未确认。已保留这次请求；请先检查状态，再决定是否重试。':'暂时没能确认最新状态，请手动重新检查。'}
   }finally{state.busy=false;notify()}
  },
  destroy(){alive=false},
 }
}
/** @param {ReturnType<typeof createQuotaHandoffController>['state']} state @param {Source} source @param {Provider[]} providers */
export function renderQuotaHandoffConfirmation(state,source,providers){
 const q=state.offer,to=state.attempt?name(state.attempt.providerId,providers):q?.state==='offer'?name(q.to,providers):''
 const confirming=state.ready&&(state.unknown&&!!state.attempt||q?.state==='offer')
 return `<header class="wb-history-head"><h2>交给另一位继续</h2><button type="button" class="wb-new" data-quota="close">关闭</button></header><div class="wb-handoff-body"><p>${esc(quotaHandoffCopy(q,providers)||'当前无需交接。')}</p><p>交接会在同一个文件夹为 ${esc(to||'接手者')} 新开任务；原来的任务仍保留。使用接手执行者的额度。</p><p>只带任务标题和继续工作的要求提示。接手者会查看文件夹里的现有文件；完整原聊天和附件不会自动带过去。</p><dl><dt>任务</dt><dd>${esc(source.title)}</dd><dt>文件夹</dt><dd>${esc(source.path)}</dd></dl>${state.attempt&&q?.state==='offer'&&state.attempt.providerId!==q.to?`<p role="status">当前接手人已变为 ${esc(name(q.to,providers))}。本次仍只核对先前交给 ${esc(to)} 的请求；确定未交出后，再重新确认。</p>`:''}${state.unknown?'<p role="status">上次交接结果尚未确认。重新连接不会自动重发；这次只核对或重试原来的请求和接手人。</p>':''}${state.error?`<p class="wb-error" role="alert">${esc(state.error)}</p>`:''}</div><footer class="wb-handoff-footer"><button type="button" class="wb-btn" data-quota="check"${state.busy?' disabled':''}>${state.busy?'正在检查…':'检查交接状态'}</button>${confirming?`<button type="button" class="wb-btn wb-btn-primary" data-quota="confirm"${state.busy?' disabled':''}>${state.unknown?'核对并重试':'确认'}交给 ${esc(to)}，使用其额度</button>`:''}</footer>`
}
/** @param {{invoke:Invoke,source:Source,initial:Offer|null,providers:Provider[],attempts:Attempts,opened:(id:string)=>Promise<void>|void,current:()=>boolean}} deps */
export function mountQuotaHandoffDialog(deps){
 const dialog=document.createElement('dialog');dialog.className='wb-history-dialog wb-handoff-dialog';dialog.setAttribute('aria-label','交给另一位继续');document.body.append(dialog)
 let lastAction=''
 const render=()=>{
  const active=document.activeElement;if(active instanceof HTMLElement&&dialog.contains(active))lastAction=active.getAttribute('data-quota')??''
  const scroll=dialog.querySelector('.wb-handoff-body')?.scrollTop??0
  dialog.innerHTML=renderQuotaHandoffConfirmation(controller.state,deps.source,deps.providers)
  const body=dialog.querySelector('.wb-handoff-body');if(body)body.scrollTop=scroll
  const focus=dialog.querySelector(`[data-quota="${lastAction}"]`);if(focus instanceof HTMLElement)focus.focus({preventScroll:true})
 }
 const destroy=()=>{controller.destroy();dialog.remove()}
 const controller=createQuotaHandoffController({...deps,changed:render,opened:async id=>{await deps.opened(id);destroy()}})
 dialog.addEventListener('close',destroy)
 dialog.addEventListener('cancel',destroy)
 dialog.addEventListener('click',event=>{const action=event.target instanceof Element?event.target.closest('[data-quota]')?.getAttribute('data-quota'):null;if(action==='close')destroy();if(action==='check')void controller.refresh();if(action==='confirm')void controller.submit()})
 render();dialog.showModal();void controller.refresh();return destroy
}
