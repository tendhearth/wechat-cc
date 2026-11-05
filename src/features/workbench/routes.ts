/**
 * 工作台的桌面路由 `/v1/workbench/*`(架构终态 A5 从 daemon/internal-api/routes-workbench.ts 搬来)。
 * 由 workbench 模块自己挂(internalApi.mount;路由表标了 module: 'workbench')。服务还没挂上 / 没起来时,
 * 模块门原样回 503 workbench_not_wired(protocol routes.ts 的 MODULE_UNAVAILABLE_CODE),处理器里不再写「没接线」的分支。
 * 状态与对外的码都查 packages/protocol 的 WORKBENCH_ERRORS(mappedError)。
 * 一件事上的动作(停下、批准、回答、成果、交给另一位、工作区、交办与回执 …)P3e 起不在这里:一个处理器在
 * daemon/internal-api/routes-matter-actions.ts(`/v1/matter/*`),桌面还在调的 `/v1/workbench/*` 旧键挂同一个函数(wire-compat.ts 的别名)。
 */
import {validateHandoffInput,type HandoffInput} from './handoff'
import {nativeImportInput,type NativeImportInput} from '../../adapters/workbench/native-adoption'
import { decodeNativeHistoryKey, normalizeHistoryList, normalizeHistoryRead, type NativeHistoryProvider } from '../../adapters/workbench/native-history'
import { isAbsolute } from 'node:path'
import type { WorkbenchListQuery } from '../../adapters/store/workbench/store'
import type {InputMaterials,WorkbenchService} from './service'
import {isWorkbenchProviderId} from '../../domain/workbench/executor-capabilities'
import {workbenchErrorHttp,workbenchErrorSpec} from '@wechat-cc/protocol'
import type { RouteHandler, RouteResult, RouteTable } from '../../daemon/internal-api/types'
import { phoneSessionList, phoneSessionRead, type PhoneSessionsDeps } from './phone-sessions'

const TASK_ID = /^[a-f0-9]{8}$/
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

/** 手机设置面板那一口的令牌(设备 / 链接;P3c-4 起交办选项、模型、扔掉材料、原生会话两条也收它们,路由表那一行的 phone 块只放设备)。 */
const fromPhone = (caller: Parameters<RouteHandler>[2]): boolean => caller?.origin === 'device' || caller?.origin === 'link'
/** 手机令牌的错误:回包同桌面那一列,原始码经 cause 带给面板里的旧路径别名(它换回 phone 那一列;cause 不出面板)。 */
function phoneError(err: unknown): RouteResult {
  const code = errorCode(err)
  const {status,error}=workbenchErrorHttp(code,'desktop')
  return { status, body: { error }, ...(/^[a-z][a-z0-9_]{0,63}$/.test(code) ? { cause: code } : {}) }
}
/** 手机交办时问模型:执行者 id 的写法(并之前 /m/api/entry/models 的处理器就是这一条,不是 isWorkbenchProviderId)。 */
const PHONE_PROVIDER_ID = /^[a-z][a-z0-9._-]{0,63}$/
/** 手机只给项目目录 id(p-…),路径只在电脑上解析。 */
const PHONE_PROJECT_ID = /^p-[A-Za-z0-9_-]{1,64}$/

/** 这几条路由要的(以前是 InternalApiDeps 的 workbench + resolveAdminChatId)。 */
export interface WorkbenchRoutesDeps {
  workbench: WorkbenchService
  /** 交办入口的主人(entry context 的 ownerKey);没配主人 ⇒ ''。 */
  resolveAdminChatId?: () => string | null
  /**
   * 手机令牌读原生会话(P3c-4,phone-sessions.ts):单飞 + 短缓存过的读法、执行者正式名字。缺 `sessions` ⇒ 手机令牌
   * 503 sessions_not_wired(绝不退回桌面那一份)。
   */
  phoneSessions?: PhoneSessionsDeps
  /**
   * 桌面那一侧(S3b):attention 每 3 秒拉一次 = 桌面 app 开着(`notePoll`);非手机令牌读一件任务的详情 = 在电脑上看过了(`seen`)。
   * 一件事的提议读这两样决定桌面那一级由谁弹、到点还推不推手机。缺省 ⇒ 不记。
   */
  desktop?: { notePoll(): void; seen(taskId: string): void }
}

export function workbenchRoutes(deps: WorkbenchRoutesDeps): RouteTable {
  const entryContext=()=>({ownerKey:deps.resolveAdminChatId?.()??'',surface:'desktop' as const})
  // 手机令牌按手机表面(并之前面板交给服务的就是这一份:wire-settings-panel.ts 的 entry / uploads)
  const phoneContext=()=>({ownerKey:deps.resolveAdminChatId?.()??'',surface:'phone' as const})
  // 出生地(2026-10-19):只有桌面 app 的 operator 令牌才算「从电脑来的」;别的 admin 令牌(会话 / 未来的调用方)不知道 ⇒ 不写。
  const desktopOrigin=(caller?:{origin:string})=>caller?.origin==='operator'?{origin:'desktop' as const}:{}
  return {
    'GET /v1/workbench/entry-options':async(query,_body,caller)=>{
      if(query.size)return invalid()
      // 手机令牌(P3c-4,原 /m/api/entry/options):同一份选项,按手机表面问
      if(fromPhone(caller)){try{return{status:200,body:deps.workbench.entryOptions(phoneContext())}}catch(error){return phoneError(error)}}
      try{return{status:200,body:deps.workbench.entryOptions(entryContext())}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/project':async(_query,body)=>{
      const value=objectBody(body)
      if(!value||typeof value.path!=='string'||!isAbsolute(value.path)||value.path.includes('\0')||!isWorkbenchProviderId(value.providerId)||(value.name!==undefined&&typeof value.name!=='string'))return invalid()
      try{return{status:200,body:{project:deps.workbench.addProject({path:value.path,providerId:value.providerId,...(value.name!==undefined?{name:value.name as string}:{})})}}}catch(error){return mappedError(error)}
    },
    'GET /v1/workbench/models':async(query,_body,caller)=>{
      // 手机令牌(P3c-4,原 /m/api/entry/models):只认执行者 id + 可选的项目目录 id,**不认 path** —— 手机说不出、也不该探
      // 电脑上的任意路径;没给项目 ⇒ 由 CC 安排的受管根目录(service/entry.ts 的 entryModels)。
      if(fromPhone(caller)){
        const providerId=query.get('providerId'),projectId=query.get('projectId')
        if([...query.keys()].some(k=>k!=='providerId'&&k!=='projectId')||query.getAll('providerId').length!==1||query.getAll('projectId').length>1||!providerId||!PHONE_PROVIDER_ID.test(providerId)||(projectId!==null&&!PHONE_PROJECT_ID.test(projectId)))return{status:400,body:{error:'invalid_request'},cause:'invalid_request'}
        try{return{status:200,body:{catalog:await deps.workbench.entryModels({providerId,...(projectId?{projectId}:{})},phoneContext())}}}catch(error){return phoneError(error)}
      }
      const providerId=query.get('providerId'),path=query.get('path')
      if(query.getAll('providerId').length!==1||query.getAll('path').length!==1||!isWorkbenchProviderId(providerId)||!path||path.length>4096||path.includes('\0')||!isAbsolute(path))return invalid()
      try{return{status:200,body:{catalog:await deps.workbench.modelCatalog(providerId,path)}}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/attachment':async(_query,body)=>{
      const value=objectBody(body)
      if(!value||IDENTITY_FIELDS.some(key=>Object.hasOwn(value,key))||typeof value.id!=='string'||!REQUEST_ID.test(value.id)||typeof value.draftId!=='string'||!REQUEST_ID.test(value.draftId)||typeof value.name!=='string'||typeof value.mime!=='string'||typeof value.base64!=='string'||(value.taskId!==undefined&&(typeof value.taskId!=='string'||!TASK_ID.test(value.taskId))))return invalid()
      try{return{status:200,body:{attachment:deps.workbench.uploadAttachment({id:value.id,draftId:value.draftId,name:value.name,mime:value.mime,base64:value.base64,...(value.taskId?{taskId:value.taskId as string}:{})})}}}catch(error){return mappedError(error)}
    },
    'GET /v1/workbench/attachment':async query=>{
      const taskId=query.get('taskId'),id=query.get('id')
      if(query.getAll('taskId').length!==1||query.getAll('id').length!==1||!taskId||!TASK_ID.test(taskId)||!id||!REQUEST_ID.test(id))return invalid()
      try{return{status:200,body:deps.workbench.readAttachment(taskId,id)}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/discard-attachment':async(_query,body,caller)=>{
      // 手机令牌(P3c-4,原 /m/api/attachment/discard):只扔手机分块上传的那一份(按主人 + 手机表面),正文原样交给上传登记处验
      // (恰好 id + draftId,别的键 / 坏 id ⇒ invalid_upload_chunk,同并之前)。桌面那条还能扔一次性上传的材料,手机不能。
      if(fromPhone(caller)){try{deps.workbench.discardAttachmentUpload(body as {id:string;draftId:string},phoneContext());return{status:200,body:{ok:true}}}catch(error){return phoneError(error)}}
      const value=objectBody(body)
      if(!value||typeof value.id!=='string'||!REQUEST_ID.test(value.id)||typeof value.draftId!=='string'||!REQUEST_ID.test(value.draftId))return invalid()
      try{deps.workbench.discardAttachment(value.id,value.draftId);return{status:200,body:{ok:true}}}catch(error){return mappedError(error)}
    },
    'GET /v1/workbench/attention':async(_query,_body,caller)=>{
      if(!fromPhone(caller))try{deps.desktop?.notePoll()}catch{/* 只是记一笔 */}
      try{return{status:200,body:deps.workbench.attention()}}catch(err){return mappedError(err)}
    },
    'POST /v1/workbench/input':async(_query,body)=>{
      const value=objectBody(body)
      const files=value?materials(value):null
      if(!value||Object.hasOwn(value,'execution')||!files||typeof value.id!=='string'||!TASK_ID.test(value.id)||typeof value.runId!=='string'||!REQUEST_ID.test(value.runId)||typeof value.requestId!=='string'||!REQUEST_ID.test(value.requestId)||typeof value.text!=='string'||(!value.text.trim()&&!files.attachmentIds?.length)||value.text.length>20_000)return invalid()
      try{return{status:200,body:{input:await deps.workbench.submitInput(value.id,{runId:value.runId,requestId:value.requestId,text:value.text,...files})}}}catch(err){return mappedError(err)}
    },
    'POST /v1/workbench/withdraw-input':async(_query,body)=>{
      const value=objectBody(body)
      if(!value||typeof value.id!=='string'||!TASK_ID.test(value.id)||typeof value.requestId!=='string'||!REQUEST_ID.test(value.requestId))return invalid()
      try{deps.workbench.withdrawInput(value.id,value.requestId);return{status:200,body:{ok:true}}}catch(err){return mappedError(err)}
    },
    'GET /v1/workbench': async query => {
      for(const key of ['q','archived','limit','cursor'])if(query.getAll(key).length>1)return invalid()
      const q=query.get('q')?.trim(),archived=query.get('archived'),rawLimit=query.get('limit'),cursor=query.get('cursor')
      if((q!==undefined && q.length>200) || (archived!==null && !['exclude','only','all'].includes(archived)) ||
          (rawLimit!==null && (!/^\d+$/.test(rawLimit) || Number(rawLimit)<1 || Number(rawLimit)>100)))return invalid()
      if(cursor!==null && (!cursor || cursor.length>1024))return {status:400,body:{error:'invalid_cursor'}}
      const filters:WorkbenchListQuery={
        ...(q!==undefined ? {q} : {}),...(archived!==null ? {archived:archived as WorkbenchListQuery['archived']} : {}),
        ...(rawLimit!==null ? {limit:Number(rawLimit)} : {}),...(cursor!==null ? {cursor} : {}),
      }
      try {return {status:200,body:await (Object.keys(filters).length ? deps.workbench.list(filters) : deps.workbench.list())}}
      catch(err){return mappedError(err)}
    },

    'GET /v1/workbench/sessions': async (query, _body, caller) => {
      // 手机令牌(P3c-4,原 /m/api/sessions):回手机那一份(phone-sessions.ts:只给目录名、一页 30、不认 cwd / limit、单飞 + 预算)
      if (fromPhone(caller)) return phoneSessionList(deps.phoneSessions ?? {}, query, caller?.frameBudget)
      for(const key of ['providerId','q','limit','cursor','cwd'])if(query.getAll(key).length>1)return invalid()
      const providerId=query.get('providerId')
      if(!isNativeHistoryProvider(providerId))return invalid()
      try {
        const rawLimit=query.get('limit');if(rawLimit!==null&&!/^\d+$/.test(rawLimit))return invalid()
        const input=normalizeHistoryList({q:query.get('q')??'',limit:rawLimit===null?50:Number(rawLimit),...(query.has('cursor')?{cursor:query.get('cursor')!}:{}),...(query.has('cwd')?{cwd:query.get('cwd')!}:{})})
        return {status:200,body:await deps.workbench.listNativeHistory(providerId,input)}
      }catch(error){return mappedError(error)}
    },
    'GET /v1/workbench/session': async (query, _body, caller) => {
      // 手机令牌(P3c-4,原 /m/api/session):回手机那一份(一页 20、每条至多 4000 字、window=start | recent)
      if (fromPhone(caller)) return phoneSessionRead(deps.phoneSessions ?? {}, query, caller?.frameBudget)
      for(const field of ['key','limit','cursor'])if(query.getAll(field).length>1)return invalid()
      try {
        const key=query.get('key')??'';decodeNativeHistoryKey(key)
        const rawLimit=query.get('limit');if(rawLimit!==null&&!/^\d+$/.test(rawLimit))return invalid()
        const input=normalizeHistoryRead({limit:rawLimit===null?100:Number(rawLimit),...(query.has('cursor')?{cursor:query.get('cursor')!}:{})})
        return {status:200,body:await deps.workbench.readNativeHistory(key,input)}
      }catch(error){return mappedError(error)}
    },

    'POST /v1/workbench/handoff-preview':async(_query,body)=>{
      try{return{status:200,body:await deps.workbench.previewHandoff(validateHandoffInput(body as HandoffInput))}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/handoff':async(_query,body)=>{
      const value=objectBody(body),token=value?.token,restartToken=value?.restartToken,sourceClosedToken=value?.sourceClosedToken
      if(typeof token!=='string'||!SHA256.test(token))return invalid()
      for(const optional of [restartToken,sourceClosedToken])if(optional!==undefined&&(typeof optional!=='string'||!SHA256.test(optional)))return invalid()
      try{return{status:202,body:await deps.workbench.handoff({token,...(typeof restartToken==='string'?{restartToken}:{}),...(typeof sourceClosedToken==='string'?{sourceClosedToken}:{})})}}catch(error){return mappedError(error)}
    },
    'GET /v1/workbench/handoff':async query=>{
      const taskId=query.get('taskId'),handoffId=query.get('handoffId')
      if(query.getAll('taskId').length!==1||query.getAll('handoffId').length!==1||!taskId||!TASK_ID.test(taskId)||!handoffId||!REQUEST_ID.test(handoffId))return invalid()
      try{return{status:200,body:deps.workbench.handoffRecord(taskId,handoffId)}}catch(error){return mappedError(error)}
    },

    'POST /v1/workbench/import':async(_query,body)=>{
      try{return{status:200,body:await deps.workbench.importNativeHistory(nativeImportInput(body as NativeImportInput))}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/prepare-resume':async(_query,body)=>{
      const value=objectBody(body),id=value?.id,mode=value?.mode??'native_resume'
      if(typeof id!=='string'||!TASK_ID.test(id)||(mode!=='native_resume'&&mode!=='fresh_context'))return invalid()
      try{return{status:200,body:await deps.workbench.prepareNativeResume(id,mode,...(value&&Object.hasOwn(value,'execution')?[value.execution] as const:[]))}}catch(error){return mappedError(error)}
    },
    'POST /v1/workbench/prepare-continuation':async(_query,body)=>{
      const value=objectBody(body)
      if(!value||typeof value.id!=='string'||!TASK_ID.test(value.id))return invalid()
      try{
        const continuation=Object.hasOwn(value,'execution')?deps.workbench.prepareContinuation(value.id,value.execution):deps.workbench.prepareContinuation(value.id)
        return{status:200,body:{continuation}}
      }catch(error){return mappedError(error)}
    },

    'GET /v1/workbench/task': async (query, _body, caller) => {
      const id = query.get('id')
      if (!id || !TASK_ID.test(id)) return invalid()
      if (!fromPhone(caller)) try { deps.desktop?.seen(id) } catch { /* 只是露面登记 */ }
      if (query.getAll('since').length > 1 || query.getAll('since_cursor').length > 1 || query.getAll('wait_ms').length > 1) return invalid()
      const sinceRaw = query.get('since'), cursorRaw = query.get('since_cursor'), waitRaw = query.get('wait_ms')
      if (sinceRaw !== null && cursorRaw !== null) return invalid()
      const since = sinceRaw === null ? undefined : nonNegInt(sinceRaw)
      const sinceCursor = cursorRaw === null ? undefined : nonNegInt(cursorRaw)
      const waitMs = waitRaw === null ? 0 : nonNegInt(waitRaw)
      if (since === null || sinceCursor === null || waitMs === null) return invalid()
      try {
        // 按游标(P1b,桌面新版):这件事的游标超过 since_cursor 就回;不然挂着等它前进。
        if (sinceCursor !== undefined) {
          const first = await deps.workbench.detail(id, { sinceCursor })
          if (first.cursor > sinceCursor || waitMs === 0) return { status: 200, body: first }
          await deps.workbench.changes.waitCursor(id, sinceCursor, Math.min(waitMs, WAIT_MAX_MS))
          return { status: 200, body: await deps.workbench.detail(id, { sinceCursor }) }
        }
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
      try {return {status:200,body:{task:await deps.workbench.setArchived(id,archived)}}}
      catch(err){return mappedError(err)}
    },

    // 「没确认退出」的旧记录:主人确认执行程序已经结束(2026-10-06)。进程组还活着 ⇒ 409 writer_alive。
    'POST /v1/workbench/writer-exited': async (_query,body) => {
      const value=objectBody(body),id=typeof value?.id==='string' ? value.id : ''
      if(!TASK_ID.test(id))return invalid()
      try {return {status:200,body:{task:await deps.workbench.confirmWriterExited(id)}}}
      catch(err){return mappedError(err)}
    },

    'POST /v1/workbench/unattended-ack': async () => {
      try { return { status: 200, body: { acknowledgedAt: deps.workbench.acknowledgeUnattended() } } }
      catch (err) { return mappedError(err) }
    },

    'POST /v1/workbench/approve': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      const artifactId = typeof value?.artifactId === 'string' ? value.artifactId : ''
      const sha256 = typeof value?.sha256 === 'string' ? value.sha256 : ''
      if (!TASK_ID.test(id) || !ARTIFACT_ID.test(artifactId) || !SHA256.test(sha256)) return invalid()
      try {
        await deps.workbench.approve(id, artifactId, sha256)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return mappedError(err)
      }
    },

    // 批准工作区脚本:hash = 主人在确认框里看到的那份内容;对不上 ⇒ 409 script_config_changed(重新拉详情再看)。
    'POST /v1/workbench/script-approve': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : '', hash = typeof value?.hash === 'string' ? value.hash : ''
      if (!TASK_ID.test(id) || !SHA256.test(hash) || Object.keys(value ?? {}).some(k => k !== 'id' && k !== 'hash')) return invalid()
      try { return { status: 200, body: { scripts: deps.workbench.approveScripts(id, hash) } } }
      catch (err) { return mappedError(err) }
    },

    // 看改动 / 逐文件标记与打回 / 行评论(2026-10-06 起)P3e 起是一件事上的动作,在 /v1/matter/changes、review-*。
    // 逐文件撤销(2026-10-06):恢复成这一轮开始前的内容。文件夹还被占着 ⇒ 409 workbench_busy;之后又改过 ⇒ 409 review_file_changed。
    // (独立工作区的 commit / remove / merge / reopen 与工作区脚本 run / stop 是一件事上的动作,P3e 起在 /v1/matter/worktree。)
    'POST /v1/workbench/review-revert': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      const artifactId = typeof value?.artifactId === 'string' ? value.artifactId : ''
      const path = value?.path
      if (!TASK_ID.test(id) || !ARTIFACT_ID.test(artifactId) || typeof path !== 'string' || !path || path.length > 4096 || Object.keys(value ?? {}).some(k => !['id', 'artifactId', 'path'].includes(k))) return invalid()
      try { return { status: 200, body: { reverted: deps.workbench.revertReviewFile(id, { artifactId, path }) } } }
      catch (err) { return mappedError(err) }
    },

    // 按块撤回 / 恢复:这件事有会话(哪怕答复过)/ 检查 / 脚本在跑 ⇒ 409 workbench_busy;块变了 ⇒ 409 review_hunk_stale;之后又改过 ⇒ 409 review_file_changed。
    'POST /v1/workbench/review-hunk': async (query, body) => {
      const value = objectBody(body)
      if (query.size || !value || Object.keys(value).sort().join(',') !== 'action,artifactId,hunk,hunkSha256,id,path' ||
          typeof value.id !== 'string' || !TASK_ID.test(value.id) || typeof value.artifactId !== 'string' || !ARTIFACT_ID.test(value.artifactId) ||
          typeof value.path !== 'string' || !value.path || value.path.length > 4096 || typeof value.hunk !== 'number' || !Number.isInteger(value.hunk) || value.hunk < 0 ||
          typeof value.hunkSha256 !== 'string' || !SHA256.test(value.hunkSha256) || (value.action !== 'revert' && value.action !== 'restore')) return invalid()
      try { return { status: 200, body: { hunk: deps.workbench.revertReviewHunk(value.id, { artifactId: value.artifactId, path: value.path, hunk: value.hunk, hunkSha256: value.hunkSha256, action: value.action }) } } }
      catch (err) { return mappedError(err) }
    },

    // 回到某一轮(2026-10-21):预览与执行 / 撤销是一件事上的动作,P3e 起在 /v1/matter/rewind;这一条是停住后主人拍板。
    'POST /v1/workbench/rewind-resolve': async (query, body) => {
      const value = objectBody(body)
      if (query.size || !value || Object.keys(value).sort().join(',') !== 'choice,id' || typeof value.id !== 'string' || !TASK_ID.test(value.id) ||
          (value.choice !== 'keep' && value.choice !== 'restore_backup')) return invalid()
      try { return { status: 200, body: { resolved: await deps.workbench.rewindResolve(value.id, value.choice) } } }
      catch (err) { return mappedError(err) }
    },
  }
}
