import type {EntryResult} from '../core/workbench/service'
import type {UploadChunk,UploadState} from '../core/workbench/attachment-uploads'
import type {MattersService,MatterSayInput} from '../core/matters/service'
import {entryErrorStatus,parseEntryInput,type EntryInput,type EntryOptions} from '../core/workbench/task-entry'

export type MobileMatterActions=Partial<Pick<MattersService,'permission'|'answer'|'artifactChunk'>>
export interface MobileEntryActions {
  entryOptions():EntryOptions
  createEntry(input:EntryInput):EntryResult
  entryReceipt(requestId:string):EntryResult|null
}
export interface MobileUploadActions {chunk(input:UploadChunk):UploadState;status(input:{id:string;draftId:string}):UploadState;discard(input:{id:string;draftId:string}):void}
const ID=/^[a-f0-9]{8}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const SHA=/^[a-f0-9]{64}$/
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const json=(body:object,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})
export function mobileMatterError(error:unknown):Response {
  const code=error instanceof Error?error.message:'internal'
  const entryStatus=entryErrorStatus(code)
  if(entryStatus!==undefined)return json({ok:false,error:code},entryStatus)
  if(code==='upload_invalid_content')return json({ok:false,error:code},400)
  if(['matter_not_found','not_found'].includes(code))return json({ok:false,error:'matter_not_found'},404)
  if(code==='upload_not_found')return json({ok:false,error:code},404)
  if(['upload_discarded','upload_expired'].includes(code))return json({ok:false,error:code},410)
  if(['attachment_storage_limit','attachment_limit','upload_limit','upload_unfinished_limit','invalid_attachment_size'].includes(code))return json({ok:false,error:code},413)
  if(['upload_conflict','upload_changed','upload_offset','attachment_in_use'].includes(code))return json({ok:false,error:code},409)
  if(code==='invalid_entry_owner')return json({ok:false,error:code},403)
  if(['creation_conflict','managed_workspace_changed','attachment_scope','attachment_conflict'].includes(code))return json({ok:false,error:code},409)
  if(['entry_not_wired','managed_workspace_unavailable','invalid_managed_workspace','workbench_stopping','unavailable_provider','provider_quota_exhausted'].includes(code))return json({ok:false,error:code},503)
  if(['permission_stale','question_stale','input_stale','input_conflict','input_delivery_busy','workbench_busy','reply_sink_busy','workbench_archived','artifact_changed','restart_confirmation_required','restart_confirmation_stale','external_close_confirmation_required','external_close_confirmation_stale'].includes(code))return json({ok:false,error:code},409)
  if(code.endsWith('_not_wired')||code==='input_storage_unavailable')return json({ok:false,error:'unavailable'},503)
  if(code.startsWith('invalid_')||['matter_task_required','matter_say_unsupported'].includes(code))return json({ok:false,error:code},400)
  return json({ok:false,error:'unavailable'},500)
}
export function mobileSayInput(body:Record<string,unknown>):MatterSayInput|undefined {
  if(Object.keys(body).some(key=>!['id','text','requestId','runId','draftId','attachmentIds'].includes(key)))throw Error('invalid_request')
  if(body.requestId===undefined&&body.runId===undefined&&body.draftId===undefined&&body.attachmentIds===undefined)return undefined
  if(typeof body.requestId!=='string'||!UUID.test(body.requestId)||(body.runId!==undefined&&(typeof body.runId!=='string'||!UUID.test(body.runId)))||(body.draftId!==undefined&&(typeof body.draftId!=='string'||!UUID.test(body.draftId))))throw Error('invalid_request')
  let ids:string[]|undefined
  if(body.attachmentIds!==undefined){
    if(!Array.isArray(body.attachmentIds)||body.attachmentIds.length>8||body.attachmentIds.some(id=>typeof id!=='string'||!UUID.test(id)))throw Error('invalid_attachment')
    ids=body.attachmentIds.map(id=>id.toLowerCase());if(new Set(ids).size!==ids.length)throw Error('invalid_attachment')
  }
  return {requestId:body.requestId.toLowerCase(),...(body.runId!==undefined?{runId:(body.runId as string).toLowerCase()}:{}),...(body.draftId!==undefined?{draftId:(body.draftId as string).toLowerCase()}:{}),...(ids?{attachmentIds:ids}:{})}
}
/** Called only inside settings-panel's existing authenticated-device boundary. */
export async function mobileWorkbenchRoute(actions:MobileMatterActions|undefined,url:URL,req:Request,entry?:MobileEntryActions,uploads?:MobileUploadActions):Promise<Response|null>{
  const uploadOperation=url.pathname==='/m/api/attachment/chunk'?'chunk':url.pathname==='/m/api/attachment/upload'?'status':url.pathname==='/m/api/attachment/discard'?'discard':null
  if(uploadOperation){
    if(req.method!==(uploadOperation==='status'?'GET':'POST'))return json({ok:false,error:'method_not_allowed'},405)
    try{
      if(!uploads)throw Error('uploads_not_wired')
      if(uploadOperation==='status'){
        const q=url.searchParams
        if(q.getAll('id').length!==1||q.getAll('draftId').length!==1||[...q.keys()].some(key=>!['id','draftId','t','d','_via'].includes(key)))throw Error('invalid_upload_chunk')
        return json({ok:true,...uploads.status({id:q.get('id')!,draftId:q.get('draftId')!})})
      }
      let body:unknown;try{body=await req.json()}catch{throw Error('invalid_upload_chunk')}
      if(uploadOperation==='chunk')return json({ok:true,...uploads.chunk(body as UploadChunk)})
      uploads.discard(body as {id:string;draftId:string});return json({ok:true})
    }catch(error){return mobileMatterError(error)}
  }

  const entryOperation=url.pathname==='/m/api/entry/options'?'options':url.pathname==='/m/api/matter/create'?'create':url.pathname==='/m/api/matter/create-receipt'?'receipt':null
  if(entryOperation){
    if(req.method!==(entryOperation==='create'?'POST':'GET'))return json({ok:false,error:'method_not_allowed'},405)
    try{
      if(!entry)throw Error('entry_not_wired')
      if(entryOperation==='options')return json({ok:true,...entry.entryOptions()})
      if(entryOperation==='create'){
        let body:unknown;try{body=await req.json()}catch{throw Error('invalid_entry')}
        return json({ok:true,...entry.createEntry(parseEntryInput(body))},202)
      }
      const requestId=url.searchParams.get('requestId')
      if(!requestId||!UUID.test(requestId)||url.searchParams.getAll('requestId').length!==1)throw Error('invalid_request_id')
      const result=entry.entryReceipt(requestId.toLowerCase());if(!result)throw Error('not_found')
      return json({ok:true,...result})
    }catch(error){return mobileMatterError(error)}
  }
  const operation=url.pathname==='/m/api/matter/permission'?'permission':url.pathname==='/m/api/matter/answer'?'answer':url.pathname==='/m/api/matter/artifact'?'artifact':null
  if(!operation)return null
  if(req.method!==(operation==='artifact'?'GET':'POST'))return json({ok:false,error:'method_not_allowed'},405)
  try{
    if(operation==='artifact'){
      const q=url.searchParams,id=q.get('id'),artifactId=q.get('artifactId'),sha256=q.get('sha256'),offset=q.get('offset'),length=q.get('length')
      if(['id','artifactId','sha256','offset'].some(k=>q.getAll(k).length!==1)||q.getAll('length').length>1||!id||!ID.test(id)||!artifactId||!UUID.test(artifactId)||!sha256||!SHA.test(sha256)||offset===null||!/^\d+$/.test(offset)||(length!==null&&!/^\d+$/.test(length)))throw Error('invalid_request')
      if(!actions?.artifactChunk)throw Error('workbench_not_wired')
      return json({ok:true,...actions.artifactChunk(id,{artifactId,sha256,offset:Number(offset),...(length!==null?{length:Number(length)}:{})})})
    }
    let b:unknown
    try{b=await req.json()}catch{throw Error('invalid_request')}
    if(!object(b)||typeof b.id!=='string'||!ID.test(b.id)||typeof b.runId!=='string'||!UUID.test(b.runId)||typeof b.requestId!=='string'||!UUID.test(b.requestId))throw Error('invalid_request')
    if(operation==='permission'){
      if(b.decision!=='allow'&&b.decision!=='deny')throw Error('invalid_decision')
      if(!actions?.permission)throw Error('workbench_not_wired')
      actions.permission(b.id,b.runId,b.requestId,b.decision)
    }else{
      if((b.answers!==null&&!object(b.answers))||JSON.stringify(b.answers).length>20_000)throw Error('invalid_answer')
      if(!actions?.answer)throw Error('workbench_not_wired')
      actions.answer(b.id,b.runId,b.requestId,b.answers)
    }
    return json({ok:true})
  }catch(error){return mobileMatterError(error)}
}
