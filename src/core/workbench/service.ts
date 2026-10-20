import {makeWechatWorkbenchControl,type WechatMessageIdentity,type WechatWorkbenchReply} from './wechat-control'
import type { ProviderRegistry } from '../provider-registry'
import { type NativeHistoryReader, type NativeHistoryProvider } from './native-history'
import type { MatterStore } from '../matters/store'
import type { ReportSink } from '../matters/report'
import type { RecollectSink } from '../matters/recollection'
import type { UsageSnapshot } from '../subscription-usage'
import { type WorkbenchStore } from './store'
import { makeTaskChangeHub, type TaskChangeHub } from './task-changes'

interface Options {
  store: WorkbenchStore
  registry: ProviderRegistry
  stateDir: string
  managedWorkspaceRoot?: string; networkGate?: import('../../lib/network-gate').NetworkGate; projectLessons?: ServiceCtx['deps']['projectLessons']; fetchIssue?: Parameters<typeof makeWechatWorkbenchControl>[0]['fetchIssue']  // 网络闸门(2026-10-02)/ 项目经验 / issue 开工(2026-10-20),见 ServiceDeps
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
  holdBusy?: (label: string) => () => void; onTurnError?: ServiceCtx['deps']['onTurnError']; writerGroupAlive?: ServiceCtx['deps']['writerGroupAlive']; bootTimeMs?: ServiceCtx['deps']['bootTimeMs']; writerWatchMs?: number   // onTurnError:错误通道 → CLI 自动升级的报错触发(见 ctx.ts)
  timeoutMs?: number
  closeTimeoutMs?: number
  permissionTimeoutMs?: number; permissionDecide?: ServiceCtx['deps']['permissionDecide']   // 放行规则(2026-10-19);不传 ⇒ 每条权限都问主人
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
  unattendedAck?: { get(): number | null; set(at: number): void }; scripts?: ScriptsOptions; until?: UntilOptions; rewind?: RewindOptions; quotaResume?: QuotaResumeOptions   // scripts / until / rewind:工作区脚本、检查命令(2026-10-20)与回退(2026-10-21)的测试旋钮,生产不传;quotaResume.notify:到点没接上时告诉主人一句
}
import { makeRuntimeState } from './service/state'
import { Ref } from '../../lib/lifecycle'
import { makeReviewDomain } from './service/review'; import { makeWorktreeDomain } from './service/worktree'; import { makeScriptsDomain, type ScriptsOptions } from './service/scripts'; import { makeUntilDomain, type UntilOptions } from './service/until'; import { makeRewindDomain, type RewindOptions } from './service/rewind'; import { makeQuotaResumeDomain, type QuotaResumeOptions } from './service/quota-resume'
import { makeAttachmentsDomain } from './service/attachments'
import { makeQuotaDomain } from './service/quota'
import { makeNoticesDomain } from './service/notices'
import { makeArtifactsDomain } from './service/artifacts'
import { makeAdmissionDomain } from './service/admission'
import { makeViewDomain } from './service/view'
import { makeNativeDomain } from './service/native'
import { makeInputsDomain } from './service/inputs'
import { makeLifecycleDomain } from './service/lifecycle'
import { makeExecuteDomain } from './service/execute'
import { makeEntryDomain } from './service/entry'
import { makeQuotaHandoffDomain } from './service/quota-handoff'
import type { ServiceActions, ServiceCtx } from './service/ctx'
export type { CreateWechatTask, SendWechatArtifact, TaskWaitingFor } from './wechat-types'
export type { InputMaterials, CreateTask, WorkbenchPhase, WorkbenchTaskView, EntryResult } from './service/types'

export function makeWorkbenchService(opts: Options) {
  const { store } = opts
  const changes = opts.changes ?? makeTaskChangeHub()
  /** store 的写方法把 seq 落库,但不知道 hub —— 这里把持久化 seq 送进去唤醒长轮询。 */
  const touched = (id: string, seq?: number) => { try { changes.publish(id, seq ?? store.version(id)) } catch { /* 信号丢了只是多等一轮 */ } }
  /** 非 store 状态变化:先落库拿新 seq 再唤醒。bump 本身可能抛(任务不存在),别让它冒进调用方的 finally/catch。 */
  const bumped = (id: string) => { try { touched(id, store.bump(id)) } catch { /* 信号丢了只是多等一轮 */ } }
  const state=makeRuntimeState()
  const actions=new Ref<ServiceActions>('workbench-actions')
  const ctx:ServiceCtx={store,stateDir:opts.stateDir,state,hub:{touched,bumped,dispose:()=>changes.dispose()},deps:{ownerChatId:opts.ownerChatId,registry:opts.registry,...(opts.usage?{usage:opts.usage}:{}),...(opts.permissionTimeoutMs!==undefined?{permissionTimeoutMs:opts.permissionTimeoutMs}:{}),...(opts.permissionDecide?{permissionDecide:opts.permissionDecide}:{}),...(opts.unattendedAck?{unattendedAck:opts.unattendedAck}:{}),...(opts.nativeHistory?{nativeHistory:opts.nativeHistory}:{}),...(opts.registeredProjects?{registeredProjects:opts.registeredProjects}:{}),...(opts.defaultProvider!==undefined?{defaultProvider:opts.defaultProvider}:{}),...(opts.executionConflict?{executionConflict:opts.executionConflict}:{}),...(opts.reports?{reports:opts.reports}:{}),...(opts.recollect?{recollect:opts.recollect}:{}),...(opts.revokeSessionToken?{revokeSessionToken:opts.revokeSessionToken}:{}),...(opts.retainedIdleCloseMs!==undefined?{retainedIdleCloseMs:opts.retainedIdleCloseMs}:{}),...(opts.handoffGraceMs!==undefined?{handoffGraceMs:opts.handoffGraceMs}:{}),...(opts.matters?{matters:opts.matters}:{}),...(opts.mintSessionToken?{mintSessionToken:opts.mintSessionToken}:{}),...(opts.timeoutMs!==undefined?{timeoutMs:opts.timeoutMs}:{}),...(opts.closeTimeoutMs!==undefined?{closeTimeoutMs:opts.closeTimeoutMs}:{}),...(opts.holdBusy?{holdBusy:opts.holdBusy}:{}),...(opts.onTurnError?{onTurnError:opts.onTurnError}:{}),...(opts.writerGroupAlive?{writerGroupAlive:opts.writerGroupAlive}:{}),...(opts.bootTimeMs?{bootTimeMs:opts.bootTimeMs}:{}),...(opts.writerWatchMs!==undefined?{writerWatchMs:opts.writerWatchMs}:{}),...(opts.managedWorkspaceRoot!==undefined?{managedWorkspaceRoot:opts.managedWorkspaceRoot}:{}),...(opts.networkGate?{networkGate:opts.networkGate}:{}),...(opts.projectLessons?{projectLessons:opts.projectLessons}:{})},ensureAccepting,...(opts.log?{log:opts.log}:{}),now:Date.now,actions}
  const scriptsDomain=makeScriptsDomain(ctx,opts.scripts),untilDomain=makeUntilDomain(ctx,opts.until),quotaResumeDomain=makeQuotaResumeDomain(ctx,opts.quotaResume),review=makeReviewDomain(ctx,{scripts:scriptsDomain,until:untilDomain}),worktreeDomain=makeWorktreeDomain(ctx,{scripts:scriptsDomain})
  const attachmentsDomain=makeAttachmentsDomain(ctx)
  const {continuationAttachmentScope,selectAttachments,combinedAttachments,handoffAttachments}=attachmentsDomain
  const quotaDomain=makeQuotaDomain(ctx)
  const {fallbackExecutor}=quotaDomain
  const admissionDomain=makeAdmissionDomain(ctx)
  const {provider,requireInput,canResume,continuation,taskVersion}=admissionDomain
  const viewDomain=makeViewDomain(ctx,{quotaHandoff:id=>quotaHandoffDomain.quotaHandoff(id),scripts:scriptsDomain.status})
  const {held,runtimeSnapshot,inputMode,isReplied,taskView}=viewDomain
  const nativeDomain=makeNativeDomain(ctx)
  const inputsDomain=makeInputsDomain(ctx)
  const {holdInputs,hasUndeliveredInput}=inputsDomain
  const lifecycleDomain=makeLifecycleDomain(ctx)
  const {cancelIdleClose,settleAfterDecision}=lifecycleDomain
  const noticesDomain=makeNoticesDomain(ctx),rewindDomain=makeRewindDomain(ctx,{lifecycle:lifecycleDomain,scripts:scriptsDomain,until:untilDomain},opts.rewind)
  const {stageFinishedNotice,publishFinishedNotices,enqueueNotice}=noticesDomain
  const artifactsDomain=makeArtifactsDomain(ctx)
  const {collect,collectTurnArtifacts,captureCodeChanges}=artifactsDomain
  const executeDomain=makeExecuteDomain(ctx,{admission:admissionDomain,attachments:attachmentsDomain,quota:quotaDomain,view:viewDomain,native:nativeDomain,inputs:inputsDomain,lifecycle:lifecycleDomain,notices:noticesDomain,artifacts:artifactsDomain,scripts:scriptsDomain,rewind:rewindDomain})
  const entryDomain=makeEntryDomain(ctx,{execute:executeDomain,view:viewDomain,admission:admissionDomain,quota:quotaDomain,scripts:scriptsDomain}),quotaHandoffDomain=makeQuotaHandoffDomain(ctx,{execute:executeDomain,quota:quotaDomain})
  store.recover()
  store.liveInputs.recover();lifecycleDomain.adoptWriters();scriptsDomain.recover();void rewindDomain.recover();quotaResumeDomain.recover()

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
    /** 额度耗尽时"交给谁继续"的默认人选;null = 没有可接的。quotaHandoff / handOff:手机确认卡把一件事交出去(service/quota-handoff.ts)。 */
    fallbackExecutor(exhaustedId:string):string|null{return fallbackExecutor(exhaustedId)},...quotaHandoffDomain.api,...quotaResumeDomain.api,   // api:额度恢复后接着做(service/quota-resume.ts)
    contextAvailable:noticesDomain.contextAvailable,
    notificationEligible:noticesDomain.notificationEligible,
    setWechatWatch:noticesDomain.setWechatWatch,
    entryOptions:entryDomain.entryOptions,entryModels:entryDomain.entryModels,
    entryReceipt:entryDomain.entryReceipt,
    createEntry:entryDomain.createEntry,
    projects:viewDomain.projects,
    createWechat:executeDomain.createWechat,
    attention:viewDomain.attention,
    resolveAnswer:inputsDomain.resolveAnswer,
    withdrawInput:inputsDomain.withdrawInput,
    submitInput:inputsDomain.submitInput,inputReceipt:inputsDomain.inputReceipt,
    ...nativeDomain.api,
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
    discardAttachmentUpload:attachmentsDomain.discardAttachmentUpload,takeChatImages:attachmentsDomain.takeChatImages,
    readAttachment:attachmentsDomain.readAttachment,
    discardAttachment:attachmentsDomain.discardAttachment,
    setArchived:(id:string,archived:boolean)=>{const view=lifecycleDomain.setArchived(id,archived);if(archived)worktreeDomain.tidyOnArchive(id);return view},confirmWriterExited:lifecycleDomain.confirmWriterExited,
    cancel:lifecycleDomain.cancel,suspendForNetwork:lifecycleDomain.suspendForNetwork,resumeFromNetwork:lifecycleDomain.resumeFromNetwork,stopSuspendedForNetwork:lifecycleDomain.stopSuspendedForNetwork,networkSuspended:lifecycleDomain.networkSuspended,
    artifact:artifactsDomain.artifact,
    approve:artifactsDomain.approve,
    /** 这个任务的所有变更快照,新→旧,每个文件附上当前标记。坏的那一轮单独 unavailable,不牵连别轮。 */
    reviewList:review.reviewList,
    markReviewFile:review.markReviewFile,
    returnReviewFiles:review.returnReviewFiles,revertReviewFile:review.revertReviewFile,reviewComment:review.reviewComment,sendReviewComments:review.sendReviewComments,revertReviewHunk:review.revertReviewHunk,worktreeAction:worktreeDomain.worktreeAction,rewindPreview:rewindDomain.rewindPreview,rewind:rewindDomain.rewind,undoRewind:rewindDomain.undoRewind,rewindResolve:rewindDomain.rewindResolve,pruneRewindRefs:rewindDomain.pruneRefs,scriptAction:scriptsDomain.scriptAction,approveScripts:scriptsDomain.approveScripts,   // 工作区脚本(2026-10-20):运行 / 停下 / 批准
    resolvePermission:inputsDomain.resolvePermission,
    async handleWechat(chatId:string,text:string,identity?:WechatMessageIdentity):Promise<WechatWorkbenchReply|null>{return wechatControl(chatId,text,identity)},
    shutdown:()=>Promise.all([rewindDomain.shutdown(),scriptsDomain.shutdown(),untilDomain.shutdown(),Promise.resolve(quotaResumeDomain.shutdown()),lifecycleDomain.shutdown()]).then(()=>{}),   // 工作区脚本和会话一起停(TERM → 宽限 → KILL)
    changes: { onChange: (cb: (taskId: string, seq: number) => void) => changes.onChange(cb),
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
  actions.set({submitInput:(id,input,policy)=>service.submitInput(id,input,policy),continueTask:(id,text,options,policy)=>service.continueTask(id,text,options,policy),isReplied,fallbackExecutor,artifact:(id,artifactId)=>service.artifact(id,artifactId),quotaExhausted:quotaDomain.quotaExhausted,continuation,provider,requireInput,canResume,taskVersion,selectAttachments,combinedAttachments,handoffAttachments,taskView,matterSync:executeDomain.matterSync,start:executeDomain.start,continuationAttachmentScope,inputMode,armIdleClose:lifecycleDomain.armIdleClose,cancelIdleClose,settleAfterDecision,execute:executeDomain.execute,hasUndeliveredInput,holdInputs,collect,collectTurnArtifacts,captureCodeChanges,runtimeSnapshot,held,stageFinishedNotice,publishFinishedNotices,enqueueNotice,untilAfterTurn:untilDomain.afterTurn,untilStop:untilDomain.stop})
  const wechatControl=makeWechatWorkbenchControl({store,ownerChatId:opts.ownerChatId,actions:service,hasExecutor:(id)=>{try{provider(id);return true}catch{return false}},...(opts.fetchIssue?{fetchIssue:opts.fetchIssue}:{})})
  return service
}
export type WorkbenchService=ReturnType<typeof makeWorkbenchService>
