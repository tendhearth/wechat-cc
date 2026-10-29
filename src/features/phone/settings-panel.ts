/**
 * settings-panel.ts — the WeChat-openable graphical settings page
 * (2026-08-25, owner: 微信用户不会背命令,前期一个设置面板能非常好地帮助他们).
 *
 * Shape: a tiny LAN-bound HTTP server inside the daemon. The owner asks for
 * 设置 in WeChat → the daemon mints a ONE-ACTIVE, 10-minute token and replies
 * with `http://<mac-lan-ip>:<port>/set?t=…`; tapping it opens a warm-paper
 * settings page in WeChat's built-in browser.
 *
 * Security posture:
 *  - the server starts LAZILY on first link request; before that, nothing
 *    listens. Once up, EVERY endpoint requires the current token — an idle
 *    panel is a wall of 401s.
 *  - one active token at a time (reissue revokes), TTL 10 min.
 *  - writes go through the same guarded primitives as everything else:
 *    normalizeUserName, chat-prefs store, config-surface's writable
 *    whitelist (further narrowed to PANEL_CONFIG_KEYS) with the standard
 *    config_changed audit.
 *  - dangerous / flow-shaped operations (provider switch, guest approval,
 *    pairing, restore, restart) are deliberately NOT here — they stay
 *    conversational where CC can confirm context.
 */
import { RESTORE_NOTE } from '../memory'
import { executorNames } from '../../domain/provider-display-names'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { normalizeUserName } from '../../lib/user-name'
import { writeConfigKey, readConfigSurface } from '../../daemon/config-surface'
import { kickAtelierModelProvision, readModelStatus, shouldProvisionOnConfigChange } from '../atelier'
import { makePortraitPng, type PortraitRender } from '../../daemon/portrait-png'
import { safeSvgFile, EXPIRED_HTML, SW_JS, M_BOOTSTRAP_HTML, pageHtml, phoneHtml } from './settings-panel-html'
import { loadAgentConfig, saveAgentConfig, modelForProvider } from '../../lib/agent-config'
import { saveLlmKey } from '../../daemon/llm-keys'
import { PROVIDER_SETUP_HINTS, type LlmHealthReport } from '../../daemon/llm-health'
import { capabilitiesFor } from '../../domain/capability-matrix'
import { providerDenialFor } from '../../domain/provider-policy'
import { PROVIDER_IDS } from '../../lib/provider-ids'
import { buildFeed, FEED_DEFAULT_LIMIT, dayKey, type FeedSources, type TurnLite } from './mobile-feed'
import presenceArt from './mobile-presence-art.json'
import { MOBILE_BRAND_ICON_PNG, MOBILE_BRAND_ICON_SIZES } from './mobile-brand-icon'
import { mobileChatRoutes, type MobileChatDeps } from './mobile-chat'
import { mobileActivityRoutes } from './mobile-activity'
import { mobileReadsRoutes } from './mobile-reads'
import { combinePhoneRoutes, ownsMethod, routePhone, type PhoneHandler, type PhoneRouteTable } from './phone-route-table'
import {mobileSessionContinueRoutes,mobileWorkbenchRoutes,mobileMatterError,mobileSayInput,type MobileMatterActions,type MobileEntryActions,type MobileUploadActions,type MobileSessionContinueActions} from './mobile-workbench'
import {mobileMatterDetailResponse} from './mobile-matter-response'
import {mobileHomeFocus} from './mobile-home-focus'
import type {MatterSayInput} from '../../app/matters/service'
import { pairCheckCode, PushPlatform, PHONE_SAY_MAX_CHARS, pushTokenValid, type PushPlatformT } from '@wechat-cc/protocol'
import type { Presence } from '../../domain/companion-presence'
import type { CatchRow } from '../../adapters/store/journal-store'
import type { PlanLogEntry } from '../../domain/companion-plan'

export const SETTINGS_LINK_TTL_MS = 10 * 60_000

/** Config-surface keys the panel may show/write (surface whitelist ∩ panel). */
export const PANEL_CONFIG_KEYS: readonly string[] = [
  'bot_name', 'model', 'knowledge_enabled', 'social_enabled', 'autoStart',
  'companion.atelier_mode',
  // 「模型与后端」一块(2026-09-08):各家模型、/api 地址、后台评估用哪家。
  'openaiModel', 'openaiBaseUrl', 'agyModel', 'cursorModel', 'geminiModel', 'cheap_eval_provider', 'trusted_providers',
  'provider',
]

/** 面板「模型与后端」表格覆盖的六家,顺序即显示顺序。 */
const PANEL_PROVIDERS = PROVIDER_IDS
const ALIAS_RE = /^[A-Za-z0-9._-]{1,32}$/
const MODEL_NAME_RE = /^[A-Za-z0-9._/:-]{1,100}$/

const PREF_KEYS = new Set(['split', 'care', 'stickers', 'hunt'])
const PERSONA_MAX_CHARS = 8000

/** 客户端生成的评论 id / 投递 id(同 internal-api 的 REQUEST_ID)。 */
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

export interface SettingsPanelDeps {
  stateDir: string
  ownerChatId: () => string | null
  entry?:MobileEntryActions
  uploads?:MobileUploadActions
  chatPrefs: {
    get(chatId: string): Record<string, unknown>
    set(chatId: string, patch: Record<string, unknown>): Record<string, unknown>
  }
  getUserName: (chatId: string) => string | null
  setUserName: (chatId: string, name: string) => Promise<void>
  /** 随身 CC 数据面(待办) — 注入 facts + 联系人显示名。缺省 ⇒ 手机页无待办区。 */
  todos?: {
    facts: {
      findFacts(kind: string | null, predicate: string | null, query: string | null, status: string | null, limit: number | null): object
      setFactStatus(id: number, status: string, now: number): object
    }
    names: () => Array<{ username: string; display: string }>
  }
  /** 表情库(只读展示 + 图片文件服务)。 */
  stickers?: { list(): Array<{ file: string; tags: string[]; desc?: string }>; dir: string }
  /** 「CC 画的你」SVG → base64 PNG(给原生 App,收敛清单 ④)。测试注入;默认 macOS qlmanage(portrait-png.ts)。 */
  portraitRender?: PortraitRender
  /**
   * 随身 CC 首屏「伙伴的一天」的三个来源(spec 2026-09-06-mobile-home-feed §5.4)。
   * 缺省 ⇒ /m/api/home 三项 sources_degraded。IO 全在这里,mobile-feed.ts 是纯函数。
   */
  feed?: {
    journal: { list(limit?: number): readonly CatchRow[] }
    planLogDays: (days: number) => readonly PlanLogEntry[]
    turnsRecent: (limit: number) => readonly TurnLite[]
    timezone: () => string
  }
  /** 三轴 presence,经 internal-api lifecycle.getPresence 共用。缺省/抛 ⇒ 手机页显示「不知道」。 */
  presence?: () => Promise<Presence | null>
  /** 手机洞察(批准说明 + 进展概括,spec 2026-09-30-tendhearth-app-v1 §5)。缺省 ⇒ /m/api/matter/insight 503。 */
  insight?: import('./phone-insight').PhoneInsight
  /** 手机看改动(§5.3):一件事的复盘轮次(工作台 reviewList);未知任务应抛。缺省 ⇒ /m/api/matter/changes 503。 */
  changes?: (id: string) => readonly import('./phone-changes').ReviewTurnLike[]
  /** 手机逐文件审阅(2026-10-17):同桌面 review-mark / review-return。缺省 ⇒ 两条路由 503。 */
  review?: {
    mark(id: string, input: { artifactId: string; path: string; mark: 'accepted' | 'returned' }): unknown
    ret(id: string, input: { artifactId: string; paths: string[]; comment: string }): unknown
    /** 行评论(切片 4):手机只建整块评论 / 删草稿。缺省 ⇒ review-comment 503。 */
    comment?(id: string, input: { commentId: string; artifactId: string; path: string; hunk: number; hunkSha256: string; body: string } | { commentId: string; delete: true }): unknown
    /** 发出这件事所有草稿;回 sent / remaining / skippedDiscarded(回执与任务视图不给手机)。缺省 ⇒ 503。 */
    sendComments?(id: string, input: { summary?: string; inputRequestId?: string }): unknown
  }
  /** 「一件事」(2026-09-16):手机看同一份 matter 列表 / 详情,并能往里说话。seenOnPhone 记「在手机露过面」。 */
  matters?: MobileMatterActions & {
    list(filter: { kind?: 'chat' | 'task' | 'companion'; statuses?: Array<'open' | 'replied' | 'done' | 'archived'>; limit?: number }): unknown[]
    detail(id: string): Promise<unknown> | unknown
    say(id: string, text: string, input?:MatterSayInput): Promise<unknown>
    seenOnPhone(id: string): void
  }
  /** 跟 CC 说(spec 2026-10-01):主人对话一页 + 说一句。缺省 ⇒ /m/api/chat* 503。 */
  chat?: MobileChatDeps
  /**
   * 别的功能交来的 `/m/api/*` 处理器(架构终态 A5 · 手机):处理器归那个功能,表从它的 index.ts 导出,组装的地方
   * (wiring/wire-settings-panel.ts)填进来 —— 面板不 import 别的功能。现在是信(`/m/api/letters*`)和定时(`/m/api/jobs*`)。
   * 路由表里登记了、这里没交 ⇒ 查不到(404);生产里组装的地方总会交(功能自己的 deps 缺了由它的处理器回 503)。
   */
  featureRoutes?: ReadonlyArray<PhoneRouteTable<unknown>>
  /** 「CC 做过的事」(B9):只给设备令牌。 */
  activity?: import('./mobile-activity').MobileActivityDeps
  /** 「CC 的连接」快照(spec 2026-10-01)。缺省 ⇒ /m/api/connections 503。 */
  connections?: () => import('../../daemon/connections').ConnectionsSnapshot
  /** 电脑上的原生会话(只读)。缺省 ⇒ /m/api/sessions 503。 */
  sessions?: import('./mobile-reads').MobileSessionsDeps
  /** 终端会话登记处(v76,只读)。缺省 ⇒ /m/api/cli/sessions 503。 */
  cliSessions?: () => import('../../ports/cli-session').CliSessionView[]
  /** 终端会话:拍板等批准的那一项、接着说一句(features/terminal/phone-actions.ts)。缺省 ⇒ /m/api/cli/permission、/m/api/cli/say 503,列表不带码。 */
  cliActions?: import('../terminal').CliPhoneActions
  /** 「今天」一眼看完(core/overseer-today.ts,只读)。缺省 ⇒ /m/api/today 503。 */
  overseerToday?: () => import('../../domain/overseer-today').OverseerToday
  /** 在手机上接着做电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions)。缺省 ⇒ /m/api/session/continue 503。 */
  sessionContinue?: MobileSessionContinueActions
  /** 执行者 id → 正式名字(收敛清单 ⑥,接 registry.namesOf(id).name)。缺省 ⇒ 会话 / 终端行不带 displayName,App 退回 id。 */
  executorName?: (id: string) => string
  /** 主人「看到哪了」的水位,与桌面觅食台同一个文件(一个主人一个水位)。缺省 ⇒ POST /m/api/seen 503。 */
  seen?: { read: () => string | null; write: (iso: string) => void }
  /** 推送(中继 v2,spec 2026-09-30 §5)。缺省 ⇒ /m/api/push/* 503。按设备 id,不是令牌。 */
  push?: {
    register(deviceId: string, platform: PushPlatformT, token: string): boolean
    test(deviceId: string): Promise<{ ok: boolean; code: string }>
    unregister(deviceId: string): void
    forgetAll(): void
  }
  /** 手机「CC 记得你」(2026-09-25,memory/nightly-runtime)。 */
  curatedMemory?: () => import('../memory').CuratedView
  /** 主人逐条纠错(2026-10-06):不对 / 过时 / 删掉。没接 ⇒ 503。 */
  correctMemory?: (id: string, verdict: import('../memory').MemoryVerdict) => Promise<{ text: string }>
  /** 收回的话与恢复(架构终态 G6):列表、恢复一条(null = 不在了)。 */
  memoryRetractions?: () => Array<{ key: string; section: string | null; text: string; day: string | null; verdict: string | null; note: string }>
  restoreMemory?: (key: string) => Promise<{ restored: string[] } | null>
  /** 远程隧道信息(启用时):relay wss + 本机 daemon id。手机页出门时用它
   *  经中继访问。缺省 ⇒ 手机页只能在同一 Wi-Fi 直连。 */
  remoteInfo?: () => { relay: string; id: string } | null
  /** agent-config.json 的 relay_v2_url 现在非空吗(桌面「连接手机」用;只读,主人事项)。缺省 ⇒ 当没开通。 */
  relayV2Configured?: () => boolean
  /** 这次启动时配置就要连中继吗(remote_tunnel 开 + relay_v2_url 非空;开机快照,wire-settings-panel 传入)。
   *  为 true 而运行中没有中继 = v2 身份坏了(relay-identity.json 读不出等),重启也换不来 ⇒ 不重启,直接
   *  relay_unavailable(否则每个新进程都会再重启一次,成了重启循环)。缺省 ⇒ false(当开机时没配)。 */
  remoteAtBoot?: boolean
  /** 远程访问一键开关(2026-08-26):读/写 remote_tunnel + 触发重启。
   *  缺省 ⇒ 设置页不显示远程访问开关。 */
  remote?: {
    isEnabled: () => boolean
    setEnabled: (on: boolean) => void
    requestRestart: () => void
  }
  /**
   * 「模型与后端」的数据源:哪些 provider 注册了、上次体检结果(只读缓存,
   * 面板绝不主动外呼)、key 配了没(只回 boolean)。缺省 ⇒ 表格只显示模型字段。
   */
  llm?: {
    registered: () => string[]
    cached: () => LlmHealthReport | null
    hasKey: (provider: 'openai' | 'gemini') => boolean
  }
  /** 改了要重启才生效的键(provider)写完后触发 daemon 重启。缺省 ⇒ 只写不重启,回复里说明。 */
  requestRestart?: (reason: string) => void
  /** config_changed audit sink (events store append) — best-effort. */
  audit?: (reasoning: string) => void
  log: (tag: string, line: string) => void
  now?: () => number
  /**
   * 内部 API 的 token-registry 窄接口(梳理第 6 步):链接令牌与设备令牌登记在这里,
   * 带 origin / routeAllow,撤销走 invalidateSession。缺省 ⇒ 面板自建一个(测试用)。
   */
  tokens?: PanelTokens
}

export interface SettingsPanel {
  issueToken(): string
  validToken(t: string | null | undefined): boolean
  /** 当前还有效的链接令牌(没有或已过期就 null)—— 隧道只额外认这一个。 */
  activeLinkToken(): string | null
  /** 已配对设备的令牌 —— 隧道握手要逐个试(替代裸读 settings-devices.json)。 */
  deviceTokens(): string[]
  /** `currentToken`:调用者自己的令牌,用来在设备列表里标「这台」。 */
  state(currentToken?: string | null): object
  apply(op: unknown): Promise<{ ok: boolean; error?: string; restart?: 'requested' | 'required' }>
  /** Start the HTTP server (idempotent). port 0 = ephemeral. */
  start(port?: number): Promise<{ port: number }>
  stop(): Promise<void>
  /** Mint a fresh token and return the tappable URL (starts the server on
   *  first use). Null when no LAN address / no owner is resolvable. */
  linkUrl(): Promise<string | null>
  /** 桌面「连接手机」(spec 2026-10-01-tendhearth-pairing-ux §4.1):按需打开远程隧道;只在 v2 中继就绪时铸码。 */
  phoneLink(opts: { enableRemote: boolean }): Promise<PhoneLinkResult>
  /** 已配对设备(不含令牌),桌面轮询「已连上」用。 */
  phoneDevices(): DeviceRow[]
  /** Route one request — shared by the LAN Bun.serve and the remote tunnel
   *  client, so /m/* and /set/* behave identically over both transports. */
  handleRequest(req: Request): Promise<Response>
  /** 处理器表里的键("METHOD /path"),scripts/phone-routes.guard.test.ts 对着路由表核对用。 */
  routeKeys(): string[]
  /** `/m/api/home` 的载荷,不经 HTTP(手机事件集线器的 `home` 主题用)。`work: false` 跳过「手头这件事」。 */
  home(limit: number, opts?: { work?: boolean }): Promise<HomePayload>
}

/** `/m/api/home` 的回包形状。 */
export interface HomePayload {
  ok: true
  synced_at: string
  today: string
  presence: Presence | null
  work?: Awaited<ReturnType<typeof mobileHomeFocus>>
  presence_error?: 'unavailable'
  unread: number
  seen_until: string | null
  events: ReturnType<typeof buildFeed>['events']
  next_cursor: ReturnType<typeof buildFeed>['next_cursor']
  sources_degraded: ReturnType<typeof buildFeed>['sources_degraded']
}

/** First non-internal IPv4 address (en0 preferred). Re-exported from
 *  lib/local-address —— 「本机对外该报哪个地址」现在只有那一处判定
 *  (配手的 `hand invite` 也要用它)。 */
export { lanIp } from '../../lib/local-address'
import { lanIp } from '../../lib/local-address'
import { serve, type Server } from '../../lib/runtime/http'
import { makeTokenRegistry, type PanelTokens } from '../../daemon/internal-api/token-registry'
import { makeDeviceCredentials, makeDeviceStore, type DeviceRow } from './device-store'
import { normalizeLang } from './phone-insight-llm'
import { latestChanges } from './phone-changes'
import { LAN_ONLY_OPS, LINK_ROUTES, PHONE_ROUTES, phoneRouteAllowed } from './phone-routes'
import { phoneClientOf, withPhoneClient } from './phone-client'
import { phoneLinkState, psetUrl, type PhoneLinkResult } from './phone-link'

/**
 * 手机能不能看这件 matter:聊天 matter 只给主人自己的(别人的聊天 —— 访客、朋友 —— 不到手机)。
 * 列表筛选和按 id 打开(详情 / 解读)共用这一条,免得两条路漂开:列表藏住了,按 id 却能读出最近 50 条。
 */
export function phoneMayOpenMatter(matter: unknown, owner: string | null): boolean {
  const m = (matter ?? {}) as { kind?: unknown; ownerChatId?: unknown }
  return m.kind !== 'chat' || (owner !== null && m.ownerChatId === owner)
}

/** 回复附带的旁白 / 语音文字 / 附件名和消息 id 只给已配对设备(和信、chat/file 一样);10 分钟的链接令牌只看正文。 */
function withoutReplyExtras<T>(detail: T): T {
  const events = (detail as { events?: unknown } | null)?.events
  if (!Array.isArray(events)) return detail
  return { ...detail, events: events.map(e => {
    if (!e || typeof e !== 'object') return e
    const { replyExtras: _x, messageId: _m, ...rest } = e as Record<string, unknown>
    return rest
  }) }
}

export function makeSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const now = deps.now ?? (() => Date.now())
  let server: Server | null = null
  let remoteRestartRequested = false

  // 令牌都在内部 API 的 token-registry 里(梳理第 6 步):链接令牌 origin 'link'、
  // 10 分钟;长期设备令牌(随身 CC 配对)origin 'device'、永不过期但可按台撤销。
  // 设备的落盘与注册表同步只在 device-store.ts 的 makeDeviceCredentials 一处。
  const tokens: PanelTokens = deps.tokens ?? makeTokenRegistry(undefined, now)
  const devices = makeDeviceCredentials({ store: makeDeviceStore(deps.stateDir, now), tokens, routeAllow: PHONE_ROUTES })
  devices.bootRegister()
  const portraitPng = makePortraitPng({ stateDir: deps.stateDir, ...(deps.portraitRender ? { render: deps.portraitRender } : {}) })
  /** 只认面板自己的两种令牌 —— 共享注册表后 session / file / operator 也能 resolve,必须挡住。 */
  const panelToken = (t: string | null | undefined) => {
    if (!t) return null
    const info = tokens.resolve(t)
    return info && (info.origin === 'device' || info.origin === 'link') ? info : null
  }
  const deviceIdOfSession = (sessionKey: string | undefined) =>
    sessionKey?.startsWith('device:') ? sessionKey.slice('device:'.length) : null
  const deviceList = (currentToken: string | null | undefined): Array<DeviceRow & { current: boolean }> => {
    const mine = deviceIdOfSession(panelToken(currentToken)?.sessionKey)
    return devices.list().map(d => ({ ...d, current: d.id === mine }))
  }

  const personaPath = (): string | null => {
    const owner = deps.ownerChatId()
    if (!owner || owner.includes('..') || owner.includes('/') || owner.includes('\\')) return null
    return join(deps.stateDir, 'memory', owner, 'persona.md')
  }

  /** 「模型与后端」:六家一行(注册/体检/模型),openai 的地址·key·别名,后台评估用谁。 */
  const modelsState = () => {
    const cfg = loadAgentConfig(deps.stateDir)
    const registered = new Set(deps.llm?.registered() ?? [])
    const report = deps.llm?.cached() ?? null
    const probe = new Map((report?.results ?? []).map(r => [r.provider, r]))
    const providers = PANEL_PROVIDERS.map(id => {
      const isReg = registered.has(id)
      const pr = probe.get(id)
      const status = !isReg ? 'unconfigured' : pr == null ? 'unknown' : pr.ok === true ? 'ok' : pr.ok === false ? 'broken' : 'unknown'
      return {
        id,
        // 设置页要分清「怎么连的」⇒ 用 settings 那种写法(收敛清单 ⑥;页面不再自带名字表)
        name: executorNames(id, [...registered]).settings,
        registered: isReg,
        model: modelForProvider(cfg, id) ?? null,
        status,
        ...(pr?.error ? { error: pr.error.slice(0, 160) } : {}),
        ...(!isReg && PROVIDER_SETUP_HINTS[id] ? { hint: PROVIDER_SETUP_HINTS[id] } : {}),
        ...(pr?.latency_ms != null ? { latency_ms: pr.latency_ms } : {}),
      }
    })
    return {
      default_provider: cfg.provider,
      checked_at: report?.checked_at ?? null,
      providers,
      openai: {
        base_url: cfg.openaiBaseUrl ?? '',
        model: cfg.openaiModel ?? '',
        has_key: deps.llm?.hasKey('openai') ?? false,
        aliases: cfg.openaiAliases ?? {},
      },
      gemini: { has_key: deps.llm?.hasKey('gemini') ?? false },
      cheap: cfg.cheapEvalProvider ?? 'auto',
      // 非管理员可用哪些(null = 全部)。两张单子不是一回事:
      //  - shared_token:共享一把 trusted 钥匙(adminMcpTools=false)⇒ 面板上的 🔑 徽章;
      //  - guest_blocked:guest 一律拒的(共享钥匙的 + 约束不住自己工具面的 —— 能力表 confines 里有一件收不住,
      //    如走 ACP 的 cursor)⇒ 面板上"访客不可用"那句。cursor 不是共享钥匙,所以没有 🔑,
      //    但访客照样用不了 —— 两条规矩(core/provider-policy.ts)对得上。
      trusted_providers: cfg.trusted_providers ?? null,
      shared_token: PANEL_PROVIDERS.filter(id => { try { return !capabilitiesFor(id).adminMcpTools } catch { return false } }),
      // 从 providerDenialFor 推出来,不另抄一遍规矩:面板说的和分派时真挡的永远是同一个判断。
      guest_blocked: PANEL_PROVIDERS.filter(id => providerDenialFor(id, 'guest', undefined) !== null),
    }
  }

  const FEED_WINDOW_DAYS = 14
  const FEED_JOURNAL_LIMIT = 200
  const FEED_TURNS_LIMIT = 2000

  /** 三源各自 try;哪个抛就记 null(buildFeed 会翻译成 sources_degraded)。 */
  const collectSources = (): FeedSources => {
    const f = deps.feed
    if (!f) return { journal: null, thoughts: null, turns: null }
    const since = now() - FEED_WINDOW_DAYS * 86_400_000
    let journal: FeedSources['journal'] = null
    let thoughts: FeedSources['thoughts'] = null
    let turns: FeedSources['turns'] = null
    try { journal = f.journal.list(FEED_JOURNAL_LIMIT) } catch (e) { deps.log('SETTINGS', `feed journal 读不到: ${e instanceof Error ? e.message : e}`) }
    try { thoughts = f.planLogDays(FEED_WINDOW_DAYS) } catch (e) { deps.log('SETTINGS', `feed plan-log 读不到: ${e instanceof Error ? e.message : e}`) }
    try { turns = f.turnsRecent(FEED_TURNS_LIMIT).filter(t => t.endedAt >= since) } catch (e) { deps.log('SETTINGS', `feed turns 读不到: ${e instanceof Error ? e.message : e}`) }
    return { journal, thoughts, turns }
  }
  const feedTimezone = (): string => { try { return deps.feed?.timezone() || 'UTC' } catch { return 'UTC' } }
  const readSeen = (): string | null => { try { return deps.seen?.read() ?? null } catch { return null } }
  const parseLimit = (url: URL): number => {
    const n = Number(url.searchParams.get('limit'))
    return Number.isFinite(n) && n > 0 ? n : FEED_DEFAULT_LIMIT
  }

  // 随身 CC 首页数据:待办(活跃+最近了结,带显示名)、小像、表情库。
  const phoneState = (): { portrait: string | null } & Record<string, unknown> => {
    const owner = deps.ownerChatId()
    const names = new Map((deps.todos?.names() ?? []).map(c => [c.username, c.display]))
    const deco = (rows: Array<{ contact: string } & Record<string, unknown>>) =>
      rows.map(r => ({ ...r, display: names.get(r.contact) ?? r.contact }))
    const active = deps.todos
      ? deco(((deps.todos.facts.findFacts('obligation', null, null, 'active', 200) as { results?: never[] }).results ?? []))
      : []
    const settledAll = deps.todos
      ? deco(((deps.todos.facts.findFacts('obligation', null, null, 'resolved', 100) as { results?: never[] }).results ?? []))
      : []
    const cutoff = Math.floor(now() / 1000) - 7 * 86400
    const settled = settledAll.filter(r => {
      const u = (r as unknown as { updated_at?: number }).updated_at
      return typeof u === 'number' && u > cutoff
    }).slice(0, 20)
    let portrait: string | null = null
    if (owner) {
      const pp = join(deps.stateDir, 'memory', owner, 'portrait.svg')
      if (existsSync(pp)) portrait = safeSvgFile(pp)
    }
    return {
      ok: true,
      name: owner ? deps.getUserName(owner) ?? '' : '',
      todos: { active, settled },
      portrait,
      stickers: deps.stickers?.list() ?? [],
    }
  }

  /**
   * `/m/api/home` 的载荷(手机协议 v2 第 11 步抽出来):路由与手机事件集线器的 `home` 主题
   * 共用这一个构建函数,不经 HTTP。`work: false` 跳过「手头这件事」(要逐个读任务详情,
   * 集线器每 2 s 轮询一次时不该付这个钱;主题只取未读 / CC 状态 / 最新动态游标)。
   */
  const home = async (limit: number, opts: { work?: boolean } = {}): Promise<HomePayload> => {
    let presence: Presence | null = null
    let presenceFailed = false
    try { presence = (await deps.presence?.()) ?? null } catch (e) { presenceFailed = true; deps.log('SETTINGS', `presence 读不到: ${e instanceof Error ? e.message : e}`) }
    const tz = feedTimezone()
    const seenUntil = readSeen()
    const r = buildFeed(collectSources(), { ownerChatId: deps.ownerChatId(), timezone: tz, limit, seenUntil })
    return {
      ok: true,
      synced_at: new Date(now()).toISOString(),
      today: dayKey(now(), tz),
      presence,
      ...(opts.work === false ? {} : { work: await mobileHomeFocus(deps.matters) }),
      ...(presenceFailed ? { presence_error: 'unavailable' as const } : {}),
      unread: r.unread,
      seen_until: seenUntil,
      events: r.events,
      next_cursor: r.next_cursor,
      sources_degraded: r.sources_degraded,
    }
  }

  const json = (body: object, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

  // Shared router — the LAN Bun.serve and the remote tunnel client both call
  // this, so /m/* and /set/* behave identically over both transports.
  const handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const t = url.searchParams.get('d') ?? url.searchParams.get('t')
    // 原生 App(中继 v2 帧)还是浏览器(直连 / v1 隧道):只看传输,见 phone-client.ts。下游建一件事时取它当出生地。
    return await withPhoneClient(phoneClientOf(req), () => routeRequest(url, t, req))
  }

  const panel: SettingsPanel = {
    issueToken() {
      // 't' 前缀:手机页按首字母 'd' 认长期设备令牌,裸 hex 有 1/16 会被误认。
      // 同一时刻只一枚:发新的之前撤掉旧的。
      tokens.invalidateSession('link')
      const token = 't' + randomBytes(16).toString('hex')
      tokens.register(token, { tier: 'admin', origin: 'link', sessionKey: 'link', routeAllow: LINK_ROUTES, ttlMs: SETTINGS_LINK_TTL_MS })
      return token
    },

    activeLinkToken() {
      return tokens.listSessions('link')[0]?.token ?? null
    },

    deviceTokens() {
      return devices.tokens()
    },

    validToken(t) {
      return panelToken(t) !== null
    },

    state(currentToken) {
      const owner = deps.ownerChatId()
      if (!owner) return { ok: false, error: 'no_owner' }
      const pp = personaPath()
      const persona = pp && existsSync(pp) ? readFileSync(pp, 'utf8') : ''
      const config: Record<string, string | boolean | number | null> = {}
      for (const row of readConfigSurface(deps.stateDir)) {
        if (PANEL_CONFIG_KEYS.includes(row.key)) config[row.key] = row.value
      }
      return {
        ok: true,
        name: deps.getUserName(owner) ?? '',
        persona,
        prefs: deps.chatPrefs.get(owner),
        config,
        remote: deps.remote
          ? { available: true, enabled: deps.remote.isEnabled(), devices: deviceList(currentToken) }
          : { available: false, enabled: false, devices: [] },
        // Paint-set download progress so the phone can show "已开始 / 62%" right
        // after the owner flips the switch; the download itself runs on the Mac.
        atelier: { model_status: readModelStatus(deps.stateDir) },
        models: modelsState(),
      }
    },

    async apply(raw) {
      const owner = deps.ownerChatId()
      if (!owner) return { ok: false, error: 'no_owner' }
      const b = (raw ?? {}) as Record<string, unknown>
      try {
        if (b.op === 'set_name') {
          const name = typeof b.name === 'string' ? normalizeUserName(b.name).trim() : ''
          if (!name || name.length > 32) return { ok: false, error: 'invalid_name' }
          await deps.setUserName(owner, name)
          return { ok: true }
        }
        if (b.op === 'set_persona') {
          const content = typeof b.content === 'string' ? b.content : null
          if (content === null || content.length > PERSONA_MAX_CHARS) return { ok: false, error: 'invalid_persona' }
          const pp = personaPath()
          if (!pp) return { ok: false, error: 'no_owner' }
          mkdirSync(join(pp, '..'), { recursive: true })
          writeFileSync(pp, content)
          return { ok: true }
        }
        if (b.op === 'set_pref') {
          const key = typeof b.key === 'string' ? b.key : ''
          if (!PREF_KEYS.has(key)) return { ok: false, error: 'unknown_pref' }
          if (key === 'care') {
            if (b.value !== 'off' && b.value !== 'low' && b.value !== 'high') return { ok: false, error: 'invalid_value' }
          } else if (typeof b.value !== 'boolean') {
            return { ok: false, error: 'invalid_value' }
          }
          deps.chatPrefs.set(owner, { [key]: b.value })
          return { ok: true }
        }
        if (b.op === 'forget_devices') {
          // 安全 review HIGH 收尾 (2026-08-26):设备令牌长期有效是产品决策
          // (加主屏永不过期),但必须可撤销。一键全忘,手机重新配对即可。
          devices.forgetAll()
          deps.push?.forgetAll()
          deps.audit?.('随身 CC:忘掉所有已配对设备 — 设置面板')
          return { ok: true }
        }
        if (b.op === 'revoke_device') {
          // 按台撤销(梳理第 6 步):丢了一台手机不必让所有设备重新配对。
          if (typeof b.id !== 'string' || !devices.revoke(b.id)) return { ok: false, error: 'unknown_device' }
          deps.push?.unregister(b.id)
          deps.audit?.(`随身 CC:忘掉设备 ${b.id} — 设置面板`)
          return { ok: true }
        }
        if (b.op === 'label_device') {
          if (typeof b.id !== 'string' || typeof b.label !== 'string' || !devices.label(b.id, b.label)) return { ok: false, error: 'invalid_value' }
          return { ok: true }
        }
        if (b.op === 'set_remote') {
          if (typeof b.enabled !== 'boolean') return { ok: false, error: 'invalid_value' }
          if (!deps.remote) return { ok: false, error: 'remote_not_wired' }
          deps.remote.setEnabled(b.enabled)
          deps.audit?.(`remote_tunnel: → ${b.enabled} — 设置面板`)
          // Restart applies the new tunnel wiring (dials out / stops).
          deps.remote.requestRestart()
          return { ok: true }
        }
        if (b.op === 'set_llm_key') {
          // key 只进 daemon.env,不进日志、不进 audit 正文、不回显。
          const r = await saveLlmKey(deps.stateDir, b, deps.log)
          if (!r.ok) return { ok: false, error: r.error }
          deps.audit?.(`llm key(${String(b.provider)}) 已保存 — 设置面板(值不记录);重启后生效`)
          return { ok: true }
        }
        if (b.op === 'set_alias' || b.op === 'del_alias') {
          const alias = typeof b.alias === 'string' ? b.alias.trim() : ''
          if (!ALIAS_RE.test(alias) || /^(list|alias|unalias)$/i.test(alias)) return { ok: false, error: 'invalid_alias' }
          const cfg = loadAgentConfig(deps.stateDir)
          const next = { ...(cfg.openaiAliases ?? {}) }
          if (b.op === 'del_alias') {
            if (!(alias in next)) return { ok: false, error: 'unknown_alias' }
            delete next[alias]
          } else {
            const model = typeof b.model === 'string' ? b.model.trim() : ''
            if (!MODEL_NAME_RE.test(model)) return { ok: false, error: 'invalid_model' }
            next[alias] = model
          }
          const { openaiAliases: _drop, ...rest } = cfg
          saveAgentConfig(deps.stateDir, Object.keys(next).length > 0 ? { ...rest, openaiAliases: next } : rest)
          deps.audit?.(`/api 别名 ${b.op === 'del_alias' ? `删除 ${alias}` : `${alias} → ${String(b.model).trim()}`} — 设置面板`)
          return { ok: true }
        }
        if (b.op === 'set_config') {
          const key = typeof b.key === 'string' ? b.key : ''
          if (!PANEL_CONFIG_KEYS.includes(key)) return { ok: false, error: 'unknown_key' }
          const r = await writeConfigKey(deps.stateDir, key, b.value)
          if (!r.ok) return { ok: false, error: r.error }
          // Turning the atelier on here (phone) kicks the same silent, deduped
          // ~5GB paint-set download that /v1/config/set does. Never blocks.
          if (shouldProvisionOnConfigChange(key, r.previous, b.value)) {
            void kickAtelierModelProvision(deps.stateDir, { log: deps.log })
          }
          deps.audit?.(`${key}: ${JSON.stringify(r.previous)} → ${JSON.stringify(b.value)} — 设置面板`)
          // 默认 provider 是开机捕获的,改完自己重启(和 set_remote 同一条路);
          // 没接 requestRestart 时告诉调用方要手动重启。
          if (key === 'provider' && r.previous !== b.value) {
            if (deps.requestRestart) { deps.requestRestart('provider-change'); return { ok: true, restart: 'requested' } }
            return { ok: true, restart: 'required' }
          }
          return { ok: true }
        }
        return { ok: false, error: 'unknown_op' }
      } catch (e) {
        deps.log('SETTINGS', `apply failed: ${String(e)}`)
        return { ok: false, error: 'internal' }
      }
    },

    handleRequest,
    routeKeys: () => Object.keys(routes),
    home,
    async start(port = 0) {
      if (server) return { port: server.port! }
      server = serve({
        hostname: '0.0.0.0',
        port,
        fetch: handleRequest,
      })
      await server.ready
      deps.log('SETTINGS', `panel listening on 0.0.0.0:${server.port} (token-gated)`)
      return { port: server.port! }
    },

    async stop() {
      if (server) { server.stop(true); server = null }
    },

    async linkUrl() {
      const ip = lanIp()
      if (!ip || !deps.ownerChatId()) return null
      const { port } = await panel.start()
      const token = panel.issueToken()
      // 远程隧道开着 → 链接指向中继上的公网壳页(owner 2026-08-26:人在
      // 电脑旁但手机走流量是常态,LAN 链接打不开)。令牌放 # 锚点 ——
      // 锚点不上服务器,中继看不到;壳先探 LAN(在家秒开),不通走隧道。
      const remote = deps.remoteInfo?.()
      if (remote) return psetUrl(remote, token, `${ip}:${port}`)
      return `http://${ip}:${port}/set?t=${token}`
    },

    async phoneLink(opts) {
      const remote = deps.remoteInfo?.() ?? null
      const state = phoneLinkState({
        owner: !!deps.ownerChatId(),
        v2Configured: deps.relayV2Configured?.() ?? false,
        tunnelOn: deps.remote?.isEnabled() ?? false,
        bootRemoteId: remote?.id ?? null,
        bootFailed: !!deps.remoteAtBoot && !remote,
      })
      if (state === 'remote_off' && opts.enableRemote && deps.remote) {
        // 桌面就是主人自己的电脑(裁决 4):点「连接手机」= 打开远程隧道。只写 remote_tunnel,不碰 relay_v2_url。
        deps.remote.setEnabled(true)
        deps.audit?.('remote_tunnel: → true — 桌面「连接手机」')
        remoteRestartRequested = true
        deps.remote.requestRestart()
        return { ok: false, state: 'starting' }
      }
      if (state === 'starting' && !remote && opts.enableRemote && deps.remote && !remoteRestartRequested) {
        // 配置现在说要连(隧道开 + relay_v2_url 在),这次启动却没连:其中一样是开机之后才配的,隧道不会自己起来。
        // 重启一次让它按现在的配置连。同进程只重启一次,免得点一下重启一下;开机时就该连却没连成 ⇒ 上面判成
        // relay_unavailable(身份坏了,重启无用),走不到这里。
        remoteRestartRequested = true
        deps.audit?.('relay_v2_url / remote_tunnel 是开机之后才配的 — 桌面「连接手机」触发重启')
        deps.remote.requestRestart()
        return { ok: false, state: 'starting' }
      }
      if (state !== 'ready' || !remote) return { ok: false, state: state === 'ready' ? 'starting' : state }
      // 先把服务器与局域网地址弄好再铸码:start 抛错时不能留下一枚活的 10 分钟 admin 链接令牌(也不该先作废微信那条 /set 链接)。
      const ip = lanIp()
      const lan = ip ? `${ip}:${(await panel.start()).port}` : null
      const token = panel.issueToken()
      return { ok: true, state: 'ready', url: psetUrl(remote, token, lan), expires_at: now() + SETTINGS_LINK_TTL_MS, check_code: pairCheckCode(remote.id) }
    },

    phoneDevices() {
      return devices.list()
    },
  }

  // ── 手机面板的处理器表(F2):键同路由表 "METHOD /path",门过了才查。面板自己那几条在下面,其余各在 mobile-*.ts。
  type PanelCtx = { t: string; caller: NonNullable<ReturnType<typeof panelToken>>; deviceId: string | null }
  type PanelHandler = PhoneHandler<PanelCtx>
  // 推送两条:注册与试推共用前两道门(没接 / 只给设备),再各走各的。
  const pushRoute = (test: boolean): PanelHandler => async (_url, req, { caller, deviceId }) => {
    if (!deps.push) return json({ ok: false, error: 'push_not_wired' }, 503)
    if (caller.origin !== 'device' || !deviceId) return json({ ok: false, error: 'device_only' }, 403)
    if (test) return json({ ok: true, result: await deps.push.test(deviceId) })
    let body: unknown
    try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
    const b = (body ?? {}) as { platform?: unknown; token?: unknown }
    const platform = PushPlatform.safeParse(b.platform)
    if (!platform.success || typeof b.token !== 'string' || !pushTokenValid(platform.data, b.token)) return json({ ok: false, error: 'invalid' }, 400)
    if (!deps.push.register(deviceId, platform.data, b.token)) return json({ ok: false, error: 'invalid' }, 400)
    deps.log('SETTINGS', `push registered for device ${deviceId} (${platform.data})`)
    return json({ ok: true })
  }
  // 逐文件审阅两条:同一份正文校验,mark 记一个文件、return 打回走续接。
  const reviewFileRoute = (mark: boolean): PanelHandler => async (_url, req) => {
    if (!deps.review) return json({ ok: false, error: 'review_not_wired' }, 503)
    let body: unknown
    try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
    const b = (body ?? {}) as Record<string, unknown>
    if (typeof b.id !== 'string' || !/^[a-f0-9]{8}$/.test(b.id) || typeof b.artifactId !== 'string' || !b.artifactId) return json({ ok: false, error: 'invalid' }, 400)
    try {
      if (mark) {
        if (typeof b.path !== 'string' || !b.path || (b.mark !== 'accepted' && b.mark !== 'returned')) return json({ ok: false, error: 'invalid' }, 400)
        deps.review.mark(b.id, { artifactId: b.artifactId, path: b.path, mark: b.mark })
      } else {
        if (!Array.isArray(b.paths) || typeof b.comment !== 'string' || b.comment.length > PHONE_SAY_MAX_CHARS) return json({ ok: false, error: 'invalid' }, 400)
        // 打回走续接:还在跑的会话里补一句 / 已结算的接着做;结果都靠刷新详情看到
        await deps.review.ret(b.id, { artifactId: b.artifactId, paths: b.paths as string[], comment: b.comment })
      }
      return json({ ok: true })
    } catch (e) {
      const code = e instanceof Error ? e.message : ''
      if (code === 'review_file_unmarkable') return json({ ok: false, error: code }, 400)
      return mobileMatterError(e)
    }
  }
  const panelRoutes: PhoneRouteTable<PanelCtx> = {
    'GET /set': ownsMethod(async (_url, _req, { t }) => new Response(pageHtml(t), { headers: { 'content-type': 'text/html; charset=utf-8' } })),
    'GET /set/api/state': async (_url, _req, { t }) => {
      return json(panel.state(t))
    },
    'POST /set/api/apply': async (url, req, { caller, deviceId }) => {
      let body: unknown
      try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
      // set_remote (toggle remote access + restart the daemon) is a
      // flow-shaped op — refuse it over the tunnel; you only toggle remote
      // access from home anyway, and a leaked device token must not be
      // able to flip config + force restarts remotely.
      // LAN_ONLY_OPS(phone-routes.ts):开关远程访问、撤销 / 全忘设备 —— 只在家做。
      const op = (body as { op?: unknown })?.op
      if (typeof op === 'string' && LAN_ONLY_OPS.has(op) && url.searchParams.get('_via') === 'tunnel') {
        return json({ ok: false, error: 'lan_only' })
      }
      // 手机 app「解除配对」(spec 2026-09-30-tendhearth-app-v1 §6):只撤调用者自己这台,经隧道也行 ——
      // 撤自己不会把别人锁在门外;撤别的设备仍是 LAN_ONLY 的 revoke_device。
      if (op === 'unpair_self') {
        if (caller.origin !== 'device' || !deviceId) return json({ ok: false, error: 'device_only' }, 403)
        devices.revoke(deviceId)
        deps.push?.unregister(deviceId)
        deps.audit?.(`随身 CC:设备 ${deviceId} 自己解除配对 — 手机 app`)
        return json({ ok: true })
      }
      return json(await panel.apply(body))
    },
    'POST /set/api/pair': async (_url, _req, { caller }) => {
      // 单次配对(spec 2026-10-01-tendhearth-pairing-ux §3):只有链接令牌能换设备令牌(D1),
      // 换成功立刻作废这枚链接令牌 —— 一个码只配一台;设备满了不消耗。
      // 从 panelToken(t) 到这里没有 await:校验、铸设备令牌、作废链接令牌同一拍完成,两个并发请求不可能都配上。
      if (caller.origin !== 'link') return json({ ok: false, error: 'link_only' }, 403)
      const paired = devices.pair()
      if (!paired) return json({ ok: false, error: 'device_limit' })
      tokens.invalidateSession('link')
      deps.log('SETTINGS', `phone device paired (id ${paired.id}); link token consumed`)
      return json({ ok: true, device_token: paired.token })
    },
    'GET /m': ownsMethod(async (_url, _req, { t }) => {
      return new Response(phoneHtml(t, deps.remoteInfo?.() ?? null), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }),
    'GET /m/api/state': async () => {
      const s = phoneState()
      // 原生 App 读 PNG(没有 SVG 渲染);画不出 / 画得慢 ⇒ 这一次不带这个字段,不挡回包
      const png = s.portrait ? await portraitPng(s.portrait).catch(() => null) : null
      return json(png ? { ...s, portraitPng: png } : s)
    },
    // 「此刻」形象画(手机协议包 v2 Task 4 fix round 1,2026-09-29):按需拉,
    // 不再内联进 /m 页 —— 两张 PNG base64 加起来 ~257KB,是页面撑爆中继
    // 512KB 帧预算的大头。apps/mobile/src/presence.js 的 loadPresenceArt() 调这个。
    'GET /m/api/art/presence': async () => {
      return json({ ok: true, mime: 'image/png', unlit: presenceArt.unlit.base64, lit: presenceArt.lit.base64 })
    },
    'GET /m/api/memory': async () => {
      if (!deps.curatedMemory) return json({ ok: false, error: 'memory_not_wired' }, 503)
      // 经隧道时 handleRequest 抛出不会回包,手机会一直等 —— 这里兜住,让页面走「暂时读不到」。
      try { return json({ ok: true, ...deps.curatedMemory() }) } catch { return json({ ok: false, error: 'unavailable' }, 500) }
    },
    // 「CC 记得你」逐条纠错(步骤 A,2026-10-06):正文恰好 id + verdict;id 是 memory.md 每条尾注里的那串 hex。
    'POST /m/api/memory/correct': ownsMethod(async (_url, req) => {
      if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
      if (!deps.correctMemory) return json({ ok: false, error: 'memory_not_wired' }, 503)
      let b: unknown
      try { b = await req.json() } catch { return json({ ok: false, error: 'invalid' }, 400) }
      const o = b as { id?: unknown; verdict?: unknown } | null
      if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(k => k !== 'id' && k !== 'verdict')
        || typeof o.id !== 'string' || !/^[a-f0-9]{2,32}$/.test(o.id) || (o.verdict !== 'wrong' && o.verdict !== 'outdated' && o.verdict !== 'delete')) return json({ ok: false, error: 'invalid' }, 400)
      try { await deps.correctMemory(o.id, o.verdict); return json({ ok: true }) } catch (e) {
        const m = e instanceof Error ? e.message : ''
        return m === 'memory_entry_not_found' || m === 'memory_not_found' ? json({ ok: false, error: 'not_found' }, 404) : json({ ok: false, error: 'unavailable' }, 500)
      }
    }),
    'GET /m/api/memory/retractions': async () => {
      if (!deps.memoryRetractions) return json({ ok: false, error: 'memory_not_wired' }, 503)
      try { return json({ ok: true, items: deps.memoryRetractions() }) } catch { return json({ ok: false, error: 'unavailable' }, 500) }
    },
    // 恢复一条收回的话(主人 10-26 第 3 条):正文恰好 key;回应带 note(随之删掉的笔记行不会回来),手机原样显示。
    'POST /m/api/memory/restore': ownsMethod(async (_url, req) => {
      if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
      if (!deps.restoreMemory) return json({ ok: false, error: 'memory_not_wired' }, 503)
      let b: unknown
      try { b = await req.json() } catch { return json({ ok: false, error: 'invalid' }, 400) }
      const o = b as { key?: unknown } | null
      if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(k => k !== 'key') || typeof o.key !== 'string' || !/^c:[^\s]{1,80}$/.test(o.key)) return json({ ok: false, error: 'invalid' }, 400)
      try {
        const res = await deps.restoreMemory(o.key)
        return res ? json({ ok: true, restored: res.restored, note: RESTORE_NOTE }) : json({ ok: false, error: 'not_found' }, 404)
      } catch { return json({ ok: false, error: 'unavailable' }, 500) }
    }),
    'GET /m/api/home': async (url) => {
      return json(await home(parseLimit(url)))
    },
    'POST /m/api/seen': async (_url, req) => {
      if (!deps.seen) return json({ ok: false, error: 'seen_not_wired' }, 503)
      let body: unknown
      try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
      const until = (body as { until?: unknown } | null)?.until
      const ms = typeof until === 'string' ? Date.parse(until) : NaN
      if (!Number.isFinite(ms)) return json({ ok: false, error: 'invalid_until' }, 400)
      // 夹到 now(不许推到未来);单调(桌面与手机两边推,谁靠后算谁)。
      const clamped = new Date(Math.min(ms, now())).toISOString()
      const cur = readSeen()
      if (cur !== null && clamped <= cur) return json({ ok: true, seen_until: cur })
      deps.seen.write(clamped)
      return json({ ok: true, seen_until: clamped })
    },
    'POST /m/api/push/register': pushRoute(false),
    'POST /m/api/push/test': pushRoute(true),
    'GET /m/api/matters': async (url) => {
      if (!deps.matters) return json({ ok: false, error: 'matters_not_wired' }, 503)
      const kind = url.searchParams.get('kind'), status = url.searchParams.get('status')
      if ((kind !== null && !['chat', 'task', 'companion'].includes(kind)) || (status !== null && status.split(',').some(s => !['open', 'replied', 'done', 'archived'].includes(s)))) return json({ ok: false, error: 'invalid' }, 400)
      // 不带 status ⇒ 不含归档(真机 2026-09-30:前 50 条里 49 条是归档的自检任务,「一起做」只剩一条)。
      const statuses = (status ? status.split(',') : ['open', 'replied', 'done']) as Array<'open' | 'replied' | 'done' | 'archived'>
      // 多取一些再筛:别人的聊天 matter(updated_at 现在会被微信入站推高)不给手机,也不挤掉任务。
      const owner = deps.ownerChatId()
      const matters = deps.matters.list({ ...(kind ? { kind: kind as 'chat' | 'task' | 'companion' } : {}), statuses, limit: 200 })
        .filter(m => phoneMayOpenMatter(m, owner))
        .slice(0, 50)
      for (const m of matters) { const id = (m as { id?: unknown }).id; if (typeof id === 'string') { try { deps.matters.seenOnPhone(id) } catch { /* 只是露面登记 */ } } }
      return json({ ok: true, matters })
    },
    'GET /m/api/matter': async (url, _req, { caller }) => {
      if (!deps.matters) return json({ ok: false, error: 'matters_not_wired' }, 503)
      const id = url.searchParams.get('id')
      if (!id || !/^[a-f0-9]{8}$/.test(id)) return json({ ok: false, error: 'invalid' }, 400)
      try {
        const detail = await deps.matters.detail(id)
        // 跟列表同一条规矩:别人的聊天按 id 也打不开,回得跟「没有这件」一样(不让人拿 id 试探)
        if (!phoneMayOpenMatter((detail as { matter?: unknown } | null)?.matter, deps.ownerChatId())) return json({ ok: false, error: 'matter_not_found' }, 404)
        try { deps.matters.seenOnPhone(id) } catch { /* 只是露面登记 */ }
        return mobileMatterDetailResponse(caller.origin === 'device' ? detail : withoutReplyExtras(detail))
      }
      catch (e) { const msg = e instanceof Error ? e.message : 'internal'; return json({ ok: false, error: msg === 'matter_not_found' ? msg : 'unavailable' }, msg === 'matter_not_found' ? 404 : 500) }
    },
    'GET /m/api/matter/insight': async (url) => {
      if (!deps.insight) return json({ ok: false, error: 'insight_not_wired' }, 503)
      const id = url.searchParams.get('id')
      if (!id || !/^[a-f0-9]{8}$/.test(id)) return json({ ok: false, error: 'invalid' }, 400)
      try {
        const r = await deps.insight.forMatter(id, normalizeLang(url.searchParams.get('lang')))
        return json({ ok: true, ...r })
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        return json({ ok: false, error: msg === 'matter_not_found' ? msg : 'unavailable' }, msg === 'matter_not_found' ? 404 : 500)
      }
    },
    'GET /m/api/matter/changes': async (url) => {
      if (!deps.changes) return json({ ok: false, error: 'changes_not_wired' }, 503)
      const id = url.searchParams.get('id')
      if (!id || !/^[a-f0-9]{8}$/.test(id)) return json({ ok: false, error: 'invalid' }, 400)
      try { return json({ ok: true, turn: latestChanges(deps.changes(id)) }) }
      catch (e) {
        const notFound = e instanceof Error && e.message === 'not_found'
        return json({ ok: false, error: notFound ? 'matter_not_found' : 'unavailable' }, notFound ? 404 : 500)
      }
    },
    'POST /m/api/matter/review-mark': reviewFileRoute(true),
    'POST /m/api/matter/review-return': reviewFileRoute(false),
    // 行评论(切片 4):建 {id, commentId, artifactId, path, hunk, hunkSha256, body}(整块,不带行)/ 删 {id, commentId, delete:true},按键集合精确校验。
    'POST /m/api/matter/review-comment': async (_url, req) => {
      if (!deps.review?.comment) return json({ ok: false, error: 'review_not_wired' }, 503)
      let body: unknown
      try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
      const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
      const keys = Object.keys(b).sort().join(',')
      if (typeof b.id !== 'string' || !/^[a-f0-9]{8}$/.test(b.id) || typeof b.commentId !== 'string' || !UUID_RE.test(b.commentId)) return json({ ok: false, error: 'invalid' }, 400)
      const commentId = b.commentId.toLowerCase()
      let input: Parameters<NonNullable<NonNullable<SettingsPanelDeps['review']>['comment']>>[1]
      if (keys === 'commentId,delete,id') { if (b.delete !== true) return json({ ok: false, error: 'invalid' }, 400); input = { commentId, delete: true } }
      else if (keys === 'artifactId,body,commentId,hunk,hunkSha256,id,path') {
        if (typeof b.artifactId !== 'string' || !/^[a-f0-9-]{8,64}$/.test(b.artifactId) || typeof b.path !== 'string' || !b.path || b.path.length > 4096 ||
            typeof b.hunk !== 'number' || !Number.isInteger(b.hunk) || b.hunk < 0 || b.hunk > 1_000_000 || typeof b.hunkSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(b.hunkSha256) ||
            typeof b.body !== 'string' || !b.body.trim() || b.body.length > 2000) return json({ ok: false, error: 'invalid' }, 400)
        input = { commentId, artifactId: b.artifactId, path: b.path, hunk: b.hunk, hunkSha256: b.hunkSha256, body: b.body }
      } else return json({ ok: false, error: 'invalid' }, 400)
      try {
        deps.review.comment(b.id, input)
        return json({ ok: true, ...('delete' in input ? { deleted: true } : { commentId }) })
      } catch (e) {
        const code = e instanceof Error ? e.message : ''
        if (code === 'review_file_unmarkable') return json({ ok: false, error: code }, 400)
        return mobileMatterError(e)
      }
    },
    // 发出评论 {id, summary?, inputRequestId?}:投递同 review-return;原会话接不上 ⇒ 409 restart_confirmation_required(手机不带 restartToken,回电脑上确认)。
    'POST /m/api/matter/review-comments-send': async (_url, req) => {
      if (!deps.review?.sendComments) return json({ ok: false, error: 'review_not_wired' }, 503)
      let body: unknown
      try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
      const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
      if (typeof b.id !== 'string' || !/^[a-f0-9]{8}$/.test(b.id) || Object.keys(b).some(k => !['id', 'summary', 'inputRequestId'].includes(k)) ||
          (b.summary !== undefined && (typeof b.summary !== 'string' || b.summary.length > 2000)) ||
          (b.inputRequestId !== undefined && (typeof b.inputRequestId !== 'string' || !UUID_RE.test(b.inputRequestId)))) return json({ ok: false, error: 'invalid' }, 400)
      try {
        const r = await deps.review.sendComments(b.id, { ...(typeof b.summary === 'string' ? { summary: b.summary } : {}), ...(typeof b.inputRequestId === 'string' ? { inputRequestId: b.inputRequestId.toLowerCase() } : {}) }) as Record<string, unknown> | undefined
        const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0
        return json({ ok: true, sent: n(r?.sent), remaining: n(r?.remaining), skippedDiscarded: n(r?.skippedDiscarded) })
      } catch (e) { return mobileMatterError(e) }
    },
    'POST /m/api/matter/say': async (_url, req) => {
      if (!deps.matters) return json({ ok: false, error: 'matters_not_wired' }, 503)
      let body: unknown
      try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
      const b = (body ?? {}) as Record<string,unknown>
      if (typeof b.id !== 'string' || !/^[a-f0-9]{8}$/.test(b.id) || typeof b.text !== 'string' || (!b.text.trim()&&(!Array.isArray(b.attachmentIds)||!b.attachmentIds.length)) || b.text.length > PHONE_SAY_MAX_CHARS) return json({ ok: false, error: 'invalid' }, 400)
      try { const input=mobileSayInput(b);return json({ ok: true, result: input?await deps.matters.say(b.id,b.text,input):await deps.matters.say(b.id,b.text) }) }
      catch (e) {
        return mobileMatterError(e)
      }
    },
    'POST /m/api/todo': async (_url, req) => {
      let body: unknown
      try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
      const b = (body ?? {}) as { id?: unknown; status?: unknown }
      if (typeof b.id !== 'number' || (b.status !== 'resolved' && b.status !== 'active' && b.status !== 'rejected')) {
        return json({ ok: false, error: 'invalid' }, 400)
      }
      if (!deps.todos) return json({ ok: false, error: 'todos_not_wired' }, 503)
      deps.todos.facts.setFactStatus(b.id, b.status, Math.floor(now() / 1000))
      return json({ ok: true })
    },
    'GET /m/api/sticker/': async (url) => {
      if (!deps.stickers) return json({ error: 'not_found' }, 404)
      const raw = decodeURIComponent(url.pathname.slice('/m/api/sticker/'.length))
      const name = basename(raw)
      // basename + known-in-library double guard — never a free file read.
      if (name !== raw || !deps.stickers.list().some(e => e.file === name)) return json({ error: 'not_found' }, 404)
      const fp = join(deps.stickers.dir, name)
      if (!existsSync(fp)) return json({ error: 'not_found' }, 404)
      const ext = name.split('.').pop()?.toLowerCase() ?? 'png'
      const type = ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png'
      // 隧道/壳模式的图片通道:隧道 body 是 JSON 文本,二进制走不了 ——
      // ?b64=1 返回 base64 载荷,页面拼 data URI(出门表情不再裂图)。
      if (url.searchParams.get('b64') === '1') {
        return json({ ok: true, mime: type, data: readFileSync(fp).toString('base64') })
      }
      return new Response(readFileSync(fp), { headers: { 'content-type': type } })
    },
  }
  const routes = combinePhoneRoutes<PanelCtx>(
    panelRoutes,
    // ── 「一件事」:与桌面同一份数据,同一套语义 ──────────────────
    mobileWorkbenchRoutes(deps.matters, deps.entry, deps.uploads),
    mobileSessionContinueRoutes(deps.sessionContinue, id => deps.matters?.seenOnPhone(id), deps.executorName ? { executorName: deps.executorName } : {}),
    // 跟 CC 说(spec 2026-10-01):主人对话一页 + 收下即回的说一句。
    mobileChatRoutes(deps.chat),
    // 别的功能交来的(信 / 定时 ……,见 featureRoutes):放在原来信、定时那两张表的位置,合表顺序不变。链接令牌不在册(phone-routes.ts LINK_ROUTES)。
    ...(deps.featureRoutes ?? []),
    // CC 做过的事(B9):只读时间线。链接令牌不在册。
    mobileActivityRoutes(deps.activity),
    mobileReadsRoutes({ ...(deps.connections ? { connections: deps.connections } : {}), ...(deps.sessions ? { sessions: deps.sessions } : {}), ...(deps.cliSessions ? { cliSessions: deps.cliSessions } : {}), ...(deps.cliActions ? { cliActions: deps.cliActions } : {}), ...(deps.overseerToday ? { today: deps.overseerToday } : {}), ...(deps.executorName ? { executorName: deps.executorName } : {}) }),
  )

  /** 不带令牌也给的几样(不敏感):图标、PWA 清单、service worker。任何方法都回,同改造前。 */
  const PUBLIC_ASSETS: Readonly<Record<string, () => Response>> = {
    '/m/icon.png': () => new Response(MOBILE_BRAND_ICON_PNG, { headers: { 'content-type': 'image/png' } }),
    '/m/manifest.json': () => json({
      name: 'CC', short_name: 'CC', id: '/m', start_url: '/m', scope: '/m', display: 'standalone',
      background_color: '#f5ead8', theme_color: '#f5ead8',
      // Read dimensions from the bundled PNG so launchers accept it.
      icons: [{ src: '/m/icon.png', sizes: MOBILE_BRAND_ICON_SIZES, type: 'image/png' }],
    }),
    // Service worker — WITHOUT it the PWA shell can't load off-LAN
    // (the origin is the daemon's LAN address, unreachable outside).
    // Caches the last tokened /m document + icon so the shell loads
    // from cache offline; the page's own api() then reaches data over
    // the tunnel. Header widens scope to /m (sw sits at /m/sw.js).
    '/m/sw.js': () => new Response(SW_JS, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'Service-Worker-Allowed': '/m' } }),
  }

  async function routeRequest(url: URL, t: string | null, req: Request): Promise<Response> {
    // ── tokenless surfaces (non-sensitive) ─────────────────────────
    const asset = PUBLIC_ASSETS[url.pathname]
    if (asset) return asset()
    // 下面两处 pathname 比较是认证失败时回哪种页,不是路由:没有有效令牌就没有处理器可查。
    if (url.pathname === '/m' && !panel.validToken(t)) {
      // localStorage bootstrap:加进主屏后 start_url 无参 —— 从本机
      // 存的 deviceToken 续命;没有则提示回微信要新链接。
      return new Response(M_BOOTSTRAP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }

    const caller = panelToken(t)
    if (!caller) {
      if (url.pathname === '/set') {
        return new Response(EXPIRED_HTML, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      return json({ error: 'unauthorized' }, 401)
    }
    // routeAllow(phone-routes.ts):不在册的路径一律 403,与内部 API 同名的错误与日志字段。
    if (!phoneRouteAllowed(caller.routeAllow ?? new Set(), req.method, url.pathname)) {
      deps.log('SETTINGS', `route_not_allowed origin=${caller.origin} path=${req.method} ${url.pathname}`)
      return json({ error: 'route_not_allowed' }, 403)
    }
    const deviceId = deviceIdOfSession(caller.sessionKey)
    if (caller.origin === 'device' && deviceId) devices.touch(deviceId)

    // ── token-gated:查表 ──────────────────────────────────────────
    return (await routePhone(routes, url, req, { t: t!, caller, deviceId })) ?? json({ error: 'not_found' }, 404)
  }

  return panel
}
