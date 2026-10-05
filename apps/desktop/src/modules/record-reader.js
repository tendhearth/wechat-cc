// A single reading surface for kept pictures and words. Callers own their data/actions.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
let active=null
export function closeRecordReader(options={}) { active?.close(options) }

/** @param {Element|null} element */
export function isVisibleRecordTarget(element) {
 if(!element||!element.isConnected||element.closest('[hidden]'))return false
 for(let parent=element.parentElement;parent;parent=parent.parentElement){
  if(parent.tagName==='DETAILS'&&!parent.hasAttribute('open')&&!parent.querySelector(':scope > summary')?.contains(element))return false
 }
 return true
}

/** @param {{focusFallback?:(opener:Element|null)=>Element|null,onClose?:()=>void}} [options] */
export function createRecordReader({focusFallback=()=>null,onClose=()=>{}}={}) {
 /** @type {HTMLDialogElement|null} */ let element=null
 /** @type {Element|null} */ let opener=null
 const reader={
  get element(){return element},
  close({restoreFocus=true}={}){
   const previous=element;if(!previous)return
   element=null;if(active===reader)active=null
   if(previous.open)previous.close()
   previous.remove();onClose()
   if(restoreFocus){
    const target=isVisibleRecordTarget(opener)?opener:focusFallback(opener)
    target?.focus?.({preventScroll:true})
   }
  },
  /** @param {{label:string,html:string,trigger?:Element|null,onAction?:(event:MouseEvent,dialog:HTMLDialogElement)=>void|Promise<void>}} options */
  open({label,html,trigger,onAction=()=>{}}){
   closeRecordReader({restoreFocus:false});opener=trigger||document.activeElement
   const dialog=document.createElement('dialog')
   dialog.className='cc-record-reader pc-dialog'
   dialog.setAttribute('aria-label',label)
   dialog.innerHTML=`<header class="cc-record-toolbar"><span>${esc(label)}</span><button type="button" data-record-close autofocus>关闭</button></header><div class="cc-record-content">${html}</div>`
   element=dialog;active=reader
   dialog.addEventListener('cancel',event=>{event.preventDefault();reader.close()})
   dialog.addEventListener('close',()=>{if(element===dialog)reader.close()})
   dialog.addEventListener('click',async event=>{
    if(event.target.closest?.('[data-record-close]')){reader.close();return}
    if(event.target===dialog){
     const r=dialog.getBoundingClientRect()
     if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom){reader.close();return}
    }
    if(element===dialog)await onAction(event,dialog)
   })
   document.body.append(dialog);dialog.showModal()
   return dialog
  },
 }
 return reader
}
