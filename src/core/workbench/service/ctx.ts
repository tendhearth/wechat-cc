/**
 * 域模块看到的 service 上下文(spec 2026-09-27-workbench-service-split §2)。
 * 显式、只读、不含 service 对象本身:域需要「别的域 / service 的动作」一律 ctx.actions.deref() 在**调用时**取
 * —— Ref 由 service.ts 在 public 对象建好后 set 一次;工厂体里不许 deref(那时还没 set)。
 */
import type { Ref } from '../../../lib/lifecycle'
import type { ProviderRegistry } from '../../provider-registry'
import type { UsageSnapshot } from '../../subscription-usage'
import type { StoredTask, Task, WorkbenchStore } from '../store'
import type { NativeHistoryProvider, NativeHistoryReader } from '../native-history'
import type { Continuation } from '../continuation'
import type { QuotaState } from '../../provider-quota'
import type { AgentExecutionChoice } from '../../agent-provider'
import type { LiveInput } from '../live-inputs'
import type { AcceptedContinuation, Active, WorkbenchRuntimeState } from './state'
import type { AdmittedProvider, InputMaterials, WorkbenchTaskView } from './types'
import type { MatterStore } from '../../matters/store'
import type { AcceptedNativeResume } from '../native-adoption'
import type { ArtifactSelection, AttachmentSelection } from '../handoff'
import type { Attachment } from '../attachments'

export interface ServiceHub {
  /** store 的写方法把 seq 落库,但不知道 hub —— 这里把持久化 seq 送进去唤醒长轮询。 */
  touched(id:string,seq?:number):void
  /** 非 store 状态变化:先落库拿新 seq 再唤醒。 */
  bumped(id:string):void
}
/** service.ts / 别的域提供、域模块在调用时才取的动作;后续 PR 往里加字段(execute/pump/cancelRun/…)。 */
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
