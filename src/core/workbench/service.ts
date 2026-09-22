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
import { captureGitBaseline, finishGitReview, serializeGitReview, GIT_REVIEW_MIME, type GitBaseline, type GitReview, type ReviewFile } from './git-review'
import { composeReturnText, derivedReturnRequestId, parseGitReviewSnapshot, type ReviewTurn } from './review'
import type { ReviewMark } from './review-marks'
import { decodeNativeHistoryKey, normalizeHistoryList, normalizeHistoryRead, type NativeHistoryReader, type NativeHistoryProvider, type NativeHistoryListInput, type NativeHistoryReadInput } from './native-history'
import {readNativeImport,nativeImportInput,publicSource,pageInput,nativeResumeToken,snapshotHash,type ImportPage,type NativeImportInput,type NativeResumeDecision,type AcceptedNativeResume} from './native-adoption'
import {historyDeadline} from './native-history'
import {handoffToken,handoffTokenHash,validateHandoffInput,handoffArtifactText,handoffContext,type HandoffInput,type HandoffPreview,type ArtifactSelection,type AttachmentSelection} from './handoff'
import {makeDeltaCoalescer} from './delta-coalescer'
import {pathsConflict} from './scheduler'
import { restartPreview, type Continuation, type RestartPreview } from './continuation'
import {canResumeWorkbenchExecutor,isUnattendedExecutor,isWorkbenchExecutorCapabilities,isWorkbenchProviderId,requireWorkbenchInput,type WorkbenchExecutorCapabilities} from './executor-capabilities'
import { makeRunPermissions, type PermissionDecision, type RunPermissions, WORKBENCH_PERMISSION_TIMEOUT_MS } from './permissions'
import { findPathBlocker, type PathReservation, type WaitingFor } from './scheduler'
import { makeQuotaRegistry, classifyProviderError, type QuotaState } from '../provider-quota'
import { providerDisplayName } from '../provider-display-names'
import type { MatterStore } from '../matters/store'
import type { UsageSnapshot } from '../subscription-usage'
import { publicTask, TERMINAL_TASK_STATUSES, type WorkbenchListQuery, type StoredTask, type Task, type TaskStatus, type WorkbenchStore } from './store'
import { makeTaskChangeHub, type TaskChangeHub } from './task-changes'

interface Options {
  store: WorkbenchStore
  registry: ProviderRegistry
  stateDir: string
  ownerChatId: () => string | null
  /** 「一件事」登记处:任务与 matter 一对一同 id,生命周期同步(docs/cc-workbench.md「一件事」)。可选,老接线不传。 */
  matters?: MatterStore
  /** 订阅执行者的真实额度快照(subscription-usage.ts 的监视器缓存);登记处据此提前判耗尽,列表把它带给桌面。 */
  usage?: (providerId: string) => UsageSnapshot | null
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
  /** 保留会话安静下来、**没人等这个文件夹**时的空闲自动收工时长(ms;缺省 10 分钟)。
   *  纯粹是别让一个闲着的原生进程占着资源。允许 0(=立刻关)与很大的数(=几乎不自动关);
   *  负数/非数视作缺省。函数形式让主人改了 agent-config.json 立刻生效。 */
  retainedIdleCloseMs?: number | (() => number)
  /** 安静下来而**有人在等这个文件夹**时的短让位时长(ms;缺省 15 秒)。同上。 */
  handoffGraceMs?: number | (() => number)
  /** 变更信号中心(长轮询);不传就自建。 */
  changes?: TaskChangeHub
  /** 免审执行者的一次性确认(daemon 侧持久化);不传 ⇒ 免审执行者永远要求确认。 */
  unattendedAck?: { get(): number | null; set(at: number): void }
}
type AcceptedContinuation = { mode: 'new' } | { mode: 'resume'; sessionId: string } | { mode: 'restart'; preview: RestartPreview }
interface Active extends PathReservation {
  execution:AgentExecutionChoice
  attachments:Attachment[]
  handoffId?:string
  handoffArtifacts?:ArtifactSelection[]
  nativeResume?:AcceptedNativeResume
  reviewBaseline?: GitBaseline
  /** 已截取的代码变更快照数;第一份沿用旧名,之后带 -2/-3。 */
  reviewSeq?: number
  reviewCapture?: Promise<void>
  /** 醒来那一下的基线重取是否在途(见 retakeBaseline)。 */
  baselineRetaking?: boolean
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
  turnCollection?:Promise<void>
  /** 已记过的收集警告:每回合都重扫成果目录,同一条只记一次(评审 2026-09-16) */
  warned?:Set<string>
  /** 空闲自动收工的计时器:会话安静下来才起,任何一下互动都取消。`at` 是到点的绝对时刻
   *  (重排时用来判「新档位是不是更短」),`reason` 分「有人等的短让位」与「没人等的长空闲」。 */
  idleClose?:{timer:ReturnType<typeof setTimeout>;at:number;reason:'handoff'|'idle'}
  /** 停止请求到达时本轮已经答复 —— 那是收工,不是取消,终态记 completed。 */
  closedWhileReplied?: boolean
  credentialsMinted: boolean
  credentialsRevoked: boolean
}
export interface InputMaterials {attachmentIds?:string[];draftId?:string;execution?:unknown}
export interface CreateTask extends InputMaterials { title?: string; path: string; providerId: string; text: string }
export interface CreateWechatTask {ownerChatId:string;accountId:string;requestId:string;commandHash:string;projectId:string;providerId?:string;text:string}
export interface SendWechatArtifact {ownerChatId:string;accountId:string;requestId:string;commandHash:string;taskId:string;artifactId:string}
/**
 * 主人眼里的进度,两家执行者一致。持久化的 status 记的是这条 run 的生命周期
 * (Claude 会话保留时它永远是 running,Codex 自行收尾后是 completed),而主人要问的
 * 是「本轮做完没有、还能不能接着说」—— 那是 replied,与进程留不留无关。
 */
export type WorkbenchPhase='queued'|'working'|'replied'|'failed'|'cancelled'|'interrupted'
export interface WorkbenchTaskView extends Task { phase:WorkbenchPhase; importedOnly?:boolean; canArchive:boolean; waitingFor: WaitingFor | null; pendingPermissionCount?: number; pendingQuestionCount?:number; runtime?:AgentRuntimeSnapshot }

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
  const changes = opts.changes ?? makeTaskChangeHub()
  /** store 的写方法把 seq 落库,但不知道 hub —— 这里把持久化 seq 送进去唤醒长轮询。 */
  const touched = (id: string, seq?: number) => { try { changes.publish(id, seq ?? store.version(id)) } catch { /* 信号丢了只是多等一轮 */ } }
  /** 非 store 状态变化:先落库拿新 seq 再唤醒。bump 本身可能抛(任务不存在),别让它冒进调用方的 finally/catch。 */
  const bumped = (id: string) => { try { touched(id, store.bump(id)) } catch { /* 信号丢了只是多等一轮 */ } }
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
      bumped(id)
      autoContinueBlocked.delete(id)
    }catch{/* Stop must not depend on a successful disk write. */}
  }
  const runsByTask=new Map<string,Active>()
  /** 文件夹的占用:派发时写入,会话关闭(结算 / 隔离)时删除 —— 中间从不释放。 */
  const reservations=new Map<string,Active>()
  /** 各执行者的额度/限流状态(provider-quota.ts):从失败里认出来、记住、再避开。 */
  const quota=makeQuotaRegistry(Date.now,opts.usage)
  /** 除了 exhaustedId 之外、已准入且没耗尽的原生执行者 —— "交给谁继续"的候选。 */
  function fallbackExecutor(exhaustedId:string):string|null {
    for(const id of opts.registry.list()){
      if(id===exhaustedId||!isWorkbenchProviderId(id))continue
      const p=opts.registry.get(id);if(!p||!isWorkbenchExecutorCapabilities(p.opts.workbench)||p.opts.workbench.background!=='tracked')continue
      if(quota.exhausted(id))continue
      return id
    }
    return null
  }
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
      try{store.addEvent(task.id,'system','微信提醒未能保存；任务仍可在工作台查看。',null,runId);touched(task.id)}catch{}
    }
  }
  function requestNotice(task:StoredTask,runId:string,kind:'permission'|'question',id:string,label:string){
    enqueueNotice(task,runId,kind,`${task.title.replace(/[\r\n]+/g,' ')} · ${task.id}\n${task.providerId} · ${kind==='permission'?'需要你批准':'需要你回答'}\n\n${label.slice(0,600)}\n\n查看：任务 ${task.id} ${kind==='permission'?'权限':'问题'} ${id}`,id)
  }
  function stageFinishedNotice(running:Active,status:TaskStatus,error:string|null=null){
    if(!TERMINAL_TASK_STATUSES.includes(status))return
    const watch=store.wechatNotifications.subscription(running.taskId)
    if(!watch?.enabled||watch.ownerChatId!==running.task.ownerChatId||watch.ownerChatId!==opts.ownerChatId())return
    let reply=store.events(running.taskId).filter(e=>e.runId===running.identity&&e.kind==='text').at(-1)?.text
    const label={completed:'这一轮已完成',failed:'这一轮需要处理',interrupted:'这一轮已中断',cancelled:'这一轮已停止'}[status as 'completed'|'failed'|'interrupted'|'cancelled']
    if(status==='failed'&&(error==='provider_quota_exhausted'||error==='provider_rate_limited')){
      const code=error,other=fallbackExecutor(running.task.providerId)
      reply=`${executionFailureMessage(code)}${other?`\n交给 ${providerDisplayName(other)} 继续？回「是」我就把这件事交给它。`:''}`
    }
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
    const entry=isWorkbenchProviderId(id)?opts.registry.get(id):null
    if(!entry||!isWorkbenchExecutorCapabilities(entry.opts.workbench))throw new Error('unavailable_provider')
    return entry as typeof entry&{opts:typeof entry.opts&{workbench:WorkbenchExecutorCapabilities}}
  }
  function requireInput(providerId:string,attachments:readonly unknown[],execution:AgentExecutionChoice,resume=false){
    const entry=provider(providerId)
    if(isUnattendedExecutor(entry.opts.workbench)&&(opts.unattendedAck?.get()??null)===null)throw new Error('unattended_ack_required')
    requireWorkbenchInput(entry.opts.workbench,{attachments,execution,resume})
    return entry
  }
  function canResume(task:StoredTask):boolean {
    try {
      const entry=provider(task.providerId)
      return !!task.sessionId&&canResumeWorkbenchExecutor(entry.opts.workbench)&&!!entry.opts.canResume(task.path,task.sessionId)
    }
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
  /** 当前占着文件夹的 run。 */
  const held=()=>[...reservations.values()]
  function waitingFor(running:Active):WaitingFor|null {
    if (running.state !== 'queued') return null
    const earlier=queue.filter(item => item.order < running.order && item.state === 'queued')
    return findPathBlocker(running,[...held(),...earlier])
  }
  function runtimeSnapshot(running:Active|undefined):AgentRuntimeSnapshot|undefined {
    const runtime=running?.session?.workbenchRuntime
    return runtime?{...runtime.snapshot()}:undefined
  }
  function inputMode(running:Active):'steer'|'send'|'queue' {
    return runtimeSnapshot(running)?.input??(running.session?.steer?'steer':'queue')
  }
  /** 本轮做完、会话闲着、没有子任务在写、也没有在等主人拍板 —— 只差主人下一句话。 */
  function isReplied(running:Active):boolean {
    if (running.cancelled||running.finishing||running.uncertain) return false
    const snapshot=runtimeSnapshot(running)
    return !!snapshot&&snapshot.retained&&snapshot.foreground==='idle'&&snapshot.backgroundCount===0
      &&running.permissions.pending().length===0&&running.questions.pending().length===0
  }
  function phaseOf(task:Task, running:Active|undefined):WorkbenchPhase {
    switch (task.status) {
      case 'queued': return 'queued'
      case 'running': case 'cancelling': return running&&isReplied(running)?'replied':'working'
      case 'completed': return 'replied'
      case 'failed': case 'cancelled': case 'interrupted': return task.status
    }
  }
  function taskView(task:Task, includePermissions=false):WorkbenchTaskView {
    const running=runsByTask.get(task.id)
    const runtime=runtimeSnapshot(running)
    return {
      ...task,
      phase:phaseOf(task,running),
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
  /**
   * 回合结束就把成果登记上。会话保留时这条 run 不会结算,`collect` 也就不会跑,
   * 于是文件躺在成果目录里而详情的成果列表是空的 —— 主人得先「取消」才看得见
   * 自己刚拿到的东西(2026-09-15 真机)。`collectArtifacts` 按 name+sha256 去重,
   * 重复调用安全;结算时那次照旧,代码变更快照仍然只在那里生成。
   */
  function collectTurnArtifacts(running:Active) {
    if (running.artifactsCollected || shutdownComplete || running.turnCollection) return
    const pending=(async()=>{
      // 先让出事件流回调:目录扫描 + 哈希是同步的,别让它卡在 SDK 流的消费点上。
      await new Promise<void>(resolve=>setImmediate(resolve))
      if (shutdownComplete || running.artifactsCollected || running.uncertain || running.finishing || running.cancelled) return
      try {
        if (canonicalProject(running.path)!==running.path || directoryIdentity(running.path)!==running.directoryIdentity) return
        noteWarnings(running,collectArtifacts(store,running.taskId,running.path,opts.stateDir))
        touched(running.taskId)
      } catch { /* 结算时还会再收一次,这里不打断本轮 */ }
    })()
    running.turnCollection=pending;collections.add(pending)
    const clear=()=>{collections.delete(pending);if(running.turnCollection===pending)running.turnCollection=undefined}
    void pending.then(clear,clear)
  }
  function noteWarnings(running:Active,warnings:string[]) {
    const seen=(running.warned??=new Set())
    for (const warning of warnings) { if (seen.has(warning)) continue; seen.add(warning); store.addEvent(running.taskId,'system',warning); touched(running.taskId) }
  }
  async function captureOutputs(running:Active) {
    if (running.artifactsCollected || shutdownComplete) return
    running.artifactsCollected=true
    try {
      if (canonicalProject(running.path) !== running.path || directoryIdentity(running.path) !== running.directoryIdentity) throw new Error('invalid_path')
      await captureCodeChanges(running)
      if(canonicalProject(running.path)!==running.path || directoryIdentity(running.path)!==running.directoryIdentity)throw new Error('invalid_path')
      noteWarnings(running,collectArtifacts(store,running.taskId,running.path,opts.stateDir))
      touched(running.taskId)
    }
    catch { try { store.addEvent(running.taskId,'system','本轮成果目录无法读取，请检查文件夹权限或是否被移动。');touched(running.taskId) } catch { /* storage is already unavailable */ } }
  }
  function revokeCredentials(running:Active) {
    if (!running.credentialsMinted || running.credentialsRevoked) return
    running.credentialsRevoked=true
    try { opts.revokeSessionToken?.(`workbench/${running.taskId}`) } catch { /* token expiry remains fail closed */ }
  }
  /**
   * 一个文件夹,同时只有一个**还能写它**的会话:占用从派发开始,到那个会话被关闭为止。
   * 「还能写」是能力不是行为 —— 一条保留下来的原生会话随时会被后台通知唤醒、自己又动手
   * (`claude-workbench-runtime` 里 `retained` 是黏性的,`foreground` 能从 idle 自己翻回 running,
   * 没有任何事件预告「我要开始写了」)。所以不存在「答复即释放」:2026-09-15 起的那套
   * 「答复即释放 + 续接再申请」以及 2026-09-21 早上为维持它而加的回合代数 / fail-closed
   * 都是在用事后观察逼近一个本来不成立的等式,这一轮整套删掉
   * (docs/superpowers/specs/2026-09-21-one-folder-one-session-design.md)。
   *
   * 文件夹让出来只有三条路:执行者自己收工(不保留会话的,流结束即结算)、主人收工、
   * **空闲自动收工**(下面的计时器)。
   */
  /**
   * 把当前基线以来的代码变更截成一份快照,然后丢掉基线。差异边界 = 回合边界:回合安静时
   * (以及结算时)截一次,续接时重新取基线 —— 同文件夹里别人改的文件不会被记到这条任务头上
   * (别人根本进不来:文件夹一直是它的)。
   */
  function captureCodeChanges(running:Active):Promise<void> {
    // 正在截的那份就是答案:续接会先 await 它再取新基线,所以这里复用不会把新回合的改动截进来。
    if (running.reviewCapture) return running.reviewCapture
    const pending=(async()=>{
      const baseline=running.reviewBaseline
      if (!baseline || !running.session) return
      running.reviewBaseline=undefined
      try {
        const report=await finishGitReview(baseline)
        if(shutdownComplete)return
        if(canonicalProject(running.path)!==running.path || directoryIdentity(running.path)!==running.directoryIdentity)throw new Error('invalid_path')
        if(!report||!report.files.some(f=>f.kind!=='not_reviewed'))return
        const seq=(running.reviewSeq??0)+1; running.reviewSeq=seq
        saveArtifactSnapshot(store,running.taskId,{name:`代码变更-${running.identity.slice(0,8)}${seq>1?`-${seq}`:''}.json`,mime:GIT_REVIEW_MIME,bytes:serializeGitReview(report)},opts.stateDir)
        touched(running.taskId)
      } catch { try { store.addEvent(running.taskId,'system','代码对比未能保存；其他成果仍会单独收集。');touched(running.taskId) } catch { /* storage unavailable */ } }
    })()
    running.reviewCapture=pending
    void pending.then(()=>{if(running.reviewCapture===pending)running.reviewCapture=undefined},()=>{if(running.reviewCapture===pending)running.reviewCapture=undefined})
    return pending
  }
  /** 给「自己醒来的那一轮」重取一份差异基线。异步且吞异常(同 `submitInput` 里那一格);
   *  期间要是别人已经放了一份(主人正好也续接了),就不覆盖它。
   *  `baselineRetaking` 是在途守卫:基线要到结尾才落位,`!reviewBaseline` 挡不住在途的那一份,
   *  而一段自动续作会连着抖好几次 quiet↔busy —— 每次都开一个 `captureGitBaseline` 就是白跑一串
   *  git 子进程(BASE 用 `autonomousTurn` 挡的是同一件事,评审修复轮 #7)。 */
  async function retakeBaseline(running:Active):Promise<void> {
    if (running.baselineRetaking||running.reviewBaseline||running.cancelled||running.finishing||running.uncertain) return
    running.baselineRetaking=true
    try {
      const baseline=await captureGitBaseline(running.path,{})
      if (!running.reviewBaseline&&!running.cancelled&&!running.finishing&&!running.uncertain) running.reviewBaseline=baseline
    } catch { /* 没基线就没有这一轮的代码对比,其他成果照收 */ }
    finally { running.baselineRetaking=false }
  }
  /** 会话安静:本轮做完、没有后台子任务在写、也没有待决权限/提问 —— 只差主人下一句话。
   *  空闲自动收工的判据就是它。 */
  const quiet=isReplied
  const msKnob=(value:number|(()=>number)|undefined,fallback:number):number=>{
    let raw:unknown
    try { raw=typeof value==='function'?value():value } catch { return fallback }
    return typeof raw==='number'&&Number.isFinite(raw)&&raw>=0?raw:fallback
  }
  const handoffGraceMs=()=>msKnob(opts.handoffGraceMs,15_000)
  const retainedIdleMs=()=>msKnob(opts.retainedIdleCloseMs,600_000)
  /**
   * 主人已经交上来、还没投给执行者的补充(`pending` / `sending` —— 和 `holdInputs` / `recover`
   * 盯的是同一批)。有这种补充就不能自动收工:收工走的是 `cancelRun`,结算时 `running.cancelled`
   * 让这批补充走 `holdInputs` 而不是 `drainInputs`,主人刚打的那句话被文件夹移交盖成
   * 「补充尚未发送」(评审修复轮 #6 —— 和修复轮 #1 是同一个失败形状,只是触发者换成了
   * 「之后才来的等待者把短让位重新武装起来」)。
   * 读不出来就当有:宁可文件夹多占一会儿,也不能把主人的话弄丢。
   */
  function hasUndeliveredInput(running:Active):boolean {
    try { return store.liveInputs.count(running.taskId)>0 } catch { return true }
  }
  /**
   * 会话安静下来就起一个计时器,到点关掉会话、让出文件夹。两档:有人在等这个文件夹 ⇒ 短让位;
   * 没人等 ⇒ 长空闲(别让一个闲着的原生进程占着资源)。已经排好的短让位不会被长空闲推迟。
   */
  function armIdleClose(running:Active):void {
    if (!quiet(running)||running.finishing||running.cancelled||hasUndeliveredInput(running)) return
    const wanted=queue.some(item=>item.state==='queued'&&!!findPathBlocker(item,[running]))
    const ms=wanted?handoffGraceMs():retainedIdleMs()
    const at=Date.now()+ms
    const existing=running.idleClose
    if (existing&&existing.at<=at) return
    if (existing) clearTimeout(existing.timer)
    running.idleClose={timer:setTimeout(()=>closeForIdle(running),ms),at,reason:wanted?'handoff':'idle'}
  }
  function cancelIdleClose(running:Active):void {
    const armed=running.idleClose
    if (!armed) return
    running.idleClose=undefined
    clearTimeout(armed.timer)
  }
  /** 到点:再确认一遍还安静、文件夹还是它的、没在收尾,然后按「收工」关掉会话(答复早已交付,
   *  所以终态记 completed,等同主人点「结束后台会话」)。 */
  function closeForIdle(running:Active):void {
    const armed=running.idleClose
    running.idleClose=undefined
    if (!armed) return
    // 武装点已经拦过未投递的补充,这里再看一眼只是把「落笔前复查一遍」补全。
    if (!quiet(running)||reservations.get(running.identity)!==running||running.finishing||running.cancelled||hasUndeliveredInput(running)) return
    const next=queue.find(item=>item.state==='queued'&&!!findPathBlocker(item,[running]))
    const seconds=Math.round((armed.reason==='handoff'?handoffGraceMs():retainedIdleMs())/1000)
    const text=next
      ? `空闲 ${seconds} 秒后自动收工，文件夹让给「${next.title.replace(/[\r\n]+/g,' ')}」；要接着说直接发下一句，会按原会话恢复。`
      : `空闲 ${seconds} 秒后自动收工，释放文件夹；要接着说直接发下一句，会按原会话恢复。`
    try { store.addEvent(running.taskId,'system',text);touched(running.taskId) } catch { /* 收工照走 */ }
    running.closedWhileReplied=true
    try { cancelRun(running) } catch { /* 已经在收尾的路上,留给 execute 的 finally */ }
  }
  /**
   * 本回合安静下来:登记成果(评审 2026-09-16:会话保留时这条 run 不会结算,`collect` 也就不会跑,
   * 成果得等主人「取消」才看得见)、把 matter 标成已答复、起空闲自动收工的计时。
   * 还在等主人拍板就只收成果、不计时 —— 那不叫安静。重复调用无害:收集自己去重,计时不会被推迟。
   */
  function settleQuiet(running:Active):void {
    const snapshot=runtimeSnapshot(running)
    // 与「该暂停了」的判据同义:回合真的停下来了才登记,否则会把半成品当成固定版本的成果发布出去。
    if (!snapshot?.retained||snapshot.foreground!=='idle'||snapshot.backgroundCount!==0) return
    collectTurnArtifacts(running)
    if (!quiet(running)) return
    matterSync(m=>m.setStatus(running.taskId,'replied'))
    // 差异边界 = 回合边界:这一轮的代码变更现在就截(以前这一步挂在「答复即释放」后面,
    // 那条路没了)。续接会先 await 这份在途的快照再取新基线,所以不会把下一轮的改动算进来。
    void captureCodeChanges(running).catch(()=>{})
    armIdleClose(running)
  }
  /**
   * 拍完板重新评估一次安静:请求**自己超时**(权限 5 分钟)那一下既没有事件也不走 resolvePermission,
   * 会话早就静下来的话没有人会回来起计时(终审 I4)。先取消再重新评估,幂等。
   */
  function settleAfterDecision(running:Active):void {
    if (running.cancelled||running.finishing) return
    cancelIdleClose(running)
    settleQuiet(running)
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
    // 这条 run 的占用在结算时本该还回去(execute 的 finally),但它没能确认退出 —— 重新挂回去,
    // 之后到来的同文件夹任务按 writer_not_closed 等待,直到 confirmLateClose。
    reservations.set(running.identity,running)
  }

  async function execute(task:StoredTask,text:string,running:Active) {
    const sessionKey=`workbench/${task.id}`
    let finalStatus:TaskStatus='failed'
    let finalError:string|null=null
    let spawning:Promise<AgentSession>|undefined
    let spawnRejected=false
    let accepted=false
    try {
      requireInput(task.providerId,running.attachments,running.execution,running.continuation.mode==='resume')
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
        touched(task.id)
      }
      const directory=outputDirectory(running.path,task.id)
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
      const entry=requireInput(task.providerId,running.attachments,running.execution,running.continuation.mode==='resume')
      const token=opts.mintSessionToken?.(sessionKey)
      running.credentialsMinted=!!opts.mintSessionToken
      if (running.cancelled) revokeCredentials(running)
      store.update(task.id,running.cancelled ? 'cancelling' : 'running');touched(task.id)
      if (running.cancelled) { finalStatus='cancelled'; return }
      spawning=entry.provider.spawn({alias:`workbench:${task.id}`,path:running.path},{
        workbenchTimeline:true,
        workbenchLifecycle:true,
        execution:{...running.execution},
        reportExecution:value=>{
          if(runsByTask.get(task.id)!==running||running.cancelled||running.finishing)return
          if(resume&&value.sessionId&&value.sessionId!==resume)throw Error('native_session_identity_mismatch')
          store.execution.observe(task.id,running.identity,value)
          bumped(task.id)
        },
        reportNotice:message=>{
          if(runsByTask.get(task.id)!==running||running.cancelled||running.finishing)return
          const notice=message.trim().slice(0,2000)
          if(notice){store.addEvent(task.id,'system',notice,null,running.identity);touched(task.id)}
        },
        tierProfile:TIER_PROFILES.trusted,permissionMode:isUnattendedExecutor(entry.opts.workbench)?'dangerously':'strict',chatId:task.ownerChatId ?? `workbench:${task.id}`,
        ...(resume ? {resumeSessionId:resume} : {}),mcpEnv:sessionAuthEnv('trusted',token),appendInstructions:instructions,
        // 结束在这里补一次评估:请求**自己超时**(权限 5 分钟)那一下既没有事件、也不走
        // resolvePermission —— 会话早就静下来的话,没有人会回来起空闲收工的计时(终审 I4)。
        requestPermission:(request,signal) => {running.interactionAt=Date.now();bumped(task.id);return running.permissions.request(request,signal).finally(()=>{running.interactionAt=Date.now();bumped(task.id);settleAfterDecision(running)})},
        requestUserInput:(request,signal) => {running.interactionAt=Date.now();bumped(task.id);return running.questions.request(request,signal).finally(()=>{running.interactionAt=Date.now();bumped(task.id);settleAfterDecision(running)})},
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
      let flushErrorNoted=false
      const coalescer=makeDeltaCoalescer(ev => {
        if (ev.kind==='text'||ev.kind==='tool_call'||ev.kind==='error') { store.recordAgentEvent(task.id,running.identity,ev); touched(task.id) }
      },{onError:()=>{
        // 定时器驱动的 flush 落库失败(比如 SQLite 一过性错误):别让它把进程带走,
        // 本轮记一条提示就够,不用每次 flush 都刷屏。
        if (flushErrorNoted) return
        flushErrorNoted=true
        try { store.addEvent(task.id,'system','有一段输出没能保存，后面的会照常。'); touched(task.id) } catch { /* best effort */ }
      }})
      /**
       * 状态转移探测器(评审 2026-09-21 #6 #2):每个事件之后比一次快照,而不是只看 `result`。
       * 最后一个后台子任务结束只推一条 `tool_call`(#6);保留会话被后台通知唤醒也没有任何事件
       * 说「新回合开始了」(#2)—— 两处都只认得出 foreground / backgroundCount 的跳变。
       */
      let previous=runtimeSnapshot(running)
      let transitionErrorNoted=false
      const noteTransition=()=>{
        const before=previous,after=runtimeSnapshot(running)
        previous=after
        if (!before||!after) return
        if (running.cancelled||running.finishing||running.uncertain) return
        const nowQuiet=after.foreground==='idle'&&after.backgroundCount===0
        const wasQuiet=before.foreground==='idle'&&before.backgroundCount===0
        // 静下来就交给 settleQuiet 判:它自己会因为「还在等主人拍板」而只收成果、不起计时。
        // 这里若因为有待决请求而跳过,这一次转移就被吃掉了 —— 之后 wasQuiet 一直是 true,
        // 再没有人回来收尾(评审 2026-09-21 #6 续:后台问题活过了父回合的答复)。
        if (nowQuiet&&!wasQuiet) { settleQuiet(running); return }
        // 又动起来了(自己被后台通知唤醒也算):不再安静就不再计时。文件夹本来就是它的,
        // 它想写就写 —— 没有什么要 fail-closed 的。
        if (!nowQuiet&&wasQuiet) {
          cancelIdleClose(running)
          // 上一轮安静时 `captureCodeChanges` 已经把基线消费掉了,而取基线只有两个入口:起步和
          // 主人续接(`submitInput`)。自己醒来这条路没有入口 —— BASE 是靠 `onAutonomousStart`
          // → `beginTurn` 重取的,那两个函数这一轮删了。不补的话「自己醒来干的这一轮」永远生不出
          // 代码变更,而新不变式下这种活是合法的、它的差异比以前更重要(修复轮 #3)。
          if (!running.reviewBaseline) void retakeBaseline(running)
        }
      }
      let summary
      try {
        summary=await collectWorkbenchTurn(stream,running.stop,opts.timeoutMs ?? 10*60_000,
          ev => {
            if (running.cancelled) return
            if(running.queuedInputId&&['text','tool_call','result'].includes(ev.kind)){store.liveInputs.set(running.queuedInputId,'delivered');bumped(task.id)}
            if ((ev.kind==='init'||(runtime&&ev.kind==='result')) && ev.sessionId) {matterSync(m=>m.addSession(task.id,task.providerId,ev.sessionId!,'main'));if(resume&&ev.sessionId!==resume)throw new Error('native_session_identity_mismatch');store.session(task.id,ev.sessionId);if(running.handoffId){const peer=store.recordHandoffNative(running.handoffId,ev.sessionId);if(peer)touched(peer.sourceTaskId)}touched(task.id)}
            coalescer.push(ev)
            // 额度/限流在错误到达时就登记(评审 #5:只在结算时看,保留会话永远等不到结算);
            // 任何一个成功回合(result)即视为这家恢复。
            if (ev.kind==='error') quota.note(task.providerId,ev.message)
            if (ev.kind==='result') quota.clear(task.providerId)
            if (ev.kind==='result') settleQuiet(running)
            // observe 是**故意**会往外抛的(身份不符那条),所以探测器自己抛出会把整轮带走。
            // 落定漏一次会被下一个事件补上,抛出去却不可逆 —— 吞掉,只记一次(终审 M5)。
            try { noteTransition() } catch {
              if (!transitionErrorNoted) {
                transitionErrorNoted=true
                try { store.addEvent(task.id,'system','本轮的状态跟踪出过一次错；收尾会在后面的事件里补上。');touched(task.id) } catch { /* best effort */ }
              }
            }
          },()=>{
            const snapshot=runtimeSnapshot(running)
            return running.questions.pending().length>0||running.permissions.pending().length>0||!!(snapshot?.retained&&snapshot.foreground==='idle'&&snapshot.backgroundCount===0)
          },()=>running.interactionAt,runtime?()=>runtime.start(request,material):undefined)
      } finally { coalescer.dispose() }
      if (!summary) { finalStatus='cancelled'; return }
      if (summary.result?.sessionId) {if(resume&&summary.result.sessionId!==resume)throw new Error('native_session_identity_mismatch');store.session(task.id,summary.result.sessionId);if(running.handoffId){const peer=store.recordHandoffNative(running.handoffId,summary.result.sessionId);if(peer)touched(peer.sourceTaskId)}touched(task.id)}
      if (running.cancelled) finalStatus='cancelled'
      else if (summary.error || !summary.result || runtime?.snapshot().retained) {
        // An old foreground result cannot turn an unexpected retained EOF into success.
        const raw=summary.error ?? (runtime?.snapshot().retained?'background_runtime_ended':'stream_ended_without_result')
        // 额度/限流(真机 2026-09-16:Codex 额度耗尽,原文当错误码存进 task.error,通知空白):
        // 认出来就换成稳定错误码、登记这家耗尽,事件里说人话并附原文摘要。
        const quotaKind=summary.error?classifyProviderError(summary.error):null
        const error=quotaKind==='quota'?'provider_quota_exhausted':quotaKind==='rate_limit'?'provider_rate_limited':raw
        if(quotaKind)quota.note(task.providerId,summary.error!)
        finalStatus='failed'; finalError=error
        store.addEvent(task.id,'error',error==='background_runtime_ended'?'后台执行会话意外结束；对话已保留，请检查后再继续。':quotaKind?`${executionFailureMessage(error)}\n原文：${summary.error!.trim().slice(0,200)}`:executionFailureMessage(error))
        touched(task.id)
      } else { finalStatus='completed'; quota.clear(task.providerId) }
    } catch (error) {
      const message=error instanceof Error ? error.message : 'task_failed'
      finalStatus=running.cancelled ? 'cancelled' : 'failed'; finalError=running.cancelled ? null : message
      if (!running.cancelled) { store.addEvent(task.id,'error',message==='restart_confirmation_required' ? RECOVERY_MESSAGE : executionFailureMessage(message)); touched(task.id) }
    } finally {
      cancelIdleClose(running)
      running.finishing=true;running.questions.close();bumped(task.id)
      for(const input of running.runtimeInputs?.values()??[])settleRuntimeInput(running,input,new Error('runtime_closed_before_input_acknowledgement'))
      running.permissions.rejectAll(running.cancelled ? 'cancelled' : 'ended');bumped(task.id)
      let closePromise:Promise<void>|undefined
      let closeTimer:ReturnType<typeof setTimeout>|undefined
      if (running.session) {
        try {
          closePromise=Promise.resolve(running.session.close())
          await Promise.race([closePromise,new Promise<never>((_resolve,reject) => { closeTimer=setTimeout(() => reject(new Error('close_timeout')),opts.closeTimeoutMs ?? 3000) })])
        } catch {
          markUncertain(running); finalStatus='interrupted'; finalError='writer_not_closed'
          try { store.addEvent(task.id,'system','执行程序未确认退出，此文件夹内的新任务将等待。请检查后台进程或重启服务。');touched(task.id) } catch { /* final status write below may still succeed */ }
          if (closePromise) void closePromise.then(() => confirmLateClose(running,true),() => {})
        } finally { if (closeTimer) clearTimeout(closeTimer) }
      }
      if (!running.uncertain) await collect(running)
      revokeCredentials(running)
      if (running.uncertain) { finalStatus='interrupted'; finalError='writer_not_closed' }
      let terminalCommitted=false
      try {
        const status=running.cancelled&&!running.uncertain?(running.closedWhileReplied?'completed':'cancelled'):finalStatus
        store.atomic(()=>{
          store.finishRunActivities(task.id,running.identity,running.cancelled&&!running.uncertain?'cancelled':'interrupted')
          store.update(task.id,status,finalError)
          stageFinishedNotice(running,status,finalError)
        })
        touched(task.id)
        terminalCommitted=true
        matterSync(m=>m.setStatus(task.id,status==='interrupted'?'open':'done'))
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
      store.liveInputs.set(next.id,'sending');bumped(id)
      const execution=next.execution??store.execution.run(id,next.runId)?.choice??store.execution.choice(id)
      requireInput(task.providerId,next.attachments??[],execution,true)
      start(task,next.text,expectedDirectoryIdentity,{mode:'resume',sessionId:task.sessionId!},undefined,undefined,undefined,next.id,next.attachments,undefined,execution)
    }catch(error){holdInputs(id,error instanceof Error?error.message:'input_not_delivered')}
  }

  function settleRuntimeInput(running:Active,saved:LiveInput,error?:unknown) {
    if(shutdownComplete){running.runtimeInputs?.delete(saved.id);return}
    try {
      // held-only 落库不会自己 bump(store.addEvent 才会);两条分支分别记账,没写就不吵。
      let changed:'held'|'delivered'|null=null
      store.atomic(()=>{
        const current=store.liveInputs.get(saved.id)
        if(!current||current.taskId!==saved.taskId||current.runId!==saved.runId||current.text!==saved.text||!sameAttachments(current.attachments,saved.attachments))return
        if(error!==undefined){
          // Stop/recovery may already have held it. Never revive an old send.
          if(current.status==='sending'){store.liveInputs.set(saved.id,'held',`${INPUT_UNCONFIRMED}${error instanceof Error?' '+error.message:''}`);changed='held'}
          return
        }
        if(current.status!=='sending'&&current.status!=='held')return
        // A late positive native acknowledgement is truthful only for this receipt.
        store.liveInputs.set(saved.id,'delivered')
        store.addEvent(saved.taskId,'user',saved.text,null,saved.runId,saved.attachments)
        changed='delivered'
      })
      if(changed==='held')bumped(saved.taskId)
      else if(changed==='delivered')touched(saved.taskId)
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
      const blocker=findPathBlocker(running,[...held(),...earlier])
      if (blocker) {
        // 「有人来等这个文件夹了」的唯一入口:挡路的那条会话若已经安静,就按短让位重排它的
        // 自动收工(armIdleClose 自己判安静,不安静就什么都不做)。
        const holder=runsByTask.get(blocker.taskId)
        if (holder&&reservations.get(holder.identity)===holder) armIdleClose(holder)
        continue
      }
      running.state='active'; reservations.set(running.identity,running); launch.push(running)
    }
    for (const running of launch) queue.splice(queue.indexOf(running),1)
    for (const running of launch) {
      void Promise.resolve().then(() => execute(running.task,runningText.get(running.identity)!,running)).catch(() => {
        if (running.publicFinished) return
        try { running.questions.close(); running.permissions.rejectAll(running.cancelled ? 'cancelled' : 'ended'); bumped(running.taskId) } catch { /* fail closed */ }
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
    requireInput(task.providerId,dispatchAttachments,execution,acceptedContinuation.mode==='resume')
    // addRunEvent 自己 touched:权限/提问审计在 atomic 块外单独发生,不能漏。
    // 事务里面(下面 store.atomic 块内)绝不能用它——半路抛错时 bump 跟着回滚,但 touched 已经
    // 把 hub 拱到了那个从没真正落库的 seq,之后 wait 会把这个"幻影 seq"当成已经发生过的事,
    // 一路卡到超时才被 store.version 兜底纠正(纠正见下面 changes.wait);直接调 store.addEvent
    // 就不会发布这个未提交的信号,提交后的 touched(task.id)(atomic 块外)会把真实 seq 发出去。
    const addRunEvent=(kind:'user'|'system',text:string)=>{const id=store.addEvent(task.id,kind,text,null,runId);touched(task.id);return id}
    const handoffPeer=store.atomic(()=>{
      store.execution.accept(task.id,runId,execution)
      const bound=store.attachments.bind(attachments.map(a=>a.id),task.id,draftId)
      if(!sameAttachments(bound,attachments))throw Error('invalid_attachment_changed')
      // A queued receipt keeps the ORIGINAL accepted run, even when this is a new dispatch run.
      if(queuedInputId&&!store.liveInputs.get(queuedInputId)){
        store.liveInputs.add({id:queuedInputId,taskId:task.id,runId,text,attachments,execution})
        store.liveInputs.set(queuedInputId,'sending')
      }
      if(nativeResume)store.addEvent(task.id,'system',`用户声明原 ${task.providerId} 执行程序已关闭，选择${nativeResume.mode==='native_resume'?'恢复原会话':'带已确认的记录新开一轮'}。原会话：${nativeResume.nativeId}。`,null,runId)
      const requestEventId=store.addEvent(task.id,'user',text,null,runId,attachments)
      const peer=handoffId?store.recordHandoffEvent(handoffId,requestEventId):null
      store.update(task.id,'queued')
      acceptance?.persist(runId)
      return peer
    })
    // recordHandoffEvent 同时 bump 了交接的另一头(source 任务),不发它那边就看不到这条请求已挂上。
    if(handoffPeer)touched(handoffPeer.sourceTaskId)
    touched(task.id)
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

  /** matter 同步永不打断任务本身:登记失败只是少一条索引,任务照跑。 */
  function matterSync(fn:(m:MatterStore)=>void):void { if(!opts.matters)return; try{fn(opts.matters)}catch{/* 见上 */} }
  function createTask(input:CreateTask,onAccepted?:(task:StoredTask,runId:string)=>void):WorkbenchTaskView {
    ensureAccepting()
    const execution=normalizeExecutionChoice(input.execution,PROVIDER_EXECUTION_CHOICE)
    const attachments=selectAttachments(input),text=checkedText(input.text,attachments)
    requireInput(input.providerId,attachments,execution)
    if(input.title!==undefined&&(typeof input.title!=='string'||!input.title.trim()||input.title.length>120))throw Error('invalid_title')
    const path=canonicalProject(input.path),acceptedDirectoryIdentity=directoryIdentity(path)
    if(opts.executionConflict?.(path,input.providerId,null))throw Error('native_session_busy')
    let activate:()=>void=()=>{}
    const accepted=store.atomic(()=>{
      const task=store.create({title:input.title?.trim()??(text.slice(0,40)||attachments[0]!.name.slice(0,40)),path,providerId:input.providerId,ownerChatId:opts.ownerChatId()})
      matterSync(m=>{m.create({id:task.id,kind:'task',title:task.title,projectPath:path,ownerChatId:task.ownerChatId??null});m.linkTask(task.id);if(task.ownerChatId)m.bind(task.id,'wechat',task.ownerChatId)})
      return start(task,text,acceptedDirectoryIdentity,undefined,undefined,undefined,undefined,undefined,attachments,input.draftId,execution,{
        persist:runId=>onAccepted?.(task,runId),activate:fn=>{activate=fn},
      })
    })
    // An accepted in-memory run must never outlive a rolled-back creation transaction.
    activate()
    return accepted
  }

  function cancelRun(running:Active):void {
    cancelIdleClose(running)
    running.questions.close();bumped(running.taskId);holdInputs(running.taskId,'任务已停止，补充尚未发送。')
    if (running.state==='queued') {
      running.cancelled=true; running.permissions.rejectAll('cancelled'); bumped(running.taskId); running.signalStop()
      const index=queue.indexOf(running); if (index>=0) queue.splice(index,1)
      runningText.delete(running.identity)
      try {
        store.atomic(()=>{store.update(running.taskId,'cancelled');stageFinishedNotice(running,'cancelled')})
        touched(running.taskId)
        matterSync(m=>m.setStatus(running.taskId,'done'))
        publishFinishedNotices()
      } catch { /* in-memory cancellation still must settle */ }
      running.publicFinished=true; running.resolveDone()
      if (runsByTask.get(running.taskId)===running) runsByTask.delete(running.taskId)
      if (!stopping) pump()
      return
    }
    if (running.state==='uncertain') return
    if (!running.cancelled) {
      if (isReplied(running)) running.closedWhileReplied=true
      running.cancelled=true; running.permissions.rejectAll('cancelled'); bumped(running.taskId); revokeCredentials(running); running.signalStop()
      try { store.update(running.taskId,'cancelling'); touched(running.taskId) } catch { /* stop the writer even when persistence is unavailable */ }
      try { if (running.session?.cancel) void running.session.cancel().catch(() => {}) }
      catch { try { store.addEvent(running.taskId,'system','已请求停止，正在等待执行程序退出。');touched(running.taskId) } catch { /* cancellation remains active */ } }
    }
  }

  /** 一件成果 ⇒ 它装的变更快照;不是 review mime、读不出、解析不出都是 null(坏快照不抛,由调用方标 unavailable)。 */
  function readReviewSnapshot(artifact:{mime:string;storagePath:string;sha256:string}):GitReview|null {
    if(artifact.mime!==GIT_REVIEW_MIME)return null
    try{return parseGitReviewSnapshot(readArtifactSnapshot(artifact.storagePath,opts.stateDir,artifact.sha256))}catch{return null}
  }
  /** 标记的落点:成果必须属于该任务(否则 store.artifact 抛 not_found)且真是一份读得出的快照。 */
  function reviewTarget(id:string,artifactId:string) {
    const artifact=store.artifact(id,artifactId)
    const review=readReviewSnapshot(artifact)
    if(!review)throw new Error('invalid_review_reference')
    return {artifact,review}
  }
  function reviewComment(value:unknown,required:boolean):string {
    if(value===undefined&&!required)return ''
    if(typeof value!=='string'||value.length>2000)throw new Error('invalid_review_reference')
    const comment=value.trim()
    if(required&&!comment)throw new Error('invalid_review_reference')
    return comment
  }
  /** 门控:路径要在这份快照里,且不是「没展开」的那种 —— 没看过的文件不能说接受或打回。 */
  function markableFile(review:GitReview,path:string):ReviewFile {
    const file=review.files.find(candidate=>candidate.path===path)
    if(!file)throw new Error('invalid_review_reference')
    if(file.kind==='not_reviewed')throw new Error('review_file_unmarkable')
    return file
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
    /** 各执行者的额度/限流状态快照;没登记的不在里面。 */
    providerQuota():Record<string,QuotaState>{return quota.snapshot()},
    /** 这家现在还能用吗;null = 能。 */
    quotaExhausted(providerId:string):QuotaState|null{return quota.exhausted(providerId)},
    /** 额度耗尽时"交给谁继续"的默认人选;null = 没有可接的。 */
    fallbackExecutor(exhaustedId:string):string|null{return fallbackExecutor(exhaustedId)},
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
      const providers=opts.registry.list().filter(id=>isWorkbenchProviderId(id)&&isWorkbenchExecutorCapabilities(opts.registry.get(id)?.opts.workbench))
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
      bumped(id)
      // 回合早就静下来、只差这一个待决请求时,不会再有事件把落定叫起来 —— 拍完板自己补一次。
      settleAfterDecision(running)
    },
    withdrawInput(id:string,requestId:string){
      const input=store.liveInputs.get(requestId)
      if(!input||input.taskId!==id||input.status!=='pending')throw Error('input_stale')
      store.liveInputs.set(requestId,'withdrawn')
      bumped(id)
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
      requireInput(running.task.providerId,attachments,running.execution)
      // 一句补充就是一下互动:先把自动收工的计时取消掉,免得话在路上会话被关了。这一下要在
      // **入口**做,不能放进下面那个分支 —— `isReplied` 不看 `inputMode`,一条安静的运行若 runtime
      // 报 `input:'queue'`,补充会存下来等着,而计时还武装着:让位到点就把会话关了,主人收到的
      // 是「补充尚未发送」(评审 2026-09-21 修复轮 #1)。
      cancelIdleClose(running)
      if(running.session?.workbenchRuntime&&inputMode(running)!=='queue'){
        // 上一轮的快照还在截就等它截完,别把这一轮的改动算进上一轮。
        if(running.reviewCapture)await running.reviewCapture.catch(()=>{})
        // 续接 = 新一轮差异的起点:重新取基线。回合中间补一句话时上一轮还没截过快照
        // (基线还没被消费)—— 那一份要留着,起点提交不动,否则这条 run 的代码变更会丢。
        if(!running.reviewBaseline){try{running.reviewBaseline=await captureGitBaseline(running.path,{})}catch{/* 没基线就没有这一轮的代码对比,其他成果照收 */}}
        // 上面两处 await 可能等十几秒。这期间一轮自动续作可以正常收尾(新不变式下那是合法工作),
        // `settleQuiet` 就会重新武装让位计时;计时到点 `closeForIdle` 把会话收工、文件夹交给 B。
        // 所以醒过来必须把入口那道守卫再跑一遍,否则这句话会投给一条已经关掉的会话 —— 坏的那头是
        // 原生进程还没死,于是在一个正在移交的文件夹里开始写,两个写手同处一个目录。
        // (BASE 靠 `acquireTurnLease` 里的 `alive()` 挡这一下,那个函数这一轮删掉了。)
        if(runsByTask.get(id)!==running||running.cancelled||running.finishing||running.uncertain)throw Error('input_stale')
      }
      let saved:LiveInput
      try{
        saved=store.atomic(()=>{
          store.attachments.bind(attachments.map(a=>a.id),id,input.draftId)
          return store.liveInputs.add({id:requestId,taskId:id,runId:input.runId,text,attachments,execution:running.execution})
        })
      }catch(error){
        // 这一句没存下来就没有人会去写文件夹:会话还安静着,把自动收工的计时重新起上,
        // 别让一句存不下来的补充把文件夹永久锁住。
        armIdleClose(running)
        throw error
      }
      const runtime=running.session?.workbenchRuntime
      if(runtime){
        if(inputMode(running)==='queue')return saved
        store.liveInputs.set(saved.id,'sending');bumped(id)
        ;(running.runtimeInputs??=new Map()).set(saved.id,saved)
        try{
          if(canonicalProject(running.path)!==running.path||directoryIdentity(running.path)!==running.directoryIdentity)throw Error('invalid_path')
          const material=store.attachments.prepare(id,attachments,running.path,opts.stateDir)
          running.interactionAt=Date.now()
          // Replay acknowledgement may wait behind an autonomous native turn.
          // The HTTP receipt is already durable; never wait here or auto-resend.
          void runtime.submit(saved.id,text,material).then(
            ()=>settleRuntimeInput(running,saved),
            error=>{settleRuntimeInput(running,saved,error??new Error('input_not_delivered'));armIdleClose(running)},
          )
        }catch(error){settleRuntimeInput(running,saved,error??new Error('input_not_delivered'));armIdleClose(running)}
        return store.liveInputs.get(saved.id)!
      }
      if(!running.session?.steer)return saved
      running.delivering=true;store.liveInputs.set(saved.id,'sending');bumped(id)
      try{
        if(canonicalProject(running.path)!==running.path||directoryIdentity(running.path)!==running.directoryIdentity)throw Error('invalid_path')
        const material=store.attachments.prepare(id,attachments,running.path,opts.stateDir)
        await running.session.steer(text,material)
        running.interactionAt=Date.now()
        store.liveInputs.set(saved.id,'delivered');bumped(id)
        store.addEvent(id,'user',text,null,running.identity,attachments);touched(id)
      }catch(error){store.liveInputs.set(saved.id,'held',`未确认执行者收到，请检查当前对话后再决定是否重发。${error instanceof Error?' '+error.message:''}`);bumped(id)}
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
      requireInput(input.targetProviderId,combinedAttachments(materials,targetContinuation?.mode==='restart_required'?targetContinuation.restart.attachments:[]),target?store.execution.choice(target.id):PROVIDER_EXECUTION_CHOICE,!!target&&targetContinuation?.mode==='resume')
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
      const checkedHandoffAttachments=handoffAttachments(p.attachments??[],target?.id??source.id)
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
      requireInput(p.targetProviderId,combinedAttachments(checkedHandoffAttachments,accepted.mode==='restart'?accepted.preview.attachments:[]),p.targetExecution??PROVIDER_EXECUTION_CHOICE,accepted.mode==='resume')
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
        if(!target){store.update(record.targetTaskId,'failed',error instanceof Error?error.message:'task_failed');matterSync(m=>m.setStatus(record.targetTaskId,'done'))}
        store.addEvent(record.targetTaskId,'system','交接已记录，但本轮未启动。请查看任务状态，手动决定是否继续。')
        touched(record.targetTaskId)
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
      requireInput(task.providerId,[],execution,mode==='native_resume')
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
      requireInput(task.providerId,combinedAttachments(attachments,accepted.mode==='restart'?accepted.preview.attachments:[]),execution,accepted.mode==='resume')
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
      const providers=opts.registry.list().flatMap(id=>{const p=opts.registry.get(id);return isWorkbenchProviderId(id)&&p&&isWorkbenchExecutorCapabilities(p.opts.workbench)?[{id,displayName:p.opts.displayName,capabilities:structuredClone(p.opts.workbench),quota:quota.exhausted(id),usage:opts.usage?.(id)??null}]:[]})
      const result=store.listPage(query)
      const projectProviders=Object.fromEntries([...new Set(result.tasks.map(task=>task.path))].map(path=>[path,store.projectProvider(path)]))
      return {tasks:result.tasks.map(task => taskView(task,true)),page:result.page,projectProviders,providers,historyProviders:Object.keys(opts.nativeHistory??{}),defaultProvider:providers.find(p=>p.id===opts.defaultProvider)?.id ?? providers[0]?.id ?? null,canWechat:!!opts.ownerChatId(),unattendedAcknowledgedAt:opts.unattendedAck?.get()??null}
    },
    async modelCatalog(providerId:string,path:string):Promise<AgentModelCatalog>{
      const entry=provider(providerId),canonical=canonicalProject(path)
      if(!entry.opts.workbench.features.modelCatalog||!entry.provider.modelCatalog)throw Error('model_catalog_unavailable')
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
    // 不标 async:内部 wechatControl(见文件末尾)按同步 Actions 接口拿它,标了 async 会把
    // 返回类型变成 Promise 而破坏那个结构化类型;外部调用方(HTTP 长轮询、测试)照样能 await 一个普通值。
    detail(id:string,options:{since?:number}={}) {
      const detail=store.detail(id,options),running=runsByTask.get(id)
      const runtime=runtimeSnapshot(running)
      const subscription=store.wechatNotifications.subscription(id)
      const wechatNotifications={enabled:!!subscription?.enabled,notices:store.wechatNotifications.list(id).slice(-10).map(({id,runId,kind,status,reason,createdAt})=>({id,runId,kind,status,reason,createdAt}))}
      const result={...detail,wechatNotifications,...(runtime?{runtime}:{}),execution:store.execution.choice(id),lastExecution:store.execution.last(id),attachments:store.attachments.list(id),task:taskView(detail.task,true),inputs:store.liveInputs.list(id),questions:running?.questions.pending()??[],
        // The timeline stays live through cancellation and process cleanup;
        // accepting supplemental input is a separate, narrower capability.
        ...(running?{runId:running.identity}:{}),
        ...(running&&!running.cancelled&&!running.finishing&&!running.uncertain?{inputMode:inputMode(running)}:{}),
        permissions:running?.permissions.pending() ?? [],...(!running ? {continuation:continuation(store.get(id)),...(store.source(id)?.firstDispatchedAt===null?{requiresExternalClose:true}:{})} : {})}
      touched(id,detail.version)
      return result
    },
    create(input:CreateTask):WorkbenchTaskView {
      return createTask(input)
    },
    /** 免审执行者的一次性确认;不接 `unattendedAck`(老接线)时永远拒绝 —— 免审执行者只能停在
     *  「要求确认」,不能悄悄放行。 */
    acknowledgeUnattended():number {
      if(!opts.unattendedAck)throw new Error('unattended_ack_unavailable')
      const at=Date.now()
      opts.unattendedAck.set(at)
      return at
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
        if(inputRequestId&&store.liveInputs.get(inputRequestId))try{store.liveInputs.set(inputRequestId,'held','本轮未确认开始，补充内容已保留。');bumped(id)}catch{autoContinueBlocked.add(id)}
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
      const view=taskView(publicTask(store.setArchived(id,archived)))
      // store.setArchived 是裸 UPDATE,不像别的写点那样自带 bump —— archivedAt 在 detail 里能看见,补一下。
      bumped(id)
      matterSync(m=>m.setStatus(id,archived?'archived':view.status==='interrupted'?'open':TERMINAL_TASK_STATUSES.includes(view.status)?'done':view.phase==='replied'?'replied':'open'))
      return view
    },
    async cancel(id:string,expectedRunId?:string):Promise<WorkbenchTaskView> {
      const running=runsByTask.get(id)
      if(expectedRunId!==undefined&&running?.identity!==expectedRunId)throw new Error('control_stale')
      // cancelRun 落库时自己 touched;没有 running(任务不在跑)时这里兜底一下,
      // 停止请求本身也算一次「详情可能变了」。
      if (running) cancelRun(running)
      else bumped(id)
      return taskView(publicTask(store.get(id)))
    },
    artifact(id:string,artifactId:string) {
      const a=store.artifact(id,artifactId),bytes=readArtifactSnapshot(a.storagePath,opts.stateDir,a.sha256)
      return {name:a.name,mime:a.mime,size:bytes.length,sha256:a.sha256,contentBase64:bytes.toString('base64')}
    },
    approve(id:string,artifactId:string,sha256:string) { service.artifact(id,artifactId); store.approve(id,artifactId,sha256); touched(id) },
    /** 这个任务的所有变更快照,新→旧,每个文件附上当前标记。坏的那一轮单独 unavailable,不牵连别轮。 */
    reviewList(id:string):ReviewTurn[] {
      store.get(id)
      const marks=new Map<string,ReviewMark>()
      for(const mark of store.reviewMarks.list(id))marks.set(`${mark.artifactSha256}\0${mark.path}`,mark)
      return store.artifacts(id).filter(a=>a.mime===GIT_REVIEW_MIME).map(a=>{
        const head={artifactId:a.id,sha256:a.sha256,name:a.name,createdAt:a.createdAt}
        const review=readReviewSnapshot(a)
        if(!review)return {...head,status:'unavailable' as const,headBefore:null,headAfter:null,preexistingPaths:[],notes:['快照无法读取或已损坏'],files:[]}
        return {...head,status:review.status,headBefore:review.headBefore,headAfter:review.headAfter,preexistingPaths:review.preexistingPaths,notes:review.notes,
          files:review.files.map(file=>{
            const mark=marks.get(`${a.sha256}\0${file.path}`)
            return mark?{...file,mark:{mark:mark.mark,comment:mark.comment,createdAt:mark.createdAt}}:{...file}
          })}
      })
    },
    markReviewFile(id:string,input:{artifactId:string;path:string;mark:'accepted'|'returned';comment?:string}):ReviewMark {
      if(input.mark!=='accepted'&&input.mark!=='returned')throw new Error('invalid_request')
      const comment=reviewComment(input.comment,false)
      const {artifact,review}=reviewTarget(id,input.artifactId)
      const file=markableFile(review,input.path)
      const mark=store.reviewMarks.set({taskId:id,artifactSha256:artifact.sha256,path:file.path,afterSha256:file.afterSha256??null,mark:input.mark,comment})
      touched(id)
      return mark
    },
    /**
     * 打回 = 把「哪几处、为什么、当时长什么样」组成一段续接要求 + 逐文件标 `returned`。
     * 按会话状态分路(评审 2026-09-21 #7):**会话还留着且已答复** ⇒ 走 `submitInput` 投给同一条
     * 会话(和主人自己在输入框里补一句话同一条路),回的是一张投递回执;`continueTask` 对任何还在
     * `runsByTask` 的任务一律 `workbench_busy`,照旧走它的话保留会话(Claude)答复后永远送不到。
     * **还在写** ⇒ `workbench_busy`(回合中间不能打回)。**已经结算** ⇒ `continueTask` 照旧:
     * 那道门(忙 / 归档 / 免审未确认 / 要不要重开都由它判)错误码原样透传。
     * 标记**在续接成功之后**才落:`restart_confirmation_required` 是设计内的首次回应(桌面要靠它拿
     * 重开令牌),`workbench_busy` 是常见的抢跑 —— 先落标记会让主人常态化看到「已打回」却根本没发出去。
     * 原会话不能恢复时,主人确认后带上 `restartToken` 再发一次(校验交给 continueTask,和「继续」同一道门),
     * 打回就不再是死胡同。
     * 重发同一个 inputRequestId 时 continueTask 走幂等分支,再写一遍同样的标记无妨。
     */
    returnReviewFiles(id:string,input:{artifactId:string;paths:string[];comment:string;inputRequestId?:string;restartToken?:string}):WorkbenchTaskView|Promise<LiveInput> {
      if(!Array.isArray(input.paths)||!input.paths.length||input.paths.length>20||input.paths.some(path=>typeof path!=='string'||!path))throw new Error('invalid_review_reference')
      const comment=reviewComment(input.comment,true)
      // 请求 id 先验,免得为一个畸形请求留下标记。
      const given=input.inputRequestId===undefined?undefined:normalizeInputRequestId(input.inputRequestId)
      const {artifact,review}=reviewTarget(id,input.artifactId)
      // 重发同一笔打回要落到幂等分支,所以文本必须可重现:去重**排序** + 同一句意见 ⇒ 同一段文本。
      // 排序是为了跟派生 id 对齐 —— id 不看顺序,文本要是看,换个勾选顺序重发就会撞 `input_conflict`。
      const files=[...new Set(input.paths)].sort().map(path=>markableFile(review,path))
      const text=composeReturnText(files.map(({path,diff})=>({path,diff})),comment)
      const marks=()=>{
        for(const file of files)store.reviewMarks.set({taskId:id,artifactSha256:artifact.sha256,path:file.path,afterSha256:file.afterSha256??null,mark:'returned',comment})
        touched(id)
      }
      const running=runsByTask.get(id)
      if(running){
        // 回合中间打回 = 抢跑:这一轮还在写,等它答复(桌面/微信都会把这句话如实转给主人)。
        if(!isReplied(running))throw new Error('workbench_busy')
        // 请求 id 没给就从这笔打回本身派生:重发落 liveInputs 的幂等分支,不会投第二遍。
        // 把 run 的 identity 也算进去:会话重开之后这是另一次投递,不然会撞上一条 run 那笔 liveInput。
        const requestId=given??derivedReturnRequestId(artifact.sha256,files.map(file=>file.path),comment,running.identity)
        // 标记仍在拿到回执之后才落:投不出去就不该让主人看到「已打回」。
        return service.submitInput(id,{runId:running.identity,requestId,text}).then(receipt=>{marks();return receipt})
      }
      const task=service.continueTask(id,text,{inputRequestId:given??randomUUID(),...(input.restartToken!==undefined?{restartToken:input.restartToken}:{})})
      marks()
      return task
    },
    resolvePermission(id:string,requestId:string,decision:PermissionDecision):void {
      store.get(id)
      if (decision!=='allow' && decision!=='deny') throw new Error('invalid_decision')
      const running=runsByTask.get(id)
      if (!running || !running.permissions.resolve(requestId,decision)) throw new Error('permission_stale')
      bumped(id)
      // 同 resolveAnswer:静默期里拍的板,得由拍板这一下把落定补上。
      settleAfterDecision(running)
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
            try { running.permissions.rejectAll('cancelled'); bumped(running.taskId) } catch { /* fail closed */ }
            revokeCredentials(running); running.signalStop()
            try { if (running.session?.cancel) void running.session.cancel().catch(() => {}) } catch { /* close still follows */ }
          }
        }
        await Promise.allSettled(snapshot.map(running => running.done))
        while(collections.size)await Promise.allSettled([...collections])
        shutdownComplete=true
        for (const running of [...runsByTask.values()]) releaseReservation(running)
        changes.dispose()
      })()
      return shutdownPromise
    },
    changes: {
      /** store.version 才是权威:hub 缓存可能因为一笔回滚的事务而"幻影提前",落库的 seq 从不会。
       * 提前发现(persisted>since)时也顺手 publish 一下,把挂在旧值上的 waiter 一并叫醒,
       * 不用等它们各自超时。 */
      async wait(id: string, since: number, maxMs: number): Promise<number> {
        const persisted = store.version(id)
        if (persisted > since) { changes.publish(id, persisted); return persisted }
        changes.publish(id, persisted)
        return changes.wait(id, since, maxMs)
      },
    },
  }
  const wechatControl=makeWechatWorkbenchControl({store,ownerChatId:opts.ownerChatId,actions:service})
  return service
}
export type WorkbenchService=ReturnType<typeof makeWorkbenchService>
