import {PHONE_ANSWER_MAX_JSON} from '@wechat-cc/protocol'
import type {EntryResult} from '../core/workbench/service'
import type {UploadChunk,UploadState} from '../core/workbench/attachment-uploads'
import type {MattersService,MatterSayInput} from '../core/matters/service'
import {entryErrorStatus,parseEntryInput,type EntryInput,type EntryOptions} from '../core/workbench/task-entry'
import type {NativeContinuePreview} from '../core/workbench/native-adoption'

export type MobileMatterActions=Partial<Pick<MattersService,'permission'|'answer'|'artifactChunk'|'handoff'|'inputReceipt'|'stop'>>
export interface MobileEntryActions {
  entryOptions():EntryOptions
  /** 交办时可选的模型(2026-10-06):手机只给执行者 id 与项目目录 id,路径在电脑上解析。没接 ⇒ 手机不显示模型选择。 */
  entryModels?(input:{providerId:string;projectId?:string}):Promise<unknown>
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
  if(['entry_not_wired','managed_workspace_unavailable','invalid_managed_workspace','workbench_stopping','unavailable_provider','provider_quota_exhausted','quota_handoff_unavailable','network_unprotected'].includes(code))return json({ok:false,error:code},503)
  if(['permission_stale','question_stale','input_stale','input_conflict','input_delivery_busy','workbench_busy','reply_sink_busy','workbench_archived','artifact_changed','restart_confirmation_required','restart_confirmation_stale','external_close_confirmation_required','external_close_confirmation_stale','native_session_busy','native_folder_busy','native_history_changed','quota_handoff_not_needed','quota_handoff_changed'].includes(code))return json({ok:false,error:code},409)
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
  if(url.pathname==='/m/api/matter/input-receipt'){
    if(req.method!=='GET')return json({ok:false,error:'method_not_allowed'},405)
    try{
      const q=url.searchParams,id=q.get('id'),requestId=q.get('requestId')
      if(q.getAll('id').length!==1||q.getAll('requestId').length!==1||[...q.keys()].some(key=>!['id','requestId','t','d','_via'].includes(key))||!id||!ID.test(id)||!requestId||!UUID.test(requestId))throw Error('invalid_request')
      if(!actions?.inputReceipt)throw Error('workbench_not_wired')
      const input=actions.inputReceipt(id,requestId.toLowerCase())
      return input?json({ok:true,input}):json({ok:false,error:'not_found'},404)
    }catch(error){return mobileMatterError(error)}
  }
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

  if(url.pathname==='/m/api/entry/models'){
    if(req.method!=='GET')return json({ok:false,error:'method_not_allowed'},405)
    try{
      const q=url.searchParams,providerId=q.get('providerId'),projectId=q.get('projectId')
      if(q.getAll('providerId').length!==1||q.getAll('projectId').length>1||[...q.keys()].some(k=>!['providerId','projectId','t','d','_via'].includes(k))||!providerId||!/^[a-z][a-z0-9._-]{0,63}$/.test(providerId)||(projectId!==null&&!/^p-[A-Za-z0-9_-]{1,64}$/.test(projectId)))throw Error('invalid_request')
      if(!entry?.entryModels)throw Error('entry_not_wired')
      return json({ok:true,catalog:await entry.entryModels({providerId,...(projectId?{projectId}:{})})})
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
  // 额度用完 ⇒ 交给确认卡上那位继续(spec 2026-10-01-tendhearth-continue-sessions §7-3)。正文恰好三键;按 requestId 幂等。
  if(url.pathname==='/m/api/matter/handoff'){
    if(req.method!=='POST')return json({ok:false,error:'method_not_allowed'},405)
    try{
      let b:unknown
      try{b=await req.json()}catch{throw Error('invalid_request')}
      if(!object(b)||Object.keys(b).some(k=>!['id','requestId','providerId'].includes(k))||typeof b.id!=='string'||!ID.test(b.id)||typeof b.requestId!=='string'||!UUID.test(b.requestId)||typeof b.providerId!=='string'||!/^[a-z][a-z0-9._-]{0,63}$/.test(b.providerId))throw Error('invalid_request')
      if(!actions?.handoff)throw Error('workbench_not_wired')
      return json({ok:true,...await actions.handoff(b.id,{requestId:b.requestId,providerId:b.providerId},'phone')})
    }catch(error){return mobileMatterError(error)}
  }
  // 停下正在跑的这一轮(2026-10-06):正文恰好 id + runId;runId 必须是手机看到的那一轮。
  if(url.pathname==='/m/api/matter/stop'){
    if(req.method!=='POST')return json({ok:false,error:'method_not_allowed'},405)
    try{
      let b:unknown
      try{b=await req.json()}catch{throw Error('invalid_request')}
      if(!object(b)||Object.keys(b).some(k=>k!=='id'&&k!=='runId')||typeof b.id!=='string'||!ID.test(b.id)||typeof b.runId!=='string'||!UUID.test(b.runId))throw Error('invalid_request')
      if(!actions?.stop)throw Error('workbench_not_wired')
      await actions.stop(b.id,b.runId.toLowerCase())
      return json({ok:true})
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
      if((b.answers!==null&&!object(b.answers))||JSON.stringify(b.answers).length>PHONE_ANSWER_MAX_JSON)throw Error('invalid_answer')
      if(!actions?.answer)throw Error('workbench_not_wired')
      actions.answer(b.id,b.runId,b.requestId,b.answers)
    }
    return json({ok:true})
  }catch(error){return mobileMatterError(error)}
}

/** 手机「接着做」电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions §4.3)。直接调核心服务,不经 HTTP 自调。 */
export interface MobileSessionContinueActions {
  preview(key:string):Promise<NativeContinuePreview>
  adopt(key:string):Promise<{taskId:string;created:boolean}>
}
export const PHONE_CONTINUE_BUDGET_MS=10_000
export const PHONE_CONTINUE_MAX_INFLIGHT=4
const previewInflight=new WeakMap<object,Map<string,Promise<NativeContinuePreview>>>()
// 已超出预算、但底层扫描还没落定的键:仍留在 previewInflight 里供同键合并(不另起扫描),只是不再占名额。
const previewExpired=new WeakMap<object,Set<string>>()
const sessionKey=(v:unknown):string|null=>typeof v==='string'&&v.length>0&&v.length<=2048?v:null
/** 预览是读:未知失败一律 503 unavailable(不是 500 → 客户端的 unknown)。 */
function previewError(error:unknown):Response {
  const code=error instanceof Error?error.message:''
  if(code==='native_history_unsupported')return json({ok:false,error:'unsupported'},404)
  if(code==='invalid_native_history_key')return json({ok:false,error:'invalid'},400)
  return json({ok:false,error:'unavailable'},503)
}
function adoptError(error:unknown):Response {
  const code=error instanceof Error?error.message:''
  if(code==='native_history_unsupported')return json({ok:false,error:'unsupported'},404)
  if(code==='invalid_native_history_key')return json({ok:false,error:'invalid'},400)
  if(['native_history_empty','native_session_already_managed'].includes(code))return json({ok:false,error:code},409)
  return mobileMatterError(error)
}
/**
 * GET ?key= 只看能不能接(不缓存:「正在跑」不能晚知道;10 秒预算数值同 /m/api/session,但在途池是这条路由自己的、不共用,R9);
 * 同键在途合并成一次扫描(超时后、扫描落定前也合并,挂住的扫描不会越堆越多),超时即放名额(迟到结果丢弃)。POST 接管不设预算:它幂等,中途切断反而丢结果。
 * POST {key} 幂等地接成一件事,成功后登记手机露面。回包不含文件夹路径与原生 id(D13)。
 * 路径字面量必须写成 `url.pathname === '…'`:scripts/phone-routes.guard.test.ts 只抓这个形状。
 */
export async function mobileSessionContinueRoute(actions:MobileSessionContinueActions|undefined,url:URL,req:Request,seen?:(matterId:string)=>void,opts:{budgetMs?:number;maxInflight?:number}={}):Promise<Response|null>{
  const isContinue=url.pathname==='/m/api/session/continue'
  if(!isContinue)return null
  if(req.method!=='GET'&&req.method!=='POST')return json({ok:false,error:'method_not_allowed'},405)
  if(!actions)return json({ok:false,error:'sessions_not_wired'},503)
  if(req.method==='GET'){
    const keys=url.searchParams.getAll('key'),key=keys.length===1?sessionKey(keys[0]):null
    if(!key)return json({ok:false,error:'invalid'},400)
    let flights=previewInflight.get(actions)
    if(!flights){flights=new Map();previewInflight.set(actions,flights)}
    let expired=previewExpired.get(actions)
    if(!expired){expired=new Set();previewExpired.set(actions,expired)}
    // 同键在途(含已超时还挂着的)⇒ 加入同一次扫描,不另起;名额 = 还在预算内的在途键数。
    let work=flights.get(key)
    if(!work){
      if(flights.size-expired.size>=(opts.maxInflight??PHONE_CONTINUE_MAX_INFLIGHT))return json({ok:false,error:'unavailable'},503)
      const mine:Promise<NativeContinuePreview>=Promise.resolve().then(()=>actions.preview(key))
      work=mine;flights.set(key,mine)
      const drop=()=>{if(flights!.get(key)===mine){flights!.delete(key);expired!.delete(key)}}
      mine.then(drop,drop)
    }
    const shared=work,ex=expired
    let timer:ReturnType<typeof setTimeout>|undefined
    try{
      // 超时:预览只读,放掉名额(记为已超时,扫描落定前同键重试仍并进来),迟到的结果丢弃(不缓存、不送达)。
      const p=await Promise.race([shared,new Promise<never>((_,rej)=>{timer=setTimeout(()=>{ex.add(key);rej(new Error('budget_exceeded'))},opts.budgetMs??PHONE_CONTINUE_BUDGET_MS)})])
      return json({ok:true,state:p.state,provider:p.providerId,project:p.project,mode:p.mode,matterId:p.taskId})
    }catch(error){return previewError(error)}
    finally{if(timer)clearTimeout(timer)}
  }
  let body:unknown
  try{body=await req.json()}catch{return json({ok:false,error:'invalid'},400)}
  if(!object(body)||Object.keys(body).some(k=>k!=='key'))return json({ok:false,error:'invalid'},400)
  const key=sessionKey(body.key)
  if(!key)return json({ok:false,error:'invalid'},400)
  try{
    const r=await actions.adopt(key)
    try{seen?.(r.taskId)}catch{/* 只是露面登记 */}
    return json({ok:true,matterId:r.taskId,created:r.created})
  }catch(error){return adoptError(error)}
}
