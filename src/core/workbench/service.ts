import {makeWechatWorkbenchControl,type WechatMessageIdentity,type WechatWorkbenchReply} from './wechat-control'
import type { ProviderRegistry } from '../../app/provider-registry'
import { type NativeHistoryReader, type NativeHistoryProvider } from './native-history'
import type { MatterStore } from '../../adapters/store/matters-store'
import type { ReportSink } from '../matters/report'
import type { RecollectSink } from '../matters/recollection'
import type { UsageSnapshot } from '../../domain/subscription-usage'
import { type WorkbenchStore } from './store'
import { makeTaskChangeHub, type TaskChangeHub } from './task-changes'

interface Options {
  store: WorkbenchStore
  registry: ProviderRegistry
  stateDir: string
  // 网络闸门(2026-10-02)/ 项目经验 / issue 开工(2026-10-20),见 ServiceDeps
  managedWorkspaceRoot?: string
  networkGate?: import('../../lib/network-gate').NetworkGate
  projectLessons?: ServiceCtx['deps']['projectLessons']
  addLesson?: ServiceCtx['deps']['addLesson']
  checkpointDeadlineMs?: number
  reviewDeadlineMs?: number
  fetchIssue?: Parameters<typeof makeWechatWorkbenchControl>[0]['fetchIssue']
  requestReview?: Parameters<typeof makeWechatWorkbenchControl>[0]['requestReview']
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
  /** 这家执行者现在被拒着(出口地区用不了);执行者列表照实带出去。 */
  refusal?: (providerId: string) => { code: string; since: string } | null
  defaultProvider?: string
  registeredProjects?:()=>Array<{alias:string;path:string}>
  executionConflict?:(path:string,providerId:string,nativeId:string|null)=>boolean
  nativeHistory?:Partial<Record<NativeHistoryProvider,NativeHistoryReader>>
  mintSessionToken?: (sessionKey: string) => string
  revokeSessionToken?: (sessionKey: string) => void
  // onTurnError:错误通道 → CLI 自动升级的报错触发(见 ctx.ts)
  holdBusy?: (label: string) => () => void
  onTurnError?: ServiceCtx['deps']['onTurnError']
  onTurnCompleted?: ServiceCtx['deps']['onTurnCompleted']
  writerGroupAlive?: ServiceCtx['deps']['writerGroupAlive']
  bootTimeMs?: ServiceCtx['deps']['bootTimeMs']
  writerWatchMs?: number
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
  // scripts / until / rewind:工作区脚本、检查命令(2026-10-20)与回退(2026-10-21)的测试旋钮,生产不传;quotaResume.notify:到点没接上时告诉主人一句
  unattendedAck?: { get(): number | null; set(at: number): void }
  scripts?: ScriptsOptions
  until?: UntilOptions
  rewind?: RewindOptions
  quotaResume?: QuotaResumeOptions
}
import { makeRuntimeState } from './service/state'
import { makeReviewDomain } from './service/review'
import { makeWorktreeDomain } from './service/worktree'
import { makeScriptsDomain, type ScriptsOptions } from './service/scripts'
import { makeUntilDomain, type UntilOptions, type UntilResume } from './service/until'
import { makeRewindDomain, type RewindOptions } from './service/rewind'
import { makeQuotaResumeDomain, type QuotaResumeOptions } from './service/quota-resume'
import { makeAttachmentsDomain } from './service/attachments'
import { makeQuotaDomain } from './service/quota'
import { makeNoticesDomain } from './service/notices'
import { makeArtifactsDomain } from './service/artifacts'
import { makeAdmissionDomain } from './service/admission'
import { makeViewDomain } from './service/view'
import { makeNativeCheck } from './service/native-check'
import { makeNativeDomain } from './service/native'
import { makePendingInputs } from './service/pending-inputs'
import { makeInputsDomain } from './service/inputs'
import { makeLifecycleDomain } from './service/lifecycle'
import { makeExecuteDomain } from './service/execute'
import { makeEntryDomain } from './service/entry'
import { makeQuotaHandoffDomain, makeQuotaHandoffView } from './service/quota-handoff'
import type { ServiceCtx } from './service/ctx'
export type { CreateWechatTask, SendWechatArtifact, TaskWaitingFor } from './wechat-types'
export type { InputMaterials, CreateTask, WorkbenchPhase, WorkbenchTaskView, EntryResult } from './service/types'

/**
 * 工作台服务的组装:各域按依赖顺序构造,每个域只拿到它要的那几个别的域(工厂的第二个参数)。
 *
 * 依赖图(A → B = A 调 B;每一层只往前面的层指):
 *   0  scripts · quota · attachments · artifacts · pendingInputs(补充落库记账)        只认 ctx
 *   1  admission → quota
 *      notices → quota, artifacts
 *      quotaHandoffView → quota                                                     (额度交接的只读那一半)
 *      nativeCheck → admission                                                      (原生会话核对)
 *   2  view → admission, quota, quotaHandoffView, scripts
 *   3  until → view, [resumeAfterCheck]                                              (见下面唯一那条回调)
 *   4  lifecycle → view, artifacts, notices, pendingInputs, until
 *   5  inputs → admission, attachments, view, lifecycle, pendingInputs
 *      rewind → lifecycle, scripts, until, view
 *   6  execute → admission, attachments, quota, view, nativeCheck, inputs, lifecycle, notices, artifacts, scripts, rewind, until
 *   7  native → admission, attachments, quota, view, nativeCheck, execute
 *      entry → execute, view, admission, quota, scripts
 *      quotaHandoff → execute, quota
 *      review → scripts, until, view, inputs, execute
 *      worktree → scripts, view
 *      quotaResume → execute, notices, quota
 *
 * 以前这些边有一部分反着指(下层在调用时经一个晚绑定的动作表回头拿上层的函数),环藏在那张表后面。现在每条都正过来了:
 * - lifecycle.pump → execute.execute:排队的 run 自己带着做法(running.launch,execute.start 建 run 时放进去),
 *   调度器不认识 execute(state.ts 的 Active.launch)。
 * - inputs.drainInputs → execute.start:只有 execute 收尾时调它,调下来时把 start 当参数带着。
 * - lifecycle ↔ inputs:lifecycle 要的 holdInputs / hasUndeliveredInput 只认 ctx,搬进 pending-inputs.ts,两头都依赖它。
 * - native ↔ execute:execute 要的 validateNativeDecision 搬进 native-check.ts;native 建在 execute 之后、直接拿 start。
 * - lifecycle / native → execute.matterSync:它只看 ctx.deps.matters,搬进 matter-sync.ts。
 * - view → quotaHandoff:详情只要只读那一半(makeQuotaHandoffView),不碰 execute。
 * - review / quotaResume / worktree / rewind:本来就在被依赖方之后,改成构造时显式传。
 *
 * 剩一条真环,用一个具名回调在构造时注入(UntilResume,until.ts 有说明):
 *   一轮做完 → lifecycle / execute 调 until.afterTurn → 检查没过 → 让执行者接着改(inputs.submitInput / execute.continueTask)。
 * until 必须先于 lifecycle / execute 建好,而「接着改」的两个动作在它们之上;afterTurn 又是从很多低层路径
 * (收尾、拍板后的落定、网络恢复)调到的,没法每次当参数带下来。这条回调只在检查脚本跑完之后才会被调,
 * 那时所有域都已建好。
 */
export function makeWorkbenchService(opts: Options) {
  const { store } = opts
  const changes = opts.changes ?? makeTaskChangeHub()
  /** store 的写方法把 seq 落库,但不知道 hub —— 这里把持久化 seq 送进去唤醒长轮询。 */
  const touched = (id: string, seq?: number) => { try { changes.publish(id, seq ?? store.version(id)) } catch { /* 信号丢了只是多等一轮 */ } }
  /** 非 store 状态变化:先落库拿新 seq 再唤醒。bump 本身可能抛(任务不存在),别让它冒进调用方的 finally/catch。 */
  const bumped = (id: string) => { try { touched(id, store.bump(id)) } catch { /* 信号丢了只是多等一轮 */ } }
  const state = makeRuntimeState()
  // Options 里除了这几样(store / 目录 / 变更中心 / 四个子功能的选项),其余原样就是 ServiceDeps —— 不再逐字段抄一遍。
  const { store: _store, stateDir, changes: _changes, scripts: _scripts, until: _until, rewind: _rewind, quotaResume: _quotaResume, ...deps } = opts
  const ctx: ServiceCtx = {
    store, stateDir, state,
    hub: { touched, bumped, dispose: () => changes.dispose() },
    deps,
    ensureAccepting,
    ...(opts.log ? { log: opts.log } : {}),
    now: Date.now,
  }

  // ---- 0 层:只认 ctx
  const scriptsDomain = makeScriptsDomain(ctx, opts.scripts)
  const quotaDomain = makeQuotaDomain(ctx)
  const attachmentsDomain = makeAttachmentsDomain(ctx)
  const artifactsDomain = makeArtifactsDomain(ctx)
  const pendingInputs = makePendingInputs(ctx)

  // ---- 1 层
  const admissionDomain = makeAdmissionDomain(ctx, { quota: quotaDomain })
  const noticesDomain = makeNoticesDomain(ctx, { quota: quotaDomain, artifacts: artifactsDomain })
  const quotaHandoffView = makeQuotaHandoffView(ctx, { quota: quotaDomain })
  const nativeCheck = makeNativeCheck(ctx, { admission: admissionDomain })

  // ---- 2 层
  const viewDomain = makeViewDomain(ctx, {
    admission: admissionDomain,
    quota: quotaDomain,
    quotaHandoff: quotaHandoffView.quotaHandoff,
    scripts: scriptsDomain.status,
  })

  // ---- 3 层:until。检查没过之后怎么接着改,由下面这一个具名回调给出(见文件顶部「剩一条真环」)。
  // 它引用的 inputsDomain / executeDomain 在后面才建 —— 这是整个组装里唯一一处;它只在检查脚本跑完后才被调,那时都已建好。
  const resumeAfterCheck: UntilResume = (id, text, requestId, current) => {
    if (current) return inputsDomain.submitInput(id, { runId: current.identity, requestId, text })
    executeDomain.continueTask(id, text, { inputRequestId: requestId })
    return undefined
  }
  const untilDomain = makeUntilDomain(ctx, { view: viewDomain, resume: resumeAfterCheck }, opts.until)

  // ---- 4–5 层
  const lifecycleDomain = makeLifecycleDomain(ctx, {
    view: viewDomain,
    artifacts: artifactsDomain,
    notices: noticesDomain,
    pending: pendingInputs,
    until: untilDomain,
  })
  const inputsDomain = makeInputsDomain(ctx, {
    admission: admissionDomain,
    attachments: attachmentsDomain,
    view: viewDomain,
    lifecycle: lifecycleDomain,
    pending: pendingInputs,
  })
  const rewindDomain = makeRewindDomain(ctx, {
    lifecycle: lifecycleDomain,
    scripts: scriptsDomain,
    until: untilDomain,
    view: viewDomain,
  }, opts.rewind)

  // ---- 6 层:execute 在顶上,它要的都已建好
  const executeDomain = makeExecuteDomain(ctx, {
    admission: admissionDomain,
    attachments: attachmentsDomain,
    quota: quotaDomain,
    view: viewDomain,
    native: nativeCheck,
    inputs: inputsDomain,
    lifecycle: lifecycleDomain,
    notices: noticesDomain,
    artifacts: artifactsDomain,
    scripts: scriptsDomain,
    rewind: rewindDomain,
    until: untilDomain,
  })

  // ---- 7 层:建在 execute 之上的入口
  const nativeDomain = makeNativeDomain(ctx, {
    admission: admissionDomain,
    attachments: attachmentsDomain,
    quota: quotaDomain,
    view: viewDomain,
    check: nativeCheck,
    execute: executeDomain,
  })
  const entryDomain = makeEntryDomain(ctx, {
    execute: executeDomain,
    view: viewDomain,
    admission: admissionDomain,
    quota: quotaDomain,
    scripts: scriptsDomain,
  })
  const quotaHandoffDomain = makeQuotaHandoffDomain(ctx, { execute: executeDomain, quota: quotaDomain })
  const review = makeReviewDomain(ctx, {
    scripts: scriptsDomain,
    until: untilDomain,
    view: viewDomain,
    inputs: inputsDomain,
    execute: executeDomain,
  })
  const worktreeDomain = makeWorktreeDomain(ctx, { scripts: scriptsDomain, view: viewDomain })
  const quotaResumeDomain = makeQuotaResumeDomain(ctx, {
    execute: executeDomain,
    notices: noticesDomain,
    quota: quotaDomain,
  }, opts.quotaResume)

  // 开机对账:全部建好之后再做(顺序同改造前)
  store.recover()
  store.liveInputs.recover()
  lifecycleDomain.adoptWriters()
  scriptsDomain.recover()
  void rewindDomain.recover()
  quotaResumeDomain.recover()

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
    // api:额度恢复后接着做(service/quota-resume.ts)
    fallbackExecutor(exhaustedId:string):string|null{return quotaDomain.fallbackExecutor(exhaustedId)},
    ...quotaHandoffDomain.api,
    ...quotaResumeDomain.api,
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
    setArchived:(id:string,archived:boolean)=>{const view=lifecycleDomain.setArchived(id,archived);if(archived)worktreeDomain.tidyOnArchive(id);return view},
    confirmWriterExited:lifecycleDomain.confirmWriterExited,
    cancel:lifecycleDomain.cancel,
    suspendForNetwork:lifecycleDomain.suspendForNetwork,
    resumeFromNetwork:lifecycleDomain.resumeFromNetwork,
    stopSuspendedForNetwork:lifecycleDomain.stopSuspendedForNetwork,
    networkSuspended:lifecycleDomain.networkSuspended,
    artifact:artifactsDomain.artifact,
    approve:artifactsDomain.approve,
    /** 这个任务的所有变更快照,新→旧,每个文件附上当前标记。坏的那一轮单独 unavailable,不牵连别轮。 */
    reviewList:review.reviewList,
    markReviewFile:review.markReviewFile,
    // 工作区脚本(2026-10-20):运行 / 停下 / 批准
    returnReviewFiles:review.returnReviewFiles,
    revertReviewFile:review.revertReviewFile,
    reviewComment:review.reviewComment,
    sendReviewComments:review.sendReviewComments,
    revertReviewHunk:review.revertReviewHunk,
    worktreeAction:worktreeDomain.worktreeAction,
    rewindPreview:rewindDomain.rewindPreview,
    rewind:rewindDomain.rewind,
    undoRewind:rewindDomain.undoRewind,
    rewindResolve:rewindDomain.rewindResolve,
    pruneRewindRefs:rewindDomain.pruneRefs,
    scriptAction:scriptsDomain.scriptAction,
    approveScripts:scriptsDomain.approveScripts,
    resolvePermission:inputsDomain.resolvePermission,
    async handleWechat(chatId:string,text:string,identity?:WechatMessageIdentity):Promise<WechatWorkbenchReply|null>{return wechatControl(chatId,text,identity)},
    // 工作区脚本和会话一起停(TERM → 宽限 → KILL)
    shutdown: () => Promise.all([
      rewindDomain.shutdown(),
      scriptsDomain.shutdown(),
      untilDomain.shutdown(),
      Promise.resolve(quotaResumeDomain.shutdown()),
      lifecycleDomain.shutdown(),
    ]).then(() => {}),
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
  const wechatControl=makeWechatWorkbenchControl({
    store,
    ownerChatId:opts.ownerChatId,
    actions:service,
    hasExecutor:(id)=>{try{admissionDomain.provider(id);return true}catch{return false}},
    ...(opts.fetchIssue?{fetchIssue:opts.fetchIssue}:{}),
    ...(opts.addLesson?{addLesson:opts.addLesson}:{}),
    ...(opts.requestReview?{requestReview:opts.requestReview}:{}),
  })
  return service
}
export type WorkbenchService=ReturnType<typeof makeWorkbenchService>
