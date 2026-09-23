// @ts-check
/** @typedef {import('../../../../src/core/workbench/native-history').NativeHistoryItem} Item */
/** @typedef {import('../../../../src/core/workbench/native-history').NativeHistoryPage} Page */
/** @typedef {import('../../../../src/core/workbench/native-history').NativeHistoryPreview} Preview */
/** @typedef {{providerId:string,providers:string[],q:string,items:Item[],nextCursor:string|null,coverage:string,preview:Preview|null,pages:Preview[],busy:boolean,error:string}} State */
/** @typedef {(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>} Invoke */
const escape=(/** @type {unknown} */ value)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]??c)
/** @param {Preview|null} preview */
export function nativeImportMessages(preview){
  let budget=24_000
  const messages=[]
  for(const m of [...(preview?.messages??[])].reverse()){
    if(messages.length===200)break
    if(m.text.length>budget)continue
    messages.unshift(m);budget-=m.text.length
  }
  return messages
}
const names=/** @type {Record<string,string>} */ ({claude:'Claude',codex:'Codex'})
/** @param {Invoke} invoke @param {()=>void} paint @param {string[]} providers */
export function createHistoryController(invoke,paint,providers){
  /** @type {State} */
  const state={providerId:providers[0]??'claude',providers,q:'',items:[],nextCursor:null,coverage:'',preview:null,pages:[],busy:false,error:''}
  let generation=0,alive=true
  /** @type {{item:Item,append:boolean}|null} */
  let failedRead=null
  const fail=(/** @type {unknown} */ error)=>String(error).includes('native_history_changed')?'原记录已更新，请重新打开这条会话再加入。':String(error).includes('native_session_already_managed')?'这条会话已在 CC 任务列表中，请从任务列表打开。':error instanceof Error&&error.message.includes('native_history_unsupported')?'当前版本暂不支持读取这类历史。原会话仍保留在原工具中。':'暂时没能读取会话记录，可以重试。'
  async function list(/** @type {boolean} */ append){
    const request=++generation;state.busy=true;state.error='';paint()
    const query=new URLSearchParams({providerId:state.providerId,q:state.q,limit:'50'})
    if(append&&state.nextCursor)query.set('cursor',state.nextCursor)
    try{
      const page=/** @type {Page} */(await invoke('GET',`/v1/workbench/sessions?${query}`))
      if(!alive||request!==generation)return
      state.items=[...new Map([...(append?state.items:[]),...page.items].map(item=>[item.key,item])).values()]
      state.nextCursor=page.nextCursor;state.coverage=page.coverage
    }catch(error){if(alive&&request===generation)state.error=fail(error)}
    finally{if(alive&&request===generation){state.busy=false;paint()}}
  }
  async function read(/** @type {Item} */ item,/** @type {boolean} */ append){
    const request=++generation;state.busy=true;state.error='';paint()
    const query=new URLSearchParams({key:item.key,limit:'100'})
    if(append&&state.preview?.nextCursor)query.set('cursor',state.preview.nextCursor)
    try{
      const page=/** @type {Preview} */(await invoke('GET',`/v1/workbench/session?${query}`))
      if(!alive||request!==generation)return
      if(page.session.key!==item.key)throw new Error('wrong_session')
      state.pages=append?[...state.pages,page].slice(-5):[page]
      failedRead=null
      const messages=[...new Map([...(append?state.preview?.messages??[]:[]),...page.messages].map(message=>[message.id,message])).values()]
      state.preview={...page,messages:messages.slice(-500),truncated:page.truncated||messages.length>500||!!(append&&state.preview?.truncated)}
    }catch(error){if(alive&&request===generation){failedRead={item,append};state.error=fail(error)}}
    finally{if(alive&&request===generation){state.busy=false;paint()}}
  }
  return{state,
    async search(/** @type {string} */ q){failedRead=null;state.q=q.trim().slice(0,200);state.preview=null;state.pages=[];state.items=[];state.nextCursor=null;await list(false)},
    async provider(/** @type {string} */ id){if(!providers.includes(id))return;failedRead=null;state.providerId=id;state.q='';state.preview=null;state.pages=[];state.items=[];state.nextCursor=null;await list(false)},
    async more(){if(!state.busy&&state.nextCursor)await list(true)},
    async select(/** @type {Item} */ item){state.preview=null;state.pages=[];await read(item,false)},
    async moreMessages(){if(!state.busy&&state.preview?.nextCursor)await read(state.preview.session,true)},
    async importSelected(){
      if(state.busy||!state.preview)return null
      const request=++generation,preview=state.preview,messages=nativeImportMessages(preview)
      if(!messages.length)return null
      state.busy=true;state.error='';paint()
      try{
        const result=/** @type {{task:{id:string}}} */(await invoke('POST','/v1/workbench/import',{key:preview.session.key,pages:state.pages.map(p=>({...p.page,sourceFingerprint:p.sourceFingerprint})),messageIds:messages.map(m=>m.id)}))
        return alive&&request===generation?result.task.id:null
      }catch(error){if(alive&&request===generation)state.error=fail(error);return null}
      finally{if(alive&&request===generation){state.busy=false;paint()}}
    },
    async retry(){if(state.busy)return;if(failedRead)await read(failedRead.item,failedRead.append);else await list(false)},
    back(){failedRead=null;generation++;state.preview=null;state.pages=[];state.busy=false;state.error='';paint()},
    destroy(){alive=false;generation++},
  }
}
/** @param {State} state */
export function renderHistoryPanel(state){
  const disabled=state.busy?' disabled':''
  const error=state.error?`<p class="wb-history-error" role="alert">${escape(state.error)} <button type="button" class="wb-new" data-history="retry"${disabled}>重试</button></p>`:''
  const preview=state.preview
  const heading=`<header><div><h2>已有会话</h2><p>原记录来自 Claude / Codex，查看不会启动任务。</p></div><button type="button" data-history="close" aria-label="关闭已有会话">×</button></header>`
  if(preview){
    let remaining=160_000,limited=preview.truncated
    const messages=preview.messages.map(message=>{const text=message.text.slice(0,Math.min(40_000,remaining));remaining-=text.length;if(text.length<message.text.length)limited=true;return text?`<article class="wb-history-message"><strong>${message.role==='user'?'你':escape(names[preview.session.providerId])}</strong><p>${escape(text)}</p>${message.truncated?'<small>这段内容已截断。</small>':''}</article>`:''}).join('')
    const s=preview.session,selected=nativeImportMessages(preview)
    const save=preview.managedTaskId?`<footer class="wb-history-import"><p>这条会话已经在 CC 中。</p><button class="wb-btn wb-btn-primary" data-history="open-task">打开任务</button></footer>`:selected.length?`<footer class="wb-history-import"><details><summary>加入后保留 ${selected.length} 段对话 · 查看内容</summary>${selected.map(m=>`<article class="wb-history-message"><strong>${m.role==='user'?'你':escape(names[s.providerId])}</strong><p>${escape(m.text)}</p></article>`).join('')}</details><p>只保存这些文字，原工具中的完整会话仍然保留。加入不会启动任务。</p><button class="wb-btn wb-btn-primary" data-history="import"${disabled}>${state.busy?'正在处理…':'加入任务列表'}</button></footer>`:''
    return `${heading}<div class="wb-history-body"><button class="wb-new" data-history="back">← 返回会话列表</button><h3>${escape(s.title.slice(0,500))}</h3><p class="wb-history-meta">${escape(names[s.providerId])} · ${s.observedState==='active'?'原工具报告正在执行':s.remote?'远程来源':'运行状态未确认'}</p><details><summary>原会话信息</summary><p>${escape(s.cwd??'未记录文件夹')}</p><p>${escape(s.nativeId)}</p></details>${error}${limited?'<p class="wb-history-note">当前显示部分文字，原工具中的完整历史不受影响。</p>':''}${messages||'<p class="wb-history-note">这一页没有可展示的对话文字。</p>'}${preview.nextCursor?`<button class="wb-btn" data-history="more-messages"${disabled}>${state.busy?'正在读取…':'继续读取原对话'}</button>`:''}${save}</div>`
  }
  const choices=state.providers.map(id=>`<button type="button" data-history="provider" data-provider="${escape(id)}" aria-pressed="${state.providerId===id}">${escape(names[id]??id)}</button>`).join('')
  const rows=state.items.map(item=>`<button class="wb-history-row" type="button" data-history="select" data-key="${escape(item.key)}"><strong>${escape(item.title.slice(0,200))}</strong><span>${escape(item.cwd??'未记录文件夹')}</span></button>`).join('')
  return `${heading}<div class="wb-history-body"><div class="wb-history-providers">${choices}</div><form class="wb-history-search"><label class="wb-sr-only" for="wb-history-search">查找原会话</label><input id="wb-history-search" maxlength="200" placeholder="搜索会话名称" value="${escape(state.q)}"><button type="submit"${disabled}>查找</button></form>${state.coverage==='native_indexed_history'?'<p class="wb-history-note">显示本机 Codex 已收录的会话；未收录或已归档的记录可能不在这里。</p>':''}${error}${rows||`<p class="wb-history-note">${state.busy?'正在读取…':state.nextCursor?'这一批没有匹配项，可以继续查找。':state.error?'':'没有找到匹配的会话。'}</p>`}${state.nextCursor?`<button class="wb-btn" data-history="more"${disabled}>${state.busy?'正在读取…':'继续查找'}</button>`:''}</div>`
}
/** @param {Invoke} invoke @param {string[]} providers @param {(id:string)=>Promise<void>} [onImported] @returns {()=>void} */
export function mountHistoryDialog(invoke,providers,onImported){
  const dialog=document.createElement('dialog');dialog.className='wb-history-dialog';dialog.setAttribute('aria-label','已有会话');document.body.append(dialog)
  const controller=createHistoryController(invoke,()=>{
    const input=/** @type {HTMLInputElement|null} */(dialog.querySelector('#wb-history-search'))
    const draft=input?.value;const focused=input===document.activeElement
    const body=dialog.querySelector('.wb-history-body'),scroll=body?.scrollTop??0
    dialog.innerHTML=renderHistoryPanel(controller.state)
    const next=/** @type {HTMLInputElement|null} */(dialog.querySelector('#wb-history-search'))
    if(next&&draft!==undefined&&focused){next.value=draft;next.focus()}
    const content=dialog.querySelector('.wb-history-body');if(content)content.scrollTop=scroll
  },providers)
  const destroy=()=>{controller.destroy();dialog.remove()}
  dialog.addEventListener('close',destroy)
  dialog.addEventListener('submit',event=>{event.preventDefault();const field=/** @type {HTMLInputElement|null} */(dialog.querySelector('#wb-history-search'));void controller.search(field?.value??'')})
  dialog.addEventListener('click',event=>{
    const button=event.target instanceof Element?event.target.closest('[data-history]'):null
    if(!(button instanceof HTMLElement))return
    const action=button.dataset.history
    if(action==='close')dialog.close()
    if(action==='back')controller.back()
    if(action==='provider'&&button.dataset.provider)void controller.provider(button.dataset.provider)
    if(action==='open-task'&&controller.state.preview?.managedTaskId){const id=controller.state.preview.managedTaskId;dialog.close();void onImported?.(id)}
    if(action==='import')void controller.importSelected().then(async id=>{if(id){dialog.close();await onImported?.(id)}})
    if(action==='retry')void controller.retry()
    if(action==='more')void controller.more()
    if(action==='more-messages')void controller.moreMessages()
    if(action==='select'){const item=controller.state.items.find(row=>row.key===button.dataset.key);if(item)void controller.select(item)}
  })
  dialog.innerHTML=renderHistoryPanel(controller.state);dialog.showModal();void controller.search('')
  return destroy
}
