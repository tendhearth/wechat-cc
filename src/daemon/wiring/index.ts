/**
 * wiring/ — main.ts dep factory hub. Composes the three sub-builders into
 * one wireMain() entry. Holds zero business logic — pure orchestration.
 */
import type { Db } from '../../lib/db'
import type { IlinkAdapter, IlinkAccount } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import type { Access } from '../../lib/access'
import type { InboundPipelineDeps } from '../inbound/build'
import type { CompanionPushDeps, CompanionIntrospectDeps, CompanionIngestDeps } from '../companion/lifecycle'
import type { SchedulerDeps } from '../guard/scheduler'
import type { SessionsLifecycleDeps } from '../sessions-lifecycle'
import type { IlinkLifecycleDeps } from '../ilink-lifecycle'
import type { PollingDeps } from '../polling-lifecycle'
import type { StartupSweepDeps } from '../startup-sweeps'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { ReplySinks } from '../reply-sinks'
import { buildPipelineDeps, type PipelineDepsLate } from './pipeline-deps'
import { buildLifecycleDeps } from './lifecycle-deps'
import { buildTickBodies, type TickBodies } from './tick-bodies'
import type { ProactiveOutbound } from '../companion/proactive-channel'
import type { SpeechPolicy } from '../speech/policy'
import { makeMemoryLlmOps } from '../memory-llm-ops'
import { makeAtelierTick } from '../../features/atelier'

export interface WireMainOpts {
  /** 项目登记(别名 → 文件夹),伙伴那一拍选文件夹用。 */
  projects: import('../projects').Projects
  /** 比 wireMain 晚才有的几样(拉消息、入站管道、App 一轮、知识库催一下):调用时现取,模块容器的 ctx.late。 */
  late: PipelineDepsLate
  workbench?: import('../../core/workbench/service').WorkbenchService
  /** 终端会话登记处(v76):手机 GET /m/api/cli/sessions 读它。缺省 ⇒ 503。 */
  cliSessions?: () => import('../../adapters/store/cli-session-store').CliSessionView[]
  /** 「CC 做过的事」(B9):透传给手机面板。 */
  activity?: import('../mobile-activity').MobileActivityDeps
  /** 终端会话的手机动作(拍板 / 说一句):POST /m/api/cli/permission、/m/api/cli/say。缺省 ⇒ 503。 */
  cliActions?: import('../../features/terminal').CliPhoneActions
  /** 「今天」一眼看完(core/overseer-today.ts):手机 GET /m/api/today 读它。缺省 ⇒ 503。 */
  overseerToday?: () => import('../../domain/overseer-today').OverseerToday
  /** 「CC 现在怎么样」里「终端里的 Claude Code / Codex」那一行(2026-10-14)。缺省 ⇒ 那一行不出现。 */
  terminalHooks?: Pick<import('../../features/terminal').TerminalHooksService, 'capabilityInput'>
  /** 网络守护运行时(2026-10-02,network-gate 模块建):闸门 + 健康快照 + 后台任务跳过包装。缺省 = 老行为。 */
  guardRuntime?: import('../guard/runtime').GuardRuntime
  /** 可选子系统开机状态(SubsystemSupervisor.statuses)→「CC 现在怎么样」。 */
  subsystems?: () => Array<{ name: string; state: 'ok' | 'degraded' | 'off'; error?: string }>
  /** 真回合里被拒着的执行者(provider-refusals.ts)。 */
  providerRefusals?: () => Record<string, import('../provider-refusals').ProviderRefusal>
  /** 内部 API 的 token-registry 窄接口 → 手机设置面板(梳理第 6 步)。 */
  panelTokens?: import('../internal-api/token-registry').PanelTokens
  /** 「一件事」登记处(matters store);微信入站登记 chat、app 对话绑桌面表面、管家候选集都从这里来。 */
  matters?: import('../../adapters/store/matters-store').MatterStore
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  /** Sticker library — threaded to tick-bodies' daily sticker-artist step. */
  stickers?: import('../../features/stickers').StickerLib
  /** 远程访问开关的重启触发(settings-panel set_remote)。 */
  requestRestart?: (reason: string) => void
  /** 微信文本命令(重构第二批步 2,进 CommandRegistry)。 */
  commands?: readonly import('../commands/registry').WechatCommand[]
  /** LLM 体检的只读缓存(settings-panel「模型与后端」表格;面板绝不主动外呼)。 */
  llmHealth?: { cached(): import('../llm-health').LlmHealthReport | null }
  /** Loaded before makeIlinkAdapter — passed separately because IlinkAdapter doesn't expose accounts. */
  accounts: IlinkAccount[]
  boot: Bootstrap
  /** `--dangerously` flag — read by startup-sweeps for notification text. */
  dangerously: boolean
  /**
   * Task 11 — tick-bodies resolve `default_chat_id`'s tier from
   * access.json on each tick. Threaded through wireMain so the eval
   * harness can inject a fake `loadAccess` without touching disk.
   */
  loadAccess: () => Access
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /** Forwarded to buildLifecycleDeps — eval harness override. */
  schedulerIntervalMs?: number
  /**
   * Shared chat-prefs instance (constructed once in main.ts, also passed to
   * registerInternalApi's getChatPrefs) — threaded through to buildPipelineDeps
   * so the /set command reads/writes the SAME store the reply-route split
   * logic reads. A second instance would have a stale in-memory cache.
   */
  chatPrefs: ChatPrefsStore
  /**
   * Shared care-ledger instance (constructed once in main.ts alongside
   * chatPrefs) — threaded through so pushTick's claim/read and the inbound
   * no-reply reset operate on the SAME store. A second instance would have
   * a stale in-memory cache.
   */
  careLedger: CareLedger
  /**
   * Shared reply-sink registry (constructed once in main.ts, also passed to
   * registerInternalApi's `replySinks`) — threaded through to
   * buildPipelineDeps so the companion-converse closure opens sinks on the
   * SAME registry the reply route captures into.
   */
  replySinks: ReplySinks
  /**
   * 打猎战利品(2026-09-03)。和 replySinks 一样必须是 main.ts 里那个**同
   * 一个实例**:开 tap 的是打猎那一拍,往里写的是发送路径。经 `...opts`
   * 透传进 buildTickBodies。
   */
  outboundTaps?: { tap(chatId: string): { close(): string[] } }
  /** 「CC 做过的事」补记(B9);tick-bodies 拿它记主动说话。 */
  activityLog?: import('./tick-bodies').TickDeps['activityLog']
  /**
   * 回复交付(spec 2026-10-03):main.ts 里那**同一个** runtime。经 `...opts` 透传进 buildTickBodies ——
   * 伙伴推送的最后的话经它送达。只有这一条路(D3),所以必填。
   */
  replyDelivery: import('../../domain/turn-reply').ReplyDeliveryPort
  /**
   * 桌宠信号(spec 2026-09-05-cc-desktop-pet §5.1)。和 replySinks/outboundTaps
   * 一样必须是 main.ts 那个**同一个实例**:写的一头在 bootstrap(tool_call /
   * 回合结束)与 pipeline-deps(起飞 / 主人联系),读的一头是 pipeline-deps
   * 组装出的 petTurn。两个实例 = 桌宠永远看不到动静,而且不会报任何错。
   */
  petSignals?: import('../pet-signals').PetSignals
  // 伙伴日志(背包,以前叫 huntStore)。三条用途:tick-bodies 用 recordHunt(打猎入库)与 list/summary(日程判断
  // 要看包袱里堆了什么),pipeline-deps 用 list(微信「背包」命令)。这里给全,下游各取所需 —— 传的是地基里那份完整 Journal。
  journal?: {
    recordHunt(a: { chatId: string; text: string; nowIso?: string }): number
    list(limit?: number): readonly import('../../adapters/store/journal-store').CatchRow[]
    /** 包袱水位(spec 2026-09-05-companion-plan):水位之后有几条、最新一条是什么。 */
    summary(seenUntil: string | null): { unread: number; latest: { kind: string; title: string; ts: string } | null }
  }
  /** 对话回合(turn_records)—— 随身 CC 首屏的「聊天日摘要」来源。main.ts 传 turnRecordStore。 */
  turns?: { recent(limit: number): readonly { chatId: string; endedAt: number; outcome: string; mode: string; startedAt: number }[] }
  /** 三轴 presence 共用入口(internal-api lifecycle.getPresence)。main.ts 传入。 */
  presence?: () => Promise<import('../../domain/companion-presence').Presence | null>
}

export interface WiredDeps {
  pipelineDeps: InboundPipelineDeps
  /**
   * App-conversation-channel converse closure (voice arc Stage 0, Task 2).
   * main.ts late-binds this onto internal-api via setCompanionConverse()
   * once wireMain returns (bootstrap must be ready first).
   */
  companionConverse: (text: string, origin?: 'desktop' | 'phone', images?: import('../app-reply').ConverseImage[]) => Promise<import('../app-reply').ConverseResult>
  /**
   * 桌宠 turn 闭包(CC 桌宠 Phase B)。main.ts 在 setCompanionConverse 旁边
   * setPetTurn 到 internal-api —— 同样要等 bootstrap 就绪。
   */
  petTurn: import('../internal-api/types').PetTurnDep
  /** Mint a fresh graphical-settings-panel URL (10-min token). Null when no
   *  LAN/owner. Wired to 微信 /set (in-process) and GET /v1/settings/link
   *  (admin tier since plan 7a; selftest phone). */
  settingsPanelLink: () => Promise<string | null>
  /** 「CC 的连接」快照(缓存 10 s);main.ts setConnections 到 internal-api。 */
  connections: () => import('../connections').ConnectionsSnapshot
  /** 桌面「连接手机」;main.ts setPhoneConnect 到 internal-api。 */
  phoneConnect: import('../internal-api/types').PhoneConnectDep
  /** 手机 app 原生推送出口(pipeline-deps 造);main.ts 接给终端会话推送。 */
  appPush: import('../../features/terminal').AppPushOutlet
  /**
   * CC 主动找你的出口(2026-10-18,companion/proactive-channel.ts):微信能用走微信,不能用 / 发失败落到 App。
   * 伙伴的 tick 已经接上;main.ts 接给提醒。
   */
  proactive: ProactiveOutbound
  /** CC 主动开口唯一的门(第三批 3a,./wire-speech.ts);各条主动开口的路逐个迁过来。 */
  speech: SpeechPolicy
  /** App 那条路本身(没开中继 v2 / 没配对 ⇒ null);main.ts 接给信(微信不通时寄到 App)。 */
  companionApp: import('../companion/proactive-channel').AppChannel | null
  /** 每晚记忆整理运行时(pipeline-deps 造);main.ts 挂定时器 + setMemoryNightly。 */
  memoryNightly: import('../memory/nightly-runtime').MemoryNightlyRuntime
  mattersService: import('../../core/matters/service').MattersService | null
  /** 「一件事」活动时间:退订工作台事件 + 清节流定时器;main.ts 登记进 shutdown。 */
  stopMatterActivity: () => void
  /** 关机时停手机那一簇(重构第二批步 6d);main.ts 在 polling 之前登记。 */
  stopPhone: () => Promise<void>
  companionPushDeps: CompanionPushDeps
  companionIntrospectDeps: CompanionIntrospectDeps
  companionIngestDeps: CompanionIngestDeps
  guardDeps: SchedulerDeps
  sessionsDeps: SessionsLifecycleDeps
  ilinkDeps: IlinkLifecycleDeps
  pollingDeps: Omit<PollingDeps, 'runPipeline'>
  startupDeps: StartupSweepDeps
  /**
   * The same TickBodies object used by the lifecycle onTick callbacks.
   * Exposed so bootDaemon can wire DaemonHandle.fireTick directly to it —
   * eval harness calls fireTick to drive ticks deterministically.
   */
  ticks: TickBodies
}

export function wireMain(opts: WireMainOpts): WiredDeps {
  // CC 画的你 —— 小像自动刷新用的 generatePortrait(portrait-artist tick)。
  // memory-llm-ops 是无状态工厂(每次读盘),tick 与 pipeline-deps 各持一个
  // 无妨。构造在 buildTickBodies 前,以便传入。
  const tickMemoryLlm = makeMemoryLlmOps({
    stateDir: opts.stateDir, db: opts.db,
    getMode: (cid) => opts.boot.coordinator.getMode(cid),
    registry: opts.boot.registry,
  })
  // 画室那一拍(默认关;src/features/atelier):放在反省那一拍的最后一步。
  const runAtelierTick = makeAtelierTick({
    stateDir: opts.stateDir, db: opts.db,
    cheapEval: () => opts.boot.registry.getCheapEval(),
    log: (tag, line) => opts.log(tag, line),
  })
  // pipeline-deps 先造:App 那条路(companionApp)在它里面,伙伴的 tick 要用。buildTickBodies 构造时只是闭包。
  const { appPush, companionApp, proactive, speech, pipelineDeps, companionConverse, petTurn, settingsPanelLink, mattersService, memoryNightly, stopMatterActivity, stopPhone, connections, phoneConnect } = buildPipelineDeps(opts, opts.late)
  const ticks = buildTickBodies({
    ...opts,
    proactive,
    speech,
    permissionMode: opts.dangerously ? 'dangerously' : 'strict',
    generatePortrait: (chatId) => tickMemoryLlm.generatePortrait(chatId),
    // Connection-health gate (Task 7) — companion ticks read
    // boot.health.health.shouldSuspend('wechat') to stop proactive outbound
    // while the connection is confirmed down (see TickDeps.health's doc
    // comment in ./tick-bodies.ts).
    health: opts.boot.health.health,
    runAtelierTick,
  })
  const lifecycleDeps = buildLifecycleDeps(opts, ticks, speech)
  return {
    appPush,
    proactive,
    speech,
    companionApp,
    pipelineDeps,
    companionConverse,
    petTurn,
    settingsPanelLink,
    connections,
    phoneConnect,
    mattersService,
    memoryNightly,
    stopMatterActivity,
    stopPhone,
    ...lifecycleDeps,
    ticks,
  }
}
