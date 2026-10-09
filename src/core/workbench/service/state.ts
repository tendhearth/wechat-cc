/**
 * makeWorkbenchService 的共享可变状态(spec 2026-09-27-workbench-service-split §2)。
 * 这里只是把原来散在闭包里的 7 个容器 + 6 个 let 集中成一个对象,语义一个字不改:
 * service.ts 对容器解构(引用不变),对 6 个标量走 state.x;域模块经 ctx.state 看同一份。
 */
import type { AgentExecutionChoice, AgentSession } from '../../agent-provider'
import type { Attachment } from '../attachments'
import type { ArtifactSelection, HandoffPreview } from '../handoff'
import type { AcceptedNativeResume } from '../native-adoption'
import type { GitBaseline } from '../git-review'
import type { RestartPreview } from '../continuation'
import type { PathReservation } from '../scheduler'
import type { RunPermissions } from '../permissions'
import type { RunUserInput } from '../user-input'
import type { LiveInput } from '../live-inputs'
import type { StoredTask } from '../store'
import type { ArtifactDeliveryReceipt } from '../artifact-deliveries'

export type AcceptedContinuation = { mode: 'new' } | { mode: 'resume'; sessionId: string } | { mode: 'restart'; preview: RestartPreview }
export interface Active extends PathReservation {
  execution:AgentExecutionChoice
  attachments:Attachment[]
  handoffId?:string
  handoffArtifacts?:ArtifactSelection[]
  nativeResume?:AcceptedNativeResume
  restoreRunId?: string
  restoreSettlement?: Promise<void>
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
  /** 「这是第几轮」——回报去重键(评审修复轮 1:布尔 `reported` 选错了层,见 `reportOnce`)。
   *  `submitInput` 实际投给 runtime 时(主人续接,可靠的同步点)与转移探测器观察到
   *  「又动起来了」时(自己醒来,尽力而为——没有比快照更早的信号)各加一次。不是幂等锁
   *  ——同一轮里两条路径都触发也只是多加了一次,不影响「序号变了就该再报」这个判据。 */
  turnSeq: number
  /** 已经报过、且报的是第几轮(`turnSeq` 的快照)。`-1` = 还没报过。`reportOnce` 只在
   *  `turnSeq!==reportedTurn` 时才入队,不依赖「有没有观察到静下来又动起来」这件事本身
   *  ——那件事会被漏看(见 reportOnce 的注释)。 */
  reportedTurn: number
  /** 「回忆」触发的去重键(task-5,fix round 1:与 `reportedTurn` 同一套道理,同一份
   *  证据——settleQuiet 会因为转移探测器与显式 `result` 分支各调一次而在同一个 `turnSeq`
   *  上触发两次,`recollectOnce` 靠这个字段挡。`-1` = 还没触发过。 */
  recollectedTurn: number
  collection?:Promise<void>
  turnCollection?:Promise<void>
  collectionFailure?:string
  /** 已记过的收集警告:每回合都重扫成果目录,同一条只记一次(评审 2026-09-16) */
  warned?:Set<string>
  /** 空闲自动收工的计时器:会话安静下来才起,任何一下互动都取消。`at` 是到点的绝对时刻
   *  (重排时用来判「新档位是不是更短」),`reason` 分「有人等的短让位」与「没人等的长空闲」。 */
  idleClose?:{timer:ReturnType<typeof setTimeout>;at:number;reason:'handoff'|'idle'}
  /** 停止请求到达时本轮已经答复 —— 那是收工,不是取消,终态记 completed。 */
  closedWhileReplied?: boolean
  credentialsMinted: boolean
  credentialsRevoked: boolean
  /**
   * 网络守护把这条 run 的整棵进程树冻住了(主人 2026-10-03:probe 来源连续两次不安全 ⇒ 暂停,不停)。
   * 冻住期间 daemon 侧为它起的计时器一律不走:回合看门狗按「在等」算、批准期限停表、空闲收工不武装。
   */
  networkSuspended?: { since: number }
  /** 停下这条 run 时交给终态微信通知的正文(暂停到顶:「网络一直没恢复，任务已停止，可以接着做」)。 */
  stopNotice?: string
}

export interface WorkbenchRuntimeState {
  runsByTask: Map<string, Active>
  /** 文件夹的占用:派发时写入,会话关闭(结算 / 隔离)时删除 —— 中间从不释放。 */
  reservations: Map<string, Active>
  queue: Active[]
  runningText: Map<string, string>
  collections: Set<Promise<void>>
  nativeDecisions: Map<string, AcceptedNativeResume>
  handoffDecisions: Map<string, {preview:HandoffPreview;sourceVersion:string;targetVersion:string|null;directoryIdentity:string;expiresAt:number}>
  order: number
  stopping: boolean
  shutdownComplete: boolean
  shutdownPromise: Promise<void> | undefined
  noticeWake: (context?:{ownerChatId:string;accountId:string}) => Promise<void>
  artifactDelivery: ((id:string)=>Promise<ArtifactDeliveryReceipt>) | undefined
  /** 补充暂时不能自动续投的任务(存库失败 / 被 hold 中);见 inputs 域。 */
  autoContinueBlocked: Set<string>
  /**
   * 重启前没确认退出、进程组至今还活着的任务(2026-10-06):没有 Active,但照样占着文件夹 —— 以前重启后
   * 这道保护只剩库里一个标记,同文件夹的新任务其实不再等。组都没了 ⇒ 解除(lifecycle 的 writer 守望)。
   */
  writerOrphans: Map<string, PathReservation & { groups: number[] }>
  mutations: Map<string, PathReservation>
  writerWatch: ReturnType<typeof setInterval> | undefined
}

export function makeRuntimeState(): WorkbenchRuntimeState {
  return {
    runsByTask: new Map(), reservations: new Map(), queue: [], runningText: new Map(), collections: new Set(),
    nativeDecisions: new Map(), handoffDecisions: new Map(),
    order: 0, stopping: false, shutdownComplete: false, shutdownPromise: undefined,
    noticeWake: async () => {}, artifactDelivery: undefined,
    autoContinueBlocked: new Set(),
    writerOrphans: new Map(), mutations: new Map(), writerWatch: undefined,
  }
}

/** Shared admission guard reads the current shutdown state at the point of use. */
export function assertAccepting(state:Pick<WorkbenchRuntimeState,'stopping'>):void {
  if(state.stopping)throw new Error('workbench_stopping')
}
