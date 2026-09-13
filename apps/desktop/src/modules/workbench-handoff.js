// @ts-check
/** @typedef {import('../../../../src/core/workbench/handoff').HandoffInput} Input */
/** @typedef {import('../../../../src/core/workbench/handoff').HandoffPreview} Preview */
/** @typedef {Pick<import('../../../../src/core/workbench/store').Artifact,'id'|'taskId'|'name'|'mime'|'sha256'|'createdAt'>} Artifact */
/** @typedef {{input:Input,preview:Preview|null,busy:boolean,error:string}} State */
/** @typedef {(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>} Invoke */
const esc=(/** @type {unknown} */v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]??c)
const reviewMime='application/vnd.cc.workbench-review+json'
const supported=new Set(['text/plain','text/markdown','application/json',reviewMime])
/** @param {Artifact[]} artifacts */
export function defaultReviewArtifacts(artifacts){
 const sorted=artifacts.filter(a=>supported.has(a.mime)).sort((a,b)=>b.createdAt-a.createdAt)
 const chosen=sorted.find(a=>a.mime===reviewMime)??sorted[0]
 return chosen?[{taskId:chosen.taskId,artifactId:chosen.id,sha256:chosen.sha256}]:[]
}
const errorCopy=(/** @type {unknown} */error)=>{
 const code=error instanceof Error?error.message:String(error)
 return Object.entries({handoff_changed:'记录已变化，请重新查看交接内容。',invalid_handoff_quote:'请保留这条回复中的一段原文；补充要求写在下方。',workbench_busy:'原任务还在执行，结束后再交回。',workbench_archived:'请先恢复已归档的原任务。',restart_confirmation_required:'原会话暂时不能恢复，请重新查看恢复选项。',external_close_confirmation_stale:'原会话状态已变化，请重新查看并确认原程序已关闭。',native_session_busy:'此文件夹或原会话仍在使用，请结束原执行后再试。'}).find(([key])=>code.includes(key))?.[1]??'交接暂未完成，可以重试；重复提交不会多开任务。'
}
/** @param {Invoke} invoke @param {()=>void} render @param {Input} initial @param {(id:string)=>void|Promise<void>} opened */
export function createHandoffController(invoke,render,initial,opened){
 /** @type {State} */ const state={input:structuredClone(initial),preview:null,busy:false,error:''}
 let alive=true,generation=0,submitting=false
 return{state,
  edit(/** @type {Input} */input){if(!alive||submitting)return;generation++;state.input=structuredClone(input);state.preview=null;state.error='';state.busy=false},
  async prepare(){
   if(!alive||submitting)return
   const request=++generation;state.busy=true;state.error='';render()
   try{const p=/** @type {Preview} */(await invoke('POST','/v1/workbench/handoff-preview',{...state.input}));if(alive&&request===generation)state.preview=p}
   catch(e){if(alive&&request===generation){state.preview=null;state.error=errorCopy(e)}}
   finally{if(alive&&request===generation){state.busy=false;render()}}
  },
  async submit(){
   if(!alive||state.busy||!state.preview||submitting)return
   const p=state.preview;submitting=true;state.busy=true;state.error='';render()
   try{
    const result=/** @type {{task:{id:string}}} */(await invoke('POST','/v1/workbench/handoff',{token:p.token,...(p.targetContinuation?.mode==='restart_required'?{restartToken:p.targetContinuation.restart.token}:{}),...(p.nativeResume?{sourceClosedToken:p.nativeResume.token}:{})}))
    if(alive)await opened(result.task.id)
   }catch(e){if(alive){state.error=errorCopy(e);if(/handoff_changed|restart_confirmation|external_close_confirmation/.test(e instanceof Error?e.message:String(e)))state.preview=null}}
   finally{submitting=false;if(alive){state.busy=false;render()}}
  },
  destroy(){alive=false;generation++},
 }
}
/** @param {State} state @param {Artifact[]} artifacts @param {string} title */
export function renderHandoffPanel(state,artifacts,title){
 const i=state.input,p=state.preview,revision=i.purpose==='revision',helper=i.targetProviderId==='claude'?'Claude':'Codex'
 const disabled=state.busy?' disabled':''
 const files=artifacts.filter(a=>supported.has(a.mime)).map(a=>`<label class="wb-handoff-file"><input type="checkbox" data-handoff-artifact="${esc(a.id)}"${i.artifacts.some(ref=>ref.artifactId===a.id)?' checked':''}${disabled}><span>${esc(a.name)}<small>${esc(new Date(a.createdAt).toLocaleString())} · ${esc(a.sha256.slice(0,8))}</small></span></label>`).join('')
 const recovery=p?.targetContinuation?.mode==='restart_required'?`<section class="wb-recovery"><h3>原会话无法恢复</h3><p>原任务的对话和成果仍然保留。这次会带记录新开一轮。</p><details><summary>查看将带入的原任务记录</summary><pre>${esc(p.targetContinuation.restart.context)}</pre></details></section>`:''
 const closure=p?.nativeResume?'<p class="wb-history-note">继续前，请关闭原程序里这条会话的执行。CC 无法替你确认其他窗口已经停止。</p>':''
 const label=state.busy?'正在准备…':!p?'查看交接内容':p.nativeResume?'原程序已关闭，交回修改':p.targetContinuation?.mode==='restart_required'?'带记录新开并修改':revision?'交回原任务':'开始检查'
 return `<header class="wb-history-head"><div><h2>${revision?'交回原任务':`交给 ${esc(helper)} 检查`}</h2><p>${esc(title)}</p></div><button type="button" class="wb-new" data-handoff="close" aria-label="关闭交接">关闭</button></header><div class="wb-handoff-body">${revision?`<label class="wb-handoff-field">采纳的意见<textarea id="wb-handoff-quote" rows="5" maxlength="8000"${disabled}>${esc(i.quote?.text)}</textarea><small>保留要采纳的一段原文；这次不会自动采纳其他意见。</small></label>`:'<p class="wb-history-note">另开一项检查，原任务继续保留。检查结果会关联回来。</p>'}<label class="wb-handoff-field">${revision?'修改要求':'检查重点'}<textarea id="wb-handoff-request" rows="2" maxlength="4000"${disabled}>${esc(i.request)}</textarea></label>${!revision?`<details><summary>成果版本 · ${i.artifacts.length} 份</summary>${files||'<p>暂无可附加的文字成果，将使用这项任务的最近对话。</p>'}</details>`:''}${p?`<details class="wb-handoff-packet"><summary>查看将交给 ${esc(helper)} 的内容${p.truncated?' · 部分内容':''}</summary>${p.truncated?'<p>部分历史或文件内容已截断，检查范围有限。</p>':''}<pre>${esc(p.context)}</pre></details>`:''}${recovery}${closure}${state.error?`<p class="wb-error" role="alert">${esc(state.error)}</p>`:''}</div><footer class="wb-handoff-footer"><span>${revision?'回到原任务继续，保留成果版本。':'只带这项任务的记录和选定成果。'}</span><button type="button" class="wb-btn wb-btn-primary" data-handoff="submit"${disabled}>${label}</button></footer>`
}
/** @param {Invoke} invoke @param {Input} initial @param {Artifact[]} artifacts @param {string} title @param {(id:string)=>Promise<void>} opened */
export function mountHandoffDialog(invoke,initial,artifacts,title,opened){
 const dialog=document.createElement('dialog');dialog.className='wb-history-dialog wb-handoff-dialog';dialog.setAttribute('aria-label',initial.purpose==='review'?'交给另一位助手检查':'交回原任务');document.body.append(dialog)
 let focusId='',focusAction=''
 const render=()=>{
  const active=document.activeElement
  if(active instanceof HTMLElement&&dialog.contains(active)){focusId=active.id;focusAction=active.getAttribute('data-handoff')??''}
  const open=[...dialog.querySelectorAll('details')].map(d=>d.open),scroll=dialog.querySelector('.wb-handoff-body')?.scrollTop??0
  dialog.innerHTML=renderHandoffPanel(controller.state,artifacts,title)
  dialog.querySelectorAll('details').forEach((d,index)=>{d.open=open[index]??false});const body=dialog.querySelector('.wb-handoff-body');if(body)body.scrollTop=scroll
  const next=focusId?dialog.querySelector(`#${CSS.escape(focusId)}`):focusAction?dialog.querySelector(`[data-handoff="${CSS.escape(focusAction)}"]`):null
  if(next instanceof HTMLElement)next.focus({preventScroll:true})
 }
 const destroy=()=>{controller.destroy();dialog.remove()}
 const controller=createHandoffController(invoke,render,initial,async id=>{await opened(id);destroy()})
 dialog.addEventListener('close',destroy)
 dialog.addEventListener('input',()=>{
  const request=/** @type {HTMLTextAreaElement|null} */(dialog.querySelector('#wb-handoff-request')),quote=/** @type {HTMLTextAreaElement|null} */(dialog.querySelector('#wb-handoff-quote'))
  const selected=[...dialog.querySelectorAll('input[data-handoff-artifact]:checked')].map(e=>e.getAttribute('data-handoff-artifact'))
  const input={...controller.state.input,request:request?.value??'',artifacts:artifacts.filter(a=>selected.includes(a.id)).map(a=>({taskId:a.taskId,artifactId:a.id,sha256:a.sha256})),...(quote&&controller.state.input.quote?{quote:{...controller.state.input.quote,text:quote.value}}:{})}
  controller.edit(input)
  const button=/** @type {HTMLButtonElement|null} */(dialog.querySelector('[data-handoff="submit"]'));if(button){button.disabled=false;button.textContent='查看交接内容'}
  dialog.querySelector('.wb-handoff-packet')?.remove()
 })
 dialog.addEventListener('click',event=>{
  const action=event.target instanceof Element?event.target.closest('[data-handoff]')?.getAttribute('data-handoff'):null
  if(action==='close')dialog.close()
  if(action==='submit')void(controller.state.preview?controller.submit():controller.prepare())
 })
 render();dialog.showModal();void controller.prepare();return destroy
}
/** @param {Invoke} invoke @param {string} taskId @param {string} id */
export function mountHandoffRecord(invoke,taskId,id){
 const dialog=document.createElement('dialog');dialog.className='wb-history-dialog wb-handoff-dialog';dialog.setAttribute('aria-label','交接记录');document.body.append(dialog)
 let alive=true
 const close=()=>{alive=false;dialog.remove()}
 dialog.innerHTML='<header class="wb-history-head"><h2>交接记录</h2><button class="wb-new">关闭</button></header><div class="wb-handoff-body">正在读取…</div>'
 dialog.addEventListener('close',close);dialog.querySelector('button')?.addEventListener('click',()=>dialog.close());dialog.showModal()
 void invoke('GET',`/v1/workbench/handoff?taskId=${encodeURIComponent(taskId)}&handoffId=${encodeURIComponent(id)}`).then(raw=>{
  if(!alive)return
  const value=/** @type {{packet:{context:string;continuation?:{mode:string;preview?:{context:string}}};sourceNativeId?:string|null;targetNativeId?:string|null;packetSha256:string}} */(raw)
  const body=dialog.querySelector('.wb-handoff-body')
  if(body)body.innerHTML=`<p>这是当时实际选定的交接内容。</p><pre>${esc(value.packet.context)}</pre>${value.packet.continuation?.mode==='restart'?`<details><summary>本轮同时带入的原任务记录</summary><pre>${esc(value.packet.continuation.preview?.context)}</pre></details>`:''}<details><summary>来源与版本凭证</summary><p>原执行会话：${esc(value.sourceNativeId??'未记录')}</p><p>接收方执行会话：${esc(value.targetNativeId??'尚未启动')}</p><code>${esc(value.packetSha256)}</code></details>`
 },error=>{const body=dialog.querySelector('.wb-handoff-body');if(alive&&body)body.textContent=errorCopy(error)})
 return close
}
