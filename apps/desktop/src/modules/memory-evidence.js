// @ts-check
/// <reference lib="dom" />
import { escapeHtml } from "../view.js"

/** @typedef {{kind:'memory',path:string,label:string}|{kind:'observation'|'milestone',id:string,label:string}|{kind:'project',project:string,path:string,label:string}} MemorySourceRef */
/** @typedef {{content:string,revision:string,editable:boolean,canMarkOutdated:boolean,needsRefresh:boolean,archived?:boolean}} Source */
/** @typedef {{open:boolean,chatId:string,title:string,refs:MemorySourceRef[],selectedIndex:number,source:Source|null,draft:string,baseContent:string,revision:string,dirty:boolean,loading:boolean,saving:boolean,error:string,notice:string,confirmation:'close'|'switch'|null}} EvidenceState */
/** @typedef {{chatId:string,action:'correct'|'outdated'}} Reviewed */
/** @typedef {{call:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>,onReviewed?:(event:Reviewed)=>void}} ControllerOptions */

export const LEGACY_EVIDENCE_NOTICE = "旧画像未保存可核对依据，请更新画像"
/** Only typed references are navigable; a legacy display name is never a path. @param {unknown} value @returns {MemorySourceRef[]} */
export function normalizeMemorySourceRefs(value) {
  if (!Array.isArray(value)) return []
  return value.flatMap(/** @returns {MemorySourceRef[]} */ ref => {
    if (!ref || typeof ref !== "object" || typeof ref.label !== "string" || !ref.label.trim()) return []
    if (ref.kind === "memory" && typeof ref.path === "string" && ref.path) return [{kind:ref.kind,path:ref.path,label:ref.label}]
    if ((ref.kind === "observation" || ref.kind === "milestone") && typeof ref.id === "string" && ref.id) return [{kind:ref.kind,id:ref.id,label:ref.label}]
    if (ref.kind === "project" && typeof ref.project === "string" && ref.project && typeof ref.path === "string" && ref.path) return [{kind:ref.kind,project:ref.project,path:ref.path,label:ref.label}]
    return []
  })
}
/** @param {MemorySourceRef} ref @returns {Record<string,string>} */
function identity(ref) {
  if (ref.kind === "memory") return {kind:ref.kind,path:ref.path}
  if (ref.kind === "project") return {kind:ref.kind,project:ref.project,path:ref.path}
  return {kind:ref.kind,id:ref.id}
}
/** @param {unknown} error */
function sourceError(error) {
  const code = error instanceof Error ? error.message : String(error)
  if (/source_changed/.test(code)) return "来源已变化，未覆盖原文。草稿仍保留，请重新读取来源后核对。"
  if (/source_not_found/.test(code)) return "这条来源已无法读取。已有草稿仍保留。"
  if (/source_read_only/.test(code)) return "这条来源只能查看。你的草稿仍保留。"
  if (/invalid_content/.test(code)) return "改正内容不能为空或过长。请检查后再保存，草稿仍保留。"
  return "暂时无法完成，请检查连接后重试。已有草稿仍保留。"
}
/** @param {ControllerOptions} options */
export function createMemoryEvidenceController({call,onReviewed=()=>{}}) {
  /** @type {EvidenceState} */
  let state={open:false,chatId:"",title:"",refs:[],selectedIndex:-1,source:null,draft:"",baseContent:"",revision:"",dirty:false,loading:false,saving:false,error:"",notice:"",confirmation:null}
  let sequence=0, pendingIndex=-1
  /** @type {Set<(state:EvidenceState)=>void>} */ const listeners=new Set()
  /** @type {Map<string,{content:string,baseContent:string,revision:string}>} */ const drafts=new Map()
  /** @param {Partial<EvidenceState>} next */
  const update=next=>{state={...state,...next};listeners.forEach(fn=>fn(state))}
  /** @param {string} chatId @param {MemorySourceRef} ref */
  const key=(chatId,ref)=>JSON.stringify([chatId,identity(ref)])
  function remember() {
    const ref=state.refs[state.selectedIndex]
    if(!state.open||!ref||!state.source)return
    if(state.dirty)drafts.set(key(state.chatId,ref),{content:state.draft,baseContent:state.baseContent,revision:state.revision})
    else drafts.delete(key(state.chatId,ref))
  }
  function closeNow(){sequence++;update({open:false,loading:false,saving:false,confirmation:null})}
  /** @param {number} index */
  async function read(index) {
    const ref=state.refs[index];if(!ref)return
    const chatId=state.chatId,token=++sequence
    update({selectedIndex:index,source:null,loading:true,saving:false,draft:"",baseContent:"",revision:"",dirty:false,error:"",notice:"",confirmation:null})
    try {
      const query=new URLSearchParams({chat_id:chatId,...identity(ref)})
      const result=/** @type {Source & {ok?:boolean,error?:string}} */ (await call("GET",`/v1/memory/source?${query}`))
      if(token!==sequence||!state.open)return
      if(!result?.ok||typeof result.content!=="string"||typeof result.revision!=="string")throw Error(result?.error||"invalid_source")
      result.editable=result.editable===true&&(ref.kind==='memory'||ref.kind==='observation')
      result.canMarkOutdated=result.canMarkOutdated===true&&ref.kind==='observation'
      const kept=drafts.get(key(chatId,ref)),draft=kept?.content??result.content,baseContent=kept?.baseContent??result.content
      update({source:result,loading:false,draft,baseContent,revision:kept?.revision??result.revision,dirty:draft!==baseContent,
        notice:[result.archived?"这条观察已过时，原文保留在这里供回看。":!result.editable?"这条来源仅供查看。":"",kept&&kept.revision!==result.revision?"来源已变化，你之前的草稿单独保留；请核对当前原文。":""].filter(Boolean).join(' ')})
    } catch(error) {if(token===sequence&&state.open)update({loading:false,error:sourceError(error)})}
  }
  return {
    get state(){return state},
    /** @param {(state:EvidenceState)=>void} listener */
    subscribe(listener){listeners.add(listener);listener(state);return()=>listeners.delete(listener)},
    /** @param {{chatId:string,title:string,sourceRefs?:unknown,sources?:unknown}} card */
    async open(card){
      remember();sequence++
      const refs=normalizeMemorySourceRefs(card.sourceRefs)
      update({open:true,chatId:card.chatId,title:card.title,refs,selectedIndex:-1,source:null,draft:"",baseContent:"",revision:"",dirty:false,loading:false,saving:false,error:"",notice:refs.length?"":LEGACY_EVIDENCE_NOTICE,confirmation:null})
      if(refs.length&&card.chatId)await read(0)
    },
    /** @param {number} index */
    async select(index){
      if(!state.open||state.saving||index===state.selectedIndex||!state.refs[index])return
      if(state.dirty){pendingIndex=index;update({confirmation:"switch"});return}
      await read(index)
    },
    async refresh(){if(!state.open||state.saving||state.loading||state.confirmation||state.selectedIndex<0)return;remember();await read(state.selectedIndex)},
    rebase(){
      if(!state.open||state.saving||state.loading||state.confirmation||!state.source?.editable)return
      update({revision:state.source.revision,baseContent:state.source.content,dirty:state.draft!==state.source.content,error:'',notice:'已按当前来源继续编辑。请审阅草稿后再保存。'})
      remember()
    },
    /** @param {string} content */
    edit(content){if(state.open&&state.source?.editable&&!state.loading&&!state.saving&&!state.confirmation){update({draft:content,dirty:content!==state.baseContent,error:""});remember()}},
    requestClose(){if(state.saving)return;if(state.dirty)update({confirmation:"close"});else closeNow()},
    /** @param {'keep'|'discard'|'stay'} choice */
    async resolveLeave(choice){
      if(!state.confirmation||state.saving)return
      if(choice==='stay'){update({confirmation:null});return}
      const destination=state.confirmation,ref=state.refs[state.selectedIndex]
      if(choice==='keep')remember();else if(ref)drafts.delete(key(state.chatId,ref))
      if(destination==='close')closeNow();else await read(pendingIndex)
    },
    /** @param {'correct'|'outdated'} action */
    async review(action){
      const ref=state.refs[state.selectedIndex],source=state.source
      if(!state.open||!ref||!source||state.loading||state.saving||state.confirmation||!['memory','observation'].includes(ref.kind))return
      if(action==='correct'?(!source.editable||source.revision!==state.revision||!state.dirty||!state.draft.trim()):(!source.canMarkOutdated||state.dirty))return
      const token=sequence,chatId=state.chatId,content=state.draft,revision=state.revision,draftKey=key(chatId,ref)
      remember();update({saving:true,error:""})
      try {
        const result=/** @type {{ok?:boolean,error?:string}} */ (await call('POST','/v1/memory/source/review',{chat_id:chatId,...identity(ref),revision,action,...(action==='correct'?{content}:{})}))
        if(!result?.ok)throw Error(result?.error||'unavailable')
        const kept=drafts.get(draftKey);if(kept?.content===content&&kept.revision===revision)drafts.delete(draftKey)
        onReviewed({chatId,action})
        if(token===sequence&&state.open){update({dirty:false});closeNow()}
      } catch(error){if(token===sequence&&state.open)update({saving:false,error:sourceError(error)})}
    },
  }
}

/** Native dialog supplies focus containment and keyboard behavior; source text only enters textarea.value.
 * @param {ControllerOptions & {documentTarget?:Document}} options
 */
export function mountMemoryEvidenceDialog(options) {
  const doc=options.documentTarget??document,controller=createMemoryEvidenceController(options)
  const dialog=doc.createElement('dialog');dialog.className='memory-evidence-dialog'
  dialog.setAttribute('aria-labelledby','memory-evidence-title')
  dialog.innerHTML=`<div class="memory-evidence-head"><div><p class="memory-evidence-eyebrow">画像依据</p><h2 id="memory-evidence-title"></h2></div><button type="button" data-evidence-close aria-label="关闭依据">×</button></div>
    <p class="memory-evidence-intro">查看画像所引用来源的当前原文。这里没有保存生成画像时的原文快照。</p>
    <div class="memory-evidence-layout"><nav class="memory-evidence-sources" aria-label="依据来源"></nav><section class="memory-evidence-reader">
    <details class="memory-evidence-original"><summary>查看当前来源原文</summary><pre id="memory-evidence-original" tabindex="0"></pre></details>
    <label for="memory-evidence-text" class="memory-evidence-label">就地改正</label><textarea id="memory-evidence-text" spellcheck="false"></textarea>
    <p class="memory-evidence-notice" role="status" aria-live="polite"></p><p class="memory-evidence-error" role="alert"></p>
    <div class="memory-evidence-recovery"><button type="button" data-evidence-refresh>重新读取来源</button><button type="button" data-evidence-rebase>按最新来源继续编辑</button></div>
    <div class="memory-evidence-actions"><button type="button" data-evidence-outdated>这条观察已过时</button><button type="button" data-evidence-save>保存改正</button></div>
    </section></div><div class="memory-evidence-confirm" role="group" aria-label="未保存的修改" hidden><p>还有未保存的修改。保留草稿，还是放弃这次修改？</p><button type="button" data-evidence-leave="stay">继续编辑</button><button type="button" data-evidence-leave="keep">保留草稿并离开</button><button type="button" data-evidence-leave="discard">放弃修改并离开</button></div>`
  doc.body.append(dialog)
  const title=/** @type {HTMLElement} */(dialog.querySelector('h2')),list=/** @type {HTMLElement} */(dialog.querySelector('.memory-evidence-sources'))
  const editor=/** @type {HTMLTextAreaElement} */(dialog.querySelector('textarea')),notice=/** @type {HTMLElement} */(dialog.querySelector('.memory-evidence-notice')),error=/** @type {HTMLElement} */(dialog.querySelector('.memory-evidence-error'))
  const original=/** @type {HTMLElement} */(dialog.querySelector('#memory-evidence-original')),originalDetails=/** @type {HTMLDetailsElement} */(dialog.querySelector('.memory-evidence-original')),editorLabel=/** @type {HTMLElement} */(dialog.querySelector('label[for="memory-evidence-text"]')),refresh=/** @type {HTMLButtonElement} */(dialog.querySelector('[data-evidence-refresh]')),rebase=/** @type {HTMLButtonElement} */(dialog.querySelector('[data-evidence-rebase]'))
  const save=/** @type {HTMLButtonElement} */(dialog.querySelector('[data-evidence-save]')),outdated=/** @type {HTMLButtonElement} */(dialog.querySelector('[data-evidence-outdated]')),close=/** @type {HTMLButtonElement} */(dialog.querySelector('[data-evidence-close]')),confirm=/** @type {HTMLElement} */(dialog.querySelector('.memory-evidence-confirm'))
  /** @type {HTMLElement|null} */ let opener=null
  let openerKey='',listKey='',hadConfirmation=false
  function restoreFocus(){const target=opener?.isConnected?opener:doc.querySelector(`[data-memory-evidence="${openerKey}"]`);/** @type {HTMLElement|null} */(target)?.focus()}
  controller.subscribe(state=>{
    if(!state.open){if(dialog.open){dialog.close();restoreFocus()}return}
    if(!dialog.open)dialog.showModal()
    title.textContent=state.title
    const signature=JSON.stringify([state.refs,state.selectedIndex,state.saving,!!state.confirmation])
    if(signature!==listKey){
      const focusedIndex=doc.activeElement?.getAttribute('data-evidence-source')
      listKey=signature;list.innerHTML=state.refs.map((ref,index)=>`<button type="button" data-evidence-source="${index}" aria-pressed="${index===state.selectedIndex}" ${state.saving||state.confirmation?'disabled':''}>${escapeHtml(ref.label)}</button>`).join('')
      if(focusedIndex!=null&&!state.saving&&!state.confirmation)/** @type {HTMLElement|null} */(list.querySelector(`[data-evidence-source="${focusedIndex}"]`))?.focus()
    }
    const changedSource=!!state.source&&state.source.revision!==state.revision
    if(editor.value!==state.draft)editor.value=state.draft
    editor.hidden=!state.source||(!state.source.editable&&!state.dirty);editor.readOnly=!state.source?.editable;editor.disabled=state.saving||!!state.confirmation
    editorLabel.hidden=editor.hidden;editorLabel.textContent=!state.source?.editable?'保留的草稿（仅供复制，不是来源原文）':state.dirty?'你的改正（未保存）':'就地改正'
    original.textContent=state.source?.content??'';originalDetails.hidden=!state.source
    if(state.source&&(!state.source.editable||changedSource))originalDetails.open=true
    refresh.hidden=state.selectedIndex<0;refresh.disabled=state.saving||state.loading||!!state.confirmation
    rebase.hidden=!state.source?.editable||!changedSource;rebase.disabled=state.saving||state.loading||!!state.confirmation
    notice.textContent=state.loading?'正在读取来源…':state.notice;error.textContent=state.error
    save.hidden=!state.source?.editable;save.disabled=state.saving||state.loading||changedSource||!state.dirty||!state.draft.trim()||!!state.confirmation;save.textContent=state.saving?'正在保存…':'保存改正'
    outdated.hidden=!state.source?.canMarkOutdated;outdated.disabled=state.saving||state.dirty||!!state.confirmation
    close.disabled=state.saving;confirm.hidden=!state.confirmation
    if(state.confirmation&&!hadConfirmation)/** @type {HTMLElement|null} */(confirm.querySelector('button'))?.focus()
    if(!state.confirmation&&hadConfirmation){
      if(state.loading)/** @type {HTMLElement|null} */(list.querySelector('[aria-pressed="true"]'))?.focus()
      else editor.focus()
    }
    hadConfirmation=!!state.confirmation
    dialog.setAttribute('aria-busy',String(state.loading||state.saving))
  })
  editor.addEventListener('input',()=>controller.edit(editor.value))
  dialog.addEventListener('click',event=>{
    const button=/** @type {HTMLElement|null} */(event.target)?.closest('button');if(!button)return
    if(button.hasAttribute('data-evidence-close'))controller.requestClose()
    else if(button.dataset.evidenceSource!==undefined)void controller.select(Number(button.dataset.evidenceSource))
    else if(button.hasAttribute('data-evidence-save'))void controller.review('correct')
    else if(button.hasAttribute('data-evidence-outdated'))void controller.review('outdated')
    else if(button.hasAttribute('data-evidence-refresh'))void controller.refresh()
    else if(button.hasAttribute('data-evidence-rebase'))controller.rebase()
    else if(button.dataset.evidenceLeave)void controller.resolveLeave(/** @type {'keep'|'discard'|'stay'} */(button.dataset.evidenceLeave))
  })
  dialog.addEventListener('cancel',event=>{event.preventDefault();controller.requestClose()})
  return {
    /** @param {{chatId:string,title:string,sourceRefs?:unknown,sources?:unknown}} card @param {HTMLElement} trigger */
    open(card,trigger){opener=trigger;openerKey=trigger.dataset.memoryEvidence||'';return controller.open(card)},
  }
}
