/**
 * api.ts — `/m/api/*` 与 `/set/api/*` 每条真实路由的返回形状(zod v4)。
 *
 * 这是未来 Expo app 派生类型的唯一事实源(`z.infer`),daemon 那边的测试拿真实
 * 面板返回对着这里 `parse` —— 手机协议第 12 步,反漂移的主机制:daemon 改了字段、
 * 手机端没跟上,CI 就红。
 *
 * 宽松/严格的分寸(任务书裁决):schema 对多余字段宽松(用默认 `z.object()`,
 * 不加 `.strict()`,零成本地允许新字段),但对必需字段本身及其类型严格 ——
 * 少一个字段、或类型不对,`parse` 就该抛。
 *
 * 只两类路由没有形状:`GET /set`、`GET /m` 回 HTML,不是 JSON;登记在
 * `PHONE_HTML_ROUTES`,由 daemon 那边的守卫测试显式排除并核对理由。
 *
 * `PHONE_API_SCHEMAS` 用 `"METHOD /path"` 精确键,跟 `src/features/phone/phone-routes.ts`
 * 的 `PHONE_ROUTES` 同一个键形状(含 `GET /m/api/sticker/` 这个前缀键 —— schema
 * 只覆盖它 `?b64=1` 的 JSON 形式,裸图片二进制不是 JSON,不在这里管)。
 *
 * zod v4:用默认导出 `import z from 'zod'`(具名 `{ z }` 在 vitest 打包下会解析
 * 成 undefined,见 messages.ts 同一条注释)。
 */
import z from 'zod'
import type { PanelRouteKey } from './routes'

// ── 错误响应(共享)───────────────────────────────────────────────────────

/** 绝大多数 `/m/api/*`、`/set/api/*` 失败路径的形状:`{ok:false,error}`。 */
export const PhoneErrorResponse = z.object({ ok: z.literal(false), error: z.string() })

/** 少数路由(令牌门、贴纸 404)不带 `ok`,只有裸 `{error}`。 */
export const PhonePlainError = z.object({ error: z.string() })
/** 手机「说一句」正文上限(settings-panel.ts 的 POST /m/api/matter/say)。app 在手机上就拦。 */
export const PHONE_SAY_MAX_CHARS = 20_000
/** 手机「跟 CC 说」一句最多带几张图(2026-10-06;与桌面此刻同一个上限)。 */
export const PHONE_CHAT_MAX_IMAGES = 4
/** 回答问题:answers 的 JSON 序列化长度上限(mobile-workbench.ts 的 POST /m/api/matter/answer)。app 在手机上就拦。 */
export const PHONE_ANSWER_MAX_JSON = 20_000
/**
 * 按住说话(POST /m/api/chat/transcribe,2026-10-18):一段录音最长 60 秒、至多 200 KiB。
 * 手机按 16 kHz 单声道 AAC 24 kbps 录:60 s ≈ 180 KB + m4a 封装几 KB,装得下。
 * 200 KiB 的 base64 是 273 KB,经 v2 密封再 base64 约 364 KB,离中继一帧 512 KiB 还有余量(api-transcribe.test.ts 实测)。
 */
export const PHONE_TRANSCRIBE_MAX_SECONDS = 60
export const PHONE_TRANSCRIBE_MAX_BYTES = 200 * 1024
/** 收哪几种录音(whisper 一类网关都认);手机录的是 audio/mp4(m4a)。 */
export const PHONE_TRANSCRIBE_MIMES = ['audio/mp4', 'audio/m4a', 'audio/aac', 'audio/wav', 'audio/webm', 'audio/mpeg', 'audio/ogg'] as const

// ── 手机端 HTML 页(没有 JSON 形状,守卫要显式排除)───────────────────────

/** `GET /set`、`GET /m` 回 HTML 页面,不是 JSON——没有 schema,守卫核对时按理由跳过。 */
export const PHONE_HTML_ROUTES: ReadonlyMap<string, string> = new Map([
  ['GET /set', '设置页整页 HTML(pageHtml/EXPIRED_HTML),不是 JSON API'],
  ['GET /m', '随身 CC 整页 HTML(phoneHtml/M_BOOTSTRAP_HTML),不是 JSON API'],
])

// ── 「一件事」(matters)共用形状 ─────────────────────────────────────────

export const Attachment = z.object({
  id: z.string(), name: z.string(), mime: z.string(), size: z.number(), sha256: z.string(),
})

/** 一件事的出生地取值(与 daemon 的 matters.origin_surface 同一组)。 */
export const MATTER_ORIGINS = ['wechat', 'desktop', 'app', 'web', 'cli', 'companion'] as const
export type MatterOriginT = typeof MATTER_ORIGINS[number]

export const Matter = z.object({
  id: z.string(),
  kind: z.enum(['chat', 'task', 'companion']),
  title: z.string(),
  projectPath: z.string().nullable(),
  status: z.enum(['open', 'replied', 'done', 'archived']),
  ownerChatId: z.string().nullable(),
  originMatterId: z.string().nullable(),
  originMessageId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** 参与过的执行者(2026-10-19):正在做的在前。只有列表带;老 daemon 不带。 */
  agents: z.array(z.string()).optional(),
  /**
   * 执行者 id → 正式名字(收敛清单 ⑥):这件事里出现过的每一家(agents、详情里的任务执行者 / 交接对象)。
   * 名字只由 daemon 定,三端不存名字表;老 daemon 不带 ⇒ 界面退回 id。
   */
  agentNames: z.record(z.string(), z.string()).optional(),
  /**
   * 这件事从哪个表面来的(2026-10-19,建时写一次,永不改):微信 / 电脑 / 手机 App / 浏览器 / 终端 / CC 自己。
   * 老 daemon 不带、老的事不知道 ⇒ 省略,界面就不画。认不出的新值当没有(不让整行解析失败)。
   */
  origin: z.enum(MATTER_ORIGINS).optional().catch(undefined),
})

export const MatterBinding = z.object({
  matterId: z.string(), surface: z.enum(['wechat', 'desktop', 'phone', 'cli']), surfaceKey: z.string(), lastSeenAt: z.number(),
})

export const MatterSession = z.object({
  matterId: z.string(), providerId: z.string(), sessionId: z.string(), role: z.enum(['main', 'review', 'handoff']), createdAt: z.number(),
})

/** `matters/service.ts` 的 `MatterTaskView`(手机详情/say 结果里的任务投影)——
 * 跟 workbench 内部的 `WorkbenchTaskView`(见下面 entry 一节)不是同一个类型。 */
export const MatterTaskView = z.object({
  id: z.string(), title: z.string(), status: z.string(), phase: z.string().optional(),
  providerId: z.string(), path: z.string(), error: z.string().nullable(), updatedAt: z.number(),
  archivedAt: z.number().nullable().optional(),
  // 独立工作区(2026-10-07):分支名 + 工作区删了没;手机据此给「提交到分支 / 删除工作区」。
  // projectId(10-08):源项目编号,手机「另做一份」交到同一个项目;不给路径。
  // 工作区脚本(2026-10-20,tendhearth.json):配了才带。setup / run 是状态字符串(none/pending/running/done/failed、none/idle/queued/running;
  // 不用 enum:以后多一种,老 App 当「不确定」而不是整页解析失败);approved = 这份内容主人在电脑上批过;
  // lastLines = 最近那条脚本输出的最后几行(已打码、去路径);脚本原文与路径永远不到手机。
  worktree: z.object({
    branch: z.string(), removed: z.boolean(), merged: z.boolean().optional(), projectId: z.string().optional(),
    port: z.number().int().optional(), setup: z.string().optional(), run: z.string().optional(), approved: z.boolean().optional(),
    lastLines: z.array(z.string()).max(20).optional(),
  }).optional(),
  // 做到条件成立为止(v80,2026-10-20):命令原文(主人建任务时写的,手机要整条等宽显示)+ 进度。老 daemon 不带。
  until: z.object({ command: z.string(), maxRounds: z.number(), rounds: z.number(), status: z.enum(['active', 'passed', 'exhausted', 'stopped']), lastExit: z.number().nullable(), stopReason: z.string().nullable() }).optional(),
  // 每件事花了多少额度(v82,2026-10-20):执行者自己报的合计;某项 null = 这家不报(界面写「这家不报」,不写 0)。老 daemon 不带。
  usage: z.object({ turns: z.number(), input: z.number().nullable(), output: z.number().nullable(), cacheRead: z.number().nullable(), cacheWrite: z.number().nullable(), reasoning: z.number().nullable(), costUsd: z.number().nullable() }).optional(),
  // 回到某一轮(切片 4,2026-10-21):回退中途出了状况、这件事停住等主人在电脑上拍板。手机只读一句,没有按钮。老 daemon 不带。
  rewind: z.object({ blocked: z.boolean() }).optional(),
})

export const MatterEvent = z.object({
  kind: z.string(), text: z.string(), createdAt: z.number(),
  source: z.string().optional(), attachments: z.array(Attachment).optional(),
  errorCode: z.literal('execution_model_unsupported').optional(), diagnostic: z.string().optional(),
  // 工具那一步(2026-10-17):status = running / completed / failed …,手机据此标「正在」。老 daemon 不带。
  activity: z.object({ type: z.string(), status: z.string(), label: z.string() }).optional(),
})

export const MatterInput = z.object({
  id: z.string(), taskId: z.string(), runId: z.string(), text: z.string(),
  status: z.enum(['pending', 'sending', 'delivered', 'held', 'withdrawn']),
  attachments: z.array(Attachment).optional(),
  /** Single-receipt reads preserve the durable delivery reason; older backends omit it. */
  error: z.string().nullable().optional(),
})

export const MatterInputReceiptResult = z.object({ ok: z.literal(true), input: MatterInput })
export type MatterInputReceiptResultT = z.infer<typeof MatterInputReceiptResult>

export const MatterPermission = z.object({
  id: z.string(), taskId: z.string(), tool: z.string(), description: z.string(), createdAt: z.number(),
})

const QuestionOption = z.object({ label: z.string(), description: z.string() })
export const MatterQuestion = z.object({
  id: z.string(), taskId: z.string(), createdAt: z.number(),
  questions: z.array(z.object({
    id: z.string(), header: z.string(), question: z.string(),
    options: z.array(QuestionOption), multiSelect: z.boolean(), allowOther: z.boolean(),
  })),
})

export const ApprovalExplanation = z.object({
  title: z.string(), what: z.string(), scope: z.string(), effect: z.string(), source: z.enum(['model', 'raw']),
})
export const ProgressSummary = z.object({
  summary: z.string(), steps: z.array(z.object({ title: z.string(), detail: z.string() })), source: z.enum(['model', 'raw']),
})

export const MatterArtifact = z.object({
  id: z.string(), taskId: z.string(), name: z.string(), mime: z.string(), size: z.number(),
  sha256: z.string(), createdAt: z.number(), approvedAt: z.number().nullable(),
})

/** 接过来、还没发第一句的电脑会话(spec 2026-10-01-tendhearth-continue-sessions D12);发过第一句就不再出现。 */
export const MatterNativeStart = z.object({ mode: z.enum(['native_resume', 'fresh_context']), providerId: z.string() })
/** 执行者额度用完(spec 2026-10-01-tendhearth-continue-sessions §7-3):能交给谁 / 没人能接 / 已经交出去了(matterId = 新那件)。 */
export const MatterQuotaHandoff = z.discriminatedUnion('state', [
  z.object({ state: z.literal('offer'), from: z.string(), to: z.string(), kind: z.enum(['quota', 'rate_limit']), resetAt: z.number() }),
  z.object({ state: z.literal('none'), from: z.string(), kind: z.enum(['quota', 'rate_limit']), resetAt: z.number() }),
  z.object({ state: z.literal('handed'), from: z.string(), to: z.string(), matterId: z.string() }),
])
export type MatterQuotaHandoffT = z.infer<typeof MatterQuotaHandoff>
export const MatterHandoffResult = z.object({ matterId: z.string(), created: z.boolean() })
export const MatterDetail = z.object({
  matter: Matter, bindings: z.array(MatterBinding), sessions: z.array(MatterSession),
  task: MatterTaskView.nullable(), events: z.array(MatterEvent),
  runId: z.string().optional(), inputMode: z.enum(['steer', 'send', 'queue']).optional(),
  permissions: z.array(MatterPermission), questions: z.array(MatterQuestion),
  artifacts: z.array(MatterArtifact), inputs: z.array(MatterInput),
  nativeStart: MatterNativeStart.optional(),
  quotaHandoff: MatterQuotaHandoff.optional(),
})

// ── 交办入口(entry/create/create-receipt,mobile-workbench.ts)───────────

export const ProjectCatalogEntry = z.object({
  id: z.string(), name: z.string(), path: z.string(), providerId: z.string().nullable(),
})

const Reason = z.object({ code: z.string(), message: z.string() })

/** workbench/executor-capabilities.ts 的 `WorkbenchExecutorCapabilities`——
 * `provider.capabilities.features.attachments` 决定材料能不能带着交办(原先网页交办页 entry.js 真读它,
 * 收敛 5b 删了那页;字段照旧下发),不是只透传展示,类型漂移(比如变成字符串)必须被挡住。 */
export const WorkbenchExecutorCapabilities = z.object({
  version: z.literal(1),
  permissions: z.enum(['task', 'unattended']),
  configuration: z.literal('task-policy'),
  completion: z.literal('native'),
  stop: z.literal('confirmed'),
  background: z.enum(['tracked', 'disabled']),
  features: z.object({
    nativeResume: z.boolean(),
    managedResume: z.boolean().optional(),
    attachments: z.boolean(),
    executionSettings: z.boolean(),
    modelCatalog: z.boolean(),
  }),
})

/** 交办时可选的模型(GET /m/api/entry/models,2026-10-06;agent-provider.ts 的 AgentModelCatalog)。 */
export const EntryModelCatalog = z.object({
  models: z.array(z.object({ id: z.string(), displayName: z.string(), description: z.string().optional(), reasoningEfforts: z.array(z.string()), defaultReasoningEffort: z.string().optional() }).passthrough()),
  defaultModel: z.string().optional(), source: z.string(),
})
export const EntryOptions = z.object({
  status: z.enum(['ready', 'needs_connection']),
  reason: Reason.optional(),
  defaultProviderId: z.string().nullable(),
  providers: z.array(z.object({
    // displayName = 正式名字;settingsLabel = 设置里写清怎么连的(Gemini · 账号连接)。都由 daemon 定(收敛清单 ⑥),三端不再各存一份。
    id: z.string(), displayName: z.string(), settingsLabel: z.string().optional(), available: z.boolean(),
    unavailableReason: Reason.optional(),
    capabilities: WorkbenchExecutorCapabilities,
  })),
  projects: z.array(ProjectCatalogEntry),
})

/** workbench/service.ts 的 `WorkbenchTaskView`(entry/create 与 create-receipt 回的任务快照)。 */
export const WorkbenchTaskView = z.object({
  id: z.string(), title: z.string(), path: z.string(), providerId: z.string(),
  status: z.enum(['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted']),
  workspaceKind: z.enum(['project', 'managed']),
  createdAt: z.number(), updatedAt: z.number(), error: z.string().nullable(), archivedAt: z.number().nullable(),
  phase: z.enum(['queued', 'working', 'replied', 'failed', 'cancelled', 'interrupted']),
  importedOnly: z.boolean().optional(), canArchive: z.boolean(),
  // TaskWaitingFor 是个内部判别联合,手机端不解读结构,只透传。
  waitingFor: z.unknown().nullable(),
  pendingPermissionCount: z.number().optional(), pendingQuestionCount: z.number().optional(),
  runtime: z.unknown().optional(),
})

export const EntryReceipt = z.object({
  requestId: z.string(), taskId: z.string(), matterId: z.string(), runId: z.string(), acceptedAt: z.number(),
})

export const EntryResult = z.object({ receipt: EntryReceipt, task: WorkbenchTaskView })

// ── 材料上传(attachment/*,mobile-workbench.ts)───────────────────────────

export const UploadState = z.object({
  id: z.string(), draftId: z.string(), taskId: z.string().nullable(), size: z.number(), sha256: z.string(),
  nextOffset: z.number(), status: z.enum(['uploading', 'ready']), attachment: Attachment.optional(),
})

export const MatterArtifactChunk = z.object({
  taskId: z.string(), artifactId: z.string(), name: z.string(), mime: z.string(), size: z.number(),
  sha256: z.string(), offset: z.number(), nextOffset: z.number(), contentBase64: z.string(),
})

// ── 随身 CC 首屏(mobile-feed.ts / mobile-home-focus.ts / settings-panel.ts home）──

export const FeedEvent = z.object({
  id: z.string(), ts: z.string(),
  kind: z.enum(['hunt', 'visit', 'postcard', 'recollection', 'thought', 'chat_day']),
  title: z.string(), note: z.string().nullable(), day: z.string(), hhmm: z.string(),
  ref: z.object({ url: z.string().nullable(), image_svg: z.string().nullable(), status: z.string() }).optional(),
})

const FeedSourceName = z.enum(['journal', 'thought', 'chat_day'])

export const Presence = z.object({
  presence: z.enum(['ok', 'degraded', 'offline']),
  activity: z.object({
    kind: z.enum(['idle', 'chatting', 'hosting_human', 'visiting', 'hosting_peer', 'foraging', 'working']),
    label: z.string(), since: z.string().nullable(),
  }),
  news: z.object({ unread: z.number(), latest_kind: z.string().nullable(), latest_title: z.string().nullable() }),
})

export const HomeWork = z.object({
  focus: z.object({ id: z.string(), title: z.string(), kind: z.enum(['decision', 'result', 'working']) }).nullable(),
  partial: z.boolean(),
})

const HomeSuccess = z.object({
  ok: z.literal(true), synced_at: z.string(), today: z.string(), presence: Presence.nullable(),
  work: HomeWork.optional(), presence_error: z.literal('unavailable').optional(),
  unread: z.number(), seen_until: z.string().nullable(),
  events: z.array(FeedEvent), next_cursor: z.string().nullable(), sources_degraded: z.array(FeedSourceName),
})

// ── 「CC 记得你」(memory,memory/nightly-runtime.ts)───────────────────────

const MemorySection = z.enum(['关于你', '偏好', '承诺', '身边的人', '近况'])
const ViewChange = z.object({
  kind: z.enum(['add', 'update', 'remove']), label: z.enum(['新记下', '记下', '改了', '删了']),
  section: MemorySection, text: z.string(), before: z.string().optional(), reason: z.string().optional(),
})
const CuratedItem = z.object({
  id: z.string().nullable(), text: z.string(), display: z.string(), due: z.string().nullable(),
  due_label: z.string().nullable(), person: z.object({ name: z.string(), rel: z.string() }).nullable(), changed: z.boolean(),
  // 出处(2026-10-20):这条是从哪几句聊天里记下的;老 daemon 没有。
  // kind 'import' = 从别的助手导入的(2026-10-20);老 daemon 不带。不用 enum:以后多一类老包也照样解析
  sources: z.array(z.object({ ts: z.string(), excerpt: z.string(), kind: z.string().optional() })).optional(),
})
/** 手机上的一条定时(GET /m/api/jobs,2026-10-20);label 已带时区,如「每天 08:00(上海)」。 */
export const PhoneJob = z.object({
  id: z.string(), label: z.string(), text: z.string(), brief: z.boolean(), recap: z.boolean().optional(), paused: z.boolean(),
  last: z.object({ day: z.string(), status: z.string(), label: z.string() }).nullable(),
})
export type PhoneJobT = z.infer<typeof PhoneJob>

/** 「CC 做过的事」(B9,2026-10-20):一行一句,新的在前;ref 指向能点开的那件事。 */
export const PhoneActivityItem = z.object({
  id: z.string(),
  // 不用 enum:新 daemon 多一种 kind 时,老 App 也得照样把整页画出来(只当一行字),不能整页 schema 失败。
  kind: z.string(),
  at: z.number(),
  title: z.string(),
  // ref 同理:认不得的 type 由 App 当成不能点,不让整页失败。
  ref: z.object({ type: z.string(), id: z.string() }).optional(),
})
export type PhoneActivityItemT = z.infer<typeof PhoneActivityItem>
/** 收回的话(架构终态 G6,主人 10-26 第 2 / 3 条):手机「CC 记得你」页底下那张列表,每条能恢复。 */
export const MemoryRetractionsSuccess = z.object({
  ok: z.literal(true),
  items: z.array(z.object({ key: z.string(), section: z.string().nullable(), text: z.string(), day: z.string().nullable(), verdict: z.string().nullable(), note: z.string() })),
})
export const MemoryRestoreSuccess = z.object({ ok: z.literal(true), restored: z.array(z.string()), note: z.string() })

export const MemorySuccess = z.object({
  ok: z.literal(true), updated_at: z.string().nullable(), when_label: z.string().nullable(),
  mood: z.enum(['changed', 'steady', 'first']), failures: z.number(), changes: z.array(ViewChange),
  sections: z.array(z.object({ name: MemorySection, items: z.array(CuratedItem) })),
})

// ── 设置页(/set/api/*,settings-panel.ts state()）───────────────────────

export const DeviceRow = z.object({
  id: z.string(), created_at: z.string(), last_seen_at: z.string(), label: z.string().optional(), current: z.boolean(),
})
export type DeviceRowT = z.infer<typeof DeviceRow>

/** features/atelier/model-provision.ts 的 `ModelProvisionStatus`(判别联合,`state` 判别)。 */
const ModelProvisionStatus = z.discriminatedUnion('state', [
  z.object({ state: z.literal('checking') }),
  z.object({ state: z.literal('ready'), modelPath: z.string(), downloaded: z.boolean() }),
  z.object({ state: z.literal('downloading'), attempt: z.number(), received: z.number(), total: z.number() }),
  z.object({ state: z.literal('failed'), error: z.string() }),
]).nullable()

const ModelsState = z.object({
  default_provider: z.string(), checked_at: z.string().nullable(),
  providers: z.array(z.object({
    id: z.string(), registered: z.boolean(), model: z.string().nullable(),
    status: z.enum(['unconfigured', 'unknown', 'ok', 'broken']),
    error: z.string().optional(), hint: z.string().optional(), latency_ms: z.number().optional(),
  })),
  openai: z.object({ base_url: z.string(), model: z.string(), has_key: z.boolean(), aliases: z.record(z.string(), z.string()) }),
  gemini: z.object({ has_key: z.boolean() }),
  cheap: z.string(),
  trusted_providers: z.array(z.string()).nullable(),
  shared_token: z.array(z.string()),
  guest_blocked: z.array(z.string()),
})

const SetStateSuccess = z.object({
  ok: z.literal(true), name: z.string(), persona: z.string(),
  prefs: z.record(z.string(), z.unknown()),
  config: z.record(z.string(), z.union([z.string(), z.boolean(), z.number(), z.null()])),
  remote: z.object({ available: z.boolean(), enabled: z.boolean(), devices: z.array(DeviceRow) }),
  atelier: z.object({ model_status: ModelProvisionStatus }),
  models: ModelsState,
})

// ── 随身 CC 首页(/m/api/state,settings-panel.ts phoneState()）───────────

const TodoRow = z.object({
  id: z.number(), contact: z.string(), predicate: z.string(), value: z.string(),
  // FactRow.time_ref(src/adapters/knowledge/store.ts):string|null —— 手机 App 的待办页直接显示它,真读,不是透传。
  time_ref: z.string().nullable(), updated_at: z.number(), display: z.string(),
})

const PhoneStateSuccess = z.object({
  ok: z.literal(true), name: z.string(),
  todos: z.object({ active: z.array(TodoRow), settled: z.array(TodoRow) }),
  portrait: z.string().nullable(),
  // 同一张画的 base64 PNG(512px 方图,2026-10-21):原生 App 没有 SVG 渲染就读这个。只有 macOS 上的电脑画得出;
  // 没画过 / 画不出 / 老 daemon ⇒ 没有这个字段。
  portraitPng: z.string().optional(),
  stickers: z.array(z.object({ file: z.string(), tags: z.array(z.string()), desc: z.string().optional() })),
})

// ── 每条路由的响应形状(与 mobileMatterError 的 say 结果联合体）──────────

export const MatterSayResult = z.union([
  z.object({ kind: z.literal('task'), task: MatterTaskView, input: MatterInput.optional() }),
  z.object({ kind: z.literal('chat'), reply: z.string() }),
])

/** 主人对一个文件的标记(桌面「改动」面板同一张表):没问题 / 退回 + 退回时那句意见。 */
export const PhoneReviewMark = z.object({ mark: z.enum(['accepted', 'returned']), comment: z.string(), createdAt: z.number() })

/** 行评论(切片 4):一块改动的序号 / sha / 块头(@@ … @@)。客户端按 `^(?=@@ )` 切 diff,对上块数与块头才给「评论这一块」。 */
export const PhoneReviewHunk = z.object({ index: z.number(), sha256: z.string(), header: z.string() })
/** 一条行评论;state 开放(draft / sent / 以后的新值),认不得的按只读显示。 */
export const PhoneReviewComment = z.object({
  id: z.string(), hunk: z.number(), rowStart: z.number().optional(), rowEnd: z.number().optional(),
  body: z.string(), state: z.string(), sentAt: z.number().optional(),
})

export const PhoneChangesTurn = z.object({
  /** 这一轮快照的 id;逐文件「没问题 / 退回」要带上它(2026-10-17)。 */
  artifactId: z.string().optional(),
  /** 撤掉这一轮(回退切片 4):这一轮能撤(有开始前的回退点)。discarded:这一轮已撤掉(灰着,没有按钮)。
   *  discardedAfter:比这一轮新、已撤掉的轮数。老 daemon 都不带。 */
  rewindable: z.boolean().optional(), discarded: z.boolean().optional(), discardedAfter: z.number().optional(),
  createdAt: z.number(), status: z.enum(['complete', 'partial', 'unavailable']),
  /** 行评论(切片 4):这件事没撤掉的各轮上还没发出的评论数;老 daemon 不带。 */
  pendingComments: z.number().optional(),
  files: z.array(z.object({ path: z.string(), kind: z.enum(['added', 'deleted', 'modified', 'not_reviewed']), diff: z.string().optional(), reason: z.string().optional(), truncated: z.boolean(), mark: PhoneReviewMark.optional(), /** 该多看一眼的原因(B6);老 daemon 没有。 */ risk: z.array(z.string()).max(6).optional(),
    /** 块清单(带了 diff 且路径没裁才有)与已有评论;都是 optional,老 daemon 没有。 */
    hunks: z.array(PhoneReviewHunk).optional(), comments: z.array(PhoneReviewComment).optional() })),
  omittedFiles: z.number(),
  /** 本轮审阅的说明(为什么是 partial 等),至多 10 条、每条 ≤ 200 字。 */
  notes: z.array(z.string()),
})

const RewindPaths = z.object({ count: z.number(), paths: z.array(z.object({ status: z.string(), path: z.string() })) })
/** 手机「撤掉这一轮」的预览(GET /m/api/matter/rewind,回退切片 4):回到最新那一轮开始之前。
 *  round = 撤掉的是第几轮;rounds = 会撤掉的轮次;files = 要撤掉的改动(至多 50 个路径,status 是 git 的 A/M/D/R…);
 *  extraChanges = 最后一轮之后又有的改动(主人手改等,一并撤掉、先备份;null = 比不了);droppedCommits.elsewhere = 别的分支 / remote 里还有;
 *  session / 状态码一律 z.string():新值不能让老 App 解析失败。 */
export const PhoneRewindPreview = z.object({
  token: z.string(), round: z.number(), rounds: z.array(z.number()),
  files: RewindPaths, extraChanges: RewindPaths.nullable(),
  droppedCommits: z.object({ count: z.number(), elsewhere: z.boolean() }),
  rebuildHint: z.string(), session: z.string(), devServer: z.boolean(), goalWillStop: z.boolean(),
})
export type PhoneRewindPreviewT = z.infer<typeof PhoneRewindPreview>
/** 回退失败的错误体多带的(回退切片 4):reason = rewind_unavailable / rewind_noop 的短码;rolledBack = rewind_failed 时恢复原样了没有。 */
export const PhoneRewindError = z.object({ ok: z.literal(false), error: z.string(), reason: z.string().optional(), rolledBack: z.boolean().optional() })

// ── 跟 CC 说(spec 2026-10-01):主人对话一页 + 收下即回的说一句 ──────────

/** 对话一页至多这么多条(回包大小,见 plan Global Constraints)。 */
export const CHAT_PAGE_MAX = 30
/** 每条正文至多这么多字,超了截断并标 `truncated: true`。 */
export const CHAT_TEXT_MAX = 4000
/**
 * 一轮回复的附件(回复交付,2026-10-04):桌面 / 手机那一轮里 CC 发的语音 / 表情 / 文件,跟着回复那一行落库。
 * - voice:要读出来的那句。手机点了才经 `GET /m/api/chat/voice` 合成(不预先合成、不进回包)。
 * - sticker:`label` 是标签或情绪;`file` 是表情库里的文件名(经 `GET /m/api/sticker/<file>?b64=1` 取图)。
 *   联网表情没有 `file`,只显示 label —— daemon 不替 app 去外网取图。
 * - file:只给名字;手机经 `GET /m/api/chat/file` 按块读(2026-10-06)。图片(png / jpg / gif / webp)App 直接画成图(2026-10-18:
 *   CC 在微信上发给主人的图、信纸也记成这样的一行)。
 */
/** 搜主人对话的一条结果(GET /m/api/chat/search,2026-10-06)。 */
export const ChatSearchHit = z.object({ id: z.string(), role: z.enum(['me', 'cc']), text: z.string(), truncated: z.boolean(), at: z.number(), source: z.string().nullable() })
export const ChatAttachment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('voice'), text: z.string() }),
  z.object({ kind: z.literal('sticker'), label: z.string(), file: z.string().optional() }),
  z.object({ kind: z.literal('file'), name: z.string() }),
])
export type ChatAttachmentT = z.infer<typeof ChatAttachment>
/** 认不得的附件(新 daemon 加了种类 / 字段坏了)逐条丢掉,不让整页解析失败 —— 旧手机照样看得到文字。 */
const ChatAttachments = z.array(z.unknown()).transform(xs => xs.flatMap(x => {
  const r = ChatAttachment.safeParse(x)
  return r.success ? [r.data] : []
}))
/** 一条回复至多带这么多段旁白(取最后这几段);每段同样至多 CHAT_TEXT_MAX 字。 */
export const CHAT_NARRATION_MAX = 20
/**
 * attachments / narration 是 2026-10-04 加的**可选**字段:老 daemon 不带(手机当没有);只有桌面 / 手机那一轮
 * CC 的回复行才可能有。narration = 最后的话之前的过程话(没发到微信),手机显示成灰色、默认收起的「过程」。
 */
export const ChatMessage = z.object({
  id: z.string(), role: z.enum(['me', 'cc']), kind: z.string(), text: z.string(), truncated: z.boolean(), at: z.number(), source: z.enum(['wechat', 'desktop', 'phone']),
  attachments: ChatAttachments.optional(),
  narration: z.array(z.string()).optional(),
})
/**
 * 「CC 的信」里的一封(GET /m/api/letters,2026-10-18):只列寄出去了的,新的在前。pages = 几页信纸图
 * (经 GET /m/api/letters/page 按块读);0 ⇒ 这封排不成图、按文字寄的,全文在 text。
 */
export const LetterSummary = z.object({
  id: z.string(), day: z.string(), sentAt: z.number(), requested: z.boolean(), via: z.enum(['wechat', 'app']),
  opening: z.string(), pages: z.number(), text: z.string().optional(),
})
export type LetterSummaryT = z.infer<typeof LetterSummary>
/** 语音附件合成出来的声音(base64)。太长装不进中继一帧 ⇒ 413 too_large(手机提示去电脑上听)。 */
export const ChatVoice = z.object({ mime: z.string(), data: z.string() })
export const ChatJob = z.object({ requestId: z.string(), text: z.string(), status: z.enum(['pending', 'replied', 'failed']), since: z.number(), error: z.enum(['busy', 'unavailable', 'not_configured']).optional() })
export const ChatPage = z.object({ matterId: z.string(), title: z.string(), messages: z.array(ChatMessage), hasMore: z.boolean(), nextBefore: z.string().nullable(), pending: ChatJob.nullable(), failed: ChatJob.nullable() })

// ── CC 的连接(spec 2026-10-01):手机拿到的是去掉 detail 的快照 ──────────

export const ConnectionSource = z.object({ id: z.string(), kind: z.enum(['wechat_history', 'knowledge', 'plugin']), name: z.string(), state: z.enum(['ready', 'behind', 'not_loaded', 'unknown']), latestAt: z.number().nullable(), syncedAt: z.number().nullable() })
export const Connections = z.object({
  generatedAt: z.number(), sources: z.array(ConnectionSource),
  // 插件快照还没出来 ⇒ daemon 真的还在启动。可选:老 daemon 不带(手机当不知道是否在启动)。
  starting: z.boolean().optional(),
  computers: z.array(z.object({ id: z.string(), label: z.string(), online: z.boolean(), since: z.number().nullable(), version: z.string().nullable() })),
  recent: z.array(z.object({ matterId: z.string(), title: z.string(), phase: z.string(), at: z.number() })),
  outputs: z.array(z.object({ matterId: z.string(), name: z.string(), mime: z.string(), at: z.number() })),
  // 「CC 现在怎么样」(2026-10-06):各项能力四态 + 原因码 + 人话 + 至多一个动作。可选:老 daemon 不带。
  capabilities: z.array(z.object({
    id: z.string(), name: z.string(), state: z.enum(['ok', 'fallback', 'needs_you', 'off']),
    code: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])).optional(), reason: z.string(),
    // run(2026-10-14):桌面能当场做的动作(如 cli_hooks_install = 接上终端里的 Claude Code / Codex);手机只当提示。
    action: z.object({ label: z.string(), where: z.enum(['desktop', 'settings', 'wechat']), url: z.string().optional(), run: z.string().optional() }).optional(),
  })).optional(),
})
export type ConnectionsT = z.infer<typeof Connections>

// ── 电脑上的原生会话(只读,spec 2026-10-01):key 是 base64url{providerId,nativeId},不给 cwd / nativeId ──
// displayName(收敛清单 ⑥):执行者正式名字,daemon 定;老 daemon 不带 ⇒ 退回 provider id。
export const NativeSessionRow = z.object({ key: z.string(), provider: z.enum(['claude', 'codex']), displayName: z.string().optional(), title: z.string(), project: z.string().nullable(), updatedAt: z.number().nullable(), active: z.boolean() })
export const NativeSessionMessage = z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), truncated: z.boolean() })
export const NativeSessionPage = z.object({ session: NativeSessionRow, messages: z.array(NativeSessionMessage), nextCursor: z.string().nullable(), managed: z.boolean(), window: z.enum(['recent', 'start']).optional() })
export type NativeSessionRowT = z.infer<typeof NativeSessionRow>
/**
 * 终端会话登记处(GET /m/api/cli/sessions,v76,2026-10-14):主人在 CC 外面开的 claude / codex 会话。
 * status 已折算:running / waiting 超过 30 分钟没事件 ⇒ idle + stale。waiting 在最前,其余按 last_event_at 倒序。
 * code = 微信「看 码」「@码」用的短码。手机口径只给目录名(project),不给完整路径。
 * pending.hash / actionable(2026-10-14):中继真在微信里开了码(主人不在)⇒ 有 hash、actionable=true,
 * 手机可经 POST /m/api/cli/permission 拍板;主人在场、终端自己在问 ⇒ hash=null、actionable=false。
 * 老 daemon 不带这两个字段,客户端当作不可拍。
 */
/**
 * 看着它跑(GET /m/api/cli/activity?session_id=,2026-10-17):最近几步,旧 → 新。
 * you = 主人说的,said = 它说的,step = 它做的一步(已翻成一句人话:「运行 npm test」「改 main.ts」)。at 是记录里的时间(毫秒),读不到为 null。
 */
// detail / error(2026-10-17):step 点开能看的 —— 改文件是 diff(`- 旧` / `+ 新` 行),跑命令是输出尾巴;error = 这一步的工具报错。老 daemon 不带。
export const CliActivityItem = z.object({ kind: z.enum(['you', 'said', 'step']), text: z.string(), at: z.number().nullable(), detail: z.string().optional(), error: z.boolean().optional(),
  // verb + target(2026-10-17):text 是中文成句;按语言显示的端(App)用这两个自己拼。free 文本(模型自己写的说明)没有。
  verb: z.string().optional(), target: z.string().optional() })
export type CliActivityItemT = z.infer<typeof CliActivityItem>
export const CliSessionRow = z.object({
  session_id: z.string(), code: z.string(), source: z.enum(['claude', 'codex', 'cursor']),
  // displayName(收敛清单 ⑥):这家执行者的正式名字,daemon 定;老 daemon 不带 ⇒ 退回 source。
  displayName: z.string().optional(),
  status: z.enum(['running', 'waiting', 'idle', 'ended']), stale: z.boolean(),
  project: z.string(), machine: z.string().nullable(), last_summary: z.string().nullable(),
  last_event_at: z.number(), last_prompt_at: z.number().nullable(), created_at: z.number(),
  pending: z.object({ tool: z.string(), summary: z.string().nullable(), since: z.number(), hash: z.string().nullable().optional(), actionable: z.boolean().optional() }).nullable(),
  // now(2026-10-17):在跑的会话此刻那一步(同 /m/api/cli/activity 的一项,不带 detail)。老 daemon / 读不到不带。
  now: CliActivityItem.optional(),
  // live_window(2026-10-18):这条 Claude 会话开在电脑的终端窗口里 ⇒ 说一句会送进那个窗口,在跑时也能说。老 daemon 不带。
  live_window: z.boolean().optional(),
  // last_say(2026-10-20):最近一句送进窗口的结果 —— 送进窗口是后台的,手机发出后看这里改说法(sending → sent / failed)。老 daemon 不带。
  last_say: z.object({ id: z.string(), state: z.enum(['sending', 'sent', 'failed']), error: z.string().optional(), at: z.number() }).optional(),
})
export type CliSessionRowT = z.infer<typeof CliSessionRow>
export type NativeSessionPageT = z.infer<typeof NativeSessionPage>

/**
 * 「今天」一眼看完(GET /m/api/today,2026-10-14,daemon 的 core/overseer-today.ts):终端 + 一起做,
 * 过去 24 小时(滚动窗)。一件事只在一组里:needsYou(等得最久的在前)/ done / running(新的在前)/
 * stuck(失败、中断在前,再是 30 分钟没动静的)。source=terminal ⇒ id 是会话 id(进 /terminal/[id]);
 * source=together ⇒ id 是 matter id(进 /matter/[id])。project 只是目录名。
 * unavailable 非空 ⇒ 那一路读不到,数字不全,别当「没事」。
 */
export const TodayItem = z.object({
  source: z.enum(['terminal', 'together']), id: z.string(), code: z.string(), project: z.string(), agent: z.string(),
  title: z.string().nullable(), summary: z.string().nullable(), at: z.number(), machine: z.string().nullable(),
})
export const TodayNeed = TodayItem.extend({ kind: z.enum(['permission', 'question']), count: z.number(), replyRef: z.string().nullable() })
export const TodayStuck = TodayItem.extend({ reason: z.enum(['quiet', 'failed', 'interrupted']) })
export const OverseerToday = z.object({
  generatedAt: z.number(), since: z.number(), windowHours: z.number(),
  needsYou: z.array(TodayNeed), done: z.array(TodayItem), running: z.array(TodayItem), stuck: z.array(TodayStuck),
  counts: z.object({ needsYou: z.number(), done: z.number(), running: z.number(), stuck: z.number() }),
  unavailable: z.array(z.enum(['terminal', 'together'])),
})
export type TodayItemT = z.infer<typeof TodayItem>
export type OverseerTodayT = z.infer<typeof OverseerToday>

// ── 在手机上接着做电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions §4.3):只给目录名,matterId 只在 managed 有 ──
export const SESSION_CONTINUE_STATES = ['ready', 'managed', 'busy_session', 'busy_folder', 'provider_missing', 'folder_missing', 'quota', 'empty'] as const
export const SessionContinue = z.object({
  state: z.enum(SESSION_CONTINUE_STATES), provider: z.enum(['claude', 'codex']), displayName: z.string().optional(), project: z.string().nullable(),
  mode: z.enum(['native_resume', 'fresh_context']).nullable(), matterId: z.string().nullable(),
})
export type SessionContinueT = z.infer<typeof SessionContinue>
export const SessionContinueResult = z.object({ matterId: z.string(), created: z.boolean() })

// ── 汇总:`"METHOD /path"` → schema(反向由 daemon 守卫测试核对）───────────

/** 主人对话的后端 / 模型(GET/POST /m/api/chat/model,2026-10-06)。model=null ⇒ 用这个后端的全局设置。 */
export const ChatModelView = z.object({ ok: z.literal(true), mode: z.string(), provider: z.string(), model: z.string().nullable(), globalModel: z.string().nullable(), providers: z.array(z.object({ id: z.string(), name: z.string() })) })

const PHONE_API = {
  'GET /set/api/state': z.union([SetStateSuccess, PhoneErrorResponse]),
  'POST /set/api/apply': z.object({ ok: z.boolean(), error: z.string().optional(), restart: z.enum(['requested', 'required']).optional() }),
  'POST /set/api/pair': z.union([
    z.object({ ok: z.literal(true), device_token: z.string() }),
    z.object({ ok: z.literal(false), error: z.literal('device_limit') }),
    // 单次配对(plan 7a D1):只有链接令牌能配对,设备令牌来配 ⇒ 403 link_only。
    z.object({ ok: z.literal(false), error: z.literal('link_only') }),
  ]),
  'GET /m/api/state': z.union([PhoneStateSuccess, PhoneErrorResponse]),
  'GET /m/api/art/presence': z.object({ ok: z.literal(true), mime: z.literal('image/png'), unlit: z.string(), lit: z.string() }),
  'GET /m/api/memory': z.union([MemorySuccess, PhoneErrorResponse]),
  'POST /m/api/memory/correct': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'GET /m/api/memory/retractions': z.union([MemoryRetractionsSuccess, PhoneErrorResponse]),
  'POST /m/api/memory/restore': z.union([MemoryRestoreSuccess, PhoneErrorResponse]),
  'GET /m/api/home': z.union([HomeSuccess, PhoneErrorResponse]),
  'POST /m/api/seen': z.union([z.object({ ok: z.literal(true), seen_until: z.string() }), PhoneErrorResponse]),
  'GET /m/api/matters': z.union([z.object({ ok: z.literal(true), matters: z.array(Matter) }), PhoneErrorResponse]),
  'GET /m/api/matter/insight': z.union([
    z.object({ ok: z.literal(true), explanations: z.record(z.string(), ApprovalExplanation), progress: ProgressSummary.nullable() }),
    PhoneErrorResponse,
  ]),
  'GET /m/api/matter/changes': z.union([z.object({ ok: z.literal(true), turn: PhoneChangesTurn.nullable() }), PhoneErrorResponse]),
  'POST /m/api/matter/review-mark': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'POST /m/api/matter/review-return': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  // 行评论(切片 4):建 / 删草稿;发出这件事的所有草稿。错误码开放(z.string()):409 review_hunk_stale / review_comment_sent /
  // review_comment_conflict / review_comment_limit / review_round_discarded / workbench_busy / restart_confirmation_required;404 review_comment_not_found。
  'POST /m/api/matter/review-comment': z.union([z.object({ ok: z.literal(true), commentId: z.string().optional(), deleted: z.boolean().optional() }), PhoneErrorResponse]),
  'POST /m/api/matter/review-comments-send': z.union([z.object({ ok: z.literal(true), sent: z.number().optional(), remaining: z.number().optional(), skippedDiscarded: z.number().optional() }), PhoneErrorResponse]),
  // 撤掉这一轮(回退切片 4):只给设备令牌。错误码:409 rewind_confirmation_required / rewind_confirmation_stale / rewind_not_latest /
  // review_round_discarded / rewind_needs_owner / rewind_shared_folder / rewind_merged / rewind_ignored_conflict / workbench_busy;
  // 422 rewind_unavailable(带 reason)/ rewind_noop / not_worktree;502 rewind_failed(带 rolledBack)。
  'GET /m/api/matter/rewind': z.union([z.object({ ok: z.literal(true), preview: PhoneRewindPreview }), PhoneRewindError]),
  'POST /m/api/matter/rewind': z.union([z.object({ ok: z.literal(true), discarded: z.array(z.string()) }), PhoneRewindError]),
  'GET /m/api/matter': z.union([z.object({ ok: z.literal(true) }).extend(MatterDetail.shape), PhoneErrorResponse]),
  'GET /m/api/matter/input-receipt': z.union([MatterInputReceiptResult, PhoneErrorResponse]),
  'POST /m/api/matter/say': z.union([z.object({ ok: z.literal(true), result: MatterSayResult }), PhoneErrorResponse]),
  'GET /m/api/chat': z.union([z.object({ ok: z.literal(true) }).extend(ChatPage.shape), PhoneErrorResponse]),
  'GET /m/api/chat/search': z.union([z.object({ ok: z.literal(true), hits: z.array(ChatSearchHit) }), PhoneErrorResponse]),
  'POST /m/api/chat/say': z.union([z.object({ ok: z.literal(true), matterId: z.string(), job: ChatJob }), PhoneErrorResponse]),
  'GET /m/api/chat/model': z.union([ChatModelView, PhoneErrorResponse]),
  'POST /m/api/chat/model': z.union([ChatModelView, PhoneErrorResponse]),
  'GET /m/api/chat/file': z.union([z.object({ ok: z.literal(true), name: z.string(), mime: z.string(), size: z.number(), sha256: z.string(), offset: z.number(), nextOffset: z.number(), contentBase64: z.string() }), PhoneErrorResponse]),
  'GET /m/api/letters': z.union([z.object({ ok: z.literal(true), letters: z.array(LetterSummary) }), PhoneErrorResponse]),
  // 定时在手机上看得见(对标 B7,2026-10-20):列表 + 停 / 开 / 删;新建仍在微信「定时」。只给设备令牌。
  'GET /m/api/activity': z.union([z.object({ ok: z.literal(true), items: z.array(PhoneActivityItem), next: z.string().nullable(), degraded: z.array(z.string()) }), PhoneErrorResponse]),
  'GET /m/api/jobs': z.union([z.object({ ok: z.literal(true), timezone: z.string(), executor: z.string().nullable(), jobs: z.array(PhoneJob) }), PhoneErrorResponse]),
  'POST /m/api/jobs/action': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'GET /m/api/letters/page': z.union([z.object({ ok: z.literal(true), name: z.string(), mime: z.string(), size: z.number(), sha256: z.string(), offset: z.number(), nextOffset: z.number(), contentBase64: z.string() }), PhoneErrorResponse]),
  'GET /m/api/chat/voice': z.union([z.object({ ok: z.literal(true) }).extend(ChatVoice.shape), PhoneErrorResponse]),
  // 按住说话(2026-10-18):GET 只问电脑上配没配语音转文字;POST 回转好的字(不自动发)。
  // 错误码:stt_not_configured 422 / no_speech 422 / audio_too_large 413 / stt_blocked(网络守护拦下)503 / stt_failed 502 / stt_timeout 504。
  'GET /m/api/chat/transcribe': z.union([z.object({ ok: z.literal(true), configured: z.boolean() }), PhoneErrorResponse]),
  'POST /m/api/chat/transcribe': z.union([z.object({ ok: z.literal(true), text: z.string() }), PhoneErrorResponse]),
  'GET /m/api/connections': z.union([z.object({ ok: z.literal(true) }).extend(Connections.shape), PhoneErrorResponse]),
  // names:两个分段(claude / codex)的正式名字,分段标签用(收敛清单 ⑥);老 daemon 不带。
  'GET /m/api/sessions': z.union([z.object({ ok: z.literal(true), items: z.array(NativeSessionRow), nextCursor: z.string().nullable(), names: z.record(z.string(), z.string()).optional() }), PhoneErrorResponse]),
  'GET /m/api/cli/sessions': z.union([z.object({ ok: z.literal(true), sessions: z.array(CliSessionRow) }), PhoneErrorResponse]),
  // 错误码:not_found 404;cli_not_actionable(终端自己在问,没开码)/ cli_permission_stale(码已失效)409。
  'POST /m/api/cli/permission': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  // 收下即回;结果成为这条会话的下一句 last_summary。错误码:cli_session_busy(在跑 / 在等批准)/ cli_session_ended / cli_session_remote(在别的电脑上)409,not_found 404。
  // say_id:只在送进开着的窗口时给,对上会话行的 last_say.id 才是这一句的结果
  'POST /m/api/cli/say': z.union([z.object({ ok: z.literal(true), accepted: z.literal(true), say_id: z.string().optional() }), PhoneErrorResponse]),
  // 错误码:not_found 404;cli_session_remote(记录在别的电脑上)/ no_transcript(没有可读的记录)409。
  'GET /m/api/cli/activity': z.union([z.object({ ok: z.literal(true), items: z.array(CliActivityItem) }), PhoneErrorResponse]),
  'GET /m/api/today': z.union([z.object({ ok: z.literal(true), today: OverseerToday }), PhoneErrorResponse]),
  'GET /m/api/session': z.union([z.object({ ok: z.literal(true) }).extend(NativeSessionPage.shape), PhoneErrorResponse]),
  'GET /m/api/session/continue': z.union([z.object({ ok: z.literal(true) }).extend(SessionContinue.shape), PhoneErrorResponse]),
  'POST /m/api/session/continue': z.union([z.object({ ok: z.literal(true) }).extend(SessionContinueResult.shape), PhoneErrorResponse]),
  'POST /m/api/todo': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'GET /m/api/sticker/': z.union([z.object({ ok: z.literal(true), mime: z.string(), data: z.string() }), PhonePlainError]),
  'POST /m/api/attachment/chunk': z.union([z.object({ ok: z.literal(true) }).extend(UploadState.shape), PhoneErrorResponse]),
  'GET /m/api/attachment/upload': z.union([z.object({ ok: z.literal(true) }).extend(UploadState.shape), PhoneErrorResponse]),
  'POST /m/api/attachment/discard': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'GET /m/api/entry/models': z.union([z.object({ ok: z.literal(true), catalog: EntryModelCatalog }), PhoneErrorResponse]),
  'GET /m/api/entry/options': z.union([z.object({ ok: z.literal(true) }).extend(EntryOptions.shape), PhoneErrorResponse]),
  'POST /m/api/matter/create': z.union([z.object({ ok: z.literal(true) }).extend(EntryResult.shape), PhoneErrorResponse]),
  'GET /m/api/matter/create-receipt': z.union([z.object({ ok: z.literal(true) }).extend(EntryResult.shape), PhoneErrorResponse]),
  'POST /m/api/matter/permission': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'POST /m/api/matter/stop': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  // run / stop(2026-10-20)回分支 + 脚本状态 + 端口;没批 ⇒ 428 script_needs_computer(批准只在电脑上),在跑 409,没有 run 脚本 422 no_scripts。
  'POST /m/api/matter/worktree': z.union([z.object({ ok: z.literal(true), branch: z.string(), committed: z.boolean().optional(), removed: z.boolean().optional(), merged: z.boolean().optional(), reopened: z.boolean().optional(),
    port: z.number().int().optional(), setup: z.string().optional(), run: z.string().optional(), approved: z.boolean().optional() }), PhoneErrorResponse]),
  'POST /m/api/matter/answer': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'GET /m/api/matter/artifact': z.union([z.object({ ok: z.literal(true) }).extend(MatterArtifactChunk.shape), PhoneErrorResponse]),
  'POST /m/api/matter/handoff': z.union([z.object({ ok: z.literal(true) }).extend(MatterHandoffResult.shape), PhoneErrorResponse]),
  'POST /m/api/push/register': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'POST /m/api/push/test': z.union([z.object({ ok: z.literal(true), result: z.object({ ok: z.boolean(), code: z.string() }) }), PhoneErrorResponse]),
} satisfies Partial<Record<PanelRouteKey, z.ZodTypeAny>>

export const PHONE_API_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = PHONE_API

/** 有返回形状的那些路由键(架构终态 F3:类型化客户端只认这些)。 */
export type PhoneApiKey = keyof typeof PHONE_API
/** 这条路由的返回(含失败那几种形状)。 */
export type PhoneApiResponse<K extends PhoneApiKey> = z.infer<(typeof PHONE_API)[K]>
/** 成功那一半:去掉 `{ ok:false, error }` 与裸 `{ error }`(失败由传输层先按状态码 / 错误码挡掉)。 */
export type PhoneApiOk<K extends PhoneApiKey> = Exclude<PhoneApiResponse<K>, { ok: false } | { error: string; ok?: never }>
