// @ts-check
import {isThumbnailImage} from './workbench-thumbnails.js'
/** @typedef {{id:string,name:string,mime:string,size:number,sha256:string}} Attachment */
/** @typedef {Attachment & {status:'uploading'|'ready'|'failed',error?:string}} DraftAttachment */
/** @typedef {import('./workbench-window-state.js').Draft} Draft */
const esc = (/** @type {unknown} */ value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c] ?? c)
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
/** @param {unknown} value @param {boolean} [recover] @returns {DraftAttachment[]} */
export function parseDraftAttachments(value,recover=false) {
  if (!Array.isArray(value)) return []
  return value.slice(0,8).filter(a => a && uuid.test(a.id) && typeof a.name==='string' && a.name.length<=255 && typeof a.mime==='string' && a.mime.length<=128 && Number.isSafeInteger(a.size) && a.size>=0 && a.size<=8*1024*1024 && typeof a.sha256==='string' && ['uploading','ready','failed'].includes(a.status) && (a.status!=='ready'||/^[a-f0-9]{64}$/.test(a.sha256))).map(a => ({id:a.id,name:a.name,mime:a.mime,size:a.size,sha256:a.sha256,status:recover&&a.status==='uploading'?'failed':a.status,...(recover&&a.status==='uploading'?{error:'上传中断，请移除后重新选择。'}:typeof a.error==='string'?{error:a.error.slice(0,200)}:{})}))
}
/** @param {Array<Attachment>|undefined} attachments */
export const attachmentSignature = attachments => JSON.stringify((attachments??[]).map(a=>[a.id,a.sha256]))
/** @param {Blob} blob @returns {Promise<string>} */
function encodeFile(blob) {
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]??'');reader.onerror=()=>reject(reader.error??Error('read_failed'));reader.readAsDataURL(blob)})
}
/** @param {{drafts:ReturnType<typeof import('./workbench-window-state.js').createWorkbenchDraftStore>,invokeWorkbenchApi:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>,encode?:(file:File)=>Promise<string>,changed?:(scope:string)=>void,preview?:(id:string,file:File)=>void,removePreview?:(id:string)=>void}} deps */
export function createWorkbenchAttachments(deps) {
  /** @type {Map<string,string>} */ const errors=new Map()
  /** @type {Map<string,number>} */ const reserved=new Map()
  const notify=(/** @type {string} */ scope)=>deps.changed?.(scope)
  const discard=(/** @type {string} */ id,/** @type {string|undefined} */ draftId)=>{if(draftId)void deps.invokeWorkbenchApi('POST','/v1/workbench/discard-attachment',{id,draftId}).catch(()=>{})}
  return {
    error:(/** @type {string} */ scope)=>errors.get(scope)??'',
    ready:(/** @type {string} */ scope)=>(deps.drafts.get(scope).attachments??[]).every(a=>a.status==='ready'),
    /** @param {string} scope @param {string} id */
    remove(scope,id){deps.removePreview?.(id);const draft=deps.drafts.get(scope),removed=draft.attachments?.find(a=>a.id===id);draft.attachments=(draft.attachments??[]).filter(a=>a.id!==id);deps.drafts.set(scope,draft);errors.delete(scope);if(removed&&removed.status!=='uploading'&&!reserved.has(id))discard(id,draft.draftId);notify(scope)},
    /** Keep a submitted snapshot available until its request has been acknowledged.
     * @param {string} scope @param {Draft} draft */
    reserve(scope,draft){const ids=(draft.attachments??[]).map(a=>a.id);ids.forEach(id=>reserved.set(id,(reserved.get(id)??0)+1));let released=false;return()=>{if(released)return;released=true;for(const id of ids){const remaining=(reserved.get(id)??1)-1;if(remaining){reserved.set(id,remaining);continue}reserved.delete(id);if(!deps.drafts.get(scope).attachments?.some(a=>a.id===id))discard(id,draft.draftId)}}},
    /** @param {string} scope @param {File[]} files */
    async add(scope,files) {
      if(!files.length)return
      const draft=deps.drafts.get(scope),current=draft.attachments??[]
      let error=current.length+files.length>8?'每次最多添加 8 个附件。':current.reduce((n,a)=>n+a.size,0)+files.reduce((n,f)=>n+f.size,0)>24*1024*1024?'附件总大小最多 24 MiB。':''
      for(const file of files) if(!error && file.size>(file.type.startsWith('image/')?5:8)*1024*1024)error=`${file.name} 超过${file.type.startsWith('image/')?'图片 5 MiB':'文件 8 MiB'}限制。`
      if(error){errors.set(scope,error);notify(scope);return}
      errors.delete(scope)
      const draftId=draft.draftId??crypto.randomUUID()
      const pending=files.map(file=>({id:crypto.randomUUID(),name:file.name||'粘贴的图片',mime:file.type||'application/octet-stream',size:file.size,sha256:'',status:/** @type {const} */('uploading')}))
      pending.forEach((entry,index)=>files[index]&&deps.preview?.(entry.id,files[index]))
      deps.drafts.set(scope,{...draft,draftId,attachments:[...current,...pending]});notify(scope)
      await Promise.all(files.map(async(file,index)=>{
        const entry=/** @type {DraftAttachment} */(pending[index])
        /** @type {DraftAttachment} */ let next
        try {
          const base64=await(deps.encode??encodeFile)(file)
          const result=/** @type {{attachment:Attachment}} */(await deps.invokeWorkbenchApi('POST','/v1/workbench/attachment',{id:entry.id,draftId,...(scope.startsWith('task:')?{taskId:scope.slice(5)}:{}),name:entry.name,mime:entry.mime,base64}))
          const valid=parseDraftAttachments([{...result?.attachment,status:'ready'}])[0]
          if(!valid||valid.id!==entry.id||valid.size!==entry.size)throw Error('unconfirmed_upload')
          next=valid
        }catch(error){
          const code=error instanceof Error?error.message:String(error)
          const messages=/** @type {Record<string,string>} */({invalid_attachment:'此文件格式或内容暂不支持，请换一个文件。',invalid_attachment_size:'文件大小不符合限制，请换一个较小的文件。',attachment_limit:'附件数量或总大小超过限制，请移除部分附件。',attachment_storage_limit:'附件暂存空间已满，请先移除未发送的附件。',attachment_platform_unsupported:'当前系统暂不支持上传附件。'})
          next={...entry,status:'failed',error:messages[code]??'未能上传，请移除后重新选择。'}
        }
        const latest=deps.drafts.get(scope)
        if(latest.draftId!==draftId||!latest.attachments?.some(a=>a.id===entry.id)){discard(entry.id,draftId);return}
        latest.attachments=latest.attachments.map(a=>a.id===entry.id?next:a);deps.drafts.set(scope,latest);notify(scope)
      }))
    },
  }
}
/** @param {Pick<Draft,'attachments'>} [draft] @param {string} [error] */
export function renderAttachmentComposer(draft={},error='') {
  return `<div class="wb-compose-attachments"><div class="wb-attachment-chips">${(draft.attachments??[]).map(a=>`<span class="wb-attachment-chip" data-upload-status="${a.status}">${isThumbnailImage(a.mime)?`<img class="wb-draft-thumbnail" data-draft-thumbnail="${esc(a.id)}" alt="${esc(a.name)}" hidden>`:''}<span title="${esc(a.name)}">${esc(a.name)}</span><small>${a.status==='uploading'?'上传中…':a.status==='failed'?'上传失败':`${Math.max(1,Math.ceil(a.size/1024))} KB`}</small><button type="button" class="wb-new" data-action="remove-attachment" data-attachment-id="${esc(a.id)}" aria-label="移除 ${esc(a.name)}">×</button>${a.error?`<small class="wb-attachment-error">${esc(a.error)}</small>`:''}</span>`).join('')}</div><button type="button" class="wb-new wb-attach-button" data-action="choose-attachments">＋ 添加附件</button><input id="wb-attachment-files" type="file" multiple hidden aria-label="选择附件">${error?`<p class="wb-interaction-error" role="alert">${esc(error)}</p>`:''}</div>`
}
/** @param {string} taskId @param {Attachment[]|undefined} attachments */
export function renderMessageAttachments(taskId,attachments) {
  if(!attachments?.length)return ''
  return `<div class="wb-message-attachments">${attachments.map(a=>`<span class="wb-attachment-chip ${isThumbnailImage(a.mime)?'wb-image-attachment':''}">${isThumbnailImage(a.mime)?`<button type="button" class="wb-thumbnail" data-action="preview-input-attachment" data-owner-task="${esc(taskId)}" data-attachment-id="${esc(a.id)}" data-thumbnail-id="${esc(a.id)}" aria-label="查看 ${esc(a.name)}"><img alt="${esc(a.name)}" hidden><small>正在加载图片…</small></button>`:''}<button type="button" class="wb-new" data-action="preview-input-attachment" data-owner-task="${esc(taskId)}" data-attachment-id="${esc(a.id)}">${esc(a.name)}</button><small>${Math.max(1,Math.ceil(a.size/1024))} KB</small><button type="button" class="wb-new" data-action="download-input-attachment" data-owner-task="${esc(taskId)}" data-attachment-id="${esc(a.id)}" aria-label="下载 ${esc(a.name)}">下载</button></span>`).join('')}</div>`
}

/** @param {string} taskId @param {Array<{id:string,name:string,mime:string}>} artifacts */
export function renderImageArtifacts(taskId,artifacts){
  return `<div class="wb-message-attachments">${artifacts.filter(a=>isThumbnailImage(a.mime)).map(a=>`<button class="wb-thumbnail wb-result-thumbnail" type="button" data-action="preview-image-artifact" data-artifact-id="${esc(a.id)}" data-thumbnail-id="${esc(a.id)}" data-thumbnail-kind="artifact" data-owner-task="${esc(taskId)}" aria-label="查看成果 ${esc(a.name)}"><img alt="${esc(a.name)}" hidden><small>正在加载图片…</small><span>${esc(a.name)}</span></button>`).join('')}</div>`
}
