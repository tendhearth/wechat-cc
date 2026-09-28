/**
 * attachments 域:材料的作用域判定 / 选择 / 合并 / handoff 校验 / 分块上传句柄,以及 6 个 public 入口。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 2 项);只认 ctx。
 * 主人身份只从 ctx.deps.ownerChatId 取;停机闸走 ctx.ensureAccepting(service.ts 定义一次)。
 */
import type { Attachment } from '../attachments'
import type { AttachmentSelection } from '../handoff'
import type { EntryContext } from '../task-entry'
import type { WorkbenchStore } from '../store'
import type { ServiceCtx } from './ctx'
import type { InputMaterials } from './types'

type Uploads = ReturnType<WorkbenchStore['attachmentUploads']>

export interface AttachmentsDomain {
  /** 分块上传句柄:懒建、只建一次(materialUploads 那个 let 随之进来)。 */
  uploads(): Uploads
  attachmentScope(): {ownerKey:string;allowLegacyUnbound:boolean} | undefined
  strictAttachmentScope(taskId?:string): {ownerKey:string}
  continuationAttachmentScope(taskId:string,ids:unknown): {ownerKey:string} | undefined
  selectAttachments(input?:InputMaterials,taskId?:string,policy?:'owner'): Attachment[]
  combinedAttachments(current:readonly Attachment[],previous?:readonly Attachment[]): Attachment[]
  handoffAttachments(refs:AttachmentSelection[],expectedTaskId:string): Attachment[]
  uploadAttachment(input:Parameters<WorkbenchStore['attachments']['upload']>[0]): ReturnType<WorkbenchStore['attachments']['upload']>
  uploadAttachmentChunk(input:Parameters<Uploads['chunk']>[0],context:EntryContext): ReturnType<Uploads['chunk']>
  attachmentUploadStatus(input:{id:string;draftId:string},context:EntryContext): ReturnType<Uploads['status']>
  discardAttachmentUpload(input:{id:string;draftId:string},context:EntryContext): ReturnType<Uploads['discard']>
  readAttachment(taskId:string,id:string): ReturnType<WorkbenchStore['attachments']['read']>
  discardAttachment(id:string,draftId:string): ReturnType<WorkbenchStore['attachments']['discard']> | ReturnType<Uploads['discard']>
}

export function makeAttachmentsDomain(ctx:ServiceCtx):AttachmentsDomain {
  const { store } = ctx
  let materialUploads:ReturnType<typeof store.attachmentUploads>|undefined
  const uploads=()=>materialUploads??=store.attachmentUploads({stateDir:ctx.stateDir,ownerChatId:ctx.deps.ownerChatId,onTransaction:event=>ctx.log?.('attachment-upload',`${event.operation} lock_ms=${event.durationMs.toFixed(1)}`)})
  const attachmentScope=()=>{const ownerKey=ctx.deps.ownerChatId();return ownerKey?{ownerKey,allowLegacyUnbound:true}:undefined}
  const strictAttachmentScope=(taskId?:string)=>{
    const ownerKey=ctx.deps.ownerChatId()
    if(!ownerKey)throw Error('invalid_entry_owner')
    if(taskId&&store.get(taskId).ownerChatId!==ownerKey)throw Error('attachment_scope')
    return {ownerKey}
  }
  const continuationAttachmentScope=(taskId:string,ids:unknown)=>{
    const scope=strictAttachmentScope()
    // Configured owners may continue pre-owner tasks with text; this never claims materials or changes ownership.
    if(Array.isArray(ids)&&ids.length===0&&store.get(taskId).ownerChatId===null)return undefined
    if(store.get(taskId).ownerChatId!==scope.ownerKey)throw Error('attachment_scope')
    return scope
  }
  const selectAttachments=(input:InputMaterials={},taskId?:string,policy?:'owner')=>{
    const ids=input.attachmentIds??[]
    const scope=policy&&taskId?continuationAttachmentScope(taskId,ids):policy?strictAttachmentScope():input.attachmentIds?.length?attachmentScope():undefined
    return store.attachments.select(ids,taskId,input.draftId,scope)
  }
  function combinedAttachments(current:readonly Attachment[],previous:readonly Attachment[]=[]){
    const unique=new Map<string,Attachment>()
    for(const a of [...previous,...current])unique.set(a.id,{...a})
    const refs=[...unique.values()]
    if(refs.length>8||refs.reduce((n,a)=>n+a.size,0)>24*1024*1024)throw Error('invalid_attachment_context_limit')
    return refs
  }
  function handoffAttachments(refs:AttachmentSelection[],expectedTaskId:string){
    const files=store.attachments.select(refs.map(a=>a.attachmentId),expectedTaskId)
    for(let i=0;i<refs.length;i++){
      if(refs[i]!.taskId!==expectedTaskId||refs[i]!.sha256!==files[i]!.sha256)throw Error('invalid_handoff_attachment')
      store.attachments.read(expectedTaskId,refs[i]!.attachmentId,ctx.stateDir)
    }
    return files
  }

  return {
    uploads,attachmentScope,strictAttachmentScope,continuationAttachmentScope,selectAttachments,combinedAttachments,handoffAttachments,
    uploadAttachment(input:Parameters<typeof store.attachments.upload>[0]){ctx.ensureAccepting();if(input.taskId&&store.get(input.taskId).archivedAt!==null)throw Error('workbench_archived');return store.attachments.upload(input,ctx.stateDir,ctx.deps.ownerChatId()?strictAttachmentScope(input.taskId):undefined)},
    uploadAttachmentChunk(input:Parameters<ReturnType<typeof store.attachmentUploads>['chunk']>[0],context:EntryContext){ctx.ensureAccepting();return uploads().chunk(input,context)},
    attachmentUploadStatus(input:{id:string;draftId:string},context:EntryContext){return uploads().status(input,context)},
    discardAttachmentUpload(input:{id:string;draftId:string},context:EntryContext){return uploads().discard(input,context)},
    readAttachment(taskId:string,id:string){store.get(taskId);return store.attachments.read(taskId,id,ctx.stateDir)},
    discardAttachment(id:string,draftId:string){if(store.uploadRequestExists(id))return uploads().discard({id,draftId},{...strictAttachmentScope(),surface:'desktop'});return store.attachments.discard(id,draftId,attachmentScope())},
  }
}
