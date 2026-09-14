import {makeRunUserInput,type RunUserInput} from './user-input'
import {makeWechatWorkbenchControl,type WechatMessageIdentity,type WechatWorkbenchReply} from './wechat-control'
import {makeProjectCatalog} from './project-catalog'
import type {CreationReceipt} from './creation-receipts'
import type {WechatNotificationNotice,WechatNoticeKind} from './wechat-notifications'
import type {ArtifactDeliveryReceipt} from './artifact-deliveries'
import {normalizeInputRequestId,sameAttachments,type LiveInput} from './live-inputs'
import type {Attachment} from './attachments'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { AgentEvent, AgentSession, AgentExecutionChoice, AgentModelCatalog, AgentRuntimeSnapshot } from '../agent-provider'
import {executionFailureMessage,normalizeExecutionChoice,PROVIDER_EXECUTION_CHOICE,sameExecutionChoice} from './execution-settings'
import type { ProviderRegistry } from '../provider-registry'
import { TIER_PROFILES, sessionAuthEnv } from '../user-tier'
import { canonicalProject, collectArtifacts, outputDirectory, readArtifactSnapshot, saveArtifactSnapshot } from './artifacts'
import { captureGitBaseline, finishGitReview, serializeGitReview, GIT_REVIEW_MIME, type GitBaseline } from './git-review'
import { decodeNativeHistoryKey, normalizeHistoryList, normalizeHistoryRead, type NativeHistoryReader, type NativeHistoryProvider, type NativeHistoryListInput, type NativeHistoryReadInput } from './native-history'
import {readNativeImport,nativeImportInput,publicSource,pageInput,nativeResumeToken,snapshotHash,type ImportPage,type NativeImportInput,type NativeResumeDecision,type AcceptedNativeResume} from './native-adoption'
import {historyDeadline} from './native-history'
import {handoffToken,handoffTokenHash,validateHandoffInput,handoffArtifactText,handoffContext,type HandoffInput,type HandoffPreview,type ArtifactSelection,type AttachmentSelection} from './handoff'
import {pathsConflict} from './scheduler'
import { restartPreview, type Continuation, type RestartPreview } from './continuation'
import { makeRunPermissions, type PermissionDecision, type RunPermissions, WORKBENCH_PERMISSION_TIMEOUT_MS } from './permissions'
import { findPathBlocker, type PathReservation, type WaitingFor } from './scheduler'
import { publicTask, TERMINAL_TASK_STATUSES, type WorkbenchListQuery, type StoredTask, type Task, type TaskStatus, type WorkbenchStore } from './store'

interface Options {
  store: WorkbenchStore
  registry: ProviderRegistry
  stateDir: string
  ownerChatId: () => string | null
  defaultProvider?: string
  registeredProjects?:()=>Array<{alias:string;path:string}>
  executionConflict?:(path:string,providerId:string,nativeId:string|null)=>boolean
  nativeHistory?:Partial<Record<NativeHistoryProvider,NativeHistoryReader>>
  mintSessionToken?: (sessionKey: string) => string
  revokeSessionToken?: (sessionKey: string) => void
  holdBusy?: (label: string) => () => void
  timeoutMs?: number
  closeTimeoutMs?: number
  permissionTimeoutMs?: number
}
type AcceptedContinuation = { mode: 'new' } | { mode: 'resume'; sessionId: string } | { mode: 'restart'; preview: RestartPreview }
interface Active extends PathReservation {
  execution:AgentExecutionChoice
  attachments:Attachment[]
  handoffId?:string
  handoffArtifacts?:ArtifactSelection[]
  nativeResume?:AcceptedNativeResume
  reviewBaseline?: GitBaseline
  continuation: AcceptedContinuation
  task: StoredTask
  directoryIdentity: string
  cancelled: boolean
  session?: AgentSession
  done: Promise<void>
  resolveDone: () => void
  stop: Promise<null>
  signalStop: () => void
  permissions: RunPermissions
  questions: RunUserInput
  queuedInputId?:string
  finishing?:boolean
  delivering?:boolean
  runtimeInputs?:Map<string,LiveInput>
  interactionAt:number
  releaseBusy?: () => void
  publicFinished: boolean
  uncertain: boolean
  artifactsCollected: boolean
  collection?:Promise<void>
  credentialsMinted: boolean
  credentialsRevoked: boolean
}
export interface InputMaterials {attachmentIds?:string[];draftId?:string;execution?:unknown}
export interface CreateTask extends InputMaterials { title?: string; path: string; providerId: string; text: string }
export interface CreateWechatTask {ownerChatId:string;accountId:string;requestId:string;commandHash:string;projectId:string;providerId?:string;text:string}
export interface SendWechatArtifact {ownerChatId:string;accountId:string;requestId:string;commandHash:string;taskId:string;artifactId:string}
export interface WorkbenchTaskView extends Task { importedOnly?:boolean; canArchive:boolean; waitingFor: WaitingFor | null; pendingPermissionCount?: number; pendingQuestionCount?:number; runtime?:AgentRuntimeSnapshot }

function checkedText(text: string,attachments:readonly Attachment[]=[]): string {
  if (typeof text !== 'string' || (!text.trim()&&!attachments.length) || text.length > 20_000) throw new Error('invalid_text')
  return text.trim()
}
function directoryIdentity(path:string):string {
  const stat=statSync(path,{bigint:true})
  if (!stat.isDirectory()) throw new Error('invalid_path')
  return `${stat.dev}:${stat.ino}`
}
const RECOVERY_MESSAGE='原执行会话暂时无法恢复。请打开桌面工作台，查看恢复选项并确认是否带此前记录重新开始。'
const SUPPORTED = ['claude','codex']
const INPUT_UNCONFIRMED='未确认执行者收到，请检查当前对话后再决定是否重发。'

/** Cancellation must clear the idle timer even if a broken adapter leaves next() pending. */
async function collectWorkbenchTurn(events: AsyncIterable<AgentEvent>, stop: Promise<null>, timeoutMs: number, observe: (event: AgentEvent) => void, waiting:()=>boolean=()=>false,interactionAt:()=>number=()=>0,begin?:()=>void) {
  const iterator=events[Symbol.asyncIterator]()
  let result: Extract<AgentEvent,{kind:'result'}> | undefined
  let error: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Install the lifetime consumer before native start can publish any events.
    begin?.()
    for (;;) {
      let startedAt=Date.now(),paused=waiting()
      const next=iterator.next(),idle=Symbol('idle')
      const step=await (async()=>{
        for(;;){
          const nowPaused=waiting()
          if(nowPaused||paused)startedAt=Date.now()
          paused=nowPaused
          const value=await Promise.race([next,stop,new Promise<typeof idle>(resolve=>{timer=setTimeout(()=>resolve(idle),paused?timeoutMs:Math.max(1,timeoutMs-(Date.now()-Math.max(startedAt,interactionAt()))))})])
          if(timer){clearTimeout(timer);timer=undefined}
          if(value!==idle)return value
          if(paused)continue
          if(!waiting()&&Date.now()-Math.max(startedAt,interactionAt())>=timeoutMs)throw Error('turn_timeout')
        }
      })()
      if (timer) { clearTimeout(timer); timer=undefined }
      if (!step) return null
      if (step.done) return { result,error }
      observe(step.value)
      if (step.value.kind==='result') result=step.value
      if (step.value.kind==='error') error=step.value.message
    }
  } finally {
    if (timer) clearTimeout(timer)
    void Promise.resolve(iterator.return?.()).catch(() => {})
  }
}

export function makeWorkbenchService(opts: Options) {
  const { store } = opts
  const selectAttachments=(input:InputMaterials={},taskId?:string)=>store.attachments.select(input.attachmentIds??[],taskId,input.draftId)
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
      store.attachments.read(expectedTaskId,refs[i]!.attachmentId,opts.stateDir)
    }
    return files
  }
  const autoContinueBlocked=new Set<string>()
  function holdInputs(id:string,error:string){
    autoContinueBlocked.add(id)
    try{
      store.atomic(()=>{
        // A native send awaiting acknowledgement is ambiguous, even after stop.
        for(const saved of runsByTask.get(id)?.runtimeInputs?.values()??[]){
          const current=store.liveInputs.get(saved.id)
          if(current?.status==='sending'&&current.taskId===saved.taskId&&current.runId===saved.runId&&current.text===saved.text&&sameAttachments(current.attachments,saved.attachments))store.liveInputs.set(saved.id,'held',INPUT_UNCONFIRMED)
        }
        store.liveInputs.hold(id,error)
      })
      autoContinueBlocked.delete(id)
    }catch{/* Stop must not depend on a successful disk write. */}
  }
  const runsByTask=new Map<string,Active>()
  const reservations=new Map<string,Active>()
  const queue:Active[]=[]
  const runningText=new Map<string,string>()
  const collections=new Set<Promise<void>>()
  const nativeDecisions=new Map<string,AcceptedNativeResume>()
  const handoffDecisions=new Map<string,{preview:HandoffPreview;sourceVersion:string;targetVersion:string|null;directoryIdentity:string;expiresAt:number}>()
  let order=0
  let stopping=false
  let shutdownComplete=false
  let shutdownPromise:Promise<void> | undefined
  let noticeWake:(context?:{ownerChatId:string;accountId:string})=>Promise<void>=async()=>{}
  let artifactDelivery:((id:string)=>Promise<ArtifactDeliveryReceipt>)|undefined
  const wakeNotices=(context?:{ownerChatId:string;accountId:string})=>queueMicrotask(()=>{if(!stopping)void noticeWake(context).catch(()=>{})})
  store.recover()
  store.liveInputs.recover()

  function enqueueNotice(task:StoredTask,runId:string,kind:WechatNoticeKind,text:string,requestId:string|null=null){
    try{
      const watch=store.wechatNotifications.subscription(task.id)
      if(!watch?.enabled||watch.ownerChatId!==task.ownerChatId||watch.ownerChatId!==opts.ownerChatId())return
      store.wechatNotifications.enqueue({taskId:task.id,runId,ownerChatId:watch.ownerChatId,accountId:watch.accountId,kind,requestId,text:text.slice(0,4000)})
      wakeNotices()
    }catch{
      // A notification failure must not deny a valid permission or terminate execution.
      try{store.addEvent(task.id,'system','微信提醒未能保存；任务仍可在工作台查看。',null,runId)}catch{}
    }
  }
  function requestNotice(task:StoredTask,runId:string,kind:'permission'|'question',id:string,label:string){
    enqueueNotice(task,runId,kind,`${task.title.replace(/[\r\n]+/g,' ')} · ${task.id}\n${task.providerId} · ${kind==='permission'?'需要你批准':'需要你回答'}\n\n${label.slice(0,600)}\n\n查看：任务 ${task.id} ${kind==='permission'?'权限':'问题'} ${id}`,id)
  }
  function stageFinishedNotice(running:Active,status:TaskStatus){
    if(!TERMINAL_TASK_STATUSES.includes(status))return
    const watch=store.wechatNotifications.subscription(running.taskId)
    if(!watch?.enabled||watch.ownerChatId!==running.task.ownerChatId||watch.ownerChatId!==opts.ownerChatId())return
    const reply=store.events(running.taskId).filter(e=>e.runId===running.identity&&e.kind==='text').at(-1)?.text
    const label={completed:'这一轮已完成',failed:'这一轮需要处理',interrupted:'这一轮已中断',cancelled:'这一轮已停止'}[status as 'completed'|'failed'|'interrupted'|'cancelled']
    const artifacts=store.artifacts(running.taskId).slice(0,5)
    const text=`${running.title.replace(/[\r\n]+/g,' ')} · ${running.taskId}\n${running.task.providerId} · ${label}\n\n${reply?reply.slice(0,1800)+'\n\n':''}${artifacts.length?'已保存成果：'+artifacts.map(a=>a.name).join('、').slice(0,500)+'\n\n':''}查看：任务 ${running.taskId}\n结果：任务 ${running.taskId} 结果`
    // Persist the frozen result in the same transaction as the terminal task status.
    store.wechatNotifications.stage({taskId:running.taskId,runId:running.identity,ownerChatId:watch.ownerChatId,accountId:watch.accountId,kind:status as WechatNoticeKind,text:text.slice(0,4000)})
  }
  function publishFinishedNotices(){
    try{store.wechatNotifications.materializeIntents()}catch{/* The durable intent remains available to the worker or next startup. */}
    wakeNotices()
  }

  function provider(id: string) {
    const entry = SUPPORTED.includes(id) ? opts.registry.get(id) : null
    if (!entry) throw new Error('unavailable_provider')
    return entry
  }
  function canResume(task:StoredTask):boolean {
    try { return !!task.sessionId && !!provider(task.providerId).opts.canResume(task.path,task.sessionId) }
    catch { return false }
  }
  function continuation(task:StoredTask,execution:AgentExecutionChoice=store.execution.choice(task.id)):Continuation {
    const events=store.events(task.id)
    if (!events.some(event => event.kind==='user' || event.kind==='text')) return {mode:'new'}
    if (canResume(task)) return {mode:'resume'}
    return {mode:'restart_required',restart:restartPreview(task,events,execution,store.execution.choice(task.id))}
  }
  function taskVersion(task:StoredTask){return snapshotHash(JSON.stringify({updatedAt:task.updatedAt,status:task.status,sessionId:task.sessionId,events:store.events(task.id),source:store.source(task.id)?.firstDispatchedAt,execution:store.execution.choice(task.id)}))}
  function nativeReader(id:string){const reader=opts.nativeHistory?.[id as NativeHistoryProvider];if(!reader)throw new Error('native_history_unsupported');return reader}
  async function currentNativePages(task:StoredTask,pages:ImportPage[]) {
    const call=historyDeadline(),key=Buffer.from(JSON.stringify({v:1,providerId:task.providerId,nativeId:store.source(task.id)!.nativeId})).toString('base64url')
    const current:ImportPage[]=[]
    for(const page of pages){
      const preview=await call(()=>nativeReader(task.providerId).read(key,pageInput(page)))
      if(preview.session.key!==key||preview.session.cwd!==task.path)throw new Error('native_history_changed')
      if(preview.session.remote||preview.session.observedState==='active'||opts.executionConflict?.(task.path,task.providerId,store.source(task.id)!.nativeId))throw new Error('native_session_busy')
      current.push({...page,sourceFingerprint:preview.sourceFingerprint})
    }
    return current
  }
  async function validateNativeDecision(task:StoredTask,decision:AcceptedNativeResume,dispatch=false) {
    if(decision.taskId!==task.id||decision.sourceId!==store.source(task.id)?.id||decision.expiresAt<Date.now()||(!dispatch&&decision.taskVersion!==taskVersion(task)))throw new Error('external_close_confirmation_stale')
    if(directoryIdentity(task.path)!==decision.directoryIdentity||canonicalProject(task.path)!==task.path)throw new Error('invalid_path')
    if(opts.executionConflict?.(task.path,task.providerId,decision.nativeId))throw new Error('native_session_busy')
    if(decision.mode==='native_resume'){
      if(task.sessionId!==decision.nativeId||!canResume(task))throw new Error('restart_confirmation_required')
      const current=await currentNativePages(task,decision.pages)
      if(JSON.stringify(current)!==JSON.stringify(decision.pages))throw new Error('external_close_confirmation_stale')
    }
  }
  function ensureAccepting() {
    if (stopping) throw new Error('workbench_stopping')
  }
  function waitingFor(running:Active):WaitingFor|null {
    if (running.state !== 'queued') return null
    const earlier=queue.filter(item => item.order < running.order && item.state === 'queued')
    return findPathBlocker(running,[...reservations.values(),...earlier])
  }
  function runtimeSnapshot(running:Active|undefined):AgentRuntimeSnapshot|undefined {
    const runtime=running?.session?.workbenchRuntime
    return runtime?{...runtime.snapshot()}:undefined
  }
  function inputMode(running:Active):'steer'|'send'|'queue' {
    return runtimeSnapshot(running)?.input??(running.session?.steer?'steer':'queue')
  }
  function taskView(task:Task, includePermissions=false):WorkbenchTaskView {
    const running=runsByTask.get(task.id)
    const runtime=runtimeSnapshot(running)
    return {
      ...task,
      ...(runtime?{runtime}:{}),
      ...(!running&&TERMINAL_TASK_STATUSES.includes(task.status)&&store.source(task.id)?.firstDispatchedAt===null?{importedOnly:true}:{}),
      canArchive:TERMINAL_TASK_STATUSES.includes(task.status) && !running && task.error!=='writer_not_closed',
      waitingFor:running ? waitingFor(running) : null,
      ...(includePermissions ? { pendingPermissionCount:running?.permissions.pending().length ?? 0,pendingQuestionCount:running?.questions.pending().length ?? 0 } : {}),
    }
  }
  function collect(running:Active):Promise<void> {
    if(running.collection)return running.collection
    if(shutdownComplete)return Promise.resolve()
    const pending=captureOutputs(running)
    running.collection=pending;collections.add(pending)
    void pending.then(()=>collections.delete(pending),()=>collections.delete(pending))
    return pending
  }
  async function captureOutputs(running:Active) {
    if (running.artifactsCollected || shutdownComplete) return
    running.artifactsCollected=true
    try {
      if (canonicalProject(running.path) !== running.path || directoryIdentity(running.path) !== running.directoryIdentity) throw new Error('invalid_path')
      if(running.reviewBaseline && running.session) {
        try {
          const report=await finishGitReview(running.reviewBaseline)
          if(shutdownComplete)return
          if(canonicalProject(running.path)!==running.path || directoryIdentity(running.path)!==running.directoryIdentity)throw new Error('invalid_path')
          if(report)saveArtifactSnapshot(store,running.taskId,{name:`代码变更-${running.identity.slice(0,8)}.json`,mime:GIT_REVIEW_MIME,bytes:serializeGitReview(report)},opts.stateDir)
        } catch { store.addEvent(running.taskId,'system','代码对比未能保存；其他成果仍会单独收集。') }
      }
      if(canonicalProject(running.path)!==running.path || directoryIdentity(running.path)!==running.directoryIdentity)throw new Error('invalid_path')
      for (const warning of collectArtifacts(store,running.taskId,running.path,opts.stateDir)) store.addEvent(running.taskId,'system',warning)
    }
    catch { try { store.addEvent(running.taskId,'system','本轮成果目录无法读取，请检查文件夹权限或是否被移动。') } catch { /* storage is already unavailable */ } }
  }
  function revokeCredentials(running:Active) {
    if (!running.credentialsMinted || running.credentialsRevoked) return
    running.credentialsRevoked=true
    try { opts.revokeSessionToken?.(`workbench/${running.taskId}`) } catch { /* token expiry remains fail closed */ }
  }
  function releaseReservation(running:Active) {
    if (reservations.get(running.identity) === running) reservations.delete(running.identity)
    if (runsByTask.get(running.taskId) === running) runsByTask.delete(running.taskId)
    runningText.delete(running.identity)
    const release=running.releaseBusy; running.releaseBusy=undefined
    try { release?.() } catch { /* busy registry releases are best effort and idempotent */ }
    if (!stopping) pump()
  }
  async function confirmLateClose(running:Active,capture:boolean) {
    if (!running.uncertain) return
    if (capture) await collect(running)
    try { store.clearWriterError(running.taskId) } catch { /* keep the persistent guard if storage is unavailable */ }
    running.uncertain=false
    running.state='active'
    if (running.publicFinished) releaseReservation(running)
  }
  function markUncertain(running:Active) {
    running.uncertain=true
    running.state='uncertain'
  }

  async function execute(task:StoredTask,text:string,running:Active) {
    const sessionKey=`workbench/${task.id}`
    let finalStatus:TaskStatus='failed'
    let finalError:string|null=null
    let spawning:Promise<AgentSession>|undefined
    let spawnRejected=false
    let accepted=false
    try {
      running.releaseBusy=opts.holdBusy?.(sessionKey)
      if (canonicalProject(task.path) !== running.path || directoryIdentity(running.path) !== running.directoryIdentity) throw new Error('invalid_path')
      if(opts.executionConflict?.(task.path,task.providerId,task.sessionId))throw new Error('native_session_busy')
      const acceptedContinuation=running.continuation
      let resume:string|undefined,history=''
      if (acceptedContinuation.mode==='resume') {
        const current=store.get(task.id)
        if (current.sessionId!==acceptedContinuation.sessionId || !canResume(current)) throw new Error('restart_confirmation_required')
        resume=acceptedContinuation.sessionId
      } else if (acceptedContinuation.mode==='restart') {
        // Approval belongs to this immutable preview, never a newly sliced queue-time history.
        history=acceptedContinuation.preview.context
        store.addEvent(task.id,'system','用户已确认带此前记录重新开始；原任务对话和成果继续保留。')
        store.session(task.id,null)
      }
      const directory=outputDirectory(running.path,task.id)
      const entry=provider(task.providerId)
      const instructions=[
        `你是 CC 的工作助手。当前任务编号 ${task.id}，任务：${task.title}。`,
        `本任务工作目录：${running.path}。成果目录：${directory}。`,
        '只根据当前任务、选定文件夹和本任务历史工作，不读取个人陪伴记忆或其他任务。',
        '保留原始输入，除非用户明确要求修改。将待交付文件放入上述成果目录，最后说明生成了哪些文件和验证结果。',
        '回复直接输出文本。不要调用微信发消息、发文件、记忆或社交工具，不替用户发布或发送成果。',
        '不要声称完成没有做过的检查。缺依赖、权限或信息时说明具体缺项。',
      ].join('\n')
      const reviewStop=new AbortController()
      void running.stop.then(()=>reviewStop.abort())
      if(running.cancelled){finalStatus='cancelled';return}
      running.reviewBaseline=await captureGitBaseline(running.path,{},reviewStop.signal)
      if(running.cancelled){finalStatus='cancelled';return}
      if(canonicalProject(running.path)!==running.path || directoryIdentity(running.path)!==running.directoryIdentity)throw new Error('invalid_path')
      if(running.nativeResume)await validateNativeDecision(store.get(task.id),running.nativeResume,true)
      for(const ref of running.handoffArtifacts??[])handoffArtifactText(store,ref,ref.taskId,opts.stateDir)
      if(running.cancelled){finalStatus='cancelled';return}
      if(opts.executionConflict?.(task.path,task.providerId,task.sessionId))throw new Error('native_session_busy')
      const token=opts.mintSessionToken?.(sessionKey)
      running.credentialsMinted=!!opts.mintSessionToken
      if (running.cancelled) revokeCredentials(running)
      store.update(task.id,running.cancelled ? 'cancelling' : 'running')
      if (running.cancelled) { finalStatus='cancelled'; return }
      spawning=entry.provider.spawn({alias:`workbench:${task.id}`,path:running.path},{
        workbenchTimeline:true,
        workbenchLifecycle:true,
        execution:{...running.execution},
        reportExecution:value=>{
          if(runsByTask.get(task.id)!==running||running.cancelled||running.finishing)return
          if(resume&&value.sessionId&&value.sessionId!==resume)throw Error('native_session_identity_mismatch')
          store.execution.observe(task.id,running.identity,value)
        },
        reportNotice:message=>{
          if(runsByTask.get(task.id)!==running||running.cancelled||running.finishing)return
          const notice=message.trim().slice(0,2000)
          if(notice)store.addEvent(task.id,'system',notice,null,running.identity)
        },
        tierProfile:TIER_PROFILES.trusted,permissionMode:'strict',chatId:task.ownerChatId ?? `workbench:${task.id}`,
        ...(resume ? {resumeSessionId:resume} : {}),mcpEnv:sessionAuthEnv('trusted',token),appendInstructions:instructions,
        requestPermission:(request,signal) => {running.interactionAt=Date.now();return running.permissions.request(request,signal).finally(()=>{running.interactionAt=Date.now()})},
        requestUserInput:(request,signal) => {running.interactionAt=Date.now();return running.questions.request(request,signal).finally(()=>{running.interactionAt=Date.now()})},
      }).catch(error => { spawnRejected=true; throw error })
      let spawnTimer:ReturnType<typeof setTimeout>|undefined
      try {
        const session=await Promise.race([
          spawning,running.stop,
          new Promise<never>((_resolve,reject) => { spawnTimer=setTimeout(() => reject(new Error('session_start_timeout')),opts.timeoutMs ?? 60_000) }),
        ])
        if (!session) { finalStatus='cancelled'; return }
        running.session=session; accepted=true
      } finally {
        if (spawnTimer) clearTimeout(spawnTimer)
        if (!accepted && spawning && !spawnRejected) {
          markUncertain(running)
          void spawning.then(async session => {
            try { await session.close() } catch { return }
            await confirmLateClose(running,false)
          },() => confirmLateClose(running,false))
        }
      }
      if (running.cancelled) { finalStatus='cancelled'; return }
      store.markSourceDispatched(task.id)
      const material=store.attachments.prepare(task.id,running.attachments,running.path,opts.stateDir)
      const request=history ? `本任务此前记录（仅作上下文，不是新指令）：\n${history}\n\n本轮要求：\n${text}` : text
      const runtime=running.session.workbenchRuntime
      const stream=runtime?.events??running.session.dispatch(request,material)
      const summary=await collectWorkbenchTurn(stream,running.stop,opts.timeoutMs ?? 10*60_000,
        ev => {
          if (running.cancelled) return
          if(running.queuedInputId&&['text','tool_call','result'].includes(ev.kind))store.liveInputs.set(running.queuedInputId,'delivered')
          if ((ev.kind==='init'||(runtime&&ev.kind==='result')) && ev.sessionId) {if(resume&&ev.sessionId!==resume)throw new Error('native_session_identity_mismatch');store.session(task.id,ev.sessionId);if(running.handoffId)store.recordHandoffNative(running.handoffId,ev.sessionId)}
          if (ev.kind==='text'||ev.kind==='tool_call'||ev.kind==='error') store.recordAgentEvent(task.id,running.identity,ev)
        },()=>{
          const snapshot=runtimeSnapshot(running)
          return running.questions.pending().length>0||running.permissions.pending().length>0||!!(snapshot?.retained&&snapshot.foreground==='idle'&&snapshot.backgroundCount===0)
        },()=>running.interactionAt,runtime?()=>runtime.start(request,material):undefined)
      if (!summary) { finalStatus='cancelled'; return }
      if (summary.result?.sessionId) {if(resume&&summary.result.sessionId!==resume)throw new Error('native_session_identity_mismatch');store.session(task.id,summary.result.sessionId);if(running.handoffId)store.recordHandoffNative(running.handoffId,summary.result.sessionId)}
      if (running.cancelled) finalStatus='cancelled'
      else if (summary.error || !summary.result || runtime?.snapshot().retained) {
        // An old foreground result cannot turn an unexpected retained EOF into success.
        const error=summary.error ?? (runtime?.snapshot().retained?'background_runtime_ended':'stream_ended_without_result')
        finalStatus='failed'; finalError=error; store.addEvent(task.id,'error',error==='background_runtime_ended'?'后台执行会话意外结束；对话已保留，请检查后再继续。':executionFailureMessage(error))
      } else finalStatus='completed'
    } catch (error) {
      const message=error instanceof Error ? error.message : 'task_failed'
      finalStatus=running.cancelled ? 'cancelled' : 'failed'; finalError=running.cancelled ? null : message
      if (!running.cancelled) store.addEvent(task.id,'error',message==='restart_confirmation_required' ? RECOVERY_MESSAGE : executionFailureMessage(message))
    } finally {
      running.finishing=true;running.questions.close()
      for(const input of running.runtimeInputs?.values()??[])settleRuntimeInput(running,input,new Error('runtime_closed_before_input_acknowledgement'))
      running.permissions.rejectAll(running.cancelled ? 'cancelled' : 'ended')
      let closePromise:Promise<void>|undefined
      let closeTimer:ReturnType<typeof setTimeout>|undefined
      if (running.session) {
        try {
          closePromise=Promise.resolve(running.session.close())
          await Promise.race([closePromise,new Promise<never>((_resolve,reject) => { closeTimer=setTimeout(() => reject(new Error('close_timeout')),opts.closeTimeoutMs ?? 3000) })])
        } catch {
          markUncertain(running); finalStatus='interrupted'; finalError='writer_not_closed'
          try { store.addEvent(task.id,'system','执行程序未确认退出，此文件夹内的新任务将等待。请检查后台进程或重启服务。') } catch { /* final status write below may still succeed */ }
          if (closePromise) void closePromise.then(() => confirmLateClose(running,true),() => {})
        } finally { if (closeTimer) clearTimeout(closeTimer) }
      }
      if (!running.uncertain) await collect(running)
      revokeCredentials(running)
      if (running.uncertain) { finalStatus='interrupted'; finalError='writer_not_closed' }
      let terminalCommitted=false
      try {
        const status=running.cancelled&&!running.uncertain?'cancelled':finalStatus
        store.atomic(()=>{
          store.finishRunActivities(task.id,running.identity,running.cancelled&&!running.uncertain?'cancelled':'interrupted')
          store.update(task.id,status,finalError)
          stageFinishedNotice(running,status)
        })
        terminalCommitted=true
        publishFinishedNotices()
      } catch { /* never unlock an uncertain writer for a status failure */ }
      running.publicFinished=true; running.resolveDone()
      if (!running.uncertain) releaseReservation(running)
      if(terminalCommitted&&finalStatus==='completed'&&!running.cancelled&&!running.uncertain&&!stopping)drainInputs(task.id,running.directoryIdentity)
      else holdInputs(task.id,'任务已停止或未正常完成；这条补充尚未发送。')
    }
  }

  function drainInputs(id:string,expectedDirectoryIdentity:string){
    if(autoContinueBlocked.has(id))return
    const next=store.liveInputs.next(id);if(!next)return
    try{
      const task=store.get(id),decision=continuation(task)
      if(decision.mode!=='resume')throw Error('原会话需要你确认恢复方式，补充尚未发送。')
      const path=canonicalProject(task.path);if(path!==task.path||directoryIdentity(path)!==expectedDirectoryIdentity)throw Error('invalid_path')
      store.liveInputs.set(next.id,'sending')
      const execution=next.execution??store.execution.run(id,next.runId)?.choice??store.execution.choice(id)
      start(task,next.text,expectedDirectoryIdentity,{mode:'resume',sessionId:task.sessionId!},undefined,undefined,undefined,next.id,next.attachments,undefined,execution)
    }catch(error){holdInputs(id,error instanceof Error?error.message:'input_not_delivered')}
  }

  function settleRuntimeInput(running:Active,saved:LiveInput,error?:unknown) {
    if(shutdownComplete){running.runtimeInputs?.delete(saved.id);return}
    try {
      store.atomic(()=>{
        const current=store.liveInputs.get(saved.id)
        if(!current||current.taskId!==saved.taskId||current.runId!==saved.runId||current.text!==saved.text||!sameAttachments(current.attachments,saved.attachments))return
        if(error!==undefined){
          // Stop/recovery may already have held it. Never revive an old send.
          if(current.status==='sending')store.liveInputs.set(saved.id,'held',`${INPUT_UNCONFIRMED}${error instanceof Error?' '+error.message:''}`)
          return
        }
        if(current.status!=='sending'&&current.status!=='held')return
        // A late positive native acknowledgement is truthful only for this receipt.
        store.liveInputs.set(saved.id,'delivered')
        store.addEvent(saved.taskId,'user',saved.text,null,saved.runId,saved.attachments)
      })
      // Keep delivery uncertainty tracked if the durable transition failed.
      running.runtimeInputs?.delete(saved.id)
      if(runsByTask.get(saved.taskId)===running&&!running.cancelled&&!running.finishing)running.interactionAt=Date.now()
    }catch{autoContinueBlocked.add(saved.taskId)}
  }

  function pump() {
    if (stopping) return
    const launch:Active[]=[]
    for (const running of queue) {
      if (running.state !== 'queued') continue
      const earlier=queue.filter(item => item.order < running.order && item.state === 'queued')
      if (findPathBlocker(running,[...reservations.values(),...earlier])) continue
      running.state='active'; reservations.set(running.identity,running); launch.push(running)
    }
    for (const running of launch) queue.splice(queue.indexOf(running),1)
    for (const running of launch) {
      void Promise.resolve().then(() => execute(running.task,runningText.get(running.identity)!,running)).catch(() => {
        if (running.publicFinished) return
        try { running.questions.close(); running.permissions.rejectAll(running.cancelled ? 'cancelled' : 'ended') } catch { /* fail closed */ }
        revokeCredentials(running)
        if (running.session) markUncertain(running)
        running.publicFinished=true; running.resolveDone()
        if (!running.uncertain) releaseReservation(running)
      })
    }
  }

  function start(task:StoredTask,text:string,acceptedDirectoryIdentity:string,acceptedContinuation:AcceptedContinuation={mode:'new'},nativeResume?:AcceptedNativeResume,handoffArtifacts?:ArtifactSelection[],handoffId?:string,queuedInputId?:string,attachments:Attachment[]=[],draftId?:string,executionChoice?:AgentExecutionChoice,acceptance?:{persist:(runId:string)=>void;activate:(fn:()=>void)=>void}):WorkbenchTaskView {
    if (runsByTask.has(task.id)) throw new Error('workbench_busy')
    if(opts.executionConflict?.(task.path,task.providerId,task.sessionId))throw new Error('native_session_busy')
    if([...runsByTask.values()].some(run=>task.sessionId&&run.task.providerId===task.providerId&&run.task.sessionId===task.sessionId))throw new Error('native_session_busy')
    const runId=randomUUID()
    const execution=normalizeExecutionChoice(executionChoice,store.execution.choice(task.id))
    const dispatchAttachments=combinedAttachments(attachments,acceptedContinuation.mode==='restart'?acceptedContinuation.preview.attachments:[])
    const addRunEvent=(kind:'user'|'system',text:string)=>store.addEvent(task.id,kind,text,null,runId)
    store.atomic(()=>{
      store.execution.accept(task.id,runId,execution)
      const bound=store.attachments.bind(attachments.map(a=>a.id),task.id,draftId)
      if(!sameAttachments(bound,attachments))throw Error('invalid_attachment_changed')
      // A queued receipt keeps the ORIGINAL accepted run, even when this is a new dispatch run.
      if(queuedInputId&&!store.liveInputs.get(queuedInputId)){
        store.liveInputs.add({id:queuedInputId,taskId:task.id,runId,text,attachments,execution})
        store.liveInputs.set(queuedInputId,'sending')
      }
      if(nativeResume)addRunEvent('system',`用户声明原 ${task.providerId} 执行程序已关闭，选择${nativeResume.mode==='native_resume'?'恢复原会话':'带已确认的记录新开一轮'}。原会话：${nativeResume.nativeId}。`)
      const requestEventId=store.addEvent(task.id,'user',text,null,runId,attachments)
      if(handoffId)store.recordHandoffEvent(handoffId,requestEventId)
      store.update(task.id,'queued')
      acceptance?.persist(runId)
    })
    let signalStop!:()=>void,resolveDone!:()=>void
    const stop=new Promise<null>(resolve => { signalStop=() => resolve(null) })
    const done=new Promise<void>(resolve => { resolveDone=resolve })
    const permissions=makeRunPermissions({
      taskId:task.id,timeoutMs:opts.permissionTimeoutMs ?? WORKBENCH_PERMISSION_TIMEOUT_MS,
      audit:event => {
        if(event.type==='request'){
          addRunEvent('system',`权限请求：${event.permission.tool} · ${event.permission.description} · ${event.permission.id}`)
          requestNotice(task,runId,'permission',event.permission.id,`${event.permission.tool} · ${event.permission.description}`)
        }else addRunEvent('system',`权限结果：${event.permission.tool} · ${event.outcome} · ${event.permission.id}`)
      },
    })
    const questions=makeRunUserInput({taskId:task.id,audit:event=>{
      if(event.type==='request'){
        addRunEvent('system',`执行者提问：${JSON.stringify(event.request)}`)
        requestNotice(task,runId,'question',event.request.id,event.request.questions.map(q=>q.question).join('\n'))
      }
      else if(event.type==='answer')addRunEvent('user',`回答执行者的问题：\n${event.request.questions.map(q=>`${q.question}\n${event.answers?.[q.id]?.join('、')??''}`).join('\n\n')}`)
      else addRunEvent('system',`问题已结束，未提交回答：${event.request.id}`)
    }})
    const running:Active={
      execution,
      attachments:dispatchAttachments,
      interactionAt:Date.now(),questions,queuedInputId,handoffId,handoffArtifacts,nativeResume,continuation:acceptedContinuation,identity:runId,taskId:task.id,title:task.title,path:task.path,order:++order,state:'queued',task,directoryIdentity:acceptedDirectoryIdentity,
      cancelled:false,done,resolveDone,stop,signalStop,permissions,publicFinished:false,uncertain:false,artifactsCollected:false,credentialsMinted:false,credentialsRevoked:false,
    }
    const activate=()=>{runsByTask.set(task.id,running);runningText.set(running.identity,text);queue.push(running);pump()}
    if(acceptance)acceptance.activate(activate);else activate()
    return taskView(publicTask({...task,status:'queued',error:null}))
  }

  function createTask(input:CreateTask,onAccepted?:(task:StoredTask,runId:string)=>void):WorkbenchTaskView {
    ensureAccepting()
    const execution=normalizeExecutionChoice(input.execution,PROVIDER_EXECUTION_CHOICE)
    const attachments=selectAttachments(input),text=checkedText(input.text,attachments);provider(input.providerId)
    if(input.title!==undefined&&(typeof input.title!=='string'||!input.title.trim()||input.title.length>120))throw Error('invalid_title')
    const path=canonicalProject(input.path),acceptedDirectoryIdentity=directoryIdentity(path)
    if(opts.executionConflict?.(path,input.providerId,null))throw Error('native_session_busy')
    let activate:()=>void=()=>{}
    const accepted=store.atomic(()=>{
      const task=store.create({title:input.title?.trim()??(text.slice(0,40)||attachments[0]!.name.slice(0,40)),path,providerId:input.providerId,ownerChatId:opts.ownerChatId()})
      return start(task,text,acceptedDirectoryIdentity,undefined,undefined,undefined,undefined,undefined,attachments,input.draftId,execution,{
        persist:runId=>onAccepted?.(task,runId),activate:fn=>{activate=fn},
      })
    })
    // An accepted in-memory run must never outlive a rolled-back creation transaction.
    activate()
    return accepted
  }

  function cancelRun(running:Active):void {
    running.questions.close();holdInputs(running.taskId,'任务已停止，补充尚未发送。')
    if (running.state==='queued') {
      running.cancelled=true; running.permissions.rejectAll('cancelled'); running.signalStop()
      const index=queue.indexOf(running); if (index>=0) queue.splice(index,1)
      runningText.delete(running.identity)
      try {
        store.atomic(()=>{store.update(running.taskId,'cancelled');stageFinishedNotice(running,'cancelled')})
        publishFinishedNotices()
      } catch { /* in-memory cancellation still must settle */ }
      running.publicFinished=true; running.resolveDone()
      if (runsByTask.get(running.taskId)===running) runsByTask.delete(running.taskId)
      if (!stopping) pump()
      return
    }
    if (running.state==='uncertain') return
    if (!running.cancelled) {
      running.cancelled=true; running.permissions.rejectAll('cancelled'); revokeCredentials(running); running.signalStop()
      try { store.update(running.taskId,'cancelling') } catch { /* stop the writer even when persistence is unavailable */ }
      try { if (running.session?.cancel) void running.session.cancel().catch(() => {}) }
      catch { try { store.addEvent(running.taskId,'system','已请求停止，正在等待执行程序退出。') } catch { /* cancellation remains active */ } }
    }
  }

  const service={
    artifactDeliveryStore:store.artifactDeliveries,
    setArtifactDelivery(deliver:((id:string)=>Promise<ArtifactDeliveryReceipt>)|undefined){artifactDelivery=deliver},
    artifactDeliveryEligible(receipt:ArtifactDeliveryReceipt):boolean{
      return !stopping&&receipt.ownerChatId===opts.ownerChatId()&&store.get(receipt.taskId).ownerChatId===receipt.ownerChatId
    },
    async deliverWechatArtifact(input:SendWechatArtifact):Promise<ArtifactDeliveryReceipt>{
      ensureAccepting()
      if(!input.ownerChatId||input.ownerChatId!==opts.ownerChatId()||!input.accountId?.trim()||store.get(input.taskId).ownerChatId!==input.ownerChatId)throw Error('invalid_wechat_identity')
      const id=normalizeInputRequestId(input.requestId)
      if(!/^[a-f0-9]{64}$/.test(input.commandHash))throw Error('invalid_request')
      if(store.controlReceipts.get(id)||store.liveInputs.get(id)||store.creationReceipts.get(id))throw Error('artifact_delivery_conflict')
      const prior=store.artifactDeliveries.get(id)
      if(prior){
        if(prior.taskId!==input.taskId||prior.artifactId!==input.artifactId||prior.ownerChatId!==input.ownerChatId||prior.accountId!==input.accountId||prior.commandHash!==input.commandHash)throw Error('artifact_delivery_conflict')
        if(prior.status==='accepted'||prior.status==='unknown'||prior.status==='blocked')return prior
      }
      if(!artifactDelivery)throw Error('artifact_transport_unavailable')
      if(!prior){
        const artifact=service.artifact(input.taskId,input.artifactId)
        store.artifactDeliveries.reserve({id,commandHash:input.commandHash,taskId:input.taskId,artifactId:input.artifactId,ownerChatId:input.ownerChatId,accountId:input.accountId,artifactSha256:artifact.sha256,name:artifact.name,mime:artifact.mime,size:artifact.size})
      }
      return artifactDelivery(id)
    },
    notificationStore:store.wechatNotifications,
    setNotificationWake(wake:(context?:{ownerChatId:string;accountId:string})=>Promise<void>){noticeWake=wake},
    contextAvailable(ownerChatId:string,accountId:string){if(ownerChatId===opts.ownerChatId())wakeNotices({ownerChatId,accountId})},
    notificationEligible(notice:WechatNotificationNotice):boolean {
      const task=store.get(notice.taskId),watch=store.wechatNotifications.subscription(notice.taskId)
      if(!watch?.enabled||opts.ownerChatId()!==notice.ownerChatId||task.ownerChatId!==notice.ownerChatId||watch.ownerChatId!==notice.ownerChatId||watch.accountId!==notice.accountId||watch.generation!==notice.subscriptionGeneration)return false
      if(notice.kind!=='permission'&&notice.kind!=='question')return true
      const run=runsByTask.get(notice.taskId)
      if(!run||run.identity!==notice.runId||run.cancelled||run.finishing||run.uncertain)return false
      return notice.kind==='permission'
        ?run.permissions.pending().some(p=>p.id===notice.requestId&&Date.now()<p.createdAt+(opts.permissionTimeoutMs??WORKBENCH_PERMISSION_TIMEOUT_MS))
        :run.questions.pending().some(q=>q.id===notice.requestId)
    },
    setWechatWatch(id:string,accountId:string,enabled:boolean){
      const task=store.get(id)
      if(!task.ownerChatId||task.ownerChatId!==opts.ownerChatId()||!accountId?.trim())throw Error('invalid_wechat_identity')
      const watch=store.wechatNotifications.watch(id,task.ownerChatId,accountId,enabled)
      const run=runsByTask.get(id)
      if(enabled&&run){
        for(const p of run.permissions.pending())requestNotice(task,run.identity,'permission',p.id,`${p.tool} · ${p.description}`)
        for(const q of run.questions.pending())requestNotice(task,run.identity,'question',q.id,q.questions.map(q=>q.question).join('\n'))
      }
      wakeNotices();return watch
    },
    projects(){
      const ownerChatId=opts.ownerChatId();if(!ownerChatId)return[]
      const providers=SUPPORTED.filter(id=>!!opts.registry.get(id))
      return makeProjectCatalog({ownerChatId,registered:opts.registeredProjects?.()??[],known:store.ownedProjects(ownerChatId,providers),providers,defaultProvider:opts.defaultProvider})
    },
    createWechat(input:CreateWechatTask):CreationReceipt {
      ensureAccepting()
      if(!input.ownerChatId||opts.ownerChatId()!==input.ownerChatId||!input.accountId?.trim())throw Error('invalid_wechat_identity')
      const id=normalizeInputRequestId(input.requestId)
      if(!/^[a-f0-9]{64}$/.test(input.commandHash))throw Error('invalid_request')
      // Replay accepted identity before consulting configuration or a directory that may have moved.
      const prior=store.creationReceipts.get(id)
      if(prior){
        if(prior.ownerChatId!==input.ownerChatId||prior.accountId!==input.accountId||prior.commandHash!==input.commandHash)throw Error('creation_conflict')
        if(store.get(prior.taskId).ownerChatId!==input.ownerChatId)throw Error('invalid_wechat_identity')
        return prior
      }
      const project=service.projects().find(project=>project.id===input.projectId)
      if(!project)throw Error('project_stale')
      const providerId=input.providerId??project.providerId
      if(!providerId)throw Error('unavailable_provider')
      let receipt!:CreationReceipt
      createTask({path:project.path,providerId,text:input.text},(task,runId)=>{
        store.wechatNotifications.watch(task.id,input.ownerChatId,input.accountId,true)
        receipt=store.creationReceipts.add({id,accountId:input.accountId,ownerChatId:input.ownerChatId,commandHash:input.commandHash,projectId:input.projectId,path:task.path,providerId:task.providerId,taskId:task.id,runId,
          reply:`已接下这件事 · ${task.id}\n${task.providerId} · ${task.path}\n\n${task.title}\n\n完成或需要你处理时，会在这里提醒。\n查看：任务 ${task.id}\n补充：任务 ${task.id} 补充 <要求>\n关闭提醒：任务 ${task.id} 静音`,
        })
      })
      return receipt
    },
    attention(){
      const tasks=Array.from(runsByTask.values()).flatMap(run=>{
        const permissions=run.permissions.pending(),questions=run.questions.pending()
        if(!permissions.length&&!questions.length)return[]
        return[{id:run.taskId,title:run.title,providerId:run.task.providerId,pendingPermissionCount:permissions.length,pendingQuestionCount:questions.length,attentionKey:JSON.stringify([...permissions,...questions].map(q=>q.id).sort())}]
      })
      return{tasks}
    },
    resolveAnswer(id:string,requestId:string,answers:unknown){
      const running=runsByTask.get(id)
      if(!running||running.cancelled||running.finishing||!running.questions.resolve(requestId,answers))throw Error('question_stale')
    },
    withdrawInput(id:string,requestId:string){
      const input=store.liveInputs.get(requestId)
      if(!input||input.taskId!==id||input.status!=='pending')throw Error('input_stale')
      store.liveInputs.set(requestId,'withdrawn')
    },
    async submitInput(id:string,input:{runId:string;requestId:string;text:string}&InputMaterials){
      ensureAccepting()
      if(Object.hasOwn(input,'execution'))throw Error('invalid_execution')
      const attachments=selectAttachments(input,id),text=checkedText(input.text,attachments)
      if(autoContinueBlocked.has(id))throw Error('input_storage_unavailable')
      const requestId=normalizeInputRequestId(input.requestId)
      const prior=store.liveInputs.get(requestId)
      if(prior){if(prior.taskId!==id||prior.runId!==input.runId||prior.text!==text||!sameAttachments(prior.attachments,attachments))throw Error('input_conflict');return prior}
      const running=runsByTask.get(id)
      if(!running||running.identity!==input.runId||running.cancelled||running.finishing||running.uncertain)throw Error('input_stale')
      if(running.delivering)throw Error('input_delivery_busy')
      if(store.liveInputs.count(id)>=10)throw Error('input_limit')
      const saved=store.atomic(()=>{
        store.attachments.bind(attachments.map(a=>a.id),id,input.draftId)
        return store.liveInputs.add({id:requestId,taskId:id,runId:input.runId,text,attachments,execution:running.execution})
      })
      const runtime=running.session?.workbenchRuntime
      if(runtime){
        if(inputMode(running)==='queue')return saved
        store.liveInputs.set(saved.id,'sending')
        ;(running.runtimeInputs??=new Map()).set(saved.id,saved)
        try{
          if(canonicalProject(running.path)!==running.path||directoryIdentity(running.path)!==running.directoryIdentity)throw Error('invalid_path')
          const material=store.attachments.prepare(id,attachments,running.path,opts.stateDir)
          running.interactionAt=Date.now()
          // Replay acknowledgement may wait behind an autonomous native turn.
          // The HTTP receipt is already durable; never wait here or auto-resend.
          void runtime.submit(saved.id,text,material).then(
            ()=>settleRuntimeInput(running,saved),
            error=>settleRuntimeInput(running,saved,error??new Error('input_not_delivered')),
          )
        }catch(error){settleRuntimeInput(running,saved,error??new Error('input_not_delivered'))}
        return store.liveInputs.get(saved.id)!
      }
      if(!running.session?.steer)return saved
      running.delivering=true;store.liveInputs.set(saved.id,'sending')
      try{
        if(canonicalProject(running.path)!==running.path||directoryIdentity(running.path)!==running.directoryIdentity)throw Error('invalid_path')
        const material=store.attachments.prepare(id,attachments,running.path,opts.stateDir)
        await running.session.steer(text,material)
        running.interactionAt=Date.now()
        store.liveInputs.set(saved.id,'delivered')
        store.addEvent(id,'user',text,null,running.identity,attachments)
      }catch(error){store.liveInputs.set(saved.id,'held',`未确认执行者收到，请检查当前对话后再决定是否重发。${error instanceof Error?' '+error.message:''}`)}
      finally{running.delivering=false}
      return store.liveInputs.get(saved.id)!
    },
    async previewHandoff(raw:HandoffInput):Promise<HandoffPreview> {
      ensureAccepting()
      const input=validateHandoffInput(raw),source=store.get(input.sourceTaskId),version=taskVersion(source)
      provider(input.targetProviderId)
      if(source.providerId===input.targetProviderId)throw new Error('invalid_request')
      if(canonicalProject(source.path)!==source.path)throw new Error('invalid_path')
      const identity=directoryIdentity(source.path)
      let artifacts=input.artifacts,attachments=input.attachments??[],target:StoredTask|null=null,targetContinuation:Continuation|undefined,nativeResume:NativeResumeDecision|undefined
      if(input.purpose==='revision') {
        target=store.get(input.targetTaskId!)
        if(target.archivedAt!==null)throw new Error('workbench_archived')
        if(runsByTask.has(target.id)||!TERMINAL_TASK_STATUSES.includes(target.status)||target.error==='writer_not_closed')throw new Error('workbench_busy')
        if(target.providerId!==input.targetProviderId||target.path!==source.path)throw new Error('invalid_handoff_target')
        const origin=store.handoffs(source.id).find(h=>h.purpose==='review'&&h.sourceTaskId===target!.id&&h.targetTaskId===source.id)
        const event=store.events(source.id).find(e=>e.id===input.quote!.eventId&&e.kind==='text')
        if(!origin||!event?.text.includes(input.quote!.text))throw new Error('invalid_handoff_quote')
        artifacts=origin.artifacts
        const original=store.handoffRecord(source.id,origin.id)
        if(snapshotHash(original.packetJson)!==original.packetSha256)throw Error('artifact_changed')
        attachments=(JSON.parse(original.packetJson) as {attachments?:AttachmentSelection[]}).attachments??[]
        targetContinuation=continuation(target)
        if(store.source(target.id)?.firstDispatchedAt===null)nativeResume=await service.prepareNativeResume(target.id,targetContinuation.mode==='restart_required'?'fresh_context':'native_resume')
      }
      const files=artifacts.map(a=>handoffArtifactText(store,a,target?.id??source.id,opts.stateDir))
      const materials=handoffAttachments(attachments,target?.id??source.id)
      const packet=handoffContext({...input,attachments},source,store.events(source.id),files,materials)
      ensureAccepting()
      if(taskVersion(store.get(source.id))!==version)throw new Error('handoff_changed')
      const preview:HandoffPreview={token:handoffToken(),sourceTaskId:source.id,targetTaskId:target?.id??null,targetProviderId:input.targetProviderId,purpose:input.purpose,request:input.request,...packet,artifacts,targetExecution:target?store.execution.choice(target.id):{...PROVIDER_EXECUTION_CHOICE},...(attachments.length?{attachments}:{}),quote:input.quote??null,...(targetContinuation?{targetContinuation}:{}),...(nativeResume?{nativeResume}:{})}
      for(const [token,d] of handoffDecisions)if(d.expiresAt<Date.now()||d.preview.sourceTaskId===source.id)handoffDecisions.delete(token)
      if(handoffDecisions.size>=100)handoffDecisions.delete(handoffDecisions.keys().next().value!)
      handoffDecisions.set(preview.token,{preview:structuredClone(preview),sourceVersion:version,targetVersion:target?taskVersion(target):null,directoryIdentity:identity,expiresAt:Date.now()+5*60_000})
      return preview
    },
    async handoff(input:{token:string;restartToken?:string;sourceClosedToken?:string}) {
      ensureAccepting()
      if(!input||typeof input.token!=='string'||! /^[a-f0-9]{64}$/.test(input.token))throw new Error('invalid_request')
      for(const optional of [input.restartToken,input.sourceClosedToken])if(optional!==undefined&&(typeof optional!=='string'||! /^[a-f0-9]{64}$/.test(optional)))throw new Error('invalid_request')
      const hash=handoffTokenHash(input.token),previous=store.handoffByToken(hash)
      if(previous)return{task:taskView(publicTask(store.get(previous.targetTaskId))),handoffId:previous.id,sourceTaskId:previous.sourceTaskId}
      const decision=handoffDecisions.get(input.token)
      if(!decision||decision.expiresAt<Date.now())throw new Error('handoff_changed')
      const p=decision.preview,source=store.get(p.sourceTaskId),target=p.targetTaskId?store.get(p.targetTaskId):null
      const assertCurrent=()=>{
        ensureAccepting()
        if(handoffDecisions.get(input.token)!==decision||decision.expiresAt<Date.now()||taskVersion(store.get(source.id))!==decision.sourceVersion||(target&&taskVersion(store.get(target.id))!==decision.targetVersion))throw new Error('handoff_changed')
        if(canonicalProject(source.path)!==source.path||directoryIdentity(source.path)!==decision.directoryIdentity)throw new Error('invalid_path')
        if(target?.archivedAt!=null)throw new Error('workbench_archived')
        if(target&&(runsByTask.has(target.id)||!TERMINAL_TASK_STATUSES.includes(target.status)||target.error==='writer_not_closed'))throw new Error('workbench_busy')
        if(opts.executionConflict?.(source.path,p.targetProviderId,target?.sessionId??null))throw new Error('native_session_busy')
      }
      assertCurrent();provider(p.targetProviderId)
      for(const ref of p.artifacts)handoffArtifactText(store,ref,target?.id??source.id,opts.stateDir)
      handoffAttachments(p.attachments??[],target?.id??source.id)
      let accepted:AcceptedContinuation={mode:'new'},native:AcceptedNativeResume|undefined
      if(target){
        const current=continuation(target)
        if(current.mode==='restart_required'){
          if(!input.restartToken)throw new Error('restart_confirmation_required')
          if(input.restartToken!==current.restart.token||p.targetContinuation?.mode!=='restart_required'||input.restartToken!==p.targetContinuation.restart.token)throw new Error('restart_confirmation_stale')
          accepted={mode:'restart',preview:current.restart}
        }else{
          if(input.restartToken!==undefined)throw new Error('restart_confirmation_stale')
          accepted=current.mode==='resume'?{mode:'resume',sessionId:target.sessionId!}:{mode:'new'}
        }
        if(store.source(target.id)?.firstDispatchedAt===null){
          native=input.sourceClosedToken?nativeDecisions.get(input.sourceClosedToken):undefined
          if(!native||input.sourceClosedToken!==p.nativeResume?.token)throw new Error('external_close_confirmation_required')
          await validateNativeDecision(target,native)
          assertCurrent()
          if(nativeDecisions.get(native.token)!==native)throw new Error('external_close_confirmation_stale')
        }
      }
      const packetJson=JSON.stringify({context:p.context,request:p.request,artifacts:p.artifacts,attachments:p.attachments??[],quote:p.quote,truncated:p.truncated,continuation:accepted,execution:p.targetExecution})
      const record=store.createHandoff({id:randomUUID(),sourceTaskId:source.id,targetTaskId:target?.id??null,targetProviderId:p.targetProviderId,path:source.path,title:`检查 · ${source.title}`.slice(0,120),ownerChatId:source.ownerChatId,purpose:p.purpose,request:p.request,packetSha256:snapshotHash(packetJson),packetJson,artifactRefsJson:JSON.stringify(p.artifacts),quoteJson:p.quote?JSON.stringify(p.quote):null,sourceNativeId:source.sessionId,tokenHash:hash})
      handoffDecisions.delete(input.token)
      if(native)nativeDecisions.delete(native.token)
      let task:WorkbenchTaskView
      try{
        const materials=target
          ?handoffAttachments(p.attachments??[],target.id)
          :store.attachments.copyToTask(source.id,(p.attachments??[]).map(a=>a.attachmentId),record.targetTaskId)
        task=start(store.get(record.targetTaskId),p.context,decision.directoryIdentity,accepted,native,p.artifacts,record.id,undefined,materials,undefined,p.targetExecution)
      }
      catch(error){
        if(!target)store.update(record.targetTaskId,'failed',error instanceof Error?error.message:'task_failed')
        store.addEvent(record.targetTaskId,'system','交接已记录，但本轮未启动。请查看任务状态，手动决定是否继续。')
        throw error
      }
      return{task,handoffId:record.id,sourceTaskId:source.id}
    },
    handoffRecord(taskId:string,id:string){
      const record=store.handoffRecord(taskId,id)
      if(snapshotHash(record.packetJson)!==record.packetSha256)throw new Error('artifact_changed')
      return{id:record.id,sourceTaskId:record.sourceTaskId,targetTaskId:record.targetTaskId,createdAt:record.createdAt,sourceNativeId:record.sourceNativeId,targetNativeId:record.targetNativeId,packetSha256:record.packetSha256,packet:JSON.parse(record.packetJson) as {context:string;request:string;truncated:boolean;artifacts:ArtifactSelection[];attachments?:AttachmentSelection[];continuation:AcceptedContinuation;execution?:AgentExecutionChoice}}
    },
    conflictsExternal(path:string,providerId:string,nativeId:string|null):boolean {
      let canonical:string
      try{canonical=canonicalProject(path)}catch{return true}
      if(nativeId&&(store.sourceByIdentity(providerId,nativeId)||store.taskByNativeIdentity(providerId,nativeId)))return true
      return [...runsByTask.values()].some(run=>pathsConflict(run.path,canonical))
    },
    async importNativeHistory(raw:NativeImportInput) {
      ensureAccepting()
      const input=nativeImportInput(raw),{providerId,nativeId}=decodeNativeHistoryKey(input.key)
      const existing=store.sourceByIdentity(providerId,nativeId)
      if(existing)return{task:taskView(publicTask(store.get(existing.taskId))),source:publicSource(existing),created:false}
      const managed=store.taskByNativeIdentity(providerId,nativeId)
      if(managed)throw new Error('native_session_already_managed')
      const read=await readNativeImport(nativeReader(providerId),input)
      ensureAccepting()
      if(!read.session.cwd)throw new Error('invalid_path')
      const path=canonicalProject(read.session.cwd)
      if(path!==read.session.cwd)throw new Error('invalid_path')
      const result=store.importSource({providerId,nativeId,cwd:path,title:read.session.title.slice(0,120),ownerChatId:opts.ownerChatId(),messages:read.messages,snapshotJson:read.snapshotJson,snapshotSha256:read.snapshotSha256,pagesJson:read.pagesJson,observedFingerprint:read.observedFingerprint,truncated:read.truncated})
      return{...result,task:taskView(publicTask(result.task))}
    },
    async prepareNativeResume(id:string,mode:'native_resume'|'fresh_context'='native_resume',executionChoice?:unknown):Promise<NativeResumeDecision> {
      ensureAccepting()
      const task=store.get(id),source=store.source(id)
      if(!source||source.firstDispatchedAt!==null)throw new Error('invalid_request')
      if(mode!=='native_resume'&&mode!=='fresh_context')throw new Error('invalid_request')
      if(runsByTask.has(id)||task.archivedAt!==null)throw new Error('workbench_busy')
      const execution=normalizeExecutionChoice(executionChoice,store.execution.choice(id))
      provider(task.providerId)
      const identity=directoryIdentity(task.path),version=taskVersion(task),pages=JSON.parse(source.pagesJson) as ImportPage[]
      if(opts.executionConflict?.(task.path,task.providerId,source.nativeId))throw new Error('native_session_busy')
      const current=mode==='native_resume'?await currentNativePages(task,pages):pages
      if(mode==='native_resume'&&!canResume(task))throw new Error('restart_confirmation_required')
      const recovery=continuation(task)
      if(mode==='fresh_context'&&recovery.mode!=='restart_required')throw new Error('invalid_request')
      ensureAccepting()
      if(taskVersion(store.get(id))!==version||runsByTask.has(id))throw new Error('external_close_confirmation_stale')
      const preview=restartPreview(task,store.events(id),store.execution.choice(id))
      const decision:AcceptedNativeResume={token:nativeResumeToken(),taskId:id,sourceId:source.id,providerId:source.providerId,nativeId:source.nativeId,path:task.path,mode,expiresAt:Date.now()+5*60_000,context:mode==='fresh_context'?preview.context:'',truncated:source.truncated,changedSinceImport:JSON.stringify(current)!==JSON.stringify(pages),pages:current,taskVersion:version,directoryIdentity:identity,execution,...(mode==='fresh_context'?{restartToken:preview.token}:{})}
      for(const [token,value] of nativeDecisions)if(value.expiresAt<Date.now()||value.taskId===id)nativeDecisions.delete(token)
      if(nativeDecisions.size>=100)nativeDecisions.delete(nativeDecisions.keys().next().value!)
      nativeDecisions.set(decision.token,decision)
      const {pages:_pages,taskVersion:_version,directoryIdentity:_identity,restartToken:_restart,...result}=decision;return structuredClone(result)
    },
    async continueNativeTask(id:string,text:string,sourceClosedToken:string,restartToken?:string,materials:InputMaterials={}):Promise<WorkbenchTaskView> {
      ensureAccepting();const task=store.get(id),decision=nativeDecisions.get(sourceClosedToken),attachments=selectAttachments(materials,id),request=checkedText(text,attachments)
      if(!decision)throw new Error('external_close_confirmation_stale')
      const execution=normalizeExecutionChoice(materials.execution,store.execution.choice(id))
      if(!sameExecutionChoice(execution,decision.execution))throw Error('external_close_confirmation_stale')
      if(runsByTask.has(id)||task.archivedAt!==null)throw new Error('workbench_busy')
      await validateNativeDecision(task,decision)
      ensureAccepting()
      if(taskVersion(store.get(id))!==decision.taskVersion||runsByTask.has(id)||nativeDecisions.get(sourceClosedToken)!==decision)throw new Error('external_close_confirmation_stale')
      const accepted:AcceptedContinuation=decision.mode==='native_resume'?{mode:'resume',sessionId:decision.nativeId}:{mode:'restart',preview:restartPreview(task,store.events(id),store.execution.choice(id))}
      if(accepted.mode==='restart'&&(restartToken!==accepted.preview.token||restartToken!==decision.restartToken))throw new Error('restart_confirmation_stale')
      nativeDecisions.delete(sourceClosedToken)
      return start(task,request,decision.directoryIdentity,accepted,decision,undefined,undefined,undefined,attachments,materials.draftId,execution)
    },
    async listNativeHistory(providerId:NativeHistoryProvider,input:NativeHistoryListInput) {
      const reader=opts.nativeHistory?.[providerId]
      if(!reader)throw new Error('native_history_unsupported')
      return reader.list(normalizeHistoryList(input))
    },
    async readNativeHistory(key:string,input:NativeHistoryReadInput) {
      const {providerId}=decodeNativeHistoryKey(key),reader=opts.nativeHistory?.[providerId]
      if(!reader)throw new Error('native_history_unsupported')
      const preview=await reader.read(key,normalizeHistoryRead(input)),{nativeId}=decodeNativeHistoryKey(key)
      const managedTaskId=store.sourceByIdentity(providerId,nativeId)?.taskId??store.taskByNativeIdentity(providerId,nativeId)?.id
      return {...preview,...(managedTaskId?{managedTaskId}:{})}
    },
    list(query:WorkbenchListQuery={}) {
      const providers=SUPPORTED.flatMap(id => { const p=opts.registry.get(id); return p ? [{id,displayName:p.opts.displayName}] : [] })
      const result=store.listPage(query)
      const projectProviders=Object.fromEntries([...new Set(result.tasks.map(task=>task.path))].map(path=>[path,store.projectProvider(path)]))
      return {tasks:result.tasks.map(task => taskView(task,true)),page:result.page,projectProviders,providers,historyProviders:Object.keys(opts.nativeHistory??{}),defaultProvider:providers.find(p=>p.id===opts.defaultProvider)?.id ?? providers[0]?.id ?? null,canWechat:!!opts.ownerChatId()}
    },
    async modelCatalog(providerId:string,path:string):Promise<AgentModelCatalog>{
      const entry=provider(providerId),canonical=canonicalProject(path)
      if(!entry.provider.modelCatalog)throw Error('model_catalog_unavailable')
      // Discovery providers own one bounded lifecycle, including process cleanup.
      // A second race here would abandon (rather than cancel) their work.
      try{return await entry.provider.modelCatalog({alias:'workbench:model-catalog',path:canonical})}
      catch(error){throw Error(error instanceof Error&&error.message==='model_catalog_invalid'?'model_catalog_invalid':'model_catalog_unavailable')}
    },
    prepareContinuation(id:string,executionChoice?:unknown):Continuation{
      ensureAccepting()
      const task=store.get(id)
      if(runsByTask.has(id)||!TERMINAL_TASK_STATUSES.includes(task.status))throw Error('workbench_busy')
      if(task.archivedAt!==null)throw Error('workbench_archived')
      if(store.source(id)?.firstDispatchedAt===null)throw Error('external_close_confirmation_required')
      return continuation(task,normalizeExecutionChoice(executionChoice,store.execution.choice(id)))
    },
    detail(id:string) {
      const detail=store.detail(id),running=runsByTask.get(id)
      const runtime=runtimeSnapshot(running)
      const subscription=store.wechatNotifications.subscription(id)
      const wechatNotifications={enabled:!!subscription?.enabled,notices:store.wechatNotifications.list(id).slice(-10).map(({id,runId,kind,status,reason,createdAt})=>({id,runId,kind,status,reason,createdAt}))}
      return {...detail,wechatNotifications,...(runtime?{runtime}:{}),execution:store.execution.choice(id),lastExecution:store.execution.last(id),attachments:store.attachments.list(id),task:taskView(detail.task,true),inputs:store.liveInputs.list(id),questions:running?.questions.pending()??[],
        // The timeline stays live through cancellation and process cleanup;
        // accepting supplemental input is a separate, narrower capability.
        ...(running?{runId:running.identity}:{}),
        ...(running&&!running.cancelled&&!running.finishing&&!running.uncertain?{inputMode:inputMode(running)}:{}),
        permissions:running?.permissions.pending() ?? [],...(!running ? {continuation:continuation(store.get(id)),...(store.source(id)?.firstDispatchedAt===null?{requiresExternalClose:true}:{})} : {})}
    },
    create(input:CreateTask):WorkbenchTaskView {
      return createTask(input)
    },
    continueTask(id:string,text:string,options?:{restartToken?:string;inputRequestId?:string}&InputMaterials):WorkbenchTaskView {
      ensureAccepting()
      const attachments=selectAttachments(options,id)
      const inputRequestId=options?.inputRequestId===undefined?undefined:normalizeInputRequestId(options.inputRequestId)
      if(inputRequestId!==undefined){
        const prior=store.liveInputs.get(inputRequestId)
        if(prior){
          if(prior.taskId!==id||prior.text!==checkedText(text,attachments)||!sameAttachments(prior.attachments,attachments))throw Error('input_conflict')
          // An omitted retry keeps its ORIGINAL choice, never later task defaults.
          const original=prior.execution??store.execution.run(id,prior.runId)?.choice
          if(options?.execution!==undefined&&(!original||!sameExecutionChoice(normalizeExecutionChoice(options.execution,original),original)))throw Error('input_conflict')
          return taskView(publicTask(store.get(id)))
        }
      }
      if (runsByTask.has(id)) throw new Error('workbench_busy')
      const task=store.get(id)
      const execution=normalizeExecutionChoice(options?.execution,store.execution.choice(id))
      if(store.source(id)?.firstDispatchedAt===null)throw new Error('external_close_confirmation_required')
      if(task.archivedAt!==null)throw new Error('workbench_archived')
      provider(task.providerId)
      if (canonicalProject(task.path)!==task.path) throw new Error('invalid_path')
      const request=checkedText(text,attachments),acceptedDirectoryIdentity=directoryIdentity(task.path)
      const restartToken=options?.restartToken
      if (restartToken!==undefined && (typeof restartToken!=='string' || !/^[a-f0-9]{64}$/.test(restartToken))) throw new Error('invalid_request')
      const decision=continuation(task,execution)
      if (restartToken!==undefined && (decision.mode!=='restart_required' || restartToken!==decision.restart.token)) throw new Error('restart_confirmation_stale')
      if (decision.mode==='restart_required' && restartToken===undefined) throw new Error('restart_confirmation_required')
      const accepted:AcceptedContinuation=decision.mode==='restart_required'
        ? {mode:'restart',preview:decision.restart}
        : decision.mode==='resume' ? {mode:'resume',sessionId:task.sessionId!} : {mode:'new'}
      try{return start(task,request,acceptedDirectoryIdentity,accepted,undefined,undefined,undefined,inputRequestId,attachments,options?.draftId,execution)}
      catch(error){
        if(inputRequestId&&store.liveInputs.get(inputRequestId))try{store.liveInputs.set(inputRequestId,'held','本轮未确认开始，补充内容已保留。')}catch{autoContinueBlocked.add(id)}
        throw error
      }
    },
    uploadAttachment(input:Parameters<typeof store.attachments.upload>[0]){ensureAccepting();if(input.taskId&&store.get(input.taskId).archivedAt!==null)throw Error('workbench_archived');return store.attachments.upload(input,opts.stateDir)},
    readAttachment(taskId:string,id:string){store.get(taskId);return store.attachments.read(taskId,id,opts.stateDir)},
    discardAttachment(id:string,draftId:string){return store.attachments.discard(id,draftId)},
    setArchived(id:string,archived:boolean):WorkbenchTaskView {
      if(typeof archived!=='boolean')throw new Error('invalid_request')
      const task=store.get(id)
      if(archived && !taskView(publicTask(task)).canArchive)throw new Error('workbench_busy')
      return taskView(publicTask(store.setArchived(id,archived)))
    },
    async cancel(id:string,expectedRunId?:string):Promise<WorkbenchTaskView> {
      const running=runsByTask.get(id)
      if(expectedRunId!==undefined&&running?.identity!==expectedRunId)throw new Error('control_stale')
      if (running) cancelRun(running)
      return taskView(publicTask(store.get(id)))
    },
    artifact(id:string,artifactId:string) {
      const a=store.artifact(id,artifactId),bytes=readArtifactSnapshot(a.storagePath,opts.stateDir,a.sha256)
      return {name:a.name,mime:a.mime,size:bytes.length,sha256:a.sha256,contentBase64:bytes.toString('base64')}
    },
    approve(id:string,artifactId:string,sha256:string) { service.artifact(id,artifactId); store.approve(id,artifactId,sha256) },
    resolvePermission(id:string,requestId:string,decision:PermissionDecision):void {
      store.get(id)
      if (decision!=='allow' && decision!=='deny') throw new Error('invalid_decision')
      const running=runsByTask.get(id)
      if (!running || !running.permissions.resolve(requestId,decision)) throw new Error('permission_stale')
    },
    async handleWechat(chatId:string,text:string,identity?:WechatMessageIdentity):Promise<WechatWorkbenchReply|null>{return wechatControl(chatId,text,identity)},
    shutdown():Promise<void> {
      if (shutdownPromise) return shutdownPromise
      stopping=true
      shutdownPromise=(async () => {
        const snapshot=[...runsByTask.values()]
        for (const running of snapshot) {
          try { cancelRun(running) }
          catch {
            running.cancelled=true
            try { running.permissions.rejectAll('cancelled') } catch { /* fail closed */ }
            revokeCredentials(running); running.signalStop()
            try { if (running.session?.cancel) void running.session.cancel().catch(() => {}) } catch { /* close still follows */ }
          }
        }
        await Promise.allSettled(snapshot.map(running => running.done))
        while(collections.size)await Promise.allSettled([...collections])
        shutdownComplete=true
        for (const running of [...runsByTask.values()]) releaseReservation(running)
      })()
      return shutdownPromise
    },
  }
  const wechatControl=makeWechatWorkbenchControl({store,ownerChatId:opts.ownerChatId,actions:service})
  return service
}
export type WorkbenchService=ReturnType<typeof makeWorkbenchService>
