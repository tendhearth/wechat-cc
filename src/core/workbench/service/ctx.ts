/**
 * 域模块看到的 service 上下文(spec 2026-09-27-workbench-service-split §2)。
 * 显式、只读、不含 service 对象本身:域需要「别的域 / service 的动作」一律 ctx.actions.deref() 在**调用时**取
 * —— Ref 由 service.ts 在 public 对象建好后 set 一次;工厂体里不许 deref(那时还没 set)。
 */
import type { NetworkGate } from '../../../lib/network-gate'
import type { Ref } from '../../../lib/lifecycle'
import type { ProviderRegistry } from '../../provider-registry'
import type { UsageSnapshot } from '../../subscription-usage'
import type { StoredTask, Task, TaskStatus, WorkbenchStore } from '../store'
import type { NativeHistoryProvider, NativeHistoryReader } from '../native-history'
import type { Continuation } from '../continuation'
import type { QuotaState } from '../../provider-quota'
import type { AgentExecutionChoice, AgentRuntimeSnapshot } from '../../agent-provider'
import type { LiveInput } from '../live-inputs'
import type { AcceptedContinuation, Active, WorkbenchRuntimeState } from './state'
import type { AdmittedProvider, InputMaterials, WorkbenchTaskView } from './types'
import type { MatterStore } from '../../matters/store'
import type { ReportSink } from '../../matters/report'
import type { RecollectSink } from '../../matters/recollection'
import type { AcceptedNativeResume } from '../native-adoption'
import type { ArtifactSelection, AttachmentSelection } from '../handoff'
import type { Attachment } from '../attachments'

export interface ServiceHub {
  /** store 的写方法把 seq 落库,但不知道 hub —— 这里把持久化 seq 送进去唤醒长轮询。 */
  touched(id:string,seq?:number):void
  /** 非 store 状态变化:先落库拿新 seq 再唤醒。 */
  bumped(id:string):void
  /** 长轮询中心收尾:叫醒所有 waiter、清缓存(shutdown 最后一步)。 */
  dispose():void
}
/**
 * service.ts 在 public 对象建好后 set 一次;域在**调用时** deref。平铺不分组(重排是纯 churn),
 * 每段注释标明谁提供、谁消费。pump / cancelRun 留在 lifecycle 域内不进这里;execute 是唯一真正
 * 需要晚绑定的(lifecycle.pump → execute)。最后两个模块(execute / entry)改用「已建好的域对象显式注入」
 * (makeExecuteDomain(ctx, domains)),不再往这里加字段 —— 见 plans/2026-09-28-workbench-service-split-pr10.md。
 */
export interface ServiceActions {
  submitInput(id:string,input:{runId:string;requestId:string;text:string}&InputMaterials,attachmentPolicy?:'owner'):Promise<LiveInput>
  continueTask(id:string,text:string,options?:{restartToken?:string;inputRequestId?:string}&InputMaterials,attachmentPolicy?:'owner'):WorkbenchTaskView
  isReplied(running:Active):boolean
  /** quota 域:额度耗尽时「交给谁继续」的候选(notices 的终态文案用)。 */
  fallbackExecutor(exhaustedId:string):string|null
  /** 一件成果的字节与元数据(notices 的成果投递用)。 */
  artifact(id:string,artifactId:string):{name:string;mime:string;size:number;sha256:string;contentBase64:string}
  /** quota 域:这家现在还能用吗;null = 能(admission 的 requireEntryInput 与 view 的 list 用)。 */
  quotaExhausted(providerId:string):QuotaState|null
  /** admission 域:任务的续接判定(view 的 detail 用)。 */
  continuation(task:StoredTask,execution?:AgentExecutionChoice):Continuation
  /** admission 域:已准入的执行者登记项(view 的 addProject 用);没登记 / 没能力 ⇒ 抛 unavailable_provider。 */
  provider(id:string):AdmittedProvider
  // ---- 以下九个是 native/handoff 域的跨域依赖(PR 7);查询类也走这里只为保持「只此一种晚绑定」。
  requireInput(providerId:string,attachments:readonly unknown[],execution:AgentExecutionChoice,resume?:boolean):AdmittedProvider
  canResume(task:StoredTask):boolean
  taskVersion(task:StoredTask):string
  selectAttachments(input?:InputMaterials,taskId?:string,policy?:'owner'):Attachment[]
  combinedAttachments(current:readonly Attachment[],previous?:readonly Attachment[]):Attachment[]
  handoffAttachments(refs:AttachmentSelection[],expectedTaskId:string):Attachment[]
  taskView(task:Task,includePermissions?:boolean):WorkbenchTaskView
  matterSync(fn:(m:MatterStore)=>void):void
  /** execute 域:派发一条 run(handoff / continueNativeTask 的最后一步)。签名逐字抄自 service.ts 的 start。 */
  start(task:StoredTask,text:string,acceptedDirectoryIdentity:string,acceptedContinuation?:AcceptedContinuation,nativeResume?:AcceptedNativeResume,handoffArtifacts?:ArtifactSelection[],handoffId?:string,queuedInputId?:string,attachments?:Attachment[],draftId?:string,executionChoice?:AgentExecutionChoice,acceptance?:{persist:(runId:string)=>void;activate:(fn:()=>void)=>void;scope?:{ownerKey:string}},attachmentPolicy?:'owner'):WorkbenchTaskView
  // ---- inputs 域(PR 8):前两个是查询,后三个是 lifecycle 的动作 —— 环第一次真正经这里走。
  continuationAttachmentScope(taskId:string,ids:unknown):{ownerKey:string}|undefined
  inputMode(running:Active):'steer'|'send'|'queue'
  armIdleClose(running:Active):void
  cancelIdleClose(running:Active):void
  settleAfterDecision(running:Active):void
  // ---- lifecycle 域(PR 9):环完整经这里走。execute 是真晚绑定,其余是别的域的查询/动作。
  execute(task:StoredTask,text:string,running:Active):Promise<void>
  hasUndeliveredInput(running:Active):boolean
  holdInputs(id:string,error:string):void
  collect(running:Active):Promise<void>
  collectTurnArtifacts(running:Active):void
  captureCodeChanges(running:Active):Promise<void>
  runtimeSnapshot(running:Active|undefined):AgentRuntimeSnapshot|undefined
  held():Active[]
  stageFinishedNotice(running:Active,status:TaskStatus,error?:string|null,suppressCompleted?:boolean):void
  publishFinishedNotices():void
  /** 网络守护暂停时给订了微信提醒的任务发一条「已暂停(网络未受保护)」(lifecycle 域用)。 */
  enqueueNotice?(task:StoredTask,runId:string,kind:import('../wechat-notifications').WechatNoticeKind,text:string,requestId?:string|null):void
}
/** service 的外部依赖里域会用到的那几样(opts 的子集,只读);按需加,不整个 opts 透传。 */
export interface ServiceDeps {
  /** 主人身份的唯一来源(材料作用域、微信投递、entry 校验都看它)。 */
  ownerChatId: () => string | null
  /** 执行者登记处:quota 的候选、admission 的准入、notices 的显示名都从这里查。 */
  registry: ProviderRegistry
  /** 订阅执行者的真实额度快照(subscription-usage.ts 的监视器缓存);可选,不传就只靠失败信息判耗尽。 */
  usage?: (providerId: string) => UsageSnapshot | null
  /** 权限卡的等待上限(ms);缺省 WORKBENCH_PERMISSION_TIMEOUT_MS。 */
  permissionTimeoutMs?: number
  /** 免审执行者的一次性确认(daemon 侧持久化);不传 ⇒ 免审执行者永远要求确认。 */
  unattendedAck?: { get(): number | null; set(at: number): void }
  /** 原生历史读取器(claude / codex):list 只报名字,native 域真读。 */
  nativeHistory?: Partial<Record<NativeHistoryProvider, NativeHistoryReader>>
  registeredProjects?: () => Array<{alias:string;path:string}>
  defaultProvider?: string
  /** 外部(终端里的 claude/codex)是否正占着这个文件夹/会话;不传 ⇒ 不查。 */
  executionConflict?: (path:string,providerId:string,nativeId:string|null) => boolean
  /** 每轮答复的回报投递;可选,不传就整条功能不存在(降级路径)。 */
  reports?: ReportSink
  /** 「回忆」触发;可选,同上。 */
  recollect?: RecollectSink
  revokeSessionToken?: (sessionKey: string) => void
  /** 保留会话安静下来、没人等这个文件夹时的空闲自动收工时长(ms;缺省 10 分钟);函数形式热生效。 */
  retainedIdleCloseMs?: number | (() => number)
  /** 安静下来而有人在等这个文件夹时的短让位时长(ms;缺省 15 秒)。 */
  handoffGraceMs?: number | (() => number)
  // ---- execute / entry 域(PR 10)
  /** 「一件事」登记处:任务与 matter 一对一同 id;可选,老接线不传。 */
  matters?: MatterStore
  mintSessionToken?: (sessionKey: string) => string
  /** 一回合无事件的上限 / 会话关闭的上限(ms);缺省见 execute。 */
  timeoutMs?: number
  closeTimeoutMs?: number
  /** 忙碌登记处:派发时持有,结算时释放(self-restart 靠它判空闲)。 */
  holdBusy?: (label: string) => () => void
  /** 执行者一轮失败时的错误通道(码 + 原文)—— CLI 自动升级的报错触发。 */
  onTurnError?: (providerId: string, code: string | undefined, message: string) => void
  /** 受管工作目录的根;不传 ⇒ entry 的 managed 目标一律 entry_not_wired。 */
  managedWorkspaceRoot?: string
  /** 网络闸门(2026-10-02):起执行者 / 投补充之前问一次,不安全 ⇒ `network_unprotected`。不传 = 不拦。 */
  networkGate?: NetworkGate
}
export interface ServiceCtx {
  store: WorkbenchStore
  stateDir: string
  state: WorkbenchRuntimeState
  hub: ServiceHub
  deps: ServiceDeps
  /** 停机闸:stopping 后所有会开新工作的入口先过这一道(`workbench_stopping`)。只在 service.ts 定义一次。 */
  ensureAccepting: () => void
  log?: (tag:string,line:string)=>void
  now: () => number
  actions: Ref<ServiceActions>
}
