/**
 * 域模块看到的 service 上下文(spec 2026-09-27-workbench-service-split §2)。
 * 显式、只读、不含 service 对象本身,也不含别的域:域要别的域的东西,由 service.ts 按依赖顺序
 * 构造时显式传进它的工厂(makeXDomain(ctx, {admission, quota, ...}))。依赖图与环怎么断的见 service.ts 顶部。
 */
import type { AskSource } from '../../../domain/permission-rules/types'
import type { NetworkGate } from '../../../lib/network-gate'
import type { ProviderRegistry } from '../../../app/provider-registry'
import type { UsageSnapshot } from '../../../domain/subscription-usage'
import type { WorkbenchStore } from '../../../adapters/store/workbench/store'
import type { NativeHistoryProvider, NativeHistoryReader } from '../../../adapters/workbench/native-history'
import type { WorkbenchRuntimeState } from './state'
import type { MatterStore } from '../../../adapters/store/matters-store'
import type { ReportSink } from '../../../domain/matters/report'
import type { RecollectSink } from '../../../domain/matters/recollection'

export interface ServiceHub {
  /** store 的写方法把 seq 落库,但不知道 hub —— 这里把持久化 seq 送进去唤醒长轮询。 */
  touched(id:string,seq?:number):void
  /** 非 store 状态变化:先落库拿新 seq 再唤醒。 */
  bumped(id:string):void
  /** 长轮询中心收尾:叫醒所有 waiter、清缓存(shutdown 最后一步)。 */
  dispose():void
}
/** service 的外部依赖里域会用到的那几样(opts 的子集,只读);按需加,不整个 opts 透传。 */
export interface ServiceDeps {
  /** 主人身份的唯一来源(材料作用域、微信投递、entry 校验都看它)。 */
  ownerChatId: () => string | null
  /** 执行者登记处:quota 的候选、admission 的准入、notices 的显示名都从这里查。 */
  registry: ProviderRegistry
  /** 订阅执行者的真实额度快照(subscription-usage.ts 的监视器缓存);可选,不传就只靠失败信息判耗尽。 */
  usage?: (providerId: string) => UsageSnapshot | null
  /** 这家执行者现在被拒着(daemon/provider-refusals:出口地区用不了,2026-10-23)。只读;没有 ⇒ null。 */
  refusal?: (providerId: string) => { code: string; since: string } | null
  /** 权限卡的等待上限(ms);缺省 WORKBENCH_PERMISSION_TIMEOUT_MS。 */
  permissionTimeoutMs?: number
  /** 放行规则(2026-10-19):权限卡登记之前先问;不传 ⇒ 每条都问主人(改造前)。 */
  permissionDecide?: (ask: AskSource) => Promise<{ verdict: 'allow' | 'deny' | 'ask'; by: string }>
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
  /** 进程组还在不在(writer 退出证据);缺省 kill(-组, 0),只有 ESRCH 算不在。测试注入。 */
  writerGroupAlive?: (group: number) => boolean
  /** 这次开机的时刻(毫秒);测试注入。缺省按 os.uptime 推算。 */
  bootTimeMs?: () => number
  /** writer 守望多久查一次(ms;缺省 15 秒)。 */
  writerWatchMs?: number
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
  /** 执行者一轮真的完成了(不是取消、不是失败)—— 「被拒着」的标记只认这个恢复(daemon provider-refusals)。 */
  onTurnCompleted?: (providerId: string) => void
  /** 受管工作目录的根;不传 ⇒ entry 的 managed 目标一律 entry_not_wired。 */
  managedWorkspaceRoot?: string
  /** 网络闸门(2026-10-02):起执行者 / 投补充之前问一次,不安全 ⇒ `network_unprotected`。不传 = 不拦。 */
  networkGate?: NetworkGate
  /** 项目经验(2026-10-20):源项目路径 ⇒ 要放进执行者指令的那一段;没有 ⇒ null。 */
  projectLessons?: (projectPath: string | null) => string | null
  /** 加一条项目经验(打回时「同时记成这个项目的经验」);同微信「经验」命令、手机那个文件。 */
  /** checkpoint 总期限(毫秒);缺省 CHECKPOINT_DEADLINE_MS。只给测试放宽(负载下 15 秒不够,打不成点那一轮就回不去)。 */
  checkpointDeadlineMs?: number
  /** 差异快照每个阶段(基线 / 收尾)的总期限(毫秒);缺省 REVIEW_DEADLINE_MS(15 秒)。只给测试放宽:负载下读不完 ⇒ 快照 partial。 */
  reviewDeadlineMs?: number
  addLesson?: (projectPath: string, text: string) => { ok: true } | { ok: false; error: 'invalid' | 'duplicate' | 'full' }
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
}
