/** buildPipelineDeps 的入参(从 pipeline-deps.ts 搬出来,重构第二批步 6c:wire-settings-panel 也要它的一部分,放一处免得成环)。 */
import type { WechatAccounts, WechatContacts, WechatLinkStatus, WechatPages, WechatPermissions, WechatSend, WechatVoice } from '../../ports/wechat'
import type { Bootstrap } from '../bootstrap'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../../features/companion'
import type { ReplySinks } from '../reply-sinks'

/**
 * 入站管道与它带起来的那一簇(对话、手机、「CC 现在怎么样」、桌宠)用到的微信那一侧(src/ports/wechat.ts 的几口,架构终态 A6)。
 * 组装的地方(daemon-modules.ts 的 `wired`)按这张表从各口挑出来拼好,不交整个 adapter。
 */
export type PipelineWechat =
  & Pick<WechatSend, 'sendMessage' | 'sendFile' | 'sendTyping' | 'onMediaSent'>
  & Pick<WechatAccounts, 'routeChatToAccount' | 'captureContextToken' | 'markChatActive' | 'resolveAccountId'>
  & WechatContacts
  & Pick<WechatPages, 'sharePage'>
  & Pick<WechatPermissions, 'probePermissionReply' | 'handlePermissionReply' | 'listPendingPermissions'>
  & WechatLinkStatus
  & { voice: WechatVoice }

export interface PipelineDepsOpts {
  workbench?: import('../../features/workbench').WorkbenchService
  /** 终端会话登记处(v76):手机 GET /m/api/cli/sessions 读它。缺省 ⇒ 503。 */
  cliSessions?: () => import('../../ports/cli-session').CliSessionView[]
  /** 「CC 做过的事」(B9):main 拼好来源,这里只透传给手机面板。 */
  activity?: import('../../features/phone').MobileActivityDeps
  /** 终端会话的手机动作(拍板 / 说一句):POST /m/api/cli/permission、/m/api/cli/say。缺省 ⇒ 503。 */
  cliActions?: import('../../features/terminal').CliPhoneActions
  /** 「今天」一眼看完(core/overseer-today.ts):手机 GET /m/api/today 读它。缺省 ⇒ 503。 */
  overseerToday?: () => import('../../domain/overseer-today').OverseerToday
  /** 「CC 现在怎么样」里「终端里的 Claude Code / Codex」那一行(2026-10-14)。缺省 ⇒ 那一行不出现。 */
  terminalHooks?: Pick<import('../../features/terminal').TerminalHooksService, 'capabilityInput'>
  /** 网络守护运行时(2026-10-02):微信入站闸门 + 每晚整理记忆的跳过判据。 */
  guardRuntime?: import('../guard/runtime').GuardRuntime
  /** 可选子系统的开机状态(SubsystemSupervisor.statuses;「CC 现在怎么样」用)。 */
  subsystems?: () => Array<{ name: string; state: 'ok' | 'degraded' | 'off'; error?: string }>
  /** 真回合里被拒着的执行者(provider-refusals.ts)。 */
  providerRefusals?: () => Record<string, import('../provider-refusals').ProviderRefusal>
  /** 内部 API 的 token-registry 窄接口,给手机设置面板登记链接 / 设备令牌(梳理第 6 步)。 */
  panelTokens?: import('../internal-api/token-registry').PanelTokens
  matters?: import('../../ports/matters').MatterStore
  stateDir: string
  db: import('../../lib/db').Db
  ilink: PipelineWechat
  boot: Bootstrap
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /**
   * Shared chat-prefs instance — constructed once in main.ts and also fed
   * to registerInternalApi's getChatPrefs, so the /set command and the
   * reply-route split logic read/write the SAME in-memory-cached store.
   */
  chatPrefs: ChatPrefsStore
  /**
   * Shared care-ledger instance — constructed once in main.ts, also fed to
   * pushTick (via WireMainOpts). The inbound activity middleware resets the
   * no-reply streak through this SAME store on every inbound message.
   */
  careLedger: CareLedger
  /**
   * Shared reply-sink registry (app-conversation-channel, voice arc Stage
   * 0, Task 1/2) — constructed once in main.ts, also fed to
   * registerInternalApi's `replySinks` so the `POST /v1/wechat/reply`
   * route captures into the SAME sink the converse closure below opens.
   * A second instance would never see the capture.
   */
  replySinks: ReplySinks
  /**
   * 桌宠信号(spec 2026-09-05-cc-desktop-pet §5.1)—— main.ts 里造的**同一个**
   * 实例(也传给 buildBootstrap)。这里写两笔:入站分发进门时的 noteTurnStart,
   * 和 companionConverse 的 noteContact / noteTurnStart。读的那一头是下面
   * 组装出来的 petTurn 闭包。
   */
  petSignals?: import('../pet-signals').PetSignals
  /** 打猎战利品(v36)。缺失 ⇒ 微信「背包」命令说功能没接。 */
  journal?: { list(limit?: number): readonly import('../../adapters/store/journal-store').CatchRow[] }
  /** Sticker library — 随身 CC 手机页展示 + 图片服务(main.ts 传入)。 */
  stickers?: import('../../features/stickers').StickerLib
  /** 触发 daemon 重启(远程访问开关切换后套用新隧道接线)。main.ts 传入。 */
  requestRestart?: (reason: string) => void
  /** LLM 体检只读缓存 —— 设置面板「模型与后端」的通/不通一列。main.ts 传入。 */
  llmHealth?: { cached(): import('../llm-health').LlmHealthReport | null }
  /** 对话回合(turn_records)—— 随身 CC 首屏的「聊天日摘要」来源。main.ts 传 turnRecordStore。 */
  turns?: { recent(limit: number): readonly { chatId: string; endedAt: number; outcome: string; mode: string; startedAt: number }[] }
  /** 三轴 presence 共用入口(internal-api lifecycle.getPresence)。main.ts 传入。 */
  presence?: () => Promise<import('../../domain/companion-presence').Presence | null>
  /** 微信文本命令(定时 / 日历 / 做过的事 / 经验 / 导入记忆 / 终端会话 …),main.ts 传入;和本文件的 command-router 一起组成 CommandRegistry(重构第二批步 2)。 */
  commands?: readonly import('../commands/registry').WechatCommand[]
}
