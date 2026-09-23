import type {MattersService,MatterSayInput} from '../core/matters/service'

export type MobileMatterActions=Partial<Pick<MattersService,'permission'|'answer'|'artifactChunk'>>
const ID=/^[a-f0-9]{8}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const SHA=/^[a-f0-9]{64}$/
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const json=(body:object,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})
export function mobileMatterError(error:unknown):Response {
  const code=error instanceof Error?error.message:'internal'
  if(['matter_not_found','not_found'].includes(code))return json({ok:false,error:'matter_not_found'},404)
  if(['permission_stale','question_stale','input_stale','input_conflict','input_delivery_busy','workbench_busy','reply_sink_busy','workbench_archived','artifact_changed','restart_confirmation_required','restart_confirmation_stale','external_close_confirmation_required','external_close_confirmation_stale'].includes(code))return json({ok:false,error:code},409)
  if(code.endsWith('_not_wired')||code==='input_storage_unavailable')return json({ok:false,error:'unavailable'},503)
  if(code.startsWith('invalid_')||['matter_task_required','matter_say_unsupported'].includes(code))return json({ok:false,error:code},400)
  return json({ok:false,error:'unavailable'},500)
}
export function mobileSayInput(body:Record<string,unknown>):MatterSayInput|undefined {
  if(body.requestId===undefined&&body.runId===undefined)return undefined
  if(typeof body.requestId!=='string'||!UUID.test(body.requestId)||(body.runId!==undefined&&(typeof body.runId!=='string'||!UUID.test(body.runId))))throw Error('invalid_request')
  return {requestId:body.requestId,...(body.runId!==undefined?{runId:body.runId as string}:{})}
}
/** Called only inside settings-panel's existing authenticated-device boundary. */
export async function mobileWorkbenchRoute(actions:MobileMatterActions|undefined,url:URL,req:Request):Promise<Response|null>{
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
