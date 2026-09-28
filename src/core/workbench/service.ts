import {makeWechatWorkbenchControl,type WechatMessageIdentity,type WechatWorkbenchReply} from './wechat-control'
import { normalizeInputRequestId, sameAttachments } from './live-inputs'
import { randomUUID } from 'node:crypto'
import { executionFailureMessage, normalizeExecutionChoice, PROVIDER_EXECUTION_CHOICE } from './execution-settings'
import type { ProviderRegistry } from '../provider-registry'
import { canonicalProject } from './artifacts'
import { type NativeHistoryReader, type NativeHistoryProvider } from './native-history'
import { isWorkbenchExecutorCapabilities, isWorkbenchProviderId } from './executor-capabilities'
import type { MatterStore } from '../matters/store'
import type { ReportSink } from '../matters/report'
import type { RecollectSink } from '../matters/recollection'
import type { UsageSnapshot } from '../subscription-usage'
import { publicTask, type WorkbenchStore } from './store'
import { makeTaskChangeHub, type TaskChangeHub } from './task-changes'
import { canonicalEntryHash, composeEntryPrompt, parseEntryInput, type EntryContext, type EntryInput, type EntryOptions } from './task-entry'
import {createManagedWorkspaces,type ManagedWorkspaces} from './managed-workspaces'
import type {EntryRecord} from './entry-store'
import {readdirAnchored} from './anchored-fs'

interface Options {
  store: WorkbenchStore
  registry: ProviderRegistry
  stateDir: string
  managedWorkspaceRoot?: string
  ownerChatId: () => string | null
  /** 「一件事」登记处:任务与 matter 一对一同 id,生命周期同步(docs/cc-workbench.md「一件事」)。可选,老接线不传。 */
  matters?: MatterStore
  /** 每轮答复的回报投递(docs/cc-workbench.md「一件事」,task-3);可选,不传就整条功能不存在(降级路径)。 */
  reports?: ReportSink
  /** 「回忆」触发(spec 2026-09-23-delegation-report-design.md「回忆」,task-5);可选,不传就整条功能不存在(降级路径,同 opts.reports)。 */
  recollect?: RecollectSink
  /** 诊断日志(复用 permission-relay 那条通道);可选,不传就没有痕迹 —— 老接线的行为不变。 */
  log?: (tag: string, line: string) => void
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
   *  纯粹是别让一个闲着的原生进程占着资源。允许 0(=立刻关)与很大的数(封顶约 24.8 天,即
   *  setTimeout 的合法上限 2³¹−1ms;超界不会当「永不武装」,而是被钳到这个上限);
   *  负数/非数视作缺省。函数形式让主人改了 agent-config.json 立刻生效。 */
  retainedIdleCloseMs?: number | (() => number)
  /** 安静下来而**有人在等这个文件夹**时的短让位时长(ms;缺省 15 秒)。同上。 */
  handoffGraceMs?: number | (() => number)
  /** 变更信号中心(长轮询);不传就自建。 */
  changes?: TaskChangeHub
  /** 免审执行者的一次性确认(daemon 侧持久化);不传 ⇒ 免审执行者永远要求确认。 */
  unattendedAck?: { get(): number | null; set(at: number): void }
}
import { makeRuntimeState } from './service/state'
import { Ref } from '../../lib/lifecycle'
import { makeReviewDomain } from './service/review'
import { makeAttachmentsDomain } from './service/attachments'
import { makeQuotaDomain } from './service/quota'
import { makeNoticesDomain } from './service/notices'
import { directoryIdentity } from './service/directory-identity'
import { makeArtifactsDomain } from './service/artifacts'
import { makeAdmissionDomain } from './service/admission'
import { makeViewDomain } from './service/view'
import { makeNativeDomain } from './service/native'
import { makeInputsDomain } from './service/inputs'
import { makeLifecycleDomain } from './service/lifecycle'
import { makeExecuteDomain } from './service/execute'
import type { ServiceActions, ServiceCtx } from './service/ctx'
export type { CreateWechatTask, SendWechatArtifact, TaskWaitingFor } from './wechat-types'
export type { InputMaterials, CreateTask, WorkbenchPhase, WorkbenchTaskView, EntryResult } from './service/types'
import type { EntryResult } from './service/types'


export function makeWorkbenchService(opts: Options) {
  const { store } = opts
  const changes = opts.changes ?? makeTaskChangeHub()
  /** store 的写方法把 seq 落库,但不知道 hub —— 这里把持久化 seq 送进去唤醒长轮询。 */
  const touched = (id: string, seq?: number) => { try { changes.publish(id, seq ?? store.version(id)) } catch { /* 信号丢了只是多等一轮 */ } }
  /** 非 store 状态变化:先落库拿新 seq 再唤醒。bump 本身可能抛(任务不存在),别让它冒进调用方的 finally/catch。 */
  const bumped = (id: string) => { try { touched(id, store.bump(id)) } catch { /* 信号丢了只是多等一轮 */ } }
  let managedWorkspaces:ManagedWorkspaces|undefined
  const managed=()=>{
    if(!opts.managedWorkspaceRoot)throw Error('entry_not_wired')
    return managedWorkspaces??=createManagedWorkspaces({root:opts.managedWorkspaceRoot,stateDir:opts.stateDir})
  }
  const requireEntryOwner=(context:EntryContext)=>{
    if(!context.ownerKey||context.ownerKey!==opts.ownerChatId()||!['desktop','phone'].includes(context.surface))throw Error('invalid_entry_owner')
  }
  const entryResult=(record:EntryRecord):EntryResult=>{
    if(record.phase!=='accepted')throw Error('entry_not_accepted')
    const task=store.get(record.taskId)
    if(task.ownerChatId!==record.ownerKey)throw Error('invalid_entry_owner')
    return{receipt:{requestId:record.requestId,taskId:record.taskId,matterId:record.matterId,runId:record.runId,acceptedAt:record.acceptedAt},task:taskView(publicTask(task))}
  }
  const state=makeRuntimeState()
  const {runsByTask,reservations,queue,runningText,collections}=state
  const actions=new Ref<ServiceActions>('workbench-actions')
  const ctx:ServiceCtx={store,stateDir:opts.stateDir,state,hub:{touched,bumped,dispose:()=>changes.dispose()},deps:{ownerChatId:opts.ownerChatId,registry:opts.registry,...(opts.usage?{usage:opts.usage}:{}),...(opts.permissionTimeoutMs!==undefined?{permissionTimeoutMs:opts.permissionTimeoutMs}:{}),...(opts.unattendedAck?{unattendedAck:opts.unattendedAck}:{}),...(opts.nativeHistory?{nativeHistory:opts.nativeHistory}:{}),...(opts.registeredProjects?{registeredProjects:opts.registeredProjects}:{}),...(opts.defaultProvider!==undefined?{defaultProvider:opts.defaultProvider}:{}),...(opts.executionConflict?{executionConflict:opts.executionConflict}:{}),...(opts.reports?{reports:opts.reports}:{}),...(opts.recollect?{recollect:opts.recollect}:{}),...(opts.revokeSessionToken?{revokeSessionToken:opts.revokeSessionToken}:{}),...(opts.retainedIdleCloseMs!==undefined?{retainedIdleCloseMs:opts.retainedIdleCloseMs}:{}),...(opts.handoffGraceMs!==undefined?{handoffGraceMs:opts.handoffGraceMs}:{}),...(opts.matters?{matters:opts.matters}:{}),...(opts.mintSessionToken?{mintSessionToken:opts.mintSessionToken}:{}),...(opts.timeoutMs!==undefined?{timeoutMs:opts.timeoutMs}:{}),...(opts.closeTimeoutMs!==undefined?{closeTimeoutMs:opts.closeTimeoutMs}:{}),...(opts.holdBusy?{holdBusy:opts.holdBusy}:{}),...(opts.managedWorkspaceRoot!==undefined?{managedWorkspaceRoot:opts.managedWorkspaceRoot}:{})},ensureAccepting,...(opts.log?{log:opts.log}:{}),now:Date.now,actions}
  const review=makeReviewDomain(ctx)
  const attachmentsDomain=makeAttachmentsDomain(ctx)
  const {continuationAttachmentScope,selectAttachments,combinedAttachments,handoffAttachments}=attachmentsDomain
  const quotaDomain=makeQuotaDomain(ctx)
  const {quota,fallbackExecutor}=quotaDomain
  const admissionDomain=makeAdmissionDomain(ctx)
  const {provider,requireInput,requireEntryInput,canResume,continuation,taskVersion}=admissionDomain
  const viewDomain=makeViewDomain(ctx)
  const {held,runtimeSnapshot,inputMode,isReplied,taskView}=viewDomain
  const nativeDomain=makeNativeDomain(ctx)
  const inputsDomain=makeInputsDomain(ctx)
  const {holdInputs,hasUndeliveredInput}=inputsDomain
  const lifecycleDomain=makeLifecycleDomain(ctx)
  const {cancelIdleClose,settleAfterDecision}=lifecycleDomain
  const noticesDomain=makeNoticesDomain(ctx)
  const {stageFinishedNotice,publishFinishedNotices}=noticesDomain
  const artifactsDomain=makeArtifactsDomain(ctx)
  const {collect,collectTurnArtifacts,captureCodeChanges}=artifactsDomain
  const executeDomain=makeExecuteDomain(ctx,{admission:admissionDomain,attachments:attachmentsDomain,quota:quotaDomain,view:viewDomain,native:nativeDomain,inputs:inputsDomain,lifecycle:lifecycleDomain,notices:noticesDomain,artifacts:artifactsDomain})
  const {createTask}=executeDomain
  store.recover()
  store.liveInputs.recover()

  function ensureAccepting() {
    if (state.stopping) throw new Error('workbench_stopping')
  }


  const service={
    artifactDeliveryStore:store.artifactDeliveries,
    setArtifactDelivery:noticesDomain.setArtifactDelivery,
    artifactDeliveryEligible:noticesDomain.artifactDeliveryEligible,
    deliverWechatArtifact:noticesDomain.deliverWechatArtifact,
    notificationStore:store.wechatNotifications,
    setNotificationWake:noticesDomain.setNotificationWake,
    providerQuota:quotaDomain.providerQuota,
    quotaExhausted:quotaDomain.quotaExhausted,
    /** 额度耗尽时"交给谁继续"的默认人选;null = 没有可接的。 */
    fallbackExecutor(exhaustedId:string):string|null{return fallbackExecutor(exhaustedId)},
    contextAvailable:noticesDomain.contextAvailable,
    notificationEligible:noticesDomain.notificationEligible,
    setWechatWatch:noticesDomain.setWechatWatch,
    entryOptions(context:EntryContext):EntryOptions {
      if(!context.ownerKey||context.ownerKey!==opts.ownerChatId())return{status:'needs_connection',reason:{code:'invalid_entry_owner',message:'请先在电脑上配置主人身份。'},defaultProviderId:null,providers:[],projects:[]}
      const providers=opts.registry.list().flatMap(id=>{
        const p=opts.registry.get(id)
        if(!isWorkbenchProviderId(id)||!p||!isWorkbenchExecutorCapabilities(p.opts.workbench))return[]
        let reason:string|undefined
        try{requireInput(id,[],PROVIDER_EXECUTION_CHOICE);if(quota.exhausted(id))reason='provider_quota_exhausted'}catch(error){reason=error instanceof Error?error.message:'unavailable_provider'}
        return[{id,displayName:p.opts.displayName,available:!reason,...(reason?{unavailableReason:{code:reason,message:reason==='unattended_ack_required'?'请先在电脑上确认免审执行。':executionFailureMessage(reason)}}:{}),capabilities:structuredClone(p.opts.workbench)}]
      })
      const defaultProviderId=providers.find(p=>p.id===opts.defaultProvider&&p.available)?.id??null
      return{status:defaultProviderId?'ready':'needs_connection',...(!defaultProviderId?{reason:{code:'unavailable_provider',message:'请在电脑上连接默认执行者，或在更多选项中选择已连接的执行者。'}}:{}),defaultProviderId,providers,projects:service.projects()}
    },
    entryReceipt(requestId:string,context:EntryContext):EntryResult|null {
      requireEntryOwner(context)
      const record=store.entryRequests.get(context.ownerKey,normalizeInputRequestId(requestId))
      return record?.phase==='accepted'?entryResult(record):null
    },
    createEntry(value:EntryInput,context:EntryContext):EntryResult {
      requireEntryOwner(context)
      const input=parseEntryInput(value),hash=canonicalEntryHash(input)
      let record=store.entryRequests.get(context.ownerKey,input.requestId)
      if(record&&record.canonicalRequestHash!==hash)throw Error('creation_conflict')
      if(record?.phase==='accepted')return entryResult(record)
      ensureAccepting()
      if(!opts.matters)throw Error('entry_not_wired')
      const text=composeEntryPrompt(input)
      try{
        if(record&&record.createdAt<Date.now()-7*86400_000)throw Error('entry_expired')
        const prepared=store.attachments.prepareAcceptance(input.attachmentIds??[],undefined,input.draftId,opts.stateDir,context)
       if(!record){
        const materialSnapshot=prepared.attachments
        const target=input.target,project=target.kind==='project'?service.projects().find(p=>p.id===target.projectId):null
        if(input.target.kind==='project'&&!project)throw Error('project_stale')
        const providerId=input.providerId??project?.providerId??opts.defaultProvider
        if(!providerId)throw Error('unavailable_provider')
        const execution=normalizeExecutionChoice(input.execution,PROVIDER_EXECUTION_CHOICE)
        requireEntryInput(providerId,materialSnapshot,execution,text)
        const workspaceId=input.target.kind==='managed'?randomUUID():null
        record=store.entryRequests.reserve({ownerKey:context.ownerKey,requestId:input.requestId,canonicalRequestHash:hash,target:input.target,
          workspaceId,resolvedPath:workspaceId?managed().resolvePath(workspaceId):project?.path??null,directoryIdentity:project?directoryIdentity(project.path):null,
          providerId,execution,materialSnapshot})
       }
        // Another connection may have accepted between the initial read and reserve.
        if(record.phase==='accepted')return entryResult(record)
        if(record.createdAt<Date.now()-7*86400_000)throw Error('entry_expired')
        requireEntryInput(record.providerId,record.materialSnapshot,record.execution,text)
        const current=prepared.attachments
        if(!sameAttachments(current,record.materialSnapshot))throw Error('attachment_changed')
        const workspace=record.target.kind==='managed'?managed().ensure(record):null
        const path=workspace?.path??record.resolvedPath!,identity=workspace?.directoryIdentity??record.directoryIdentity!
        if(!path||!identity||canonicalProject(path)!==path||directoryIdentity(path)!==identity)throw Error('invalid_path')
        record=store.entryRequests.allocate(context.ownerKey,input.requestId,path,identity)
        if(record.phase==='accepted')return entryResult(record)
        const frozen=record
        const verify=()=>{
          requireEntryOwner(context)
          if(workspace){
            managed().verify(workspace)
            if(readdirAnchored(workspace.path,[],'managed_workspace_unavailable').length)throw Error('managed_workspace_changed')
            managed().verify(workspace)
          }
          else if(canonicalProject(path)!==path||directoryIdentity(path)!==identity)throw Error('invalid_path')
        }
        createTask({path,providerId:frozen.providerId,text,title:input.title??(input.text.trim().slice(0,40)||current[0]!.name.slice(0,40)),execution:frozen.execution,draftId:input.draftId,attachmentIds:input.attachmentIds},(task,runId)=>{
          verify()
          store.entryRequests.accept(context.ownerKey,input.requestId,{taskId:task.id,matterId:task.id,runId,acceptedAt:Date.now(),resolvedPath:path,directoryIdentity:identity})
        },undefined,{
          context,workspaceKind:frozen.target.kind==='managed'?'managed':'project',fromChat:!!input.context,materials:current,
          beforeCreate:()=>{
            const latest=store.entryRequests.get(context.ownerKey,input.requestId)
            if(latest?.phase==='accepted')throw Error('entry_already_accepted')
            verify()
            requireEntryInput(frozen.providerId,frozen.materialSnapshot,frozen.execution,text)
            prepared.assertCurrent()
          },
          verifyDirectory:(acceptedPath,acceptedIdentity)=>{if(acceptedPath!==path||acceptedIdentity!==identity)throw Error('invalid_path');verify()},
        })
        return entryResult(store.entryRequests.get(context.ownerKey,input.requestId)!)
      }catch(error){
        // A racing winner is authoritative, but never commit a losing task along with it.
        const winner=store.entryRequests.get(context.ownerKey,input.requestId)
        if(winner?.phase==='accepted'&&winner.canonicalRequestHash===hash)return entryResult(winner)
        throw error
      }
    },
    projects:viewDomain.projects,
    createWechat:executeDomain.createWechat,
    attention:viewDomain.attention,
    resolveAnswer:inputsDomain.resolveAnswer,
    withdrawInput:inputsDomain.withdrawInput,
    submitInput:inputsDomain.submitInput,
    previewHandoff:nativeDomain.previewHandoff,
    handoff:nativeDomain.handoff,
    handoffRecord:nativeDomain.handoffRecord,
    conflictsExternal:nativeDomain.conflictsExternal,
    importNativeHistory:nativeDomain.importNativeHistory,
    prepareNativeResume:nativeDomain.prepareNativeResume,
    continueNativeTask:nativeDomain.continueNativeTask,
    listNativeHistory:nativeDomain.listNativeHistory,
    readNativeHistory:nativeDomain.readNativeHistory,
    addProject:viewDomain.addProject,
    list:viewDomain.list,
    modelCatalog:admissionDomain.modelCatalog,
    prepareContinuation:admissionDomain.prepareContinuation,
    detail:viewDomain.detail,
    create:executeDomain.create,
    acknowledgeUnattended:admissionDomain.acknowledgeUnattended,
    continueTask:executeDomain.continueTask,
    uploadAttachment:attachmentsDomain.uploadAttachment,
    uploadAttachmentChunk:attachmentsDomain.uploadAttachmentChunk,
    attachmentUploadStatus:attachmentsDomain.attachmentUploadStatus,
    discardAttachmentUpload:attachmentsDomain.discardAttachmentUpload,
    readAttachment:attachmentsDomain.readAttachment,
    discardAttachment:attachmentsDomain.discardAttachment,
    setArchived:lifecycleDomain.setArchived,
    cancel:lifecycleDomain.cancel,
    artifact:artifactsDomain.artifact,
    approve:artifactsDomain.approve,
    /** 这个任务的所有变更快照,新→旧,每个文件附上当前标记。坏的那一轮单独 unavailable,不牵连别轮。 */
    reviewList:review.reviewList,
    markReviewFile:review.markReviewFile,
    returnReviewFiles:review.returnReviewFiles,
    resolvePermission:inputsDomain.resolvePermission,
    async handleWechat(chatId:string,text:string,identity?:WechatMessageIdentity):Promise<WechatWorkbenchReply|null>{return wechatControl(chatId,text,identity)},
    shutdown:lifecycleDomain.shutdown,
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
  actions.set({submitInput:(id,input,policy)=>service.submitInput(id,input,policy),continueTask:(id,text,options,policy)=>service.continueTask(id,text,options,policy),isReplied,fallbackExecutor,artifact:(id,artifactId)=>service.artifact(id,artifactId),quotaExhausted:quotaDomain.quotaExhausted,continuation,provider,requireInput,canResume,taskVersion,selectAttachments,combinedAttachments,handoffAttachments,taskView,matterSync:executeDomain.matterSync,start:executeDomain.start,continuationAttachmentScope,inputMode,armIdleClose:lifecycleDomain.armIdleClose,cancelIdleClose,settleAfterDecision,execute:executeDomain.execute,hasUndeliveredInput,holdInputs,collect,collectTurnArtifacts,captureCodeChanges,runtimeSnapshot,held,stageFinishedNotice,publishFinishedNotices})
  const wechatControl=makeWechatWorkbenchControl({store,ownerChatId:opts.ownerChatId,actions:service})
  return service
}
export type WorkbenchService=ReturnType<typeof makeWorkbenchService>
