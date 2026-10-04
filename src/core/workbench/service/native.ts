/**
 * native + handoff 域:原生会话(claude / codex 历史)的导入、续接决策、交接。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 6 项,排在第 7 项之后做);只认 ctx。
 * 跨域最重的一块:admission / attachments / view / execute 的动作都经 act()=ctx.actions.deref('native') 在调用时取,
 * 工厂体里不取。决策 Map(nativeDecisions / handoffDecisions)在 state 上,与 execute 共享同一实例。
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { canonicalProject } from '../artifacts'
import { restartPreview, type Continuation } from '../continuation'
import { normalizeExecutionChoice, PROVIDER_EXECUTION_CHOICE, sameExecutionChoice } from '../execution-settings'
import { handoffArtifactText, handoffContext, handoffToken, handoffTokenHash, validateHandoffInput, type ArtifactSelection, type AttachmentSelection, type HandoffInput, type HandoffPreview } from '../handoff'
import { decodeNativeHistoryKey, historyDeadline, historyHash, normalizeHistoryList, normalizeHistoryRead, type NativeHistoryListInput, type NativeHistoryMessage, type NativeHistoryPreview, type NativeHistoryProvider, type NativeHistoryReadInput } from '../native-history'
import { NATIVE_CONTINUE_REFUSAL, nativeImportInput, nativeResumeToken, pageInput, publicSource, readNativeImport, selectNativeImportMessages, snapshotHash, type AcceptedNativeResume, type ImportPage, type NativeContinuePreview, type NativeContinueState, type NativeImportInput, type NativeResumeDecision } from '../native-adoption'
import { pathsConflict } from '../scheduler'
import type { AgentExecutionChoice } from '../../agent-provider'
import { publicTask, TERMINAL_TASK_STATUSES, type StoredTask } from '../store'
import { normalizeInputRequestId } from '../live-inputs'
import { checkedText } from './checked-text'
import { directoryIdentity } from './directory-identity'
import type { ServiceCtx } from './ctx'
import type { AcceptedContinuation } from './state'
import type { InputMaterials, WorkbenchTaskView } from './types'

/** 翻到最后一页最多读几次(每页 100 条):超了说读不了,而不是悄悄带开头。 */
const NATIVE_TAIL_MAX_READS=400
/** 读取器不能 seek 时一页页翻到尾的总预算(每页仍各有 NATIVE_HISTORY_TIMEOUT_MS 的单次时限,不共用那 15 秒)。 */
export const NATIVE_TAIL_WALK_MS=60_000
/** 能 seek 时从离结尾几条处开始读:5 页 × 100 正好装下且最后一页不满(nextCursor 为 null),不多一次空读。 */
const NATIVE_TAIL_ROWS=499
/** A read-only recent window must settle before the phone's request budget. */
export const NATIVE_RECENT_HISTORY_MS=8_000
export const NATIVE_RECENT_MAX_READS=80
/** 本进程记住的第一句 requestId 上限;只淘汰已落定的,在途的永不淘汰。 */
const FIRST_INPUTS_MAX=500
/**
 * 原生会话记下的 cwd ⇒ 工作台用的项目路径:桌面导入与手机「接着做」共用这一条规则。
 * 先 realpath(符号链接、Windows junction、macOS 的 /var → /private/var 都落到真目录),之后所有比较与守卫
 * (目录身份、「在用」判断、路径冲突、私有目录)都只看这个解析后的路径 —— 链接指到哪,就按哪个真目录判,
 * 链接本身不给任何额外的权限。悬空 / 不是目录 / 不是绝对路径 ⇒ invalid_path。
 */
export function nativeProjectPath(cwd:string|null|undefined):string {
  if(!cwd)throw new Error('invalid_path')
  return canonicalProject(cwd)
}
export function makeNativeDomain(ctx:ServiceCtx) {
  const { store, state } = ctx
  const act=()=>ctx.actions.deref('native')
  function nativeReader(id:string){const reader=ctx.deps.nativeHistory?.[id as NativeHistoryProvider];if(!reader)throw new Error('native_history_unsupported');return reader}
  async function currentNativePages(task:StoredTask,pages:ImportPage[]) {
    const call=historyDeadline(),key=Buffer.from(JSON.stringify({v:1,providerId:task.providerId,nativeId:store.source(task.id)!.nativeId})).toString('base64url')
    const current:ImportPage[]=[]
    for(const page of pages){
      const preview=await call(()=>nativeReader(task.providerId).read(key,pageInput(page)))
      if(preview.session.key!==key||preview.session.cwd!==store.source(task.id)!.cwd)throw new Error('native_history_changed')
      // 记下的路径没变、可它现在解析到的不再是任务的真目录(链接被改指)⇒ 不跟过去。
      if(nativeProjectPath(preview.session.cwd)!==task.path)throw new Error('invalid_path')
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
    // 任务走真目录;来源记下原样的 cwd(与真目录不同 ⇒ 不恢复原会话,见 admission.canResume)。
    const path=nativeProjectPath(read.session.cwd)
    const result=store.importSource({providerId,nativeId,cwd:read.session.cwd!,path,title:read.session.title.slice(0,120),ownerChatId:ctx.deps.ownerChatId(),messages:read.messages,snapshotJson:read.snapshotJson,snapshotSha256:read.snapshotSha256,pagesJson:read.pagesJson,observedFingerprint:read.observedFingerprint,truncated:read.truncated})
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
  async function continueNativeTask(id:string,text:string,sourceClosedToken:string,restartToken?:string,materials:InputMaterials={},extra:{inputRequestId?:string;attachmentPolicy?:'owner'}={}):Promise<WorkbenchTaskView> {
    ctx.ensureAccepting();const task=store.get(id),decision=state.nativeDecisions.get(sourceClosedToken),attachments=act().selectAttachments(materials,id,extra.attachmentPolicy),request=checkedText(text,attachments)
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
    // extra.inputRequestId 进 start 的 queuedInputId:与 continueTask 同一张回执表(spec D6);内部 API 不带尾参,行为不变。
    return act().start(task,request,decision.directoryIdentity,accepted,decision,undefined,undefined,extra.inputRequestId,attachments,materials.draftId,execution,undefined,extra.attachmentPolicy)
  }
  type ImportedOptions={inputRequestId?:string;draftId?:string;attachmentIds?:string[]}
  /**
   * 同一 requestId 的去重只算本进程(裁决 R10):回执表在库里,可上一进程的执行者已经随进程死了 ——
   * 重启时 store.recover 把那一轮记成 interrupted、回执记成 held,新进程里没有在跑的轮次,重新派发不会变成两轮。
   * 值是本进程里那次调用本身:同时来的重发直接等同一个结果(只起一次);失败的从表里拿掉,停了终端之后同一 id 能再发。
   */
  const firstInputs=new Map<string,{taskId:string;text:string;attachments:string;result:Promise<WorkbenchTaskView>;settled:boolean}>()
  /**
   * 手机说的第一句(spec 2026-10-01-tendhearth-continue-sessions D2/D3/D6):确认卡上主人已声明原程序停了;
   * 模式按桌面同一判法(能恢复 ⇒ native_resume,否则 fresh_context);决定令牌与 restartToken 只在这一次调用里活,
   * 从不离开 daemon。同一 requestId 重发 ⇒ 不起第二轮;正文 / 任务 / 材料不同 ⇒ input_conflict。
   */
  async function continueImported(id:string,text:string,options:ImportedOptions={},attachmentPolicy?:'owner'):Promise<WorkbenchTaskView> {
    ctx.ensureAccepting()
    if(options.inputRequestId===undefined)return firstImported(id,text,options,undefined,attachmentPolicy)
    const requestId=normalizeInputRequestId(options.inputRequestId)
    if(typeof text!=='string')throw new Error('invalid_text')
    const same=(taskId:string,body:string,ids:readonly string[])=>taskId===id&&body===text.trim()&&JSON.stringify([...ids].sort())===JSON.stringify([...(options.attachmentIds??[])].sort())
    const mine=firstInputs.get(requestId)
    if(mine){
      if(!same(mine.taskId,mine.text,JSON.parse(mine.attachments) as string[]))throw new Error('input_conflict')
      // 等同一次调用落定(它失败,这里也失败);成功则给此刻的任务视图,不是第一次调用时那份过期的。
      await mine.result
      return act().taskView(publicTask(store.get(id)))
    }
    const prior=store.liveInputs.get(requestId)
    if(prior){
      if(!same(prior.taskId,prior.text,(prior.attachments??[]).map(a=>a.id)))throw new Error('input_conflict')
      // 上一进程留下的回执:那句话已经派发给执行者 ⇒ 原样返回;还没派发(重启前没起来)⇒ 往下重新派发。
      const source=store.source(id)
      if(!source||source.firstDispatchedAt!==null)return act().taskView(publicTask(store.get(id)))
    }
    const result=firstImported(id,text,{...options,inputRequestId:requestId},prior?requestId:undefined,attachmentPolicy)
    const entry={taskId:id,text:text.trim(),attachments:JSON.stringify(options.attachmentIds??[]),result,settled:false}
    firstInputs.set(requestId,entry)
    if(firstInputs.size>FIRST_INPUTS_MAX)for(const [k,v] of firstInputs)if(v.settled){firstInputs.delete(k);break}
    result.then(()=>{entry.settled=true},()=>{entry.settled=true;if(firstInputs.get(requestId)===entry)firstInputs.delete(requestId)})
    return result
  }
  async function firstImported(id:string,text:string,options:ImportedOptions,redispatch:string|undefined,attachmentPolicy?:'owner'):Promise<WorkbenchTaskView> {
    const task=store.get(id),source=store.source(id)
    if(!source||source.firstDispatchedAt!==null)throw new Error('invalid_request')
    const mode=act().canResume(task)?'native_resume':'fresh_context'
    // 不接管活着的会话:native_resume 的 prepare 会重读全部页;带记录新开一轮不重读,这里补读最后一页查「在跑」。
    if(mode==='fresh_context')await currentNativePages(task,(JSON.parse(source.pagesJson) as ImportPage[]).slice(-1))
    const prepared=await prepareNativeResume(id,mode)
    const decision=state.nativeDecisions.get(prepared.token)
    if(!decision)throw new Error('external_close_confirmation_stale')
    const materials:InputMaterials={...(options.draftId!==undefined?{draftId:options.draftId}:{}),...(options.attachmentIds!==undefined?{attachmentIds:options.attachmentIds}:{})}
    const view=await continueNativeTask(id,text,prepared.token,decision.restartToken,materials,{...(options.inputRequestId!==undefined?{inputRequestId:options.inputRequestId}:{}),...(attachmentPolicy?{attachmentPolicy}:{})})
    // 重新派发沿用上一进程的回执:start 只在回执不存在时才写,所以 run_id 仍是那轮死掉的 —— 无妨,送达是按
    // running.queuedInputId(就是这个 requestId)认的,不看 run_id。held ⇒ sending,送到后照常变 delivered。
    // 再记一行,把第二条同样的「用户」事件说清楚。
    if(redispatch){
      store.liveInputs.set(redispatch,'sending')
      store.addEvent(id,'system','CC 重启后按同一请求重发了一次。')
      ctx.hub.touched(id)
    }
    return view
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
  /** Recent reading never imports or takes ownership of the provider session. */
  async function readRecentNativeHistory(key:string,input:{limit:number}):Promise<NativeHistoryPreview> {
    const {providerId,nativeId}=decodeNativeHistoryKey(key),reader=nativeReader(providerId)
    const {limit}=normalizeHistoryRead({limit:input?.limit}),expiresAt=Date.now()+NATIVE_RECENT_HISTORY_MS,budget=historyDeadline(NATIVE_RECENT_HISTORY_MS)
    const call=async<T>(run:()=>Promise<T>):Promise<T>=>{
      const result=await budget(run)
      if(Date.now()>=expiresAt)throw new Error('native_history_unavailable')
      return result
    }
    let cursor=reader.tailCursor?await call(()=>reader.tailCursor!(key,limit)):null
    const startCursor=cursor,seenCursors=new Set<string|null>(),messages=new Map<string,NativeHistoryMessage>(),fingerprints:string[]=[]
    let first:NativeHistoryPreview|undefined
    for(let reads=0;reads<NATIVE_RECENT_MAX_READS;reads++){
      if(seenCursors.has(cursor))throw new Error('native_history_unavailable')
      seenCursors.add(cursor)
      const page=await call(()=>reader.read(key,{limit:100,...(cursor!==null?{cursor}:{})}))
      if(page.session.key!==key||page.session.providerId!==providerId||(first&&page.session.cwd!==first.session.cwd))throw new Error('native_history_changed')
      first??=page;fingerprints.push(page.sourceFingerprint)
      for(const message of page.messages){
        messages.delete(message.id);messages.set(message.id,message)
        if(messages.size>limit)messages.delete(messages.keys().next().value!)
      }
      if(page.nextCursor===null){
        const recent=[...messages.values()],managedTaskId=store.sourceByIdentity(providerId,nativeId)?.taskId??store.taskByNativeIdentity(providerId,nativeId)?.id
        return {...page,messages:recent,nextCursor:null,page:{limit,cursor:startCursor},truncated:recent.some(message=>message.truncated),sourceFingerprint:historyHash({window:'recent',key,fingerprints,messages:recent}),...(managedTaskId?{managedTaskId}:{})}
      }
      cursor=page.nextCursor
    }
    throw new Error('native_history_unavailable')
  }

  /**
   * 手机「接着做」:这条电脑上的会话现在能不能接、接的话是哪种(spec 2026-10-01-tendhearth-continue-sessions §4.1)。
   * 只读;page 留给 adoptNativeSession 用(省一次读)。判定顺序就是 spec 里的 1–9,别调换:
   * 「已有任务管着」先于一切(接过的永远能打开),「忙」先于「额度」(先说能不能碰,再说碰了会怎样)。
   */
  async function inspectNativeSession(key:string):Promise<{preview:NativeContinuePreview;page:NativeHistoryPreview|null}> {
    const {providerId,nativeId}=decodeNativeHistoryKey(key)
    const managedId=store.sourceByIdentity(providerId,nativeId)?.taskId??store.taskByNativeIdentity(providerId,nativeId)?.id
    if(managedId)return{preview:{state:'managed',providerId,project:basename(store.get(managedId).path),mode:null,taskId:managedId},page:null}
    const page=await historyDeadline()(()=>nativeReader(providerId).read(key,{limit:100}))
    if(page.session.key!==key)throw new Error('native_history_changed')
    const cwd=page.session.cwd
    // 目录名:解析得到就给真目录的(与接过之后 managed 给的一致),解析不了就给记下的。
    let project=cwd?basename(cwd):null
    const out=(state:NativeContinueState,mode:NativeContinuePreview['mode']=null)=>({preview:{state,providerId,project,mode,taskId:null},page})
    let path:string
    try{path=nativeProjectPath(cwd)}catch{return out('folder_missing')}
    project=basename(path)
    try{act().provider(providerId)}catch{return out('provider_missing')}
    // 看得见的「在跑」(Codex 的 active / 远程会话)与 CC 自己占着的;普通终端里的 Claude Code 看不见,靠确认卡上的声明(spec D3)。
    if(page.session.remote||page.session.observedState==='active')return out('busy_session')
    if(ctx.deps.executionConflict?.(path,providerId,null))return out('busy_folder')
    if(ctx.deps.executionConflict?.(path,providerId,nativeId))return out('busy_session')
    if(act().quotaExhausted(providerId))return out('quota')
    if(!selectNativeImportMessages(page.messages).length)return out('empty')
    // 还没有任务:用将要建的任务的三样(执行者、会话 id、目录)问能不能恢复 —— 与 prepareNativeResume 的判法一致(spec D2)。
    // 记下的路径 ≠ 真路径(经过链接)⇒ 只带记录新开,与 admission.canResume 对导入任务的判法一致。
    const resumable=path===cwd&&act().canResume({providerId,sessionId:nativeId,path} as StoredTask)
    return out('ready',resumable?'native_resume':'fresh_context')
  }
  async function previewNativeContinue(key:string):Promise<NativeContinuePreview> {
    return (await inspectNativeSession(key)).preview
  }
  /** 导入的任务补一行 matter(spec D4):与 execute.createTask 的登记一致。没接 matters ⇒ 手机进不去,直说。 */
  function ensureTaskMatter(task:StoredTask):void {
    const m=ctx.deps.matters
    if(!m)throw new Error('matters_not_wired')
    // 三步同一事务;且只有 create 看「已有」—— linkTask / bind 都幂等,每次都跑:哪一步中途失败,下次再点都能补齐。
    // 状态与 execute 的终态登记一致:完成 / 失败 / 取消 ⇒ done;interrupted 与仍在跑的 ⇒ open。
    store.atomic(()=>{
      if(!m.get(task.id))m.create({id:task.id,kind:'task',title:task.title,projectPath:task.path,ownerChatId:task.ownerChatId??null,status:task.status==='completed'||task.status==='failed'||task.status==='cancelled'?'done':'open'})
      m.linkTask(task.id)
      if(task.ownerChatId)m.bind(task.id,'wechat',task.ownerChatId)
    })
  }
  /**
   * 带过来的要是最近的,不是开头 100 条(裁决 R2):拿到会话尾部最后 ≤5 页 —— 与桌面「继续读取原对话」同一个窗口
   * (state.pages.slice(-5)),也正是 importNativeHistory 收的页数上限。能 seek 的读取器(Claude)直接从离结尾
   * NATIVE_TAIL_ROWS 条处读:每次 read 都要重新解析整份记录,一页页翻是平方级的。不能 seek 的(Codex)才一页页翻,
   * 每页各自一个单次时限,整趟另有 NATIVE_TAIL_WALK_MS 的总预算。
   */
  async function tailPages(key:string,first:NativeHistoryPreview):Promise<NativeHistoryPreview[]> {
    const reader=nativeReader(first.session.providerId),started=Date.now()
    const read=async(cursor:string)=>{
      if(Date.now()-started>NATIVE_TAIL_WALK_MS)throw new Error('native_history_unavailable')
      const next=await historyDeadline()(()=>reader.read(key,{limit:100,cursor}))
      if(next.session.key!==key||next.session.cwd!==first.session.cwd)throw new Error('native_history_changed')
      return next
    }
    const seek=first.nextCursor!==null&&reader.tailCursor?await historyDeadline()(()=>reader.tailCursor!(key,NATIVE_TAIL_ROWS)):null
    let pages=[seek===null?first:await read(seek)]
    for(let reads=1;pages.at(-1)!.nextCursor!==null;reads++){
      if(reads>=NATIVE_TAIL_MAX_READS)throw new Error('native_history_unavailable')
      pages=[...pages,await read(pages.at(-1)!.nextCursor!)].slice(-5)
    }
    return pages
  }
  /**
   * 手机「接着做」/「打开这件事」:幂等。已有任务 ⇒ 只补 matter 行;能接 ⇒ 按桌面同一规则挑消息、走现有导入、补 matter 行;
   * 其余 ⇒ NATIVE_CONTINUE_REFUSAL 里的错误码。读与导入之间会话变了 ⇒ 重来一次。matter 行补建失败不回滚导入:
   * 下次再点走 managed 再补(自愈)。不起执行者、不碰电脑上的原会话。
   */
  async function adoptNativeSession(key:string):Promise<{taskId:string;created:boolean}> {
    ctx.ensureAccepting()
    for(let attempt=0;;attempt++){
      const {preview,page}=await inspectNativeSession(key)
      if(preview.state==='managed'){ensureTaskMatter(store.get(preview.taskId!));return{taskId:preview.taskId!,created:false}}
      if(preview.state!=='ready')throw new Error(NATIVE_CONTINUE_REFUSAL[preview.state])
      try{
        const pages=await tailPages(key,page!)
        // 与桌面同一挑法:窗口里按 id 去重、至多 500 条,再从最新往前挑(selectNativeImportMessages)。
        const messages=selectNativeImportMessages([...new Map(pages.flatMap(p=>p.messages).map(m=>[m.id,m])).values()].slice(-500))
        if(!messages.length)throw new Error('native_history_empty')
        const result=await importNativeHistory({key,pages:pages.map(p=>({...p.page,sourceFingerprint:p.sourceFingerprint})),messageIds:messages.map(m=>m.id)})
        ensureTaskMatter(store.get(result.task.id))
        return{taskId:result.task.id,created:result.created}
      }catch(error){
        if(attempt===0&&error instanceof Error&&error.message==='native_history_changed')continue
        throw error
      }
    }
  }
  /** 门面(service.ts)整块展开的公开面;nativeReader / currentNativePages / validateNativeDecision 是域内与 execute 用的,不进门面。 */
  const api={ previewHandoff,handoff,handoffRecord,conflictsExternal,importNativeHistory,prepareNativeResume,continueNativeTask,listNativeHistory,readNativeHistory,readRecentNativeHistory,
    /** 手机「接着做」(spec 2026-10-01-tendhearth-continue-sessions):只读预览 / 幂等地接成一件事。 */
    previewNativeContinue,adoptNativeSession,
    /** 手机说的第一句给「导入了、还没发过第一句」的任务(spec D5):令牌不出 daemon、按 requestId 幂等。 */
    continueImported }
  return { nativeReader,currentNativePages,validateNativeDecision, previewHandoff,handoff,handoffRecord,conflictsExternal,importNativeHistory,prepareNativeResume,continueNativeTask,continueImported,listNativeHistory,readNativeHistory,readRecentNativeHistory,previewNativeContinue,adoptNativeSession, api }
}
export type NativeDomain = ReturnType<typeof makeNativeDomain>
