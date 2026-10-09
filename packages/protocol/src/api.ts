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
 * `PHONE_API_SCHEMAS` 用 `"METHOD /path"` 精确键,跟 `src/daemon/phone-routes.ts`
 * 的 `PHONE_ROUTES` 同一个键形状(含 `GET /m/api/sticker/` 这个前缀键 —— schema
 * 只覆盖它 `?b64=1` 的 JSON 形式,裸图片二进制不是 JSON,不在这里管)。
 *
 * zod v4:用默认导出 `import z from 'zod'`(具名 `{ z }` 在 vitest 打包下会解析
 * 成 undefined,见 messages.ts 同一条注释)。
 */
import z from 'zod'

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
  sourcePath: z.string().optional(),
  workspace: z.object({id:z.string(),mode:z.literal('isolated'),sourcePath:z.string(),executionPath:z.string(),branch:z.string(),baseCommit:z.string(),removed:z.boolean().optional()}).optional(),

  id: z.string(), title: z.string(), status: z.string(), phase: z.string().optional(),
  providerId: z.string(), path: z.string(), error: z.string().nullable(), updatedAt: z.number(),
  archivedAt: z.number().nullable().optional(),
  // 独立工作区(2026-10-07):分支名 + 工作区删了没;手机据此给「提交到分支 / 删除工作区」。
  worktree: z.object({ projectPath: z.string().optional(), projectId: z.string().optional(), branch: z.string(), removed: z.boolean(), merged: z.boolean().optional() }).optional(),
})

export const MatterEvent = z.object({
  kind: z.string(), text: z.string(), createdAt: z.number(),
  source: z.string().optional(), attachments: z.array(Attachment).optional(),
  errorCode: z.literal('execution_model_unsupported').optional(), diagnostic: z.string().optional(),
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
 * apps/mobile/src/entry.js:80 真读 `provider.capabilities.features.attachments`
 * 来决定材料能不能带着交办,不是只透传展示,类型漂移(比如变成字符串)必须被挡住。 */
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
    id: z.string(), displayName: z.string(), available: z.boolean(),
    unavailableReason: Reason.optional(),
    capabilities: WorkbenchExecutorCapabilities,
  })),
  projects: z.array(ProjectCatalogEntry),
})

/** workbench/service.ts 的 `WorkbenchTaskView`(entry/create 与 create-receipt 回的任务快照)。 */
export const WorkbenchTaskView = z.object({
  sourcePath: z.string().optional(),
  workspace: z.object({id:z.string(),mode:z.literal('isolated'),sourcePath:z.string(),executionPath:z.string(),branch:z.string(),baseCommit:z.string(),removed:z.boolean().optional()}).optional(),
  worktree: z.object({projectPath:z.string(),branch:z.string(),removed:z.boolean()}).optional(),

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

const FeedSuccess = z.object({
  ok: z.literal(true), events: z.array(FeedEvent), next_cursor: z.string().nullable(), sources_degraded: z.array(FeedSourceName),
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
})
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

/** atelier-model-provision.ts 的 `ModelProvisionStatus`(判别联合,`state` 判别)。 */
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
  // FactRow.time_ref(src/core/knowledge/store.ts):string|null —— apps/mobile/src/home.js:10
  // 直接把它拼进 innerHTML,真读,不是透传。
  time_ref: z.string().nullable(), updated_at: z.number(), display: z.string(),
})

const PhoneStateSuccess = z.object({
  ok: z.literal(true), name: z.string(),
  todos: z.object({ active: z.array(TodoRow), settled: z.array(TodoRow) }),
  portrait: z.string().nullable(),
  stickers: z.array(z.object({ file: z.string(), tags: z.array(z.string()), desc: z.string().optional() })),
})

// ── 每条路由的响应形状(与 mobileMatterError 的 say 结果联合体）──────────

export const MatterSayResult = z.union([
  z.object({ kind: z.literal('task'), task: MatterTaskView, input: MatterInput.optional() }),
  z.object({ kind: z.literal('chat'), reply: z.string() }),
])

export const PhoneChangesTurn = z.object({
  createdAt: z.number(), status: z.enum(['complete', 'partial', 'unavailable']),
  files: z.array(z.object({ path: z.string(), kind: z.enum(['added', 'deleted', 'modified', 'not_reviewed']), diff: z.string().optional(), reason: z.string().optional(), truncated: z.boolean() })),
  omittedFiles: z.number(),
  /** 本轮审阅的说明(为什么是 partial 等),至多 10 条、每条 ≤ 200 字。 */
  notes: z.array(z.string()),
})

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
 * - file:只给名字。文件在电脑上;手机没有取文件的路由(不为它新开一条)。
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
    action: z.object({ label: z.string(), where: z.enum(['desktop', 'settings', 'wechat']), url: z.string().optional() }).optional(),
  })).optional(),
})
export type ConnectionsT = z.infer<typeof Connections>

// ── 电脑上的原生会话(只读,spec 2026-10-01):key 是 base64url{providerId,nativeId},不给 cwd / nativeId ──
export const NativeSessionRow = z.object({ key: z.string(), provider: z.enum(['claude', 'codex']), title: z.string(), project: z.string().nullable(), updatedAt: z.number().nullable(), active: z.boolean() })
export const NativeSessionMessage = z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), truncated: z.boolean() })
export const NativeSessionPage = z.object({ session: NativeSessionRow, messages: z.array(NativeSessionMessage), nextCursor: z.string().nullable(), managed: z.boolean(), window: z.enum(['recent', 'start']).optional() })
export type NativeSessionRowT = z.infer<typeof NativeSessionRow>
export type NativeSessionPageT = z.infer<typeof NativeSessionPage>

// ── 在手机上接着做电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions §4.3):只给目录名,matterId 只在 managed 有 ──
export const SESSION_CONTINUE_STATES = ['ready', 'managed', 'busy_session', 'busy_folder', 'provider_missing', 'folder_missing', 'quota', 'empty'] as const
export const SessionContinue = z.object({
  state: z.enum(SESSION_CONTINUE_STATES), provider: z.enum(['claude', 'codex']), project: z.string().nullable(),
  mode: z.enum(['native_resume', 'fresh_context']).nullable(), matterId: z.string().nullable(),
})
export type SessionContinueT = z.infer<typeof SessionContinue>
export const SessionContinueResult = z.object({ matterId: z.string(), created: z.boolean() })

// ── 汇总:`"METHOD /path"` → schema(反向由 daemon 守卫测试核对）───────────

/** 主人对话的后端 / 模型(GET/POST /m/api/chat/model,2026-10-06)。model=null ⇒ 用这个后端的全局设置。 */
export const ChatModelView = z.object({ ok: z.literal(true), mode: z.string(), provider: z.string(), model: z.string().nullable(), globalModel: z.string().nullable(), providers: z.array(z.object({ id: z.string(), name: z.string() })) })

export const PHONE_API_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  'GET /set/api/state': z.union([SetStateSuccess, PhoneErrorResponse]),
  'POST /set/api/apply': z.object({ ok: z.boolean(), error: z.string().optional(), restart: z.enum(['requested', 'required']).optional() }),
  'POST /set/api/pair': z.union([
    z.object({ ok: z.literal(true), device_token: z.string() }),
    z.object({ ok: z.literal(false), error: z.literal('device_limit') }),
    // 单次配对(plan 7a D1):只有链接令牌能配对,设备令牌来配 ⇒ 403 link_only。
    z.object({ ok: z.literal(false), error: z.literal('link_only') }),
  ]),
  'GET /m/api/state': z.union([PhoneStateSuccess, PhoneErrorResponse]),
  'GET /m/api/art/blink': z.object({ ok: z.literal(true), mime: z.literal('image/png'), half: z.string(), closed: z.string() }),
  'GET /m/api/art/presence': z.object({ ok: z.literal(true), mime: z.literal('image/png'), unlit: z.string(), lit: z.string() }),
  'GET /m/api/memory': z.union([MemorySuccess, PhoneErrorResponse]),
  'POST /m/api/memory/correct': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'GET /m/api/home': z.union([HomeSuccess, PhoneErrorResponse]),
  'GET /m/api/feed': z.union([FeedSuccess, PhoneErrorResponse]),
  'POST /m/api/seen': z.union([z.object({ ok: z.literal(true), seen_until: z.string() }), PhoneErrorResponse]),
  'GET /m/api/matters': z.union([z.object({ ok: z.literal(true), matters: z.array(Matter) }), PhoneErrorResponse]),
  'GET /m/api/matter/insight': z.union([
    z.object({ ok: z.literal(true), explanations: z.record(z.string(), ApprovalExplanation), progress: ProgressSummary.nullable() }),
    PhoneErrorResponse,
  ]),
  'GET /m/api/matter/changes': z.union([z.object({ ok: z.literal(true), turn: PhoneChangesTurn.nullable() }), PhoneErrorResponse]),
  'GET /m/api/matter': z.union([z.object({ ok: z.literal(true) }).extend(MatterDetail.shape), PhoneErrorResponse]),
  'GET /m/api/matter/input-receipt': z.union([MatterInputReceiptResult, PhoneErrorResponse]),
  'POST /m/api/matter/say': z.union([z.object({ ok: z.literal(true), result: MatterSayResult }), PhoneErrorResponse]),
  'GET /m/api/chat': z.union([z.object({ ok: z.literal(true) }).extend(ChatPage.shape), PhoneErrorResponse]),
  'GET /m/api/chat/search': z.union([z.object({ ok: z.literal(true), hits: z.array(ChatSearchHit) }), PhoneErrorResponse]),
  'POST /m/api/chat/say': z.union([z.object({ ok: z.literal(true), matterId: z.string(), job: ChatJob }), PhoneErrorResponse]),
  'GET /m/api/chat/model': z.union([ChatModelView, PhoneErrorResponse]),
  'POST /m/api/chat/model': z.union([ChatModelView, PhoneErrorResponse]),
  'GET /m/api/chat/file': z.union([z.object({ ok: z.literal(true), name: z.string(), mime: z.string(), size: z.number(), sha256: z.string(), offset: z.number(), nextOffset: z.number(), contentBase64: z.string() }), PhoneErrorResponse]),
  'GET /m/api/chat/voice': z.union([z.object({ ok: z.literal(true) }).extend(ChatVoice.shape), PhoneErrorResponse]),
  'GET /m/api/connections': z.union([z.object({ ok: z.literal(true) }).extend(Connections.shape), PhoneErrorResponse]),
  'GET /m/api/sessions': z.union([z.object({ ok: z.literal(true), items: z.array(NativeSessionRow), nextCursor: z.string().nullable() }), PhoneErrorResponse]),
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
  'POST /m/api/matter/worktree': z.union([z.object({ ok: z.literal(true), branch: z.string(), committed: z.boolean().optional(), removed: z.boolean().optional(), merged: z.boolean().optional(), reopened: z.boolean().optional() }), PhoneErrorResponse]),
  'POST /m/api/matter/answer': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'GET /m/api/matter/artifact': z.union([z.object({ ok: z.literal(true) }).extend(MatterArtifactChunk.shape), PhoneErrorResponse]),
  'POST /m/api/matter/handoff': z.union([z.object({ ok: z.literal(true) }).extend(MatterHandoffResult.shape), PhoneErrorResponse]),
  'POST /m/api/push/register': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'POST /m/api/push/test': z.union([z.object({ ok: z.literal(true), result: z.object({ ok: z.boolean(), code: z.string() }) }), PhoneErrorResponse]),
}
