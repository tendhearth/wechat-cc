/**
 * 微信(ilink)那一侧的窄口(架构终态 A6,docs/architecture-end-state-2026-10-25.md)。
 *
 * 以前模块都 `needs: ['ilink-adapter']` 拿整个 `IlinkAdapter`,其实各自只用一两样。现在按用途分成下面几口,
 * ilink 模块(daemon/ilink/module.ts 里的 `ilink-adapter`)经容器的 `ports` 一口一个名字交出去:
 *
 *   wechat.send         发文字 / 文件、模拟编辑、群发、打字中、媒体镜像            WechatSend
 *   wechat.voice        语音合成 / 发语音 / 转文字与它们的配置                     WechatVoice
 *   wechat.companion    主动关心的开关(开 / 关 / 状态 / 免打扰 / 导入本机历史)       WechatCompanionControls
 *   wechat.accounts     chat ↔ 账号路由、context_token、最近活跃的 chat             WechatAccounts
 *   wechat.contacts     对方的称呼                                                   WechatContacts
 *   wechat.pages        分享页(sharePage / resurfacePage)                          WechatPages
 *   wechat.permissions  拍板卡与待批登记处(微信「y/n 码」、桌宠权限卡、自改共用一份)  WechatPermissions
 *   wechat.link         外发健康、主动推送窗口、会话过期状态                         WechatLinkStatus
 *   wechat.workbench    工作台的单次通知与成果上传 / 发送(带服务端确认)             WechatWorkbenchTransport
 *   wechat.polling      拉消息与关机前冲盘(只有 polling / ilink 两个生命周期用)     WechatPolling
 *
 * `IlinkAdapter`(daemon/ilink-glue.ts)就是这十口的并集,同一个对象;口只是收窄类型,运行时没有包一层。
 * 语音和开关两口是 adapter 上的子对象(`voice` / `companion`),它们的实现留在 `daemon/ilink/voice.ts`、
 * `daemon/ilink/companion.ts`:发语音要 ilink 的 context_token、账号路由和媒体上传,开关要最近活跃的 chat 和账号表。
 *
 * 守卫(scripts/ilink-ports.guard.test.ts):除了 ilink 自己与组装的地方,没有文件引 `IlinkAdapter`、没有人 `ctx.get('ilink-adapter')`。
 * 只有类型,没有逻辑。
 */
import type { SentMedia } from '../daemon/companion/media-mirror'
import type { OutboundHealth } from '../daemon/ilink/outbound-health'
import type { PendingPermissionMeta, PendingPermissionView, PermissionDecision } from '../daemon/pending-permissions'
import type { SessionStateStore } from '../adapters/store/session-state'
import type { ArtifactTransportOutcome, WorkbenchMediaItem, WorkbenchNoticeOutcome } from '../lib/ilink-workbench'

/** 容器里的口名(daemon/ilink/module.ts 的 `ilink-adapter` 模块交出)。 */
export const WECHAT_PORTS = {
  send: 'wechat.send',
  voice: 'wechat.voice',
  companion: 'wechat.companion',
  accounts: 'wechat.accounts',
  contacts: 'wechat.contacts',
  pages: 'wechat.pages',
  permissions: 'wechat.permissions',
  link: 'wechat.link',
  workbench: 'wechat.workbench',
  polling: 'wechat.polling',
} as const

/** 往微信发东西。 */
export interface WechatSend {
  sendMessage(chatId: string, text: string, metadata?: { source: 'workbench' }): Promise<{ msgId: string; error?: string }>
  /** `mirror: false` ⇒ 成功之后不报给媒体镜像(调用方自己记,如一封信的几页记成一行)。 */
  sendFile(chatId: string, path: string, opts?: { mirror?: boolean }): Promise<void>
  /** ilink 没有真的编辑:发一条带「(编辑后)」前缀的新消息。 */
  editMessage(chatId: string, msgId: string, text: string): Promise<void>
  broadcast(text: string, accountId?: string): Promise<{ ok: number; failed: number }>
  sendTyping(chatId: string, accountId?: string): Promise<void>
  /**
   * 发给某个 chat 的媒体(文件 / 表情 / 语音)成功之后报给谁(2026-10-18,companion/media-mirror.ts:主人那条记进
   * App 对话页读的消息库)。pipeline-deps 接一次;没接 ⇒ 不报。
   */
  onMediaSent?(fn: ((chatId: string, m: SentMedia | readonly SentMedia[]) => void) | null): void
  /** 路由自己报一样已经送出去的东西(联网表情存进表情库之后、信的几页一起)。没接 ⇒ 什么都不做。 */
  noteSentMedia?(chatId: string, m: SentMedia | readonly SentMedia[]): void
}

/**
 * 语音:合成、配置,以及绑着 ilink 的 replyVoice(合成 → 上传 → 发)。
 * internal-api 的 `reply_voice` 工具用 replyVoice,`voice_config_status` / `save_voice_config` 用另外几样。
 */
export interface WechatVoice {
  /** Returns {ok, msgId} or {ok:false, reason}. Generates audio, uploads via ilink, returns result. */
  replyVoice(chatId: string, text: string): Promise<
    | { ok: true; msgId: string }
    | { ok: false; reason: string }
  >
  /**
   * Synthesizes audio for arbitrary text using the daemon's voice config,
   * WITHOUT ilink-sending it anywhere (voice arc Stage 1 — POST
   * /v1/companion/speak hands the bytes back to the caller instead).
   * Throws `Error('no_voice_config')` when no voice config is saved yet;
   * propagates provider synth errors otherwise.
   */
  synthesizeSpeech(text: string): Promise<{ audio: Buffer; mime: string }>
  /** Validates input (test synth), then persists. Returns ok + tested_ms on success. */
  saveConfig(input: {
    provider: 'http_tts' | 'qwen'
    base_url?: string
    model?: string
    api_key?: string
    default_voice?: string
  }): Promise<
    | { ok: true; tested_ms: number; provider: string; default_voice: string }
    | { ok: false; reason: string; detail?: string }
  >
  /** Returns current config status (does NOT leak api_key). */
  configStatus():
    | { configured: false }
    | {
        configured: true
        provider: 'http_tts' | 'qwen'
        default_voice: string
        base_url?: string
        model?: string
        saved_at: string
      }
  /**
   * Transcribe an inbound audio clip via the gateway STT (voice arc Stage 2 —
   * POST /v1/companion/transcribe). Throws `Error('no_stt_config')` when no STT
   * config is saved yet; propagates provider errors otherwise. OPTIONAL: STT is
   * a capability the real voice adapter always provides, but a minimal/mock
   * voice dep may omit it — the routes treat its absence as not-wired.
   */
  transcribe?(audio: Buffer, mime: string): Promise<{ text: string }>
  /** Validates (test-transcribe), then persists the STT config. Optional (see `transcribe`). */
  saveSTTConfig?(input: { base_url?: string; model?: string; api_key?: string }): Promise<
    | { ok: true; tested_ms: number; base_url: string; model: string }
    | { ok: false; reason: string; detail?: string }
  >
  /** STT config status (does NOT leak api_key). Optional (see `transcribe`). */
  sttStatus?():
    | { configured: false }
    | { configured: true; provider: 'http_stt'; base_url: string; model: string; saved_at: string }
}

/** 主动关心的开关(改 companion 配置)。 */
export interface WechatCompanionControls {
  /** Turn on proactive tick. Idempotent. Scaffolds minimal config on first call. */
  enable(): Promise<
    | {
        ok: true
        state_dir: string
        welcome_message: string
        cost_estimate_note: string
      }
    | { ok: true; already_configured: true }
  >
  disable(): Promise<{ ok: true; enabled: false }>
  /** Minimal status: are proactive ticks on? snoozed until when? */
  status(): {
    enabled: boolean
    timezone: string
    default_chat_id: string | null
    snooze_until: string | null
    /** Whether auto-import of local claude/codex history is opted in. */
    import_local_history: boolean
  }
  snooze(minutes: number): Promise<{ ok: true; until: string }>
  /** Toggle auto-import of local claude/codex history. Returns the new state. */
  setImportLocal(enabled: boolean): Promise<{ ok: true; import_local_history: boolean }>
}

/** chat ↔ 账号路由与会话令牌(入站那一路写,发送那一路读)。 */
export interface WechatAccounts {
  /**
   * Resolve the ilink account bound to a chat (persisted routing, falling
   * back to the first configured account — mirrors the internal
   * resolveAccount() used by sendMessage/sendFile). Exposed for the
   * app-conversation-channel converse route, which synthesizes an InboundMsg
   * for the owner chat and needs a valid accountId to dispatch it through the coordinator.
   */
  resolveAccountId(chatId: string): string
  /** Account-routing without the lastActiveRef side effect — see
   *  TransportMethods.routeChatToAccount's doc comment (guest-path §2). */
  routeChatToAccount(chatId: string, accountId: string): void
  markChatActive(chatId: string, accountId?: string): void
  captureContextToken(chatId: string, ctxToken?: string): void
  lastActiveChatId(): string | null
}

/** 对方的称呼(存在 ConversationStore)。 */
export interface WechatContacts {
  setUserName(chatId: string, name: string): Promise<void>
  resolveUserName(chatId: string): string | undefined
}

/** 分享页。 */
export interface WechatPages {
  sharePage(title: string, content: string, opts?: { needs_approval?: boolean; chat_id?: string; account_id?: string }): Promise<{ url: string; slug: string }>
  resurfacePage(q: { slug?: string; title_fragment?: string }): Promise<{ url: string; slug: string } | null>
}

/** 拍板卡与待批登记处:微信「y/n 码」、桌宠权限卡、手机拍板、自改流水线共用同一份。 */
export interface WechatPermissions {
  /**
   * 发拍板卡到 chatId 并等 y/n。卡片没送到(errcode=-2 等)默认立刻 resolve 'undelivered'(没人能回,别死等);
   * `keepOnUndelivered` ⇒ 条目留在登记处等到点 —— 调用方另有面(手机 app 推送)能拍板时用。
   */
  askUser(chatId: string, prompt: string, hash: string, timeoutMs: number, opts?: { keepOnUndelivered?: boolean }): Promise<'allow' | 'deny' | 'timeout' | 'undelivered'>
  /**
   * 微信侧的「y/n <hash>」。`fromChatId` 是发这句话的 chat —— 条目带 meta 时
   * **只有当初被问的那个 chat** 能拍板。老条目(无 meta)保持原行为。
   */
  handlePermissionReply(text: string, fromChatId?: string, quoted?: string): boolean
  /** 只读版 handlePermissionReply:同样的判定,不 consume、不发消息。 */
  probePermissionReply(text: string, fromChatId?: string, quoted?: string): boolean
  /** Desktop pet permission queue (CC 桌宠 Phase B) — same registry as WeChat. */
  listPendingPermissions(): PendingPermissionView[]
  /** Resolve a pending permission from the desktop. = pending.consume(hash, decision). */
  resolvePermission(hash: string, decision: 'allow' | 'deny'): boolean
  /** 这条待批在微信里的两位数码(自改流水线要把它一起回给 CLI)。= pending.codeOf. */
  pendingPermissionCodeOf(hash: string): string | null
  /** 只登记一条待批,**不发卡**(外发不通时条目留着,主人换个面拍板)。= pending.register. */
  registerPendingPermission(hash: string, timeoutMs: number, meta: PendingPermissionMeta): Promise<PermissionDecision>
  /** 到点扫一遍待批(把过期的 resolve 成 timeout)。= pending.sweep. */
  sweepPendingPermissions(): void
}

/** 链路状态(只读):「CC 现在怎么样」、管家、终端会话推送用。 */
export interface WechatLinkStatus {
  /** Passive outbound link health (spec 2026-08-22-outbound-health). */
  outboundHealth(): OutboundHealth
  /**
   * 这个 chat 的主动推送窗口从什么时候起是关的(ilink errcode=-2:对方太久没说话);null = 没关。
   * 下一次发给它成功就清掉。
   */
  proactiveClosedSince(chatId: string): string | null
  /** Session state accessor for admin commands (/health, cleanup). */
  sessionState: SessionStateStore
}

/** 工作台的外发:每一下都是单次尝试、带服务端确认(重试由工作台自己的队列管)。 */
export interface WechatWorkbenchTransport {
  /** Strict persisted-route lookup for workbench notifications; never falls back. */
  chatAccountId?(chatId: string): string | null
  /** Single-attempt task text delivery with explicit server acknowledgement. */
  sendWorkbenchNotice?(notice: {
    id: string
    taskId: string
    runId: string
    ownerChatId: string
    accountId: string
    text: string
  }, signal?: AbortSignal): Promise<WorkbenchNoticeOutcome>
  uploadWorkbenchArtifact?(request: { id: string; ownerChatId: string; accountId: string; bytes: Uint8Array; name: string; mime: string }, signal?: AbortSignal): Promise<{ status: 'uploaded'; item: WorkbenchMediaItem } | { status: 'retryable' | 'blocked'; reason: string }>
  sendWorkbenchArtifact?(receipt: { id: string; taskId: string; artifactId: string; artifactSha256: string; ownerChatId: string; accountId: string; name: string }, item: WorkbenchMediaItem, signal?: AbortSignal): Promise<ArtifactTransportOutcome>
}

/** 拉消息(polling 生命周期)与关机前冲盘(ilink 生命周期)。 */
export interface WechatPolling {
  /**
   * Long-poll wrapper for poll-loop. Detects errcode=-14 session timeout and
   * flips SessionStateStore + returns { expired: true } so the loop stops.
   */
  getUpdatesForLoop(accountId: string, baseUrl: string, token: string, syncBuf: string, signal?: AbortSignal): Promise<{
    updates?: unknown[]
    sync_buf?: string
    expired?: boolean
    standby?: boolean
    /** Client-side long-poll timeout — see GetUpdatesResp.timed_out. */
    timed_out?: boolean
  }>
  flush(): Promise<void>
}
