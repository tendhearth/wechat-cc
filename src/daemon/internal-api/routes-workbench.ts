import {validateHandoffInput,type HandoffInput} from '../../core/workbench/handoff'
import {nativeImportInput,type NativeImportInput} from '../../core/workbench/native-adoption'
import { decodeNativeHistoryKey, normalizeHistoryList, normalizeHistoryRead, type NativeHistoryProvider } from '../../core/workbench/native-history'
import { isAbsolute } from 'node:path'
import type { WorkbenchListQuery } from '../../core/workbench/store'
import type {InputMaterials} from '../../core/workbench/service'
import {isWorkbenchProviderId} from '../../core/workbench/executor-capabilities'
import {parseEntryInput} from '../../core/workbench/task-entry'
import {workbenchErrorHttp,workbenchErrorSpec} from '@wechat-cc/protocol'
import type { InternalApiDeps, RouteHandler, RouteTable } from './types'

const TASK_ID = /^[a-f0-9]{8}$/
const EXPECTED_RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const WAIT_MAX_MS = 20_000
const nonNegInt = (v: string | null): number | null => v !== null && /^\d{1,12}$/.test(v) ? Number(v) : null
const ARTIFACT_ID = /^[a-f0-9-]{8,64}$/
const SHA256 = /^[a-f0-9]{64}$/
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const IDENTITY_FIELDS=['ownerKey','ownerChatId','accountId','surface','scope','owner','owner_key','owner_chat_id','account_id']
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

/** 只带这几个字段出去(service 挂在 Error 上的);别的(steps 原文这类)不外泄。 */
function rewindExtra(err:unknown):JsonObject{
  if(!err||typeof err!=='object')return{}
  const e=err as JsonObject,out:JsonObject={}
  for(const key of ['reason','detail','backupRef','path'])if(typeof e[key]==='string')out[key]=e[key]
  if(typeof e.rolledBack==='boolean')out.rolledBack=e.rolledBack
  if(Array.isArray(e.paths))out.paths=e.paths.filter(p=>typeof p==='string').slice(0,50)
  return out
}

/** 状态与对外的码都查 packages/protocol 的 WORKBENCH_ERRORS;回退那一组另带 rewindExtra。 */
function mappedError(err: unknown,entry=false): ReturnType<RouteHandler> {
  const code = errorCode(err)
  const {status,error}=workbenchErrorHttp(code,'desktop',entry)
  return {status,body:workbenchErrorSpec(code)?.rewind?{error,...rewindExtra(err)}:{error}}
}

export function workbenchRoutes(deps: InternalApiDeps): RouteTable {
  const entryContext=()=>({ownerKey:deps.resolveAdminChatId?.()??'',surface:'desktop' as const})
  // 出生地(2026-10-19):只有桌面 app 的 operator 令牌才算「从电脑来的」;别的 admin 令牌(会话 / 未来的调用方)不知道 ⇒ 不写。
  const desktopOrigin=(caller?:{origin:string})=>caller?.origin==='operator'?{origin:'desktop' as const}:{}
  return {
    'GET /v1/workbench/entry-options':async query=>{
      if(query.size)return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:200,body:deps.workbench.entryOptions(entryContext())}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/create-entry':async(query,body,caller)=>{
      if(query.size)return invalid()
      try{
        const input=parseEntryInput(body)
        if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
        return{status:202,body:deps.workbench.createEntry(input,{...entryContext(),...desktopOrigin(caller)})}
      }catch(error){return mappedError(error,true)}
    },
    'GET /v1/workbench/entry-receipt':async query=>{
      const requestId=query.get('requestId')
      if(query.size!==1||!requestId||!REQUEST_ID.test(requestId))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{
        const result=deps.workbench.entryReceipt(requestId.toLowerCase(),entryContext())
        return result?{status:200,body:result}:{status:404,body:{error:'not_found'}}
      }catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/project':async(_query,body)=>{
      const value=objectBody(body)
      if(!value||typeof value.path!=='string'||!isAbsolute(value.path)||value.path.includes('\0')||!isWorkbenchProviderId(value.providerId)||(value.name!==undefined&&typeof value.name!=='string'))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:200,body:{project:deps.workbench.addProject({path:value.path,providerId:value.providerId,...(value.name!==undefined?{name:value.name as string}:{})})}}}catch(error){return mappedError(error)}
    },
    'GET /v1/workbench/models':async query=>{
      const providerId=query.get('providerId'),path=query.get('path')
      if(query.getAll('providerId').length!==1||query.getAll('path').length!==1||!isWorkbenchProviderId(providerId)||!path||path.length>4096||path.includes('\0')||!isAbsolute(path))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:200,body:{catalog:await deps.workbench.modelCatalog(providerId,path)}}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/attachment':async(_query,body)=>{
      const value=objectBody(body)
      if(!value||IDENTITY_FIELDS.some(key=>Object.hasOwn(value,key))||typeof value.id!=='string'||!REQUEST_ID.test(value.id)||typeof value.draftId!=='string'||!REQUEST_ID.test(value.draftId)||typeof value.name!=='string'||typeof value.mime!=='string'||typeof value.base64!=='string'||(value.taskId!==undefined&&(typeof value.taskId!=='string'||!TASK_ID.test(value.taskId))))return invalid()
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

    'POST /v1/workbench/quota-handoff':async(query,body)=>{
      const value=objectBody(body)
      if(query.size||!value||Object.keys(value).some(key=>!['id','requestId','providerId'].includes(key))||typeof value.id!=='string'||!TASK_ID.test(value.id)||typeof value.requestId!=='string'||!REQUEST_ID.test(value.requestId)||!isWorkbenchProviderId(value.providerId))return invalid()
      if(!deps.workbench)return{status:503,body:{error:'workbench_not_wired'}}
      try{return{status:202,body:deps.workbench.handOff(value.id,{requestId:value.requestId,providerId:value.providerId})}}catch(error){return mappedError(error)}
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
      if (query.getAll('since').length > 1 || query.getAll('wait_ms').length > 1) return invalid()
      const sinceRaw = query.get('since'), waitRaw = query.get('wait_ms')
      const since = sinceRaw === null ? undefined : nonNegInt(sinceRaw)
      const waitMs = waitRaw === null ? 0 : nonNegInt(waitRaw)
      if (since === null || waitMs === null) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        if (since !== undefined && waitMs > 0) {
          // 先探一次:数据已经比 since 新(或任务压根不存在,detail 直接抛 not_found)就地返回,
          // 不然一个已下线的 id 会在 wait 里空耗满 20 秒才等到 detail 去报 404。
          const first = await deps.workbench.detail(id, { since })
          if (first.version > since) return { status: 200, body: first }
          await deps.workbench.changes.wait(id, since, Math.min(waitMs, WAIT_MAX_MS))
          return { status: 200, body: await deps.workbench.detail(id, { since }) }
        }
        return { status: 200, body: await deps.workbench.detail(id, since === undefined ? {} : { since }) }
      } catch (err) {
        return mappedError(err)
      }
    },

    'POST /v1/workbench/create': async (_query, body, caller) => {
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
        const task = await deps.workbench.create({ ...(title ? { title } : {}), path, providerId, text,...files,...execution(value),...desktopOrigin(caller) })
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

    // 「没确认退出」的旧记录:主人确认执行程序已经结束(2026-10-06)。进程组还活着 ⇒ 409 writer_alive。
    'POST /v1/workbench/writer-exited': async (_query,body) => {
      const value=objectBody(body),id=typeof value?.id==='string' ? value.id : ''
      if(!TASK_ID.test(id))return invalid()
      if(!deps.workbench)return {status:503,body:{error:'workbench_not_wired'}}
      try {return {status:200,body:{task:await deps.workbench.confirmWriterExited(id)}}}
      catch(err){return mappedError(err)}
    },

    'POST /v1/workbench/unattended-ack': async () => {
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try { return { status: 200, body: { acknowledgedAt: deps.workbench.acknowledgeUnattended() } } }
      catch (err) { return mappedError(err) }
    },

    'POST /v1/workbench/cancel': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      if (!TASK_ID.test(id)) return invalid()
      const expectedRunIdRaw = value?.expectedRunId
      if (typeof expectedRunIdRaw === 'string' && !EXPECTED_RUN_ID.test(expectedRunIdRaw)) return invalid()
      const expectedRunId = typeof expectedRunIdRaw === 'string' ? expectedRunIdRaw : undefined
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        return { status: 202, body: { task: await deps.workbench.cancel(id, expectedRunId) } }
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

    'GET /v1/workbench/review': async (query) => {
      const id = query.get('id') ?? ''
      if (query.getAll('id').length !== 1 || !TASK_ID.test(id)) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        return { status: 200, body: { reviews: await deps.workbench.reviewList(id) } }
      } catch (err) {
        return mappedError(err)
      }
    },

    'POST /v1/workbench/review-mark': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      const artifactId = typeof value?.artifactId === 'string' ? value.artifactId : ''
      const path = value?.path
      const mark = value?.mark
      const comment = value?.comment
      if (!TASK_ID.test(id) || !ARTIFACT_ID.test(artifactId) ||
          typeof path !== 'string' || !path || path.length > 4096 ||
          (mark !== 'accepted' && mark !== 'returned') ||
          (comment !== undefined && (typeof comment !== 'string' || comment.length > 2000))) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        const result = await deps.workbench.markReviewFile(id, { artifactId, path, mark, ...(comment !== undefined ? { comment } : {}) })
        return { status: 200, body: { mark: result } }
      } catch (err) {
        return mappedError(err)
      }
    },

    // 逐文件撤销(2026-10-06):恢复成这一轮开始前的内容。文件夹还被占着 ⇒ 409 workbench_busy;之后又改过 ⇒ 409 review_file_changed。
    // 独立工作区(2026-10-07):commit = 提交到分支(回合并命令),remove = 删工作区目录(分支保留);merge(10-08)= 快进合回项目。
    // 工作区脚本(2026-10-20):run = 起 run 脚本(setup 没跑成先跑 setup),stop = 停下;没批 ⇒ 428 script_approval_required。
    'POST /v1/workbench/worktree': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : '', action = value?.action
      if (!TASK_ID.test(id) || (action !== 'commit' && action !== 'remove' && action !== 'merge' && action !== 'reopen' && action !== 'run' && action !== 'stop') || Object.keys(value ?? {}).some(k => k !== 'id' && k !== 'action')) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try { return { status: 200, body: { worktree: action === 'run' || action === 'stop' ? await deps.workbench.scriptAction(id, action) : deps.workbench.worktreeAction(id, action) } } }
      catch (err) { return mappedError(err) }
    },

    // 批准工作区脚本:hash = 主人在确认框里看到的那份内容;对不上 ⇒ 409 script_config_changed(重新拉详情再看)。
    'POST /v1/workbench/script-approve': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : '', hash = typeof value?.hash === 'string' ? value.hash : ''
      if (!TASK_ID.test(id) || !SHA256.test(hash) || Object.keys(value ?? {}).some(k => k !== 'id' && k !== 'hash')) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try { return { status: 200, body: { scripts: deps.workbench.approveScripts(id, hash) } } }
      catch (err) { return mappedError(err) }
    },

    'POST /v1/workbench/review-revert': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      const artifactId = typeof value?.artifactId === 'string' ? value.artifactId : ''
      const path = value?.path
      if (!TASK_ID.test(id) || !ARTIFACT_ID.test(artifactId) || typeof path !== 'string' || !path || path.length > 4096 || Object.keys(value ?? {}).some(k => !['id', 'artifactId', 'path'].includes(k))) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try { return { status: 200, body: { reverted: deps.workbench.revertReviewFile(id, { artifactId, path }) } } }
      catch (err) { return mappedError(err) }
    },

    // 行评论(2026-10-21):按键集合精确分三种 —— 建 {id, commentId, artifactId, path, hunk, hunkSha256, rowStart?, rowEnd?, body} /
    // 改 {id, commentId, body} / 删 {id, commentId, delete:true}。引用与行号由服务端算,客户端给了别的键一律 400。
    'POST /v1/workbench/review-comment': async (query, body) => {
      const value = objectBody(body)
      if (query.size || !value || typeof value.id !== 'string' || !TASK_ID.test(value.id) || typeof value.commentId !== 'string' || !REQUEST_ID.test(value.commentId)) return invalid()
      const keys = Object.keys(value).sort().join(',')
      const text = (v: unknown) => typeof v === 'string' && !!v.trim() && v.length <= 2000
      const row = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000
      let input: Parameters<NonNullable<InternalApiDeps['workbench']>['reviewComment']>[1]
      if (keys === 'commentId,delete,id') { if (value.delete !== true) return invalid(); input = { commentId: value.commentId, delete: true } }
      else if (keys === 'body,commentId,id') { if (!text(value.body)) return invalid(); input = { commentId: value.commentId, body: value.body as string } }
      else if (keys === 'artifactId,body,commentId,hunk,hunkSha256,id,path' || keys === 'artifactId,body,commentId,hunk,hunkSha256,id,path,rowEnd,rowStart') {
        if (typeof value.artifactId !== 'string' || !ARTIFACT_ID.test(value.artifactId) || typeof value.path !== 'string' || !value.path || value.path.length > 4096 ||
            !row(value.hunk) || typeof value.hunkSha256 !== 'string' || !SHA256.test(value.hunkSha256) || !text(value.body) ||
            (keys.includes('rowStart') && (!row(value.rowStart) || !row(value.rowEnd)))) return invalid()
        input = { commentId: value.commentId, artifactId: value.artifactId, path: value.path, hunk: value.hunk as number, hunkSha256: value.hunkSha256, body: value.body as string,
          ...(keys.includes('rowStart') ? { rowStart: value.rowStart as number, rowEnd: value.rowEnd as number } : {}) }
      } else return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try { return { status: 200, body: deps.workbench.reviewComment(value.id, input) } }
      catch (err) { return mappedError(err) }
    },
    // 发出行评论:投递同 review-return(202,{input}|{task} + sent / remaining / skippedDiscarded);restartToken 同那道门。
    'POST /v1/workbench/review-comments-send': async (query, body) => {
      const value = objectBody(body)
      if (query.size || !value || typeof value.id !== 'string' || !TASK_ID.test(value.id) || Object.keys(value).some(k => !['id', 'summary', 'inputRequestId', 'restartToken'].includes(k))) return invalid()
      const { summary, inputRequestId, restartToken } = value
      if (summary !== undefined && (typeof summary !== 'string' || summary.length > 2000)) return invalid()
      if (inputRequestId !== undefined && (typeof inputRequestId !== 'string' || !REQUEST_ID.test(inputRequestId))) return invalid()
      if (restartToken !== undefined && (typeof restartToken !== 'string' || !SHA256.test(restartToken))) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        const result = await deps.workbench.sendReviewComments(value.id, { ...(summary !== undefined ? { summary: summary as string } : {}), ...(inputRequestId !== undefined ? { inputRequestId: inputRequestId as string } : {}), ...(restartToken !== undefined ? { restartToken: restartToken as string } : {}) })
        return { status: 202, body: result }
      } catch (err) { return mappedError(err) }
    },
    // 按块撤回 / 恢复:这件事有会话(哪怕答复过)/ 检查 / 脚本在跑 ⇒ 409 workbench_busy;块变了 ⇒ 409 review_hunk_stale;之后又改过 ⇒ 409 review_file_changed。
    'POST /v1/workbench/review-hunk': async (query, body) => {
      const value = objectBody(body)
      if (query.size || !value || Object.keys(value).sort().join(',') !== 'action,artifactId,hunk,hunkSha256,id,path' ||
          typeof value.id !== 'string' || !TASK_ID.test(value.id) || typeof value.artifactId !== 'string' || !ARTIFACT_ID.test(value.artifactId) ||
          typeof value.path !== 'string' || !value.path || value.path.length > 4096 || typeof value.hunk !== 'number' || !Number.isInteger(value.hunk) || value.hunk < 0 ||
          typeof value.hunkSha256 !== 'string' || !SHA256.test(value.hunkSha256) || (value.action !== 'revert' && value.action !== 'restore')) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try { return { status: 200, body: { hunk: deps.workbench.revertReviewHunk(value.id, { artifactId: value.artifactId, path: value.path, hunk: value.hunk, hunkSha256: value.hunkSha256, action: value.action }) } } }
      catch (err) { return mappedError(err) }
    },

    // 回到某一轮(2026-10-21):先预览(拿 token),再带 token 执行;{id, undo} = 撤销最近一次回退;rewind-resolve = 停住后主人拍板。
    'GET /v1/workbench/rewind-preview': async query => {
      const id = query.get('id'), artifactId = query.get('artifactId'), to = query.get('to')
      if (query.size !== 3 || query.getAll('id').length !== 1 || query.getAll('artifactId').length !== 1 || query.getAll('to').length !== 1 ||
          !id || !TASK_ID.test(id) || !artifactId || !ARTIFACT_ID.test(artifactId) || (to !== 'start' && to !== 'end')) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try { return { status: 200, body: { preview: await deps.workbench.rewindPreview(id, { artifactId, to }) } } }
      catch (err) { return mappedError(err) }
    },
    'POST /v1/workbench/rewind': async (query, body) => {
      const value = objectBody(body), keys = Object.keys(value ?? {}).sort().join(',')
      if (query.size || !value || typeof value.id !== 'string' || !TASK_ID.test(value.id)) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      if (keys === 'id,undo') {
        if (typeof value.undo !== 'string' || !REQUEST_ID.test(value.undo)) return invalid()
        try { return { status: 200, body: { rewind: await deps.workbench.undoRewind(value.id, value.undo) } } }
        catch (err) { return mappedError(err) }
      }
      if (keys !== 'artifactId,id,to,token' || typeof value.artifactId !== 'string' || !ARTIFACT_ID.test(value.artifactId) ||
          (value.to !== 'start' && value.to !== 'end') || typeof value.token !== 'string' || !SHA256.test(value.token)) return invalid()
      try { return { status: 200, body: { rewind: await deps.workbench.rewind(value.id, { artifactId: value.artifactId, to: value.to, token: value.token }) } } }
      catch (err) { return mappedError(err) }
    },
    'POST /v1/workbench/rewind-resolve': async (query, body) => {
      const value = objectBody(body)
      if (query.size || !value || Object.keys(value).sort().join(',') !== 'choice,id' || typeof value.id !== 'string' || !TASK_ID.test(value.id) ||
          (value.choice !== 'keep' && value.choice !== 'restore_backup')) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try { return { status: 200, body: { resolved: await deps.workbench.rewindResolve(value.id, value.choice) } } }
      catch (err) { return mappedError(err) }
    },

    'POST /v1/workbench/review-return': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      const artifactId = typeof value?.artifactId === 'string' ? value.artifactId : ''
      const paths = value?.paths
      const comment = value?.comment
      const inputRequestId = value?.inputRequestId
      // 重开令牌照 POST /v1/workbench/continue 那道门验(同一个 SHA256):原会话不能恢复时,打回也要能带着它再来一次。
      const restartToken = value?.restartToken
      if (inputRequestId !== undefined && (typeof inputRequestId !== 'string' || !REQUEST_ID.test(inputRequestId))) return invalid()
      if (restartToken !== undefined && (typeof restartToken !== 'string' || !SHA256.test(restartToken))) return invalid()
      // 同时记成这个项目的经验(10-20):可选布尔;记没记上只附在响应上,不改打回本身
      const asLesson = value?.asLesson
      if (asLesson !== undefined && typeof asLesson !== 'boolean') return invalid()
      if (!TASK_ID.test(id) || !ARTIFACT_ID.test(artifactId) ||
          !Array.isArray(paths) || !paths.length || paths.length > 20 || paths.some(p => typeof p !== 'string' || !p) ||
          typeof comment !== 'string' || !comment.trim() || comment.length > 2000) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        const { lesson, ...result } = await deps.workbench.returnReviewFiles(id, { artifactId, paths, comment, ...(inputRequestId !== undefined ? { inputRequestId } : {}), ...(restartToken !== undefined ? { restartToken: restartToken as string } : {}), ...(asLesson === true ? { asLesson: true as const } : {}) })
        // 保留会话还活着时打回走的是续接投递,回的是一张回执;已经结算的任务才回任务视图
        // (评审 2026-09-21 #7)。两种都够桌面拿去刷新详情。
        // 回执认 `taskId`(任务视图上只有 `id`),比认 `phase` 稳:少一个字段不会把回执当成任务发出去。
        return { status: 202, body: { ...('taskId' in result ? { input: result } : { task: result }), ...(lesson ? { lesson } : {}) } }
      } catch (err) {
        return mappedError(err)
      }
    },
  }
}
