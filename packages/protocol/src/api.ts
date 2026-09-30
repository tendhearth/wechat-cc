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
  id: z.string(), title: z.string(), status: z.string(), phase: z.string().optional(),
  providerId: z.string(), path: z.string(), error: z.string().nullable(), updatedAt: z.number(),
  archivedAt: z.number().nullable().optional(),
})

export const MatterEvent = z.object({
  kind: z.string(), text: z.string(), createdAt: z.number(),
  source: z.string().optional(), attachments: z.array(Attachment).optional(),
})

export const MatterInput = z.object({
  id: z.string(), taskId: z.string(), runId: z.string(), text: z.string(),
  status: z.enum(['pending', 'sending', 'delivered', 'held', 'withdrawn']),
  attachments: z.array(Attachment).optional(),
})

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

export const MatterDetail = z.object({
  matter: Matter, bindings: z.array(MatterBinding), sessions: z.array(MatterSession),
  task: MatterTaskView.nullable(), events: z.array(MatterEvent),
  runId: z.string().optional(), inputMode: z.enum(['steer', 'send', 'queue']).optional(),
  permissions: z.array(MatterPermission), questions: z.array(MatterQuestion),
  artifacts: z.array(MatterArtifact), inputs: z.array(MatterInput),
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
const MemorySuccess = z.object({
  ok: z.literal(true), updated_at: z.string().nullable(), when_label: z.string().nullable(),
  mood: z.enum(['changed', 'steady', 'first']), failures: z.number(), changes: z.array(ViewChange),
  sections: z.array(z.object({ name: MemorySection, items: z.array(CuratedItem) })),
})

// ── 设置页(/set/api/*,settings-panel.ts state()）───────────────────────

const DeviceRow = z.object({
  id: z.string(), created_at: z.string(), last_seen_at: z.string(), label: z.string().optional(), current: z.boolean(),
})

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

const MatterSayResult = z.union([
  z.object({ kind: z.literal('task'), task: MatterTaskView, input: MatterInput.optional() }),
  z.object({ kind: z.literal('chat'), reply: z.string() }),
])

export const PhoneChangesTurn = z.object({
  createdAt: z.number(), status: z.enum(['complete', 'partial', 'unavailable']),
  files: z.array(z.object({ path: z.string(), kind: z.enum(['added', 'deleted', 'modified', 'not_reviewed']), diff: z.string().optional(), truncated: z.boolean() })),
  omittedFiles: z.number(),
})

// ── 汇总:`"METHOD /path"` → schema(反向由 daemon 守卫测试核对）───────────

export const PHONE_API_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  'GET /set/api/state': z.union([SetStateSuccess, PhoneErrorResponse]),
  'POST /set/api/apply': z.object({ ok: z.boolean(), error: z.string().optional(), restart: z.enum(['requested', 'required']).optional() }),
  'POST /set/api/pair': z.union([
    z.object({ ok: z.literal(true), device_token: z.string() }),
    z.object({ ok: z.literal(false), error: z.literal('device_limit') }),
  ]),
  'GET /m/api/state': z.union([PhoneStateSuccess, PhoneErrorResponse]),
  'GET /m/api/art/blink': z.object({ ok: z.literal(true), mime: z.literal('image/png'), half: z.string(), closed: z.string() }),
  'GET /m/api/art/presence': z.object({ ok: z.literal(true), mime: z.literal('image/png'), unlit: z.string(), lit: z.string() }),
  'GET /m/api/memory': z.union([MemorySuccess, PhoneErrorResponse]),
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
  'POST /m/api/matter/say': z.union([z.object({ ok: z.literal(true), result: MatterSayResult }), PhoneErrorResponse]),
  'POST /m/api/todo': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'GET /m/api/sticker/': z.union([z.object({ ok: z.literal(true), mime: z.string(), data: z.string() }), PhonePlainError]),
  'POST /m/api/attachment/chunk': z.union([z.object({ ok: z.literal(true) }).extend(UploadState.shape), PhoneErrorResponse]),
  'GET /m/api/attachment/upload': z.union([z.object({ ok: z.literal(true) }).extend(UploadState.shape), PhoneErrorResponse]),
  'POST /m/api/attachment/discard': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'GET /m/api/entry/options': z.union([z.object({ ok: z.literal(true) }).extend(EntryOptions.shape), PhoneErrorResponse]),
  'POST /m/api/matter/create': z.union([z.object({ ok: z.literal(true) }).extend(EntryResult.shape), PhoneErrorResponse]),
  'GET /m/api/matter/create-receipt': z.union([z.object({ ok: z.literal(true) }).extend(EntryResult.shape), PhoneErrorResponse]),
  'POST /m/api/matter/permission': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'POST /m/api/matter/answer': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'GET /m/api/matter/artifact': z.union([z.object({ ok: z.literal(true) }).extend(MatterArtifactChunk.shape), PhoneErrorResponse]),
  'POST /m/api/push/register': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'POST /m/api/push/test': z.union([z.object({ ok: z.literal(true), result: z.object({ ok: z.boolean(), code: z.string() }) }), PhoneErrorResponse]),
}
