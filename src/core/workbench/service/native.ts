/**
 * native + handoff 域:原生会话(claude / codex 历史)的导入、续接决策、交接。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 6 项,排在第 7 项之后做);只认 ctx。
 * 跨域最重的一块:admission / attachments / view / execute 的动作都经 act()=ctx.actions.deref('native') 在调用时取,
 * 工厂体里不取。决策 Map(nativeDecisions / handoffDecisions)在 state 上,与 execute 共享同一实例。
 */
import { randomUUID } from 'node:crypto'
import { canonicalProject } from '../artifacts'
import { restartPreview, type Continuation } from '../continuation'
import { normalizeExecutionChoice, PROVIDER_EXECUTION_CHOICE, sameExecutionChoice } from '../execution-settings'
import { handoffArtifactText, handoffContext, handoffToken, handoffTokenHash, validateHandoffInput, type ArtifactSelection, type AttachmentSelection, type HandoffInput, type HandoffPreview } from '../handoff'
import { decodeNativeHistoryKey, historyDeadline, normalizeHistoryList, normalizeHistoryRead, type NativeHistoryListInput, type NativeHistoryProvider, type NativeHistoryReadInput } from '../native-history'
import { nativeImportInput, nativeResumeToken, pageInput, publicSource, readNativeImport, snapshotHash, type AcceptedNativeResume, type ImportPage, type NativeImportInput, type NativeResumeDecision } from '../native-adoption'
import { pathsConflict } from '../scheduler'
import type { AgentExecutionChoice } from '../../agent-provider'
import { publicTask, TERMINAL_TASK_STATUSES, type StoredTask } from '../store'
import { checkedText } from './checked-text'
import { directoryIdentity } from './directory-identity'
import type { ServiceCtx } from './ctx'
import type { AcceptedContinuation } from './state'
import type { InputMaterials, WorkbenchTaskView } from './types'

export function makeNativeDomain(ctx:ServiceCtx) {
  const { store, state } = ctx
  const act=()=>ctx.actions.deref('native')
  function nativeReader(id:string){const reader=ctx.deps.nativeHistory?.[id as NativeHistoryProvider];if(!reader)throw new Error('native_history_unsupported');return reader}
  async function currentNativePages(task:StoredTask,pages:ImportPage[]) {
    const call=historyDeadline(),key=Buffer.from(JSON.stringify({v:1,providerId:task.providerId,nativeId:store.source(task.id)!.nativeId})).toString('base64url')
    const current:ImportPage[]=[]
    for(const page of pages){
      const preview=await call(()=>nativeReader(task.providerId).read(key,pageInput(page)))
      if(preview.session.key!==key||preview.session.cwd!==task.path)throw new Error('native_history_changed')
      if(preview.session.remote||preview.session.observedState==='active'||ctx.deps.executionConflict?.(task.path,task.providerId,store.source(task.id)!.nativeId))throw new Error('native_session_busy')
      current.push({...page,sourceFingerprint:preview.sourceFingerprint})
    }
    return current
  }
  async function validateNativeDecision(task:StoredTask,decision:AcceptedNativeResume,dispatch=false) {
    if(decision.taskId!==task.id||decision.sourceId!==store.source(task.id)?.id||decision.expiresAt<Date.now()||(!dispatch&&decision.taskVersion!==act().taskVersion(task)))throw new Error('external_close_confirmation_stale')
    if(directoryIdentity(task.path)!==decision.directoryIdentity||canonicalProject(task.path)!==task.path)throw new Error('invalid_path')
    if(ctx.deps.executionConflict?.(task.path,task.providerId,decision.nativeId))throw new Error('native_session_busy')
    if(decision.mode==='native_resume'){
      if(task.sessionId!==decision.nativeId||!act().canResume(task))throw new Error('restart_confirmation_required')
      const current=await currentNativePages(task,decision.pages)
      if(JSON.stringify(current)!==JSON.stringify(decision.pages))throw new Error('external_close_confirmation_stale')
    }
  }
  async function previewHandoff(raw:HandoffInput):Promise<HandoffPreview> {
    ctx.ensureAccepting()
    const input=validateHandoffInput(raw),source=store.get(input.sourceTaskId),version=act().taskVersion(source)
    act().provider(input.targetProviderId)
    if(source.providerId===input.targetProviderId)throw new Error('invalid_request')
    if(canonicalProject(source.path)!==source.path)throw new Error('invalid_path')
    const identity=directoryIdentity(source.path)
    let artifacts=input.artifacts,attachments=input.attachments??[],target:StoredTask|null=null,targetContinuation:Continuation|undefined,nativeResume:NativeResumeDecision|undefined
    if(input.purpose==='revision') {
      target=store.get(input.targetTaskId!)
      if(target.archivedAt!==null)throw new Error('workbench_archived')
      if(state.runsByTask.has(target.id)||!TERMINAL_TASK_STATUSES.includes(target.status)||target.error==='writer_not_closed')throw new Error('workbench_busy')
      if(target.providerId!==input.targetProviderId||target.path!==source.path)throw new Error('invalid_handoff_target')
      const origin=store.handoffs(source.id).find(h=>h.purpose==='review'&&h.sourceTaskId===target!.id&&h.targetTaskId===source.id)
      const event=store.events(source.id).find(e=>e.id===input.quote!.eventId&&e.kind==='text')
      if(!origin||!event?.text.includes(input.quote!.text))throw new Error('invalid_handoff_quote')
      artifacts=origin.artifacts
      const original=store.handoffRecord(source.id,origin.id)
      if(snapshotHash(original.packetJson)!==original.packetSha256)throw Error('artifact_changed')
      attachments=(JSON.parse(original.packetJson) as {attachments?:AttachmentSelection[]}).attachments??[]
      targetContinuation=act().continuation(target)
      if(store.source(target.id)?.firstDispatchedAt===null)nativeResume=await prepareNativeResume(target.id,targetContinuation.mode==='restart_required'?'fresh_context':'native_resume')
    }
    const files=artifacts.map(a=>handoffArtifactText(store,a,target?.id??source.id,ctx.stateDir))
    const materials=act().handoffAttachments(attachments,target?.id??source.id)
    act().requireInput(input.targetProviderId,act().combinedAttachments(materials,targetContinuation?.mode==='restart_required'?targetContinuation.restart.attachments:[]),target?store.execution.choice(target.id):PROVIDER_EXECUTION_CHOICE,!!target&&targetContinuation?.mode==='resume')
    const packet=handoffContext({...input,attachments},source,store.events(source.id),files,materials)
    ctx.ensureAccepting()
    if(act().taskVersion(store.get(source.id))!==version)throw new Error('handoff_changed')
    const preview:HandoffPreview={token:handoffToken(),sourceTaskId:source.id,targetTaskId:target?.id??null,targetProviderId:input.targetProviderId,purpose:input.purpose,request:input.request,...packet,artifacts,targetExecution:target?store.execution.choice(target.id):{...PROVIDER_EXECUTION_CHOICE},...(attachments.length?{attachments}:{}),quote:input.quote??null,...(targetContinuation?{targetContinuation}:{}),...(nativeResume?{nativeResume}:{})}
    for(const [token,d] of state.handoffDecisions)if(d.expiresAt<Date.now()||d.preview.sourceTaskId===source.id)state.handoffDecisions.delete(token)
    if(state.handoffDecisions.size>=100)state.handoffDecisions.delete(state.handoffDecisions.keys().next().value!)
    state.handoffDecisions.set(preview.token,{preview:structuredClone(preview),sourceVersion:version,targetVersion:target?act().taskVersion(target):null,directoryIdentity:identity,expiresAt:Date.now()+5*60_000})
    return preview
  }
  async function handoff(input:{token:string;restartToken?:string;sourceClosedToken?:string}) {
    ctx.ensureAccepting()
    if(!input||typeof input.token!=='string'||! /^[a-f0-9]{64}$/.test(input.token))throw new Error('invalid_request')
    for(const optional of [input.restartToken,input.sourceClosedToken])if(optional!==undefined&&(typeof optional!=='string'||! /^[a-f0-9]{64}$/.test(optional)))throw new Error('invalid_request')
    const hash=handoffTokenHash(input.token),previous=store.handoffByToken(hash)
    if(previous)return{task:act().taskView(publicTask(store.get(previous.targetTaskId))),handoffId:previous.id,sourceTaskId:previous.sourceTaskId}
    const decision=state.handoffDecisions.get(input.token)
    if(!decision||decision.expiresAt<Date.now())throw new Error('handoff_changed')
    const p=decision.preview,source=store.get(p.sourceTaskId),target=p.targetTaskId?store.get(p.targetTaskId):null
    const assertCurrent=()=>{
      ctx.ensureAccepting()
      if(state.handoffDecisions.get(input.token)!==decision||decision.expiresAt<Date.now()||act().taskVersion(store.get(source.id))!==decision.sourceVersion||(target&&act().taskVersion(store.get(target.id))!==decision.targetVersion))throw new Error('handoff_changed')
      if(canonicalProject(source.path)!==source.path||directoryIdentity(source.path)!==decision.directoryIdentity)throw new Error('invalid_path')
      if(target?.archivedAt!=null)throw new Error('workbench_archived')
      if(target&&(state.runsByTask.has(target.id)||!TERMINAL_TASK_STATUSES.includes(target.status)||target.error==='writer_not_closed'))throw new Error('workbench_busy')
      if(ctx.deps.executionConflict?.(source.path,p.targetProviderId,target?.sessionId??null))throw new Error('native_session_busy')
    }
    assertCurrent();act().provider(p.targetProviderId)
    for(const ref of p.artifacts)handoffArtifactText(store,ref,target?.id??source.id,ctx.stateDir)
    const checkedHandoffAttachments=act().handoffAttachments(p.attachments??[],target?.id??source.id)
    let accepted:AcceptedContinuation={mode:'new'},native:AcceptedNativeResume|undefined
    if(target){
      const current=act().continuation(target)
      if(current.mode==='restart_required'){
        if(!input.restartToken)throw new Error('restart_confirmation_required')
        if(input.restartToken!==current.restart.token||p.targetContinuation?.mode!=='restart_required'||input.restartToken!==p.targetContinuation.restart.token)throw new Error('restart_confirmation_stale')
        accepted={mode:'restart',preview:current.restart}
      }else{
        if(input.restartToken!==undefined)throw new Error('restart_confirmation_stale')
        accepted=current.mode==='resume'?{mode:'resume',sessionId:target.sessionId!}:{mode:'new'}
      }
      if(store.source(target.id)?.firstDispatchedAt===null){
        native=input.sourceClosedToken?state.nativeDecisions.get(input.sourceClosedToken):undefined
        if(!native||input.sourceClosedToken!==p.nativeResume?.token)throw new Error('external_close_confirmation_required')
        await validateNativeDecision(target,native)
        assertCurrent()
        if(state.nativeDecisions.get(native.token)!==native)throw new Error('external_close_confirmation_stale')
      }
    }
    act().requireInput(p.targetProviderId,act().combinedAttachments(checkedHandoffAttachments,accepted.mode==='restart'?accepted.preview.attachments:[]),p.targetExecution??PROVIDER_EXECUTION_CHOICE,accepted.mode==='resume')
    const packetJson=JSON.stringify({context:p.context,request:p.request,artifacts:p.artifacts,attachments:p.attachments??[],quote:p.quote,truncated:p.truncated,continuation:accepted,execution:p.targetExecution})
    const record=store.createHandoff({id:randomUUID(),sourceTaskId:source.id,targetTaskId:target?.id??null,targetProviderId:p.targetProviderId,path:source.path,title:`检查 · ${source.title}`.slice(0,120),ownerChatId:source.ownerChatId,purpose:p.purpose,request:p.request,packetSha256:snapshotHash(packetJson),packetJson,artifactRefsJson:JSON.stringify(p.artifacts),quoteJson:p.quote?JSON.stringify(p.quote):null,sourceNativeId:source.sessionId,tokenHash:hash})
    state.handoffDecisions.delete(input.token)
    if(native)state.nativeDecisions.delete(native.token)
    let task:WorkbenchTaskView
    try{
      const materials=target
        ?act().handoffAttachments(p.attachments??[],target.id)
        :store.attachments.copyToTask(source.id,(p.attachments??[]).map(a=>a.attachmentId),record.targetTaskId)
      task=act().start(store.get(record.targetTaskId),p.context,decision.directoryIdentity,accepted,native,p.artifacts,record.id,undefined,materials,undefined,p.targetExecution)
    }
    catch(error){
      if(!target){store.update(record.targetTaskId,'failed',error instanceof Error?error.message:'task_failed');act().matterSync(m=>m.setStatus(record.targetTaskId,'done'))}
      store.addEvent(record.targetTaskId,'system','交接已记录，但本轮未启动。请查看任务状态，手动决定是否继续。')
      ctx.hub.touched(record.targetTaskId)
      throw error
    }
    return{task,handoffId:record.id,sourceTaskId:source.id}
  }
  function handoffRecord(taskId:string,id:string){
    const record=store.handoffRecord(taskId,id)
    if(snapshotHash(record.packetJson)!==record.packetSha256)throw new Error('artifact_changed')
    return{id:record.id,sourceTaskId:record.sourceTaskId,targetTaskId:record.targetTaskId,createdAt:record.createdAt,sourceNativeId:record.sourceNativeId,targetNativeId:record.targetNativeId,packetSha256:record.packetSha256,packet:JSON.parse(record.packetJson) as {context:string;request:string;truncated:boolean;artifacts:ArtifactSelection[];attachments?:AttachmentSelection[];continuation:AcceptedContinuation;execution?:AgentExecutionChoice}}
  }
  function conflictsExternal(path:string,providerId:string,nativeId:string|null):boolean {
    let canonical:string
    try{canonical=canonicalProject(path)}catch{return true}
    if(nativeId&&(store.sourceByIdentity(providerId,nativeId)||store.taskByNativeIdentity(providerId,nativeId)))return true
    return [...state.runsByTask.values()].some(run=>pathsConflict(run.path,canonical))
  }
  async function importNativeHistory(raw:NativeImportInput) {
    ctx.ensureAccepting()
    const input=nativeImportInput(raw),{providerId,nativeId}=decodeNativeHistoryKey(input.key)
    const existing=store.sourceByIdentity(providerId,nativeId)
    if(existing)return{task:act().taskView(publicTask(store.get(existing.taskId))),source:publicSource(existing),created:false}
    const managed=store.taskByNativeIdentity(providerId,nativeId)
    if(managed)throw new Error('native_session_already_managed')
    const read=await readNativeImport(nativeReader(providerId),input)
    ctx.ensureAccepting()
    if(!read.session.cwd)throw new Error('invalid_path')
    const path=canonicalProject(read.session.cwd)
    if(path!==read.session.cwd)throw new Error('invalid_path')
    const result=store.importSource({providerId,nativeId,cwd:path,title:read.session.title.slice(0,120),ownerChatId:ctx.deps.ownerChatId(),messages:read.messages,snapshotJson:read.snapshotJson,snapshotSha256:read.snapshotSha256,pagesJson:read.pagesJson,observedFingerprint:read.observedFingerprint,truncated:read.truncated})
    return{...result,task:act().taskView(publicTask(result.task))}
  }
  async function prepareNativeResume(id:string,mode:'native_resume'|'fresh_context'='native_resume',executionChoice?:unknown):Promise<NativeResumeDecision> {
    ctx.ensureAccepting()
    const task=store.get(id),source=store.source(id)
    if(!source||source.firstDispatchedAt!==null)throw new Error('invalid_request')
    if(mode!=='native_resume'&&mode!=='fresh_context')throw new Error('invalid_request')
    if(state.runsByTask.has(id)||task.archivedAt!==null)throw new Error('workbench_busy')
    const execution=normalizeExecutionChoice(executionChoice,store.execution.choice(id))
    act().requireInput(task.providerId,[],execution,mode==='native_resume')
    const identity=directoryIdentity(task.path),version=act().taskVersion(task),pages=JSON.parse(source.pagesJson) as ImportPage[]
    if(ctx.deps.executionConflict?.(task.path,task.providerId,source.nativeId))throw new Error('native_session_busy')
    const current=mode==='native_resume'?await currentNativePages(task,pages):pages
    if(mode==='native_resume'&&!act().canResume(task))throw new Error('restart_confirmation_required')
    const recovery=act().continuation(task)
    if(mode==='fresh_context'&&recovery.mode!=='restart_required')throw new Error('invalid_request')
    ctx.ensureAccepting()
    if(act().taskVersion(store.get(id))!==version||state.runsByTask.has(id))throw new Error('external_close_confirmation_stale')
    const preview=restartPreview(task,store.events(id),store.execution.choice(id))
    const decision:AcceptedNativeResume={token:nativeResumeToken(),taskId:id,sourceId:source.id,providerId:source.providerId,nativeId:source.nativeId,path:task.path,mode,expiresAt:Date.now()+5*60_000,context:mode==='fresh_context'?preview.context:'',truncated:source.truncated,changedSinceImport:JSON.stringify(current)!==JSON.stringify(pages),pages:current,taskVersion:version,directoryIdentity:identity,execution,...(mode==='fresh_context'?{restartToken:preview.token}:{})}
    for(const [token,value] of state.nativeDecisions)if(value.expiresAt<Date.now()||value.taskId===id)state.nativeDecisions.delete(token)
    if(state.nativeDecisions.size>=100)state.nativeDecisions.delete(state.nativeDecisions.keys().next().value!)
    state.nativeDecisions.set(decision.token,decision)
    const {pages:_pages,taskVersion:_version,directoryIdentity:_identity,restartToken:_restart,...result}=decision;return structuredClone(result)
  }
  async function continueNativeTask(id:string,text:string,sourceClosedToken:string,restartToken?:string,materials:InputMaterials={}):Promise<WorkbenchTaskView> {
    ctx.ensureAccepting();const task=store.get(id),decision=state.nativeDecisions.get(sourceClosedToken),attachments=act().selectAttachments(materials,id),request=checkedText(text,attachments)
    if(!decision)throw new Error('external_close_confirmation_stale')
    const execution=normalizeExecutionChoice(materials.execution,store.execution.choice(id))
    if(!sameExecutionChoice(execution,decision.execution))throw Error('external_close_confirmation_stale')
    if(state.runsByTask.has(id)||task.archivedAt!==null)throw new Error('workbench_busy')
    await validateNativeDecision(task,decision)
    ctx.ensureAccepting()
    if(act().taskVersion(store.get(id))!==decision.taskVersion||state.runsByTask.has(id)||state.nativeDecisions.get(sourceClosedToken)!==decision)throw new Error('external_close_confirmation_stale')
    const accepted:AcceptedContinuation=decision.mode==='native_resume'?{mode:'resume',sessionId:decision.nativeId}:{mode:'restart',preview:restartPreview(task,store.events(id),store.execution.choice(id))}
    if(accepted.mode==='restart'&&(restartToken!==accepted.preview.token||restartToken!==decision.restartToken))throw new Error('restart_confirmation_stale')
    act().requireInput(task.providerId,act().combinedAttachments(attachments,accepted.mode==='restart'?accepted.preview.attachments:[]),execution,accepted.mode==='resume')
    state.nativeDecisions.delete(sourceClosedToken)
    return act().start(task,request,decision.directoryIdentity,accepted,decision,undefined,undefined,undefined,attachments,materials.draftId,execution)
  }
  async function listNativeHistory(providerId:NativeHistoryProvider,input:NativeHistoryListInput) {
    const reader=ctx.deps.nativeHistory?.[providerId]
    if(!reader)throw new Error('native_history_unsupported')
    return reader.list(normalizeHistoryList(input))
  }
  async function readNativeHistory(key:string,input:NativeHistoryReadInput) {
    const {providerId}=decodeNativeHistoryKey(key),reader=ctx.deps.nativeHistory?.[providerId]
    if(!reader)throw new Error('native_history_unsupported')
    const preview=await reader.read(key,normalizeHistoryRead(input)),{nativeId}=decodeNativeHistoryKey(key)
    const managedTaskId=store.sourceByIdentity(providerId,nativeId)?.taskId??store.taskByNativeIdentity(providerId,nativeId)?.id
    return {...preview,...(managedTaskId?{managedTaskId}:{})}
  }

  return { nativeReader,currentNativePages,validateNativeDecision, previewHandoff,handoff,handoffRecord,conflictsExternal,importNativeHistory,prepareNativeResume,continueNativeTask,listNativeHistory,readNativeHistory }
}
export type NativeDomain = ReturnType<typeof makeNativeDomain>
