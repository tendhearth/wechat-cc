import {validateHandoffInput,type HandoffInput} from '../../core/workbench/handoff'
import {nativeImportInput,type NativeImportInput} from '../../core/workbench/native-adoption'
import { decodeNativeHistoryKey, normalizeHistoryList, normalizeHistoryRead, type NativeHistoryProvider } from '../../core/workbench/native-history'
import { isAbsolute } from 'node:path'
import type { WorkbenchListQuery } from '../../core/workbench/store'
import type {InputMaterials} from '../../core/workbench/service'
import {isWorkbenchProviderId} from '../../core/workbench/executor-capabilities'
import type { InternalApiDeps, RouteHandler, RouteTable } from './types'

const TASK_ID = /^[a-f0-9]{8}$/
const ARTIFACT_ID = /^[a-f0-9-]{8,64}$/
const SHA256 = /^[a-f0-9]{64}$/
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const NATIVE_HISTORY_PROVIDERS = new Set<NativeHistoryProvider>(['claude', 'codex'])
const isNativeHistoryProvider=(value:string|null):value is NativeHistoryProvider=>value!==null&&NATIVE_HISTORY_PROVIDERS.has(value as NativeHistoryProvider)

type JsonObject = Record<string, unknown>

function objectBody(body: unknown): JsonObject | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as JsonObject : null
}

function invalid(): ReturnType<RouteHandler> {
  return { status: 400, body: { error: 'invalid_request' } }
}
function materials(value:JsonObject):InputMaterials|null{
  if(value.draftId!==undefined&&(typeof value.draftId!=='string'||!REQUEST_ID.test(value.draftId)))return null
  if(value.attachmentIds!==undefined&&(!Array.isArray(value.attachmentIds)||value.attachmentIds.length>8||value.attachmentIds.some(id=>typeof id!=='string'||!REQUEST_ID.test(id))||new Set(value.attachmentIds).size!==value.attachmentIds.length))return null
  return {...(value.draftId!==undefined?{draftId:value.draftId as string}:{}),...(value.attachmentIds!==undefined?{attachmentIds:value.attachmentIds as string[]}: {})}
}
const execution=(value:JsonObject):{execution?:unknown}=>Object.hasOwn(value,'execution')?{execution:value.execution}:{}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code
  return err instanceof Error ? err.message : ''
}

function mappedError(err: unknown): ReturnType<RouteHandler> {
  const code = errorCode(err)
  if(['model_catalog_unavailable','model_catalog_invalid'].includes(code))return{status:503,body:{error:code}}
  if(/^execution_.+_(unsupported|unknown)$/.test(code))return{status:400,body:{error:code}}
  if(code==='execution_conflict')return{status:409,body:{error:code}}
  if(['attachment_limit','attachment_storage_limit','invalid_attachment_size','request_body_too_large'].includes(code))return{status:413,body:{error:code}}
  if(['attachment_conflict','attachment_changed'].includes(code))return{status:409,body:{error:code}}
  if(code==='attachment_scope')return{status:404,body:{error:'not_found'}}
  if(code==='attachment_platform_unsupported')return{status:422,body:{error:code}}
  if(['workbench_attachments_unsupported','workbench_execution_unsupported','workbench_resume_unsupported'].includes(code))return{status:422,body:{error:code}}
  if (['input_stale','input_conflict','input_delivery_busy','question_stale','input_limit'].includes(code))return{status:409,body:{error:code}}
  if (code === 'invalid_question'||code === 'invalid_answer')return{status:400,body:{error:code}}
  if (code === 'workbench_archived' || code === 'workbench_busy' || code === 'artifact_changed' || code === 'permission_stale' || code === 'restart_confirmation_required' || code === 'restart_confirmation_stale') return { status: 409, body: { error: code } }
  if (['handoff_changed','native_history_changed','native_session_already_managed','native_session_busy','native_session_identity_mismatch','external_close_confirmation_required','external_close_confirmation_stale'].includes(code))return{status:409,body:{error:code}}
  if(code==='handoff_artifact_unsupported')return{status:422,body:{error:code}}
  if(code==='native_import_too_large')return{status:400,body:{error:code}}
  if (code === 'native_history_unsupported') return {status:422,body:{error:code}}
  if (code === 'native_history_unavailable') return {status:503,body:{error:code}}
  if (code === 'not_found') return { status: 404, body: { error: code } }
  if (code === 'unavailable_provider') return { status: 422, body: { error: code } }
  if (code.startsWith('invalid_')) return { status: 400, body: { error: code } }
  return { status: 500, body: { error: 'internal' } }
}

export function workbenchRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/workbench/models':async query=>{
      const providerId=query.get('providerId'),path=query.get('path')
      if(query.getAll('providerId').length!==1||query.getAll('path').length!==1||!isWorkbenchProviderId(providerId)||!path||path.length>4096||path.includes('\0')||!isAbsolute(path))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:200,body:{catalog:await deps.workbench.modelCatalog(providerId,path)}}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/attachment':async(_query,body)=>{
      const value=objectBody(body)
      if(!value||typeof value.id!=='string'||!REQUEST_ID.test(value.id)||typeof value.draftId!=='string'||!REQUEST_ID.test(value.draftId)||typeof value.name!=='string'||typeof value.mime!=='string'||typeof value.base64!=='string'||(value.taskId!==undefined&&(typeof value.taskId!=='string'||!TASK_ID.test(value.taskId))))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:200,body:{attachment:deps.workbench.uploadAttachment({id:value.id,draftId:value.draftId,name:value.name,mime:value.mime,base64:value.base64,...(value.taskId?{taskId:value.taskId as string}:{})})}}}catch(error){return mappedError(error)}
    },
    'GET /v1/workbench/attachment':async query=>{
      const taskId=query.get('taskId'),id=query.get('id')
      if(query.getAll('taskId').length!==1||query.getAll('id').length!==1||!taskId||!TASK_ID.test(taskId)||!id||!REQUEST_ID.test(id))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:200,body:deps.workbench.readAttachment(taskId,id)}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/discard-attachment':async(_query,body)=>{
      const value=objectBody(body)
      if(!value||typeof value.id!=='string'||!REQUEST_ID.test(value.id)||typeof value.draftId!=='string'||!REQUEST_ID.test(value.draftId))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{deps.workbench.discardAttachment(value.id,value.draftId);return{status:200,body:{ok:true}}}catch(error){return mappedError(error)}
    },
    'GET /v1/workbench/attention':async()=>{
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:200,body:deps.workbench.attention()}}catch(err){return mappedError(err)}
    },
    'POST /v1/workbench/input':async(_query,body)=>{
      const value=objectBody(body)
      const files=value?materials(value):null
      if(!value||Object.hasOwn(value,'execution')||!files||typeof value.id!=='string'||!TASK_ID.test(value.id)||typeof value.runId!=='string'||!REQUEST_ID.test(value.runId)||typeof value.requestId!=='string'||!REQUEST_ID.test(value.requestId)||typeof value.text!=='string'||(!value.text.trim()&&!files.attachmentIds?.length)||value.text.length>20_000)return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:200,body:{input:await deps.workbench.submitInput(value.id,{runId:value.runId,requestId:value.requestId,text:value.text,...files})}}}catch(err){return mappedError(err)}
    },
    'POST /v1/workbench/answer':async(_query,body)=>{
      const value=objectBody(body)
      if(!value||typeof value.id!=='string'||!TASK_ID.test(value.id)||typeof value.requestId!=='string'||!REQUEST_ID.test(value.requestId)||(value.answers!==null&&!objectBody(value.answers))||JSON.stringify(value.answers).length>20_000)return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{deps.workbench.resolveAnswer(value.id,value.requestId,value.answers);return{status:200,body:{ok:true}}}catch(err){return mappedError(err)}
    },
    'POST /v1/workbench/withdraw-input':async(_query,body)=>{
      const value=objectBody(body)
      if(!value||typeof value.id!=='string'||!TASK_ID.test(value.id)||typeof value.requestId!=='string'||!REQUEST_ID.test(value.requestId))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{deps.workbench.withdrawInput(value.id,value.requestId);return{status:200,body:{ok:true}}}catch(err){return mappedError(err)}
    },
    'GET /v1/workbench': async query => {
      for(const key of ['q','archived','limit','cursor'])if(query.getAll(key).length>1)return invalid()
      const q=query.get('q')?.trim(),archived=query.get('archived'),rawLimit=query.get('limit'),cursor=query.get('cursor')
      if((q!==undefined && q.length>200) || (archived!==null && !['exclude','only','all'].includes(archived)) ||
          (rawLimit!==null && (!/^\d+$/.test(rawLimit) || Number(rawLimit)<1 || Number(rawLimit)>100)))return invalid()
      if(cursor!==null && (!cursor || cursor.length>1024))return {status:400,body:{error:'invalid_cursor'}}
      if(!deps.workbench)return {status:503,body:{error:'workbench_not_wired'}}
      const filters:WorkbenchListQuery={
        ...(q!==undefined ? {q} : {}),...(archived!==null ? {archived:archived as WorkbenchListQuery['archived']} : {}),
        ...(rawLimit!==null ? {limit:Number(rawLimit)} : {}),...(cursor!==null ? {cursor} : {}),
      }
      try {return {status:200,body:await (Object.keys(filters).length ? deps.workbench.list(filters) : deps.workbench.list())}}
      catch(err){return mappedError(err)}
    },

    'GET /v1/workbench/sessions': async query => {
      for(const key of ['providerId','q','limit','cursor','cwd'])if(query.getAll(key).length>1)return invalid()
      const providerId=query.get('providerId')
      if(!isNativeHistoryProvider(providerId))return invalid()
      if(!deps.workbench)return {status:503,body:{error:'workbench_not_wired'}}
      try {
        const rawLimit=query.get('limit');if(rawLimit!==null&&!/^\d+$/.test(rawLimit))return invalid()
        const input=normalizeHistoryList({q:query.get('q')??'',limit:rawLimit===null?50:Number(rawLimit),...(query.has('cursor')?{cursor:query.get('cursor')!}:{}),...(query.has('cwd')?{cwd:query.get('cwd')!}:{})})
        return {status:200,body:await deps.workbench.listNativeHistory(providerId,input)}
      }catch(error){return mappedError(error)}
    },
    'GET /v1/workbench/session': async query => {
      for(const field of ['key','limit','cursor'])if(query.getAll(field).length>1)return invalid()
      if(!deps.workbench)return {status:503,body:{error:'workbench_not_wired'}}
      try {
        const key=query.get('key')??'';decodeNativeHistoryKey(key)
        const rawLimit=query.get('limit');if(rawLimit!==null&&!/^\d+$/.test(rawLimit))return invalid()
        const input=normalizeHistoryRead({limit:rawLimit===null?100:Number(rawLimit),...(query.has('cursor')?{cursor:query.get('cursor')!}:{})})
        return {status:200,body:await deps.workbench.readNativeHistory(key,input)}
      }catch(error){return mappedError(error)}
    },

    'POST /v1/workbench/handoff-preview':async(_query,body)=>{
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:200,body:await deps.workbench.previewHandoff(validateHandoffInput(body as HandoffInput))}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/handoff':async(_query,body)=>{
      const value=objectBody(body),token=value?.token,restartToken=value?.restartToken,sourceClosedToken=value?.sourceClosedToken
      if(typeof token!=='string'||!SHA256.test(token))return invalid()
      for(const optional of [restartToken,sourceClosedToken])if(optional!==undefined&&(typeof optional!=='string'||!SHA256.test(optional)))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:202,body:await deps.workbench.handoff({token,...(typeof restartToken==='string'?{restartToken}:{}),...(typeof sourceClosedToken==='string'?{sourceClosedToken}:{})})}}catch(error){return mappedError(error)}
    },
    'GET /v1/workbench/handoff':async query=>{
      const taskId=query.get('taskId'),handoffId=query.get('handoffId')
      if(query.getAll('taskId').length!==1||query.getAll('handoffId').length!==1||!taskId||!TASK_ID.test(taskId)||!handoffId||!REQUEST_ID.test(handoffId))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:200,body:deps.workbench.handoffRecord(taskId,handoffId)}}catch(error){return mappedError(error)}
    },

    'POST /v1/workbench/import':async(_query,body)=>{
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:200,body:await deps.workbench.importNativeHistory(nativeImportInput(body as NativeImportInput))}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/prepare-resume':async(_query,body)=>{
      const value=objectBody(body),id=value?.id,mode=value?.mode??'native_resume'
      if(typeof id!=='string'||!TASK_ID.test(id)||(mode!=='native_resume'&&mode!=='fresh_context'))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:200,body:await deps.workbench.prepareNativeResume(id,mode,...(value&&Object.hasOwn(value,'execution')?[value.execution] as const:[]))}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/prepare-continuation':async(_query,body)=>{
      const value=objectBody(body)
      if(!value||typeof value.id!=='string'||!TASK_ID.test(value.id))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{
        const continuation=Object.hasOwn(value,'execution')?deps.workbench.prepareContinuation(value.id,value.execution):deps.workbench.prepareContinuation(value.id)
        return{status:200,body:{continuation}}
      }catch(error){return mappedError(error)}
    },

    'GET /v1/workbench/task': async (query) => {
      const id = query.get('id')
      if (!id || !TASK_ID.test(id)) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        return { status: 200, body: await deps.workbench.detail(id) }
      } catch (err) {
        return mappedError(err)
      }
    },

    'POST /v1/workbench/create': async (_query, body) => {
      const value = objectBody(body)
      if (!value) return invalid()
      const title = typeof value.title === 'string' ? value.title.trim() : undefined
      const path = typeof value.path === 'string' ? value.path.trim() : ''
      const providerId = typeof value.providerId === 'string' ? value.providerId : ''
      const text = typeof value.text === 'string' ? value.text.trim() : ''
      const files=materials(value)
      if ((value.title !== undefined && (!title || title.length > 120)) ||
          !files || !path || !isAbsolute(path) || !isWorkbenchProviderId(providerId) || (!text&&!files.attachmentIds?.length) || text.length > 20_000) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        const task = await deps.workbench.create({ ...(title ? { title } : {}), path, providerId, text,...files,...execution(value) })
        return { status: 202, body: { task } }
      } catch (err) {
        return mappedError(err)
      }
    },

    'POST /v1/workbench/continue': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      const text = typeof value?.text === 'string' ? value.text.trim() : ''
      const sourceClosedToken=value?.sourceClosedToken
      if(sourceClosedToken!==undefined&&(typeof sourceClosedToken!=='string'||!SHA256.test(sourceClosedToken)))return invalid()
      const restartToken = value?.restartToken
      const files=value?materials(value):null,inputRequestId=value?.inputRequestId
      if(inputRequestId!==undefined&&(typeof inputRequestId!=='string'||!REQUEST_ID.test(inputRequestId)))return invalid()
      if (!files || !TASK_ID.test(id) || (!text&&!files.attachmentIds?.length) || text.length > 20_000 ||
          (restartToken !== undefined && (typeof restartToken !== 'string' || !SHA256.test(restartToken)))) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        const selectedMaterials={...files,...execution(value!)}
        const options={...selectedMaterials,...(restartToken!==undefined?{restartToken:restartToken as string}:{}),...(inputRequestId!==undefined?{inputRequestId:inputRequestId as string}:{})}
        const task = sourceClosedToken!==undefined
          ? await deps.workbench.continueNativeTask(id,text,sourceClosedToken as string,restartToken as string|undefined,...(Object.keys(selectedMaterials).length?[selectedMaterials] as const:[]))
          : Object.keys(options).length?await deps.workbench.continueTask(id,text,options):await deps.workbench.continueTask(id,text)
        return { status: 202, body: { task } }
      } catch (err) {
        return mappedError(err)
      }
    },

    'POST /v1/workbench/archive': async (_query,body) => {
      const value=objectBody(body),id=typeof value?.id==='string' ? value.id : '',archived=value?.archived
      if(!TASK_ID.test(id) || typeof archived!=='boolean')return invalid()
      if(!deps.workbench)return {status:503,body:{error:'workbench_not_wired'}}
      try {return {status:200,body:{task:await deps.workbench.setArchived(id,archived)}}}
      catch(err){return mappedError(err)}
    },

    'POST /v1/workbench/cancel': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      if (!TASK_ID.test(id)) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        return { status: 202, body: { task: await deps.workbench.cancel(id) } }
      } catch (err) {
        return mappedError(err)
      }
    },

    'GET /v1/workbench/artifact': async (query) => {
      const id = query.get('id') ?? ''
      const artifactId = query.get('artifactId') ?? ''
      if (!TASK_ID.test(id) || !ARTIFACT_ID.test(artifactId)) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        return { status: 200, body: await deps.workbench.artifact(id, artifactId) }
      } catch (err) {
        return mappedError(err)
      }
    },

    'POST /v1/workbench/approve': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      const artifactId = typeof value?.artifactId === 'string' ? value.artifactId : ''
      const sha256 = typeof value?.sha256 === 'string' ? value.sha256 : ''
      if (!TASK_ID.test(id) || !ARTIFACT_ID.test(artifactId) || !SHA256.test(sha256)) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        await deps.workbench.approve(id, artifactId, sha256)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return mappedError(err)
      }
    },

    'POST /v1/workbench/permission': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      const requestId = typeof value?.requestId === 'string' ? value.requestId : ''
      const decision = value?.decision
      if (!TASK_ID.test(id) || !REQUEST_ID.test(requestId) || (decision !== 'allow' && decision !== 'deny')) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        await deps.workbench.resolvePermission(id, requestId, decision)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return mappedError(err)
      }
    },
  }
}
