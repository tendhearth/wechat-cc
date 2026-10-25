/**
 * Zod schemas for the daemon's `/v1/*` routes (desktop, CLI, the wechat-mcp stdio child, delegate-mcp).
 * Single source of truth for that HTTP contract — moved here from src/daemon/internal-api/schema.ts
 * (架构终态 F1) so the daemon and every client read the same file. Pure data: zod only, no daemon imports.
 *
 * Convention: <SchemaName> is the zod value; <SchemaName>T is the
 * inferred TS type alias.
 *
 * Validation runs in index.ts before route handler dispatch.
 */
// zod v4: `import { z } from 'zod'` resolves to undefined under vitest's
// bundler; use the default export instead (both forms are equivalent at
// runtime — this is a build-tool interop quirk, not a zod API difference).
import z from 'zod'
import {
  Attachment, Connections, EntryModelCatalog, EntryOptions, EntryReceipt, MATTER_ORIGINS, Matter, MatterDetail, MatterEvent,
  MatterSayResult, OverseerToday, WorkbenchExecutorCapabilities,
} from './api'

// ── GET /v1/health ───────────────────────────────────────────────────────────

export const SubsystemStatusSchema = z.object({
  name: z.string(),
  state: z.enum(['ok', 'degraded', 'off']),
  error: z.string().optional(),
  sinceIso: z.string(),
})

export const HealthResponse = z.object({
  ok: z.boolean(),
  daemon_pid: z.number(),
  // Ops fields (added with the admin self-diagnosis tools). Optional so older
  // consumers and the minimal-deps path still validate.
  turns_store_wired: z.boolean().optional(),
  sessions_live: z.number().optional(),
  heartbeat_fresh: z.boolean().nullable().optional(),
  // 开机时拉消息循环(2026-10-23,self deploy 健康门):老 daemon 没有;null = 还没接上。
  polling: z.object({ eligible: z.number(), started: z.number() }).nullable().optional(),
  // 后台在跑的版本(2026-09-16):桌面更新后 app 用它判断 daemon 是否还是旧的。
  version: z.object({ cli: z.string(), head: z.string().nullable(), boot_at: z.string() }).optional(),
  // Subsystem degraded-boot (spec 2026-08-17) — 启动降级状态表。
  subsystems: z.array(SubsystemStatusSchema).optional(),
  // 网络守护(2026-10-02)—— bx 优先;safe=false ⇒ CC 暂停所有模型调用。老 daemon 没有。
  guard: z.object({
    enabled: z.boolean(),
    source: z.enum(['bx', 'probe', 'off']),
    safe: z.boolean(),
    detail: z.string(),
    ip: z.string().nullable(),
    checked_at: z.string().nullable(),
    // 守护 v2(按调用判):老 daemon 没有这几项。
    signal_source: z.enum(['auto', 'probe']).optional(),
    protected_in_use: z.boolean().optional(),
    paused: z.boolean().optional(),
    providers: z.array(z.object({
      id: z.string(), model: z.string().nullable(), host: z.string().nullable(),
      protected: z.boolean(), kind: z.string(), label: z.string(), reason: z.string(),
    })).optional(),
    // 暂停在跑的任务(2026-10-03):被冻住的任务数与清单。老 daemon 没有。
    suspended: z.number().optional(),
    suspended_tasks: z.array(z.object({ task_id: z.string(), title: z.string(), provider: z.string(), since: z.string() })).optional(),
  }).optional(),
  // 文件访问(macOS TCC,2026-09-04)—— daemon 进程自己能不能读主人的文件夹。
  // 权限缺失此前是静默的;这里让它进 health / doctor / 桌面。
  fs_access: z.object({
    any_denied: z.boolean(),
    folders: z.array(z.object({ folder: z.string(), path: z.string(), state: z.enum(['ok', 'denied', 'missing', 'unknown']) })),
    settings_url: z.string(),
    hint: z.string(),
    // 完全磁盘访问(2026-10-04):null = 非 macOS / 说不清;false 时后台 wxvault 同步暂停。
    full_disk_access: z.boolean().nullable().optional(),
    fda_hint: z.string().optional(),
  }).optional(),
  // 启动时实际加载的插件(2026-09-30)。null = bootstrap 还在接线;老 daemon 没有这个字段。
  plugins: z.object({
    via: z.enum(['env', 'pointer', 'app', 'repo']).nullable(),
    count: z.number(),
    ready_count: z.number(),
    expected_missing: z.array(z.string()),
    pointer_broken: z.boolean(),
    // admin only ↓(/v1/health 是 guest 档,低于 admin 不给路径与原因)
    bundled_dir: z.string().nullable().optional(),
    pointer_dir: z.string().nullable().optional(),
    plugins: z.array(z.object({ name: z.string(), source: z.enum(['bundled', 'user']), enabled: z.boolean(), ready: z.boolean(), reason: z.string().optional() })).optional(),
  }).nullable().optional(),
  // 开机 `--version` 探测失败的外部 CLI provider(2026-10-04)。retrying = 还没注册、在退避
  // 重探(turn / selftest 照旧说不可用);registered = 晚注册成功。老 daemon 没有。
  provider_probes: z.array(z.object({
    id: z.string(),
    state: z.enum(['retrying', 'registered']),
    attempts: z.number(),
    last_error: z.string(),
    first_failed_at: z.string(),
    next_attempt_at: z.string().nullable(),
    registered_at: z.string().nullable(),
  })).optional(),
  // 真回合里被拒着的执行者(2026-10-23):{ [provider]: { code, since } }。只有码和时间(guest 档也给)。
  // 开机探测只跑 --version 判不出这个;一家之后有一轮真完成了就消失。老 daemon 没有。
  provider_refusals: z.record(z.string(), z.object({ code: z.string(), since: z.string() })).optional(),
  // Passive outbound link health (spec 2026-08-22-outbound-health) — sibling
  // of subsystems by design: subsystems is the supervisor's BOOT-time list,
  // outbound is a RUNTIME link signal. Optional for older daemons.
  outbound: z.object({
    state: z.enum(['unknown', 'ok', 'degraded']),
    consecutive_failures: z.number(),
    last_ok_at: z.string().nullable(),
    last_error: z.string().nullable(),
  }).optional(),
  // 外部 agent CLI 自动升级(2026-10-04)。老 daemon 没有。
  cli_upgrade: z.object({
    enabled: z.boolean(),
    check_hour: z.number(),
    active: z.string().nullable(),
    clis: z.array(z.object({
      id: z.string(), label: z.string(), auto: z.boolean(),
      installed: z.string().nullable(), latest: z.string().nullable(), update_available: z.boolean(),
      accepted: z.string().nullable(),
      verify: z.enum(['ok', 'failed', 'unverified', 'unknown']), verify_detail: z.string().nullable(),
      last_check_at: z.string().nullable(), last_check_error: z.string().nullable(), next_check_at: z.string().nullable(),
      pending: z.string().nullable(),
      last_upgrade: z.object({
        from: z.string().nullable(), to: z.string().nullable(), at: z.string(), source: z.string(), result: z.string(), detail: z.string().optional(),
      }).nullable(),
      known_bad: z.array(z.string()),
    })),
  }).optional(),
})

// ── POST /v1/cli/upgrade|rollback(外部 agent CLI 自动升级,2026-10-04) ─────────
export const CliUpgradeRequest = z.object({ name: z.enum(['claude', 'codex', 'cursor', 'agy']), force: z.boolean().optional() })
export const CliRollbackRequest = z.object({ name: z.enum(['claude', 'codex', 'cursor', 'agy']) })

// ── POST /v1/atelier/share ─────────────────────────────────────────────────

const AtelierSharedBackground = z.object({
  title: z.string().trim().min(1).max(120),
  origin: z.string().trim().min(1).max(800),
  approach: z.string().trim().min(1).max(500),
})
export const AtelierShareRequest = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/),
  // null means image-only; an object is the user-reviewed copy sent beside it.
  background: AtelierSharedBackground.nullable(),
})
export const AtelierShareResponse = z.union([
  z.object({ ok: z.literal(true), shared_at: z.string(), background_sent: z.boolean(), warning: z.string().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/memory/read ─────────────────────────────────────────────────────

export const MemoryReadRequest = z.object({
  path: z.string(),
})
export const MemoryReadResponse = z.union([
  z.object({ exists: z.literal(false) }),
  z.object({ exists: z.literal(true), content: z.string() }),
  z.object({ error: z.string() }),
])

// ── POST /v1/memory/write ────────────────────────────────────────────────────

export const MemoryWriteRequest = z.object({
  path: z.string(),
  content: z.string(),
})
export const MemoryWriteResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/memory/view · POST /v1/memory/edit(记忆编辑,设计稿 2026-10-23)──────

const EditableMemoryPath = z.enum(['_overview.md', 'memory.md', 'owner.md'])
export const MemoryViewRequest = z.object({ path: EditableMemoryPath })
export const MemoryEditRequest = z.object({
  path: EditableMemoryPath,
  baseHash: z.string().regex(/^[0-9a-f]{64}$/),
  lines: z.array(z.object({ text: z.string(), lineKey: z.string().optional(), assertionId: z.string().optional() })),
  confirmBulk: z.literal(true).optional(),
})

// ── GET /v1/memory/list ──────────────────────────────────────────────────────

export const MemoryListQuery = z.object({
  dir: z.string().optional(),
})
export const MemoryListResponse = z.union([
  z.object({ files: z.array(z.string()) }),
  z.object({ error: z.string() }),
])

// ── POST /v1/memory/delete (soft-delete + audit) ─────────────────────────────
//
// chat_id is required because the audit event lands in the per-chat events
// store (see docs/specs/2026-05-21-memory-delete-safety-design.md). reason
// is also required and capped — the agent must record why so the dashboard
// audit view (or `wechat-cc events show`) can attribute the delete back to
// what the user actually said.

export const MemoryDeleteRequest = z.object({
  chat_id: z.string(),
  path: z.string()
    .max(500, 'path must be <= 500 chars')
    .refine(s => !s.includes('\0'), { message: 'path must not contain null bytes' }),
  reason: z.string()
    .min(4, 'reason must be at least 4 chars — quote the user or state your inference')
    .max(500, 'reason must be <= 500 chars'),
})
export const MemoryDeleteResponse = z.union([
  z.object({ ok: z.literal(true), existed: z.literal(false) }),
  z.object({ ok: z.literal(true), existed: z.literal(true), tombstone: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])


// ── GET /v1/projects/list ────────────────────────────────────────────────────
// Legacy wire shape: array returned directly (not wrapped).
// Element shape from WechatProjectsDep.list() in wechat-tool-deps.ts.

const ProjectListItem = z.object({
  alias: z.string(),
  path: z.string(),
  current: z.boolean(),
})
export const ProjectsListResponse = z.array(ProjectListItem)

// ── POST /v1/projects/switch ─────────────────────────────────────────────────

export const ProjectsSwitchRequest = z.object({
  alias: z.string(),
})
// Shape from WechatProjectsDep.switchTo: {ok:true,path} | {ok:false,reason}
export const ProjectsSwitchResponse = z.union([
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
])

// ── POST /v1/projects/add ────────────────────────────────────────────────────

export const ProjectsAddRequest = z.object({
  alias: z.string(),
  path: z.string(),
})
export const ProjectsAddResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/projects/remove ─────────────────────────────────────────────────

export const ProjectsRemoveRequest = z.object({
  alias: z.string(),
})
export const ProjectsRemoveResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/user/set_name ───────────────────────────────────────────────────
// chat_id is snake_case — intentional; preserved from legacy wire shape.

export const UserSetNameRequest = z.object({
  chat_id: z.string(),
  // 是个称呼,不是一段话:显示名会进提示词,不设上限就是一条往别处塞长文本的路。
  name: z.string().max(64),
})
export const UserSetNameResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/share/page ──────────────────────────────────────────────────────

export const SharePageRequest = z.object({
  title: z.string(),
  content: z.string(),
  needs_approval: z.boolean().optional(),
  chat_id: z.string().optional(),
  account_id: z.string().optional(),
})
export const SharePageResponse = z.union([
  z.object({ url: z.string(), slug: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/share/resurface ─────────────────────────────────────────────────

export const ShareResurfaceRequest = z.object({
  slug: z.string().optional(),
  title_fragment: z.string().optional(),
})
export const ShareResurfaceResponse = z.union([
  z.object({ url: z.string(), slug: z.string() }),
  z.object({ ok: z.literal(false), reason: z.literal('not found') }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── GET /v1/voice/status ─────────────────────────────────────────────────────
// Pinned to WechatVoiceDep.configStatus() return shape in wechat-tool-deps.ts.

export const VoiceStatusResponse = z.union([
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    provider: z.enum(['http_tts', 'qwen']),
    default_voice: z.string(),
    base_url: z.string().optional(),
    model: z.string().optional(),
    saved_at: z.string(),
  }),
])

// ── POST /v1/voice/save_config ───────────────────────────────────────────────

export const VoiceSaveConfigRequest = z.object({
  provider: z.enum(['http_tts', 'qwen']),
  base_url: z.string().optional(),
  model: z.string().optional(),
  api_key: z.string().optional(),
  default_voice: z.string().optional(),
})
// Pinned to WechatVoiceDep.saveConfig() return shape.
// ok=true branch also includes tested_ms, provider, default_voice.
// Catch path in routes.ts emits {ok:false, reason:'unexpected_error', detail}.
export const VoiceSaveConfigResponse = z.union([
  z.object({ ok: z.literal(true), tested_ms: z.number(), provider: z.string(), default_voice: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string().optional() }),
])

// ── GET /v1/companion/status ─────────────────────────────────────────────────
// Pinned to WechatCompanionDep.status() return shape.

export const CompanionStatusResponse = z.object({
  enabled: z.boolean(),
  timezone: z.string(),
  default_chat_id: z.string().nullable(),
  snooze_until: z.string().nullable(),
  import_local_history: z.boolean(),
})

// ── GET /v1/companion/presence(spec 2026-09-03-companion-presence)───────────
export const PresenceResponse = z.object({
  presence: z.enum(['ok', 'degraded', 'offline']),
  activity: z.object({
    kind: z.enum(['idle', 'chatting', 'hosting_human', 'visiting', 'hosting_peer', 'foraging', 'working']),
    label: z.string(),
    since: z.string().nullable(),
  }),
  news: z.object({
    unread: z.number().int().nonnegative(),
    latest_kind: z.string().nullable(),
    latest_title: z.string().nullable(),
  }),
})

// ── POST /v1/companion/enable ────────────────────────────────────────────────
// Pinned to WechatCompanionDep.enable() return shape (two ok=true variants).
// Union includes forward-compat ok=false branch.

export const CompanionEnableResponse = z.union([
  z.object({
    ok: z.literal(true),
    state_dir: z.string(),
    welcome_message: z.string(),
    cost_estimate_note: z.string(),
  }),
  z.object({ ok: z.literal(true), already_configured: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/companion/disable ───────────────────────────────────────────────
// Pinned to WechatCompanionDep.disable() return shape + forward-compat error.

export const CompanionDisableResponse = z.union([
  z.object({ ok: z.literal(true), enabled: z.literal(false) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/companion/snooze ────────────────────────────────────────────────

export const CompanionSnoozeRequest = z.object({
  minutes: z.number().int().min(1).max(1440),
})
// Pinned to WechatCompanionDep.snooze() return shape + forward-compat error.
export const CompanionSnoozeResponse = z.union([
  z.object({ ok: z.literal(true), until: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/companion/import-local ──────────────────────────────────────────

export const CompanionImportLocalRequest = z.object({
  enabled: z.boolean(),
})
// Pinned to WechatCompanionDep.setImportLocal() return shape + forward-compat error.
export const CompanionImportLocalResponse = z.union([
  z.object({ ok: z.literal(true), import_local_history: z.boolean() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── Customer Review (owner-only app module) ────────────────────────────────


// ── POST /v1/wechat/reply ────────────────────────────────────────────────────

export const WechatReplyRequest = z.object({
  chat_id: z.string(),
  text: z.string(),
  participant_tag: z.string().optional(),
})
export const WechatReplyResponse = z.union([
  z.object({ ok: z.literal(true), msg_id: z.string() }),
  // App 那条路开着回话口(reply sink)时:话被截给 App,没经微信发,所以没有 msg_id。
  z.object({ ok: z.literal(true), captured: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/wechat/reply_voice ──────────────────────────────────────────────
// text is capped at 500 chars (enforced by the route handler).
// Response is from WechatVoiceDep.replyVoice() or the handler's own error shapes.

export const WechatReplyVoiceRequest = z.object({
  chat_id: z.string(),
  text: z.string(),
})
export const WechatReplyVoiceResponse = z.union([
  z.object({ ok: z.literal(true), msgId: z.string() }),
  z.object({ ok: z.literal(false), reason: z.literal('too_long'), limit: z.literal(500) }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string().optional() }),
])

// ── POST /v1/wechat/send_file ────────────────────────────────────────────────

export const WechatSendFileRequest = z.object({
  chat_id: z.string(),
  path: z.string(),
})
export const WechatSendFileResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/wechat/edit_message ─────────────────────────────────────────────

export const WechatEditMessageRequest = z.object({
  chat_id: z.string(),
  msg_id: z.string(),
  text: z.string(),
})
export const WechatEditMessageResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/wechat/broadcast ────────────────────────────────────────────────

export const WechatBroadcastRequest = z.object({
  text: z.string(),
  account_id: z.string().optional(),
})
// deps.ilink.broadcast() returns {ok: number, failed: number} (counts).
// Catch path returns {ok:false, error}.
export const WechatBroadcastResponse = z.union([
  z.object({ ok: z.number(), failed: z.number() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/delegate ────────────────────────────────────────────────────────
// cwd must start with '/' if provided (enforced by route handler).

export const DelegateRequest = z.object({
  peer: z.string(),
  prompt: z.string(),
  context_summary: z.string().optional(),
  cwd: z.string().refine(s => s.startsWith('/'), { message: 'cwd_must_be_absolute' }).optional(),
  depth: z.number().optional(),
})
export const DelegateResponse = z.union([
  z.object({
    ok: z.literal(true),
    response: z.string(),
    num_turns: z.number().optional(),
    duration_ms: z.number().optional(),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
])

// ── A2A dashboard routes ─────────────────────────────────────────────────────

export const A2APreviewRequest = z.object({ url: z.string().url() })
export const A2APreviewResponse = z.union([
  z.object({
    name: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    proto_version: z.number(),
    proto_mismatch: z.boolean(),
    auth: z.object({ type: z.string(), required: z.boolean() }).optional(),
    capabilities: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      endpoint: z.string().optional(),
      method: z.string().optional(),
    })).optional(),
  }),
  z.object({ error: z.string() }),
])

export const A2AInstallRequest = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(128),
  url: z.string().url(),
  outbound_api_key: z.string().default(''),
})
export const A2AInstallResponse = z.union([
  z.object({ ok: z.literal(true), inbound_api_key: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

export const A2ARemoveRequest = z.object({ id: z.string() })
export const A2APauseRequest = z.object({ id: z.string(), paused: z.boolean() })

// ── POST /v1/plugins/toggle ──────────────────────────────────────────────────
export const PluginToggleRequest = z.object({ name: z.string(), enabled: z.boolean() })
export type PluginToggleRequestT = z.infer<typeof PluginToggleRequest>
export const PluginInstallRequest = z.object({ name: z.string() })
export type PluginInstallRequestT = z.infer<typeof PluginInstallRequest>
// POST /v1/plugins/upgrade reuses the same { name } shape.
export const LicenseActivateRequest = z.object({ key: z.string() })
export type LicenseActivateRequestT = z.infer<typeof LicenseActivateRequest>

export type A2APreviewRequestT = z.infer<typeof A2APreviewRequest>
export type A2AInstallRequestT = z.infer<typeof A2AInstallRequest>
export type A2ARemoveRequestT = z.infer<typeof A2ARemoveRequest>
export type A2APauseRequestT = z.infer<typeof A2APauseRequest>

// ── POST /v1/a2a/send ────────────────────────────────────────────────────────

export const A2ASendRequest = z.object({
  agent_id: z.string().min(1).max(64),
  text: z.string().min(1),
})
export const A2ASendResponse = z.union([
  z.object({ ok: z.literal(true), http_status: z.number().optional(), response: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.string(), http_status: z.number().optional(), registered: z.array(z.string()).optional() }),
])
export type A2ASendRequestT = z.infer<typeof A2ASendRequest>

// 心愿 (2026-09-04) has no entry here on purpose: the wish routes
// (routes-social.ts) are inline-validated per the pair/inbound routes'
// precedent, so they get no REQUEST_SCHEMAS entry.

// ── POST /v1/a2a/test ────────────────────────────────────────────────────────
// Server-side smoke test for the dashboard's Test button. With outbound=false
// (default), the daemon performs a synthetic inbound notify against its own
// /a2a/notify (using the agent's inbound_api_key — never exposed to clients).
// With outbound=true, behaves identically to /v1/a2a/send.
export const A2ATestRequest = z.object({
  agent_id: z.string().min(1).max(64),
  text: z.string().min(1),
  outbound: z.boolean().default(false),
})
export const A2ATestResponse = z.union([
  z.object({ ok: z.literal(true), direction: z.enum(['in', 'out']), http_status: z.number().optional(), response: z.unknown().optional() }),
  z.object({ ok: z.literal(false), direction: z.enum(['in', 'out']), error: z.string(), http_status: z.number().optional() }),
])
export type A2ATestRequestT = z.infer<typeof A2ATestRequest>

// ── POST /v1/conversation/set-mode ──────────────────────────────────────────
// chatId is camelCase — intentional divergence from other wechat routes.
// Mode is a discriminated union matching the runtime Mode type in conversation.ts.

// parallel/chatroom carry an optional explicit participant list — dashboard
// sends `{kind:'chatroom', participants:['claude','cursor']}` to opt the user
// into a specific N-way set. Pre-fix the schema omitted `participants` so
// zod (default behavior strips unknown keys on discriminated-union arms)
// silently dropped the field before the handler saw it, downgrading the
// mode to "use registry default" — visible to the user as their explicit
// participant choice being ignored.
const ModeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('solo'), provider: z.string(), model: z.string().min(1).max(100).optional() }),
  z.object({ kind: z.literal('parallel'), participants: z.array(z.string()).optional() }),
  z.object({ kind: z.literal('primary_tool'), primary: z.string() }),
  z.object({ kind: z.literal('chatroom'), participants: z.array(z.string()).optional() }),
])

export const ConversationSetModeRequest = z.object({
  chatId: z.string(),
  mode: ModeSchema,
  /** Skip the route's own「🎛 已切换到 …」wechat reply — the caller (wechat-mcp
   *  provider_switch) is an agent that will tell the user itself. */
  quiet: z.boolean().optional(),
})
export const ConversationSetModeResponse = z.union([
  /** notice:切到的这家「问不了就放行」时要照实告诉主人的那一句(domain/enforcement-matrix 的 noAskNotice:从真判定推出来)。 */
  z.object({ ok: z.literal(true), notice: z.string().optional() }),
  z.object({ error: z.string() }),
])

// ── reminders (per-chat precise-time; spec 2026-08-20-reminders-port) ────────
// Caller supplies EITHER an absolute due_at (ISO 8601) OR a relative
// delay_seconds (the daemon computes due_at = now + delay using its own clock,
// avoiding timezone ambiguity). Exactly one must be present. Session-origin
// callers are scoped to their own chat in routes-reminders.ts.

export const ReminderScheduleRequest = z.object({
  chat_id: z.string().min(1),
  text: z.string().min(1).max(4000),
  due_at: z.string().datetime({ offset: true }).optional(),
  delay_seconds: z.number().int().min(1).max(60 * 60 * 24 * 365).optional(),
}).refine(
  b => (b.due_at === undefined) !== (b.delay_seconds === undefined),
  { message: 'provide exactly one of due_at or delay_seconds' },
)
export const ReminderScheduleResponse = z.union([
  z.object({ ok: z.literal(true), reminder_id: z.string(), due_at: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

export const ReminderCancelRequest = z.object({
  chat_id: z.string().min(1),
  reminder_id: z.string().min(1),
})
export const ReminderCancelResponse = z.union([
  z.object({ ok: z.literal(true), cancelled: z.boolean() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

export const ReminderListQuery = z.object({ chat_id: z.string().min(1) })
export const ReminderListResponse = z.union([
  z.object({ ok: z.literal(true), reminders: z.array(z.object({
    id: z.string(), due_at: z.string(), text: z.string(), status: z.string(),
  })) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

export type ReminderScheduleRequestT = z.infer<typeof ReminderScheduleRequest>
export type ReminderCancelRequestT = z.infer<typeof ReminderCancelRequest>

// ── Inferred TS type aliases ────────────────────────────────────────────
// Convention: <Schema>T is z.infer<typeof <Schema>>. JSDoc consumers and
// handler signatures import these aliases.

export type HealthResponseT = z.infer<typeof HealthResponse>

export type MemoryReadRequestT = z.infer<typeof MemoryReadRequest>
export type MemoryReadResponseT = z.infer<typeof MemoryReadResponse>
export type MemoryWriteRequestT = z.infer<typeof MemoryWriteRequest>
export type MemoryViewRequestT = z.infer<typeof MemoryViewRequest>
export type MemoryEditRequestT = z.infer<typeof MemoryEditRequest>
export type MemoryWriteResponseT = z.infer<typeof MemoryWriteResponse>
export type MemoryListQueryT = z.infer<typeof MemoryListQuery>
export type MemoryListResponseT = z.infer<typeof MemoryListResponse>
export type MemoryDeleteRequestT = z.infer<typeof MemoryDeleteRequest>
export type MemoryDeleteResponseT = z.infer<typeof MemoryDeleteResponse>

export type ProjectsListResponseT = z.infer<typeof ProjectsListResponse>
export type ProjectsSwitchRequestT = z.infer<typeof ProjectsSwitchRequest>
export type ProjectsSwitchResponseT = z.infer<typeof ProjectsSwitchResponse>
export type ProjectsAddRequestT = z.infer<typeof ProjectsAddRequest>
export type ProjectsAddResponseT = z.infer<typeof ProjectsAddResponse>
export type ProjectsRemoveRequestT = z.infer<typeof ProjectsRemoveRequest>
export type ProjectsRemoveResponseT = z.infer<typeof ProjectsRemoveResponse>

export type UserSetNameRequestT = z.infer<typeof UserSetNameRequest>
export type UserSetNameResponseT = z.infer<typeof UserSetNameResponse>

export type SharePageRequestT = z.infer<typeof SharePageRequest>
export type SharePageResponseT = z.infer<typeof SharePageResponse>
export type ShareResurfaceRequestT = z.infer<typeof ShareResurfaceRequest>
export type ShareResurfaceResponseT = z.infer<typeof ShareResurfaceResponse>

export type VoiceStatusResponseT = z.infer<typeof VoiceStatusResponse>
export type VoiceSaveConfigRequestT = z.infer<typeof VoiceSaveConfigRequest>
export type VoiceSaveConfigResponseT = z.infer<typeof VoiceSaveConfigResponse>

export type CompanionStatusResponseT = z.infer<typeof CompanionStatusResponse>
export type CompanionEnableResponseT = z.infer<typeof CompanionEnableResponse>
export type CompanionDisableResponseT = z.infer<typeof CompanionDisableResponse>
export type CompanionSnoozeRequestT = z.infer<typeof CompanionSnoozeRequest>
export type CompanionSnoozeResponseT = z.infer<typeof CompanionSnoozeResponse>
export type CompanionImportLocalRequestT = z.infer<typeof CompanionImportLocalRequest>
export type CompanionImportLocalResponseT = z.infer<typeof CompanionImportLocalResponse>


export type WechatReplyRequestT = z.infer<typeof WechatReplyRequest>
export type WechatReplyResponseT = z.infer<typeof WechatReplyResponse>
export type WechatReplyVoiceRequestT = z.infer<typeof WechatReplyVoiceRequest>
export type WechatReplyVoiceResponseT = z.infer<typeof WechatReplyVoiceResponse>
export type WechatSendFileRequestT = z.infer<typeof WechatSendFileRequest>
export type WechatSendFileResponseT = z.infer<typeof WechatSendFileResponse>
export type WechatEditMessageRequestT = z.infer<typeof WechatEditMessageRequest>
export type WechatEditMessageResponseT = z.infer<typeof WechatEditMessageResponse>
export type WechatBroadcastRequestT = z.infer<typeof WechatBroadcastRequest>
export type WechatBroadcastResponseT = z.infer<typeof WechatBroadcastResponse>

export type AtelierShareRequestT = z.infer<typeof AtelierShareRequest>
export type AtelierShareResponseT = z.infer<typeof AtelierShareResponse>

export type DelegateRequestT = z.infer<typeof DelegateRequest>
export type DelegateResponseT = z.infer<typeof DelegateResponse>

export type ConversationSetModeRequestT = z.infer<typeof ConversationSetModeRequest>
export type ConversationSetModeResponseT = z.infer<typeof ConversationSetModeResponse>

export type A2ASendResponseT = z.infer<typeof A2ASendResponse>

// ── POST /v1/cli/event ───────────────────────────────────────────────────────
// 终端 claude / codex 会话的 hook 事件(spec 2026-09-09-cli-hook-push §6.1)。
export const CliEventRequest = z.object({
  source: z.enum(['claude', 'codex', 'cursor']),
  kind: z.enum(['stop', 'prompt', 'permission', 'session_end']),
  session_id: z.string().min(1).max(200),
  cwd: z.string().min(1).max(1000),
  text: z.string().max(4000).optional(),
  automated: z.boolean().optional(),
  transcript_path: z.string().max(1000).optional(),
  idle_s: z.number().min(0).optional(),
  machine: z.string().max(200).optional(),
})
export type CliEventRequestT = z.infer<typeof CliEventRequest>

export const CliPermissionRequest = z.object({
  source: z.enum(['claude', 'codex', 'cursor']),
  session_id: z.string().min(1).max(200),
  cwd: z.string().min(1).max(1000),
  tool_name: z.string().min(1).max(200),
  summary: z.string().max(2000).optional(),
  /** 放行规则用的原文(2026-10-19):命令截 2000;文件路径最多 50 条。老 hook 不带 ⇒ allow 规则与初审放不了它。 */
  command: z.string().max(2000).optional(),
  paths: z.array(z.string().min(1).max(1000)).max(50).optional(),
  idle_s: z.number().min(0).optional(),
  machine: z.string().max(200).optional(),
})
export const CliPermissionQuery = z.object({
  hash: z.string().min(1).max(16),
  wait_ms: z.coerce.number().int().min(0).max(60_000).optional(),
})
// ── GET /v1/cli/sessions(终端会话登记处,v76)──────────────────────────────
// ended=1 连已结束的也列;limit 默认 100,封顶 500(= 登记处的行数上限)。
export const CliSessionsQuery = z.object({
  ended: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  // detail=1:每条补开没开着窗口 / 此刻在做哪一步(CC 的 terminal_sessions 用,2026-10-24)
  detail: z.enum(['0', '1']).optional(),
})
// ── POST|GET /v1/cli/say(CC 代主人对终端会话说一句、等回话,terminal_say 2026-10-24)──────────
// code = 会话码(会话 id 前缀,4–12 位十六进制,同「@码」);text 封顶同手机说一句。GET 带票轮询,一次最多挂 25s。
export const CliSayRequest = z.object({
  code: z.string().regex(/^[0-9a-f]{4,64}$/i),
  text: z.string().min(1).max(4000),
})
export const CliSayQuery = z.object({
  ticket: z.string().regex(/^[0-9a-f]{12}$/),
  wait_ms: z.coerce.number().int().min(0).max(60_000).optional(),
})
// ── POST /v1/cli/hooks/install|uninstall(接上 / 撤掉终端里的 Claude Code / Codex)──────────
// sources 缺省:install = 这台机上有、还没接好的那几家;uninstall = 两家都撤。
export const CliHooksRequest = z.object({
  sources: z.array(z.enum(['claude', 'codex', 'cursor'])).min(1).max(3).optional(),
})

// ── POST /v1/letters/write|settings(CC 的信,2026-10-16)────────────────────
// request:主人当面要信时说的话(原话或大意),可空。
export const LettersWriteRequest = z.object({ request: z.string().max(2000).optional(), preview: z.boolean().optional() })
export type LettersWriteRequestT = z.infer<typeof LettersWriteRequest>
export const LettersSettingsRequest = z.object({ enabled: z.boolean() })
export type LettersSettingsRequestT = z.infer<typeof LettersSettingsRequest>

// ══════ 响应契约(F1):工作台 ══════

// ── 工作台共用形状(src/core/workbench/service/types.ts 等的 TS 类型逐字对照)──────────
// 字段类型照真实形状写;但 routes-workbench.test.ts 的工作台替身只回很少几个字段(比如 {task:{id}}),
// 契约检查在测试里跑,于是服务给出的对象里除了这几个键(id / 信封)以外都标成可选:
// 拦得住类型漂移(null 写成 string、枚举多出一个值),拦不住少键。少键靠 TS 类型本身管。

const WorkbenchTaskStatus = z.enum(['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'])
const WorkbenchPhaseEnum = z.enum(['queued', 'working', 'replied', 'failed', 'cancelled', 'interrupted'])
const WorkbenchQuotaKind = z.enum(['quota', 'rate_limit'])
const WorkbenchLiveInputStatus = z.enum(['pending', 'sending', 'delivered', 'held', 'withdrawn'])
/** execution-settings.ts 的 AgentExecutionChoice。 */
const WorkbenchExecutionChoice = z.object({ defaults: z.enum(['provider', 'native']), model: z.string().nullable(), reasoningEffort: z.string().nullable() })
/** service/types.ts 的 ScriptsView(工作区脚本,2026-10-20)。 */
const WorkbenchScriptsView = z.union([
  z.object({ configured: z.literal(false), invalid: z.string() }),
  z.object({
    configured: z.literal(true), approved: z.boolean(), hash: z.string(),
    config: z.object({ setup: z.string().nullable(), run: z.string().nullable(), archive: z.string().nullable() }),
    setup: z.enum(['none', 'pending', 'running', 'done', 'failed']),
    run: z.enum(['none', 'idle', 'queued', 'running']),
    archiving: z.boolean(),
  }),
])
/** agent-provider.ts 的 AgentRuntimeSnapshot。 */
const WorkbenchRuntimeSnapshot = z.object({
  retained: z.boolean(), foreground: z.enum(['unknown', 'running', 'idle']), backgroundCount: z.number(), input: z.enum(['steer', 'send', 'queue']),
})
/** service/types.ts 的 WorkbenchTaskView(store.Task + 视图字段)。 */
export const WorkbenchDesktopTaskView = z.object({
  title: z.string(), path: z.string(), providerId: z.string(), status: WorkbenchTaskStatus,
  workspaceKind: z.enum(['project', 'managed']),
  createdAt: z.number(), updatedAt: z.number(), error: z.string().nullable(), archivedAt: z.number().nullable(),
  phase: WorkbenchPhaseEnum,
  importedOnly: z.boolean().optional(),
  canArchive: z.boolean(),
  writerExit: z.enum(['alive', 'unconfirmed']).optional(),
  worktree: z.object({
    branch: z.string(), projectPath: z.string(), removed: z.boolean(), merged: z.boolean(),
    port: z.number().optional(), scripts: WorkbenchScriptsView.optional(),
  }).optional(),
  waitingFor: z.object({
    taskId: z.string(), title: z.string(), reason: z.enum(['same_path', 'nested_path', 'writer_not_closed']),
    holderWriting: z.boolean().optional(), closeInMs: z.number().nullable().optional(),
  }).nullable(),
  pendingPermissionCount: z.number().optional(),
  pendingQuestionCount: z.number().optional(),
  runtime: WorkbenchRuntimeSnapshot.optional(),
  networkSuspended: z.object({ since: z.number() }).optional(),
  agents: z.array(z.string()).optional(),
  origin: z.enum(MATTER_ORIGINS).optional(),
  usage: z.object({
    turns: z.number(), input: z.number().nullable(), output: z.number().nullable(), cacheRead: z.number().nullable(),
    cacheWrite: z.number().nullable(), reasoning: z.number().nullable(), costUsd: z.number().nullable(),
  }).optional(),
  until: z.object({
    command: z.string(), maxRounds: z.number(), rounds: z.number(), status: z.enum(['active', 'passed', 'exhausted', 'stopped']),
    lastExit: z.number().nullable(), stopReason: z.string().nullable(),
  }).optional(),
}).partial().extend({ id: z.string() })
export type WorkbenchDesktopTaskViewT = z.infer<typeof WorkbenchDesktopTaskView>
/** live-inputs.ts 的 LiveInput(补充输入回执)。 */
const WorkbenchLiveInput = z.object({
  id: z.string(), taskId: z.string(), runId: z.string(), text: z.string(), status: WorkbenchLiveInputStatus,
  createdAt: z.number(), error: z.string().nullable(),
  attachments: z.array(Attachment).optional(), execution: WorkbenchExecutionChoice.optional(),
}).partial()
/** WorkbenchProject(store.ts)。 */
const WorkbenchProjectRow = z.object({ id: z.string(), path: z.string(), name: z.string(), providerId: z.string(), createdAt: z.number().optional() })
/** continuation.ts 的 Continuation(续接前的判断:新开 / 恢复 / 要带上下文重开)。 */
const WorkbenchRestartPreview = z.object({
  token: z.string(), context: z.string(), eventCount: z.number().optional(), includedEventCount: z.number().optional(), truncated: z.boolean().optional(),
  attachments: z.array(Attachment).optional(), omittedAttachmentCount: z.number().optional(),
})
const WorkbenchContinuation = z.union([
  z.object({ mode: z.enum(['new', 'resume']) }),
  z.object({ mode: z.literal('restart_required'), restart: WorkbenchRestartPreview }),
])
/** native-history.ts 的 NativeHistoryItem。 */
const WorkbenchNativeHistoryItem = z.object({
  key: z.string(), providerId: z.enum(['claude', 'codex']), nativeId: z.string(), title: z.string(),
  titleSource: z.enum(['native_custom', 'native_summary', 'first_prompt', 'fallback']),
  cwd: z.string().nullable(), updatedAt: z.number().nullable(), remote: z.boolean(), observedState: z.enum(['active', 'observed', 'unknown']),
})
/** native-adoption.ts 的 NativeSource(导入的原生会话)。 */
const WorkbenchNativeSource = z.object({
  taskId: z.string(), providerId: z.enum(['claude', 'codex']), nativeId: z.string(), cwd: z.string(),
  importedAt: z.number(), firstDispatchedAt: z.number().nullable(), snapshotSha256: z.string(), observedFingerprint: z.string(),
  selectedMessageCount: z.number(), truncated: z.boolean(),
}).partial().extend({ id: z.string() })
/** native-adoption.ts 的 NativeResumeDecision。 */
const WorkbenchNativeResumeDecision = z.object({
  taskId: z.string(), sourceId: z.string(), providerId: z.enum(['claude', 'codex']), nativeId: z.string(), path: z.string(),
  mode: z.enum(['native_resume', 'fresh_context']), expiresAt: z.number(), context: z.string(), truncated: z.boolean(), changedSinceImport: z.boolean(),
  execution: WorkbenchExecutionChoice.optional(),
}).partial().extend({ token: z.string() })
const WorkbenchArtifactSelection = z.object({ taskId: z.string(), artifactId: z.string(), sha256: z.string() })
const WorkbenchAttachmentSelection = z.object({ taskId: z.string(), attachmentId: z.string(), sha256: z.string() })
const WorkbenchReviewQuote = z.object({ taskId: z.string(), eventId: z.number(), text: z.string() })
/** review-comments.ts 的行评论。 */
const WorkbenchReviewCommentShape = z.object({
  id: z.string(), hunk: z.number(), rowStart: z.number().optional(), rowEnd: z.number().optional(),
  side: z.enum(['old', 'new']).optional(), lineStart: z.number().optional(), lineEnd: z.number().optional(),
  body: z.string(), state: z.enum(['sent', 'draft']), sentAt: z.number().optional(), laterTouched: z.number().optional(),
})
/** 记成项目经验那一下的结果(只附在打回的响应上)。 */
const WorkbenchLessonResult = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.enum(['failed', 'full', 'invalid', 'duplicate', 'no_project', 'too_long', 'not_wired']) }),
])
const WorkbenchOkResponse = z.object({ ok: z.literal(true) })

// ── GET /v1/workbench/entry-options ──
export const WorkbenchEntryOptionsResponse = EntryOptions

// ── POST /v1/workbench/create-entry(202)/ GET /v1/workbench/entry-receipt ──
export const WorkbenchEntryResultResponse = z.object({ receipt: EntryReceipt, task: WorkbenchDesktopTaskView })

// ── GET /v1/workbench(列表)──
export const WorkbenchListResponse = z.object({
  tasks: z.array(WorkbenchDesktopTaskView),
  providers: z.array(z.object({
    id: z.string(), displayName: z.string(),
    settingsLabel: z.string().optional(), capabilities: WorkbenchExecutorCapabilities.optional(),
    quota: z.object({ kind: WorkbenchQuotaKind, since: z.number(), resetAt: z.number(), message: z.string() }).nullable().optional(),
    usage: z.object({
      providerId: z.enum(['claude', 'codex']), plan: z.string().nullable(),
      windows: z.array(z.object({ name: z.string(), usedPercent: z.number(), resetsAt: z.number().nullable(), durationMins: z.number().nullable() })),
      exhausted: z.boolean(), fetchedAt: z.number(),
    }).nullable().optional(),
    refusal: z.object({ code: z.string(), since: z.string() }).nullable().optional(),
  })),
  defaultProvider: z.string().nullable(),
  canWechat: z.boolean(),
}).extend(z.object({
  projects: z.array(WorkbenchProjectRow),
  page: z.object({ limit: z.number(), total: z.number(), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
  projectProviders: z.record(z.string(), z.string()),
  historyProviders: z.array(z.string()),
  agentNames: z.record(z.string(), z.string()),
  unattendedAcknowledgedAt: z.number().nullable(),
}).partial().shape)
export type WorkbenchListResponseT = z.infer<typeof WorkbenchListResponse>

// ── GET /v1/workbench/models ──
export const WorkbenchModelsResponse = z.object({ catalog: EntryModelCatalog })

// ── POST /v1/workbench/attachment / GET /v1/workbench/attachment / POST /v1/workbench/discard-attachment ──
export const WorkbenchAttachmentUploadResponse = z.object({ attachment: Attachment.partial().extend({ id: z.string() }) })
export const WorkbenchAttachmentReadResponse = z.object({ attachment: Attachment, base64: z.string() })

// ── GET /v1/workbench/attention ──
export const WorkbenchAttentionResponse = z.object({
  tasks: z.array(z.object({
    id: z.string(), title: z.string(), providerId: z.string(), pendingPermissionCount: z.number(), pendingQuestionCount: z.number(),
    first: z.object({ kind: z.enum(['permission', 'question']), text: z.string() }).nullable().optional(), attentionKey: z.string(),
  })),
  progress: z.array(z.object({ id: z.string(), phase: WorkbenchPhaseEnum })).optional(),
})

// ── POST /v1/workbench/input ──
export const WorkbenchInputResponse = z.object({ input: WorkbenchLiveInput })

// ── GET /v1/workbench/sessions / GET /v1/workbench/session(原生会话历史)──
export const WorkbenchSessionsResponse = z.object({
  items: z.array(WorkbenchNativeHistoryItem), nextCursor: z.string().nullable(),
  coverage: z.enum(['native_supported_history', 'native_indexed_history']),
})
export const WorkbenchSessionResponse = z.object({
  messages: z.array(z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), truncated: z.boolean() })),
  nextCursor: z.string().nullable(),
  managedTaskId: z.string().optional(),
  session: WorkbenchNativeHistoryItem.optional(),
  sourceFingerprint: z.string().optional(),
  page: z.object({ limit: z.number(), cursor: z.string().nullable() }).optional(),
  truncated: z.boolean().optional(),
})

// ── GET /v1/workbench/task(详情;带 since / wait_ms 时长轮询)──
const WorkbenchTaskEvent = z.object({
  id: z.number(), taskId: z.string(), kind: z.enum(['user', 'text', 'tool_call', 'error', 'system']), text: z.string(), createdAt: z.number(),
  sourceId: z.string().nullable().optional(), runId: z.string().optional(),
  activity: z.object({
    id: z.string(), type: z.enum(['search', 'command', 'read', 'edit', 'tool', 'agent']),
    status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']), label: z.string(),
    detail: z.string().optional(), output: z.string().optional(), parentId: z.string().optional(), agentIds: z.array(z.string()).optional(),
  }).optional(),
  attachments: z.array(Attachment).optional(),
  errorCode: z.literal('execution_model_unsupported').optional(),
  diagnostic: z.string().optional(),
})
const WorkbenchTaskArtifact = z.object({
  id: z.string(), taskId: z.string(), name: z.string(), mime: z.string(), size: z.number(), sha256: z.string(),
  createdAt: z.number(), approvedAt: z.number().nullable(),
})
const WorkbenchHandoffView = z.object({
  id: z.string(), sourceTaskId: z.string(), targetTaskId: z.string(), purpose: z.enum(['review', 'revision']), request: z.string(),
  packetSha256: z.string(), createdAt: z.number(), requestEventId: z.number().nullable(),
  sourceNativeId: z.string().nullable(), targetNativeId: z.string().nullable(),
  artifacts: z.array(WorkbenchArtifactSelection), quote: WorkbenchReviewQuote.nullable(),
  sourceTitle: z.string(), targetTitle: z.string(), sourceProviderId: z.string(), targetProviderId: z.string(),
  sourceStatus: z.string(), targetStatus: z.string(),
})
export const WorkbenchTaskDetailResponse = z.object({
  task: WorkbenchDesktopTaskView,
  events: z.array(WorkbenchTaskEvent),
  artifacts: z.array(WorkbenchTaskArtifact),
}).extend(z.object({
  version: z.number(),
  handoffs: z.array(WorkbenchHandoffView),
  source: WorkbenchNativeSource.optional(),
  wechatNotifications: z.object({
    enabled: z.boolean(),
    notices: z.array(z.object({
      id: z.string(), runId: z.string(),
      kind: z.enum(['permission', 'question', 'completed', 'failed', 'interrupted', 'cancelled']),
      status: z.enum(['pending', 'sending', 'accepted', 'unknown', 'suppressed']),
      reason: z.string().nullable(), createdAt: z.number(),
    })),
  }),
  quotaHandoff: z.union([
    z.object({ state: z.literal('offer'), from: z.string(), to: z.string(), kind: WorkbenchQuotaKind, resetAt: z.number() }),
    z.object({ state: z.literal('none'), from: z.string(), kind: WorkbenchQuotaKind, resetAt: z.number() }),
    z.object({ state: z.literal('handed'), from: z.string(), to: z.string(), matterId: z.string() }),
  ]).nullable(),
  runtime: WorkbenchRuntimeSnapshot.optional(),
  execution: WorkbenchExecutionChoice,
  lastExecution: z.object({
    taskId: z.string(), runId: z.string(), choice: WorkbenchExecutionChoice,
    effective: z.object({
      model: z.string(), reasoningEffort: z.string().optional(), sessionId: z.string().optional(),
      source: z.enum(['native_response', 'native_message', 'native_reroute']),
    }).nullable(),
    createdAt: z.number(), observedAt: z.number().nullable(),
  }).nullable(),
  attachments: z.array(Attachment),
  agentNames: z.record(z.string(), z.string()),
  inputs: z.array(WorkbenchLiveInput),
  questions: z.array(z.object({
    id: z.string(), taskId: z.string(), createdAt: z.number(),
    questions: z.array(z.object({
      id: z.string(), header: z.string(), question: z.string(),
      options: z.array(z.object({ label: z.string(), description: z.string() })),
      multiSelect: z.boolean().optional(), allowOther: z.boolean().optional(),
    })),
  })),
  runId: z.string().optional(),
  inputMode: z.enum(['steer', 'send', 'queue']).optional(),
  rewind: z.object({
    undo: z.object({ rewindId: z.string(), createdAt: z.number() }).nullable(),
    blocked: z.object({ rewindId: z.string(), backupRef: z.string(), reason: z.string().nullable() }).nullable(),
  }).optional(),
  permissions: z.array(z.object({ id: z.string(), taskId: z.string(), tool: z.string(), description: z.string(), createdAt: z.number() })),
  continuation: WorkbenchContinuation,
  requiresExternalClose: z.boolean(),
}).partial().shape)
export type WorkbenchTaskDetailResponseT = z.infer<typeof WorkbenchTaskDetailResponse>

// ── POST /v1/workbench/project ──
export const WorkbenchProjectResponse = z.object({ project: WorkbenchProjectRow })

// ── POST /v1/workbench/create|continue|cancel(202)/ archive / writer-exited:都回 {task} ──
export const WorkbenchTaskResponse = z.object({ task: WorkbenchDesktopTaskView })

// ── GET /v1/workbench/artifact(一段内容,base64)──
export const WorkbenchArtifactResponse = z.object({ name: z.string(), mime: z.string(), size: z.number(), sha256: z.string(), contentBase64: z.string() })

// ── POST /v1/workbench/unattended-ack ──
export const WorkbenchUnattendedAckResponse = z.object({ acknowledgedAt: z.number() })

// ── GET /v1/workbench/review(逐文件审阅)──
const WorkbenchReviewFile = z.object({
  path: z.string(), preexisting: z.boolean(), kind: z.enum(['added', 'deleted', 'modified', 'not_reviewed']),
  beforeSha256: z.string().optional(), afterSha256: z.string().optional(), diff: z.string().optional(), reason: z.string().optional(),
  beforeExecutable: z.boolean().optional(),
  mark: z.object({ mark: z.enum(['accepted', 'returned']), comment: z.string(), createdAt: z.number() }).optional(),
  risk: z.array(z.string()).optional(),
  hunks: z.array(z.object({
    index: z.number(), sha256: z.string(), header: z.string(), oldStart: z.number(), oldCount: z.number(),
    newStart: z.number(), newCount: z.number(), rows: z.number(), reverted: z.object({ at: z.number() }).optional(),
  })).optional(),
  comments: z.array(WorkbenchReviewCommentShape).optional(),
})
export const WorkbenchReviewResponse = z.object({
  reviews: z.array(z.object({
    artifactId: z.string(), status: z.enum(['complete', 'partial', 'unavailable']),
  }).extend(z.object({
    sha256: z.string(), name: z.string(), createdAt: z.number(),
    headBefore: z.string().nullable(), headAfter: z.string().nullable(),
    preexistingPaths: z.array(z.string()), notes: z.array(z.string()),
    files: z.array(WorkbenchReviewFile),
    discarded: z.literal(true).optional(),
    rewindable: z.object({ start: z.boolean(), end: z.boolean() }),
  }).partial().shape)),
})

// ── POST /v1/workbench/review-mark ──
export const WorkbenchReviewMarkResponse = z.object({
  mark: z.object({
    taskId: z.string(), artifactSha256: z.string(), path: z.string(), afterSha256: z.string().nullable(),
    mark: z.enum(['accepted', 'returned']), comment: z.string(), createdAt: z.number(),
  }),
})

// ── POST /v1/workbench/review-return(202):续接投递 ⇒ {input};已结算 ⇒ {task};可选 lesson ──
export const WorkbenchReviewReturnResponse = z.union([
  z.object({ input: WorkbenchLiveInput, lesson: WorkbenchLessonResult.optional() }),
  z.object({ task: WorkbenchDesktopTaskView, lesson: WorkbenchLessonResult.optional() }),
])

// ── POST /v1/workbench/review-revert ──
export const WorkbenchReviewRevertResponse = z.object({ reverted: z.object({ path: z.string(), restored: z.enum(['content', 'removed']) }) })

// ── POST /v1/workbench/review-comment(建 / 改 ⇒ {comment};删 ⇒ {deleted})──
export const WorkbenchReviewCommentResponse = z.union([
  z.object({ comment: WorkbenchReviewCommentShape }),
  z.object({ deleted: z.string() }),
])

// ── POST /v1/workbench/review-comments-send(202)──
const WorkbenchCommentsSendCounts = { sent: z.number(), remaining: z.number(), skippedDiscarded: z.number() }
export const WorkbenchReviewCommentsSendResponse = z.union([
  z.object({ input: WorkbenchLiveInput, ...WorkbenchCommentsSendCounts }),
  z.object({ task: WorkbenchDesktopTaskView, ...WorkbenchCommentsSendCounts }),
])

// ── POST /v1/workbench/review-hunk ──
export const WorkbenchReviewHunkResponse = z.object({
  hunk: z.object({ path: z.string(), hunk: z.number(), state: z.enum(['reverted', 'restored']), unchanged: z.literal(true).optional() }),
})

// ── POST /v1/workbench/worktree(commit/remove/merge/reopen ⇒ WorktreeActionResult;run/stop ⇒ 脚本状态)──
export const WorkbenchWorktreeResponse = z.object({
  worktree: z.union([
    z.object({
      branch: z.string(), committed: z.boolean().optional(), sha: z.string().optional(), mergeHint: z.string().optional(),
      removed: z.boolean().optional(), removing: z.boolean().optional(), merged: z.boolean().optional(), into: z.string().optional(),
      reopened: z.boolean().optional(),
    }),
    z.object({ branch: z.string(), scripts: WorkbenchScriptsView.nullable(), port: z.number().nullable() }),
  ]),
})

// ── POST /v1/workbench/script-approve ──
export const WorkbenchScriptApproveResponse = z.object({ scripts: WorkbenchScriptsView.nullable() })

// ── GET /v1/workbench/rewind-preview ──
const WorkbenchRewindPathList = z.object({ count: z.number(), paths: z.array(z.object({ status: z.string(), path: z.string() })) })
export const WorkbenchRewindPreviewResponse = z.object({
  preview: z.object({
    token: z.string(),
    target: z.object({ artifactId: z.string(), to: z.enum(['start', 'end']), round: z.number() }),
    discarded: z.array(z.object({ artifactId: z.string(), round: z.number() })),
  }).extend(z.object({
    files: WorkbenchRewindPathList,
    extraChanges: WorkbenchRewindPathList.nullable(),
    droppedCommits: z.object({ count: z.number(), elsewhere: z.boolean() }),
    ignoredUntouched: z.literal(true),
    rebuildHint: z.string(), refsNote: z.string(),
    session: z.enum(['none', 'will_close']),
    devServer: z.boolean(),
    goal: z.object({ status: z.string(), willStop: z.boolean() }).nullable(),
  }).partial().shape),
})

// ── POST /v1/workbench/rewind({id, undo} 撤销同形)──
export const WorkbenchRewindResponse = z.object({
  rewind: z.object({ rewindId: z.string(), backupRef: z.string(), head: z.string(), discarded: z.array(z.string()) }),
})

// ── POST /v1/workbench/rewind-resolve ──
export const WorkbenchRewindResolveResponse = z.object({
  resolved: z.object({ resolution: z.enum(['keep', 'restore_backup']), rewindId: z.string().optional() }),
})

// ── POST /v1/workbench/import(导入原生会话)──
export const WorkbenchImportResponse = z.object({ task: WorkbenchDesktopTaskView, source: WorkbenchNativeSource, created: z.boolean() })

// ── POST /v1/workbench/prepare-resume ──
export const WorkbenchPrepareResumeResponse = WorkbenchNativeResumeDecision

// ── POST /v1/workbench/prepare-continuation ──
export const WorkbenchPrepareContinuationResponse = z.object({ continuation: WorkbenchContinuation })

// ── POST /v1/workbench/quota-handoff(202)──
export const WorkbenchQuotaHandoffResponse = z.object({ taskId: z.string(), created: z.boolean() })

// ── POST /v1/workbench/handoff-preview ──
export const WorkbenchHandoffPreviewResponse = z.object({
  token: z.string(), context: z.string(),
}).extend(z.object({
  sourceTaskId: z.string(), targetProviderId: z.string(), targetTaskId: z.string().nullable(),
  purpose: z.enum(['review', 'revision']), request: z.string(),
  artifacts: z.array(WorkbenchArtifactSelection), quote: WorkbenchReviewQuote.nullable(), truncated: z.boolean(),
  attachments: z.array(WorkbenchAttachmentSelection),
  targetExecution: WorkbenchExecutionChoice,
  targetContinuation: WorkbenchContinuation,
  nativeResume: WorkbenchNativeResumeDecision,
}).partial().shape)

// ── POST /v1/workbench/handoff(202)──
export const WorkbenchHandoffResponse = z.object({ task: WorkbenchDesktopTaskView, handoffId: z.string().optional(), sourceTaskId: z.string().optional() })

// ── GET /v1/workbench/handoff(交接记录)──
export const WorkbenchHandoffRecordResponse = z.object({
  packet: z.object({
    context: z.string(),
  }).extend(z.object({
    request: z.string(), truncated: z.boolean(),
    artifacts: z.array(WorkbenchArtifactSelection),
    attachments: z.array(WorkbenchAttachmentSelection),
    continuation: z.union([
      z.object({ mode: z.literal('new') }),
      z.object({ mode: z.literal('resume'), sessionId: z.string() }),
      z.object({ mode: z.literal('restart'), preview: WorkbenchRestartPreview }),
    ]),
    execution: WorkbenchExecutionChoice,
  }).partial().shape),
}).extend(z.object({
  id: z.string(), sourceTaskId: z.string(), targetTaskId: z.string(), createdAt: z.number(),
  sourceNativeId: z.string().nullable(), targetNativeId: z.string().nullable(), packetSha256: z.string(),
}).partial().shape)

// ══════ 响应契约(F1):一件事 / 连接 / 手机 / 插件 / 许可 / 终端会话 / 日历 / 信 ══════

// 共用的软错误形状(200 + ok:false)。
const D2SoftError = z.object({ ok: z.literal(false), error: z.string() })

// ══ 一件事(routes-matters.ts)══════════════════════════════════════════

// ── GET /v1/matters ──
// MattersService.list();被网络守护冻住的那几件多一个 networkSuspended:true。
export const MattersListResponse = z.object({
  matters: z.array(Matter.extend({ networkSuspended: z.literal(true).optional() })),
})

// ── GET /v1/matter ──
// MattersService.detail(id) 原样(手机 /m/api/matter 同一份,只是那边多 ok:true)。
export const MatterDetailResponse = MatterDetail

// ── GET /v1/matter/owner-chat ──
// ownerChat('desktop'):没配置主人对话 ⇒ 404(不在 2xx 里)。
export const MatterOwnerChatResponse = MatterDetail

// ── GET /v1/matter/owner-chat/search ──
export const MatterOwnerChatSearchResponse = z.object({
  hits: z.array(MatterEvent.extend({ id: z.string() })),
})

// ── POST /v1/matter/say ──
export const MatterSayResponse = MatterSayResult

// ══ CC 的连接(routes-connections.ts)═══════════════════════════════════

// ── GET /v1/connections ──
// 全量快照:sources 里比手机多一个 detail(不校验,透传)。
export const ConnectionsResponse = Connections

// ══ 连接手机(routes-phone.ts)══════════════════════════════════════════

// ── POST /v1/phone/link ──
// phone-link.ts 的 PhoneLinkResult:ready 带链接 + 核对码;其余 state 只有 ok:false + state。
export const PhoneLinkResponse = z.union([
  z.object({ ok: z.literal(true), state: z.literal('ready'), url: z.string(), expires_at: z.number(), check_code: z.string() }),
  z.object({ ok: z.literal(false), state: z.enum(['starting', 'remote_off', 'relay_not_configured', 'relay_unavailable', 'no_owner']) }),
])

// ── GET /v1/phone/devices ──
// device-store 的 DeviceRow(没有 current:那是设置页 /set/api/state 才加的)。
const PhoneDevicesRowShape = z.object({ id: z.string(), created_at: z.string(), last_seen_at: z.string(), label: z.string().optional() })
export const PhoneDevicesResponse = z.object({ ok: z.literal(true), devices: z.array(PhoneDevicesRowShape) })

// ══ 插件(routes-plugins.ts)════════════════════════════════════════════

// ── GET /v1/plugins/list ──
const PluginsListSyncStatusShape = z.object({
  state: z.string(), running: z.boolean(), last_success_at: z.string().nullable(), error: z.string().nullable(),
})
const PluginsListEntryShape = z.object({
  name: z.string(),
  source: z.enum(['bundled', 'user']),
  version: z.string().nullable(),
  enabled: z.boolean(),
  ready: z.boolean(),
  not_ready_reason: z.string().nullable(),
  display_name: z.string(),
  description: z.string().nullable(),
  tools: z.array(z.string()),
  command: z.string(),
  has_setup: z.boolean(),
  has_sync: z.boolean(),
  sync_status: PluginsListSyncStatusShape.nullable(),
})
export const PluginsListResponse = z.object({ host_version: z.string(), plugins: z.array(PluginsListEntryShape) })

// ── POST /v1/plugins/toggle ──
export const PluginToggleResponse = z.object({ ok: z.literal(true), name: z.string(), enabled: z.boolean(), note: z.string() })

// ── GET /v1/plugins/registry ──
// 市场目录取不到 ⇒ 200 + error + 空 plugins(没有 host_version)。
const PluginsRegistryEntryShape = z.object({
  name: z.string(),
  version: z.string(),
  display_name: z.string(),
  description: z.string().nullable(),
  author: z.string().nullable(),
  homepage: z.string().nullable(),
  installed: z.boolean(),
  installed_version: z.string().nullable(),
  update_available: z.boolean(),
})
export const PluginsRegistryResponse = z.union([
  z.object({ host_version: z.string(), plugins: z.array(PluginsRegistryEntryShape) }),
  z.object({ error: z.string(), plugins: z.array(z.never()) }),
])

// ── POST /v1/plugins/install ──
export const PluginInstallResponse = z.union([
  z.object({ ok: z.literal(true), name: z.string(), version: z.string(), note: z.string() }),
  D2SoftError,
])

// ── POST /v1/plugins/upgrade ──
export const PluginUpgradeResponse = z.union([
  z.object({ ok: z.literal(true), name: z.string(), upgraded: z.boolean(), from: z.string().nullable(), to: z.string(), note: z.string() }),
  D2SoftError,
])

// ══ 许可(routes-license.ts)════════════════════════════════════════════

// ── GET /v1/license/status ──
export const LicenseStatusResponse = z.object({ pro: z.boolean(), reason: z.string(), expires_at: z.string().nullable() })

// ── POST /v1/license/activate ──
export const LicenseActivateResponse = z.union([
  z.object({ ok: z.literal(true), pro: z.boolean(), reason: z.string(), expires_at: z.string().nullable(), note: z.string() }),
  D2SoftError,
])

// ── POST /v1/license/deactivate ──
export const LicenseDeactivateResponse = z.object({ ok: z.literal(true), note: z.string() })

// ══ 终端会话(features/terminal/routes.ts)═════════════════════════════════════

const CliD2Source = z.enum(['claude', 'codex', 'cursor'])

// ── POST /v1/cli/event ──
export const CliEventResponse = z.object({ ok: z.literal(true), action: z.enum(['scheduled', 'cancelled', 'cleared', 'noop']) })

// ── POST /v1/cli/permission ──
// CliPermissionOpen:主人在场 ⇒ owner_present(终端自己问);否则 pending + hash。
export const CliPermissionOpenResponse = z.union([
  z.object({ status: z.literal('pending'), hash: z.string() }),
  z.object({ status: z.literal('owner_present') }),
])

// ── GET /v1/cli/permission ──
export const CliPermissionStatusResponse = z.object({
  hash: z.string(),
  status: z.enum(['pending', 'allow', 'deny', 'timeout', 'undelivered', 'unknown']),
})

// ── GET /v1/cli/sessions ──
// core/cli-session-store 的 CliSessionView(桌面口径带 cwd / origin_agent);detail=1 时补 live_window + now_step。
const CliSessionsRowShape = z.object({
  session_id: z.string(),
  code: z.string(),
  source: CliD2Source,
  status: z.enum(['running', 'waiting', 'idle', 'ended']),
  stale: z.boolean(),
  project: z.string(),
  cwd: z.string(),
  machine: z.string().nullable(),
  origin_agent: z.string().nullable(),
  last_summary: z.string().nullable(),
  last_event_at: z.number(),
  last_prompt_at: z.number().nullable(),
  created_at: z.number(),
  pending: z.object({ tool: z.string(), summary: z.string().nullable(), since: z.number() }).nullable(),
  live_window: z.boolean().optional(),
  now_step: z.string().nullable().optional(),
})
export const CliSessionsResponse = z.object({ ok: z.literal(true), sessions: z.array(CliSessionsRowShape) })

// ── POST /v1/cli/say ──
// TerminalSayStart 的 ok:true 分支;ok:false 一律走 4xx(workbench-errors 表)。
export const CliSayStartResponse = z.object({
  ok: z.literal(true),
  ticket: z.string(),
  via: z.enum(['window', 'resume']),
  code: z.string(),
  source: CliD2Source,
  project: z.string(),
  was_running: z.boolean(),
  read_only: z.boolean(),
  max_wait_ms: z.number(),
})

// ── GET /v1/cli/say ──
// { ok:true, ...TerminalSayView };票不认识 ⇒ 404。
export const CliSayWaitResponse = z.object({
  ok: z.literal(true),
  ticket: z.string(),
  code: z.string(),
  source: CliD2Source,
  project: z.string(),
  via: z.enum(['window', 'resume']),
  state: z.enum(['sending', 'delivered', 'running', 'replied', 'failed', 'ended', 'timeout', 'expired']),
  final: z.boolean(),
  delivered: z.boolean().nullable(),
  reply: z.string().nullable(),
  reply_truncated: z.boolean(),
  reply_verified: z.boolean().nullable(),
  error: z.string().nullable(),
  elapsed_ms: z.number(),
  was_running: z.boolean(),
  read_only: z.boolean(),
  owner_notified: z.boolean(),
  owner_has_reply: z.boolean(),
  max_wait_ms: z.number(),
})

// ── GET /v1/overseer/today ──
export const OverseerTodayResponse = z.object({ ok: z.literal(true), today: OverseerToday })

// ── POST /v1/cli/hooks/install · POST /v1/cli/hooks/uninstall ──
// features/terminal/hooks.ts 的 TerminalHooksResult:每一家的改动 + 改完的状态。
const CliHooksChangeShape = z.object({
  source: CliD2Source,
  ok: z.boolean(),
  file: z.string(),
  changed: z.boolean().optional(),
  removed: z.number().optional(),
  command: z.string().optional(),
  error: z.string().optional(),
  skipped: z.literal('cli_not_found').optional(),
})
const CliHooksSourceStateShape = z.object({
  source: CliD2Source,
  cli: z.string().nullable(),
  file: z.string(),
  installed: z.boolean(),
  command: z.string().nullable(),
  health: z.enum(['missing', 'stale', 'ok']),
  matchesSelf: z.boolean(),
})
export const CliHooksResponse = z.object({
  ok: z.boolean(), results: z.array(CliHooksChangeShape), status: z.array(CliHooksSourceStateShape),
})

// ══ 日历(features/calendar/routes.ts)══════════════════════════════════

// ── GET /v1/calendar/agenda ──
// 就是「日历」命令那段话(没开 / 没授权也照实成句)。
export const CalendarAgendaResponse = z.object({ ok: z.literal(true), text: z.string() })

// ══ CC 的信(features/letters/routes.ts)════════════════════════════════

// letters/runtime.ts 的 LetterStatus(GET /v1/letters 与 POST /v1/letters/settings 都回 { ok:true, ...status })。
const LettersStatusShape = z.object({
  ok: z.literal(true),
  enabled: z.boolean(),
  scheduled: z.boolean(),
  pending: z.object({ id: z.string(), created_at: z.string(), waiting_for_owner: z.boolean() }).nullable(),
  letters: z.array(z.object({ id: z.string(), day: z.string(), sent_at: z.string().nullable(), requested: z.boolean(), opening: z.string() })),
})

// ── GET /v1/letters ──
export const LettersStatusResponse = LettersStatusShape

// ── POST /v1/letters/write ──
// preview=true:等写完,回图片路径与正文(或 skipped / failed + reason);否则立刻 started。
export const LettersWriteResponse = z.union([
  z.object({ ok: z.literal(true), started: z.literal(true) }),
  z.object({
    ok: z.literal(true),
    preview: z.union([
      z.object({ status: z.literal('ok'), pages: z.array(z.string()), text: z.string() }),
      z.object({ status: z.enum(['skipped', 'failed']), reason: z.string() }),
    ]),
  }),
])

// ── POST /v1/letters/settings ──
export const LettersSettingsResponse = LettersStatusShape

// ══ 找文件(routes-files.ts)════════════════════════════════════════════

// ── GET /v1/locate ──
// lib/locate-files 的 Candidate:只有元数据,不给内容。
const LocateCandidateShape = z.object({
  path: z.string(), name: z.string(), dir: z.string(), bytes: z.number(), mtime: z.string(), isDir: z.boolean(), score: z.number(),
})
export const LocateResponse = z.object({ candidates: z.array(LocateCandidateShape), truncated: z.boolean() })

// ══ 故障记录(routes-health.ts)═════════════════════════════════════════

// ── GET /v1/health/incidents ──
// health-incidents.json 原样读出(没接线 ⇒ 空列表)。
const HealthIncidentShape = z.object({
  id: z.string(),
  dependency: z.enum(['wechat', 'llm']),
  kind: z.enum(['login_taken_over', 'llm_auth', 'network', 'unknown']),
  actionable: z.boolean(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  notifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
})
export const HealthIncidentsResponse = z.object({ incidents: z.array(HealthIncidentShape) })

// ══════ 响应契约(F1):回合 / 贴纸 / 语音 / 会话 / 后台控制 / 模型健康 / 画室 ══════

// 共用的软错误形状(200 + ok:false)。
const D1SoftError = z.object({ ok: z.literal(false), error: z.string() })
const D1SoftReason = z.object({ ok: z.literal(false), reason: z.string() })
const D1NoStickerForTag = z.object({ ok: z.literal(false), reason: z.literal('no_sticker_for_tag'), tags: z.array(z.string()) })

// ── POST /v1/turn/attach ──
// 附件只登记,交付时才发;回执不带 msg_id。
export const TurnAttachResponse = z.union([
  z.object({ ok: z.literal(true), attached: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.literal('too_long'), limit: z.number() }),
  D1NoStickerForTag,
  D1SoftError,
])

// ── POST /v1/wechat/message ──
// to='broadcast' 原样回 ilink.broadcast 的计数(ok 是条数,不是布尔)。
export const WechatMessageResponse = z.union([
  z.object({ ok: z.literal(true), msg_id: z.string() }),
  z.object({ ok: z.number(), failed: z.number() }),
  D1SoftError,
])

// ── POST /v1/wechat/send_sticker ──
export const WechatSendStickerResponse = z.union([
  z.object({ ok: z.literal(true), file: z.string() }),
  D1NoStickerForTag,
  D1SoftError,
])

// ── POST /v1/wechat/search_online_sticker ──
export const WechatSearchOnlineStickerResponse = z.union([
  z.object({ ok: z.literal(true), source: z.enum(['local', 'online']), file: z.string() }),
  D1SoftReason,
  D1SoftError,
])

// ── POST /v1/wechat/search_online_sticker_candidates ──
export const WechatOnlineStickerCandidatesResponse = z.object({
  ok: z.literal(true),
  candidates: z.array(z.object({ url: z.string(), id: z.string() })),
})

// ── POST /v1/wechat/send_online_sticker_candidate ──
export const WechatSendOnlineStickerCandidateResponse = z.union([
  z.object({ ok: z.literal(true), source: z.literal('online'), file: z.string() }),
  D1SoftReason,
  D1SoftError,
])

// ── POST /v1/wechat/sticker_feedback ──
// 找不到可评的那张 ⇒ ok:false, file:null。
export const WechatStickerFeedbackResponse = z.object({ ok: z.boolean(), file: z.string().nullable() })

// ── GET /v1/stickers ──
export const StickersListResponse = z.object({
  ok: z.literal(true),
  stickers: z.array(z.object({ file: z.string(), tags: z.array(z.string()), desc: z.string().optional() })),
  tags: z.array(z.string()),
})

// ── POST /v1/stickers ──
export const StickersSaveResponse = z.object({ ok: z.literal(true), file: z.string(), tags: z.array(z.string()) })

// ── POST /v1/stt/save_config ──
export const SttSaveConfigResponse = z.union([
  z.object({ ok: z.literal(true), tested_ms: z.number(), base_url: z.string(), model: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string().optional() }),
])

// ── GET /v1/stt/status ──
export const SttStatusResponse = z.union([
  z.object({ configured: z.literal(true), provider: z.literal('http_stt'), base_url: z.string(), model: z.string(), saved_at: z.string() }),
  z.object({ configured: z.literal(false) }),
])

// ── POST /v1/chat-prefs ──
export const ChatPrefsSetResponse = z.object({
  ok: z.literal(true),
  prefs: z.object({ care: z.enum(['off', 'low', 'high']).optional(), split: z.boolean().optional() }),
})

// ── POST /v1/companion/converse ──
// 附件是 app 的形状(src/daemon/app-reply.ts ConverseAttachment);attachments / narration 总在。
const CompanionConverseAttachmentShape = z.union([
  z.object({ kind: z.literal('voice'), text: z.string() }),
  z.object({ kind: z.literal('sticker'), label: z.string(), file: z.string().optional(), image: z.string().optional() }),
  z.object({ kind: z.literal('file'), name: z.string(), path: z.string() }),
])
export const CompanionConverseResponse = z.object({
  ok: z.literal(true),
  reply: z.string(),
  attachments: z.array(CompanionConverseAttachmentShape),
  narration: z.array(z.string()),
})

// ── POST /v1/companion/speak ──
export const CompanionSpeakResponse = z.object({ ok: z.literal(true), audio_b64: z.string(), mime: z.string() })

// ── POST /v1/companion/transcribe ──
export const CompanionTranscribeResponse = z.object({ ok: z.literal(true), text: z.string() })

// ── GET /v1/turns ──
// StoredTurnRecord(core/turn-record-store.ts toRecord);老行缺的列不带键。
const DaemonTurnRecordShape = z.object({
  id: z.string(),
  chatId: z.string(),
  provider: z.string(),
  alias: z.string(),
  mode: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
  durationMs: z.number(),
  outcome: z.string(),
  replyToolCalled: z.boolean(),
  textChunks: z.number(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  toolCalls: z.array(z.string()),
  delivery: z.string().optional(),
  bubbles: z.number().optional(),
  attachments: z.number().optional(),
  narrationSegments: z.number().optional(),
})
export const DaemonTurnsResponse = z.object({ turns: z.array(DaemonTurnRecordShape) })

// ── GET /v1/sessions ──
const DaemonLiveSessionShape = z.object({
  alias: z.string(),
  path: z.string(),
  providerId: z.string(),
  chatId: z.string(),
  lastUsedAt: z.number(),
}).passthrough()
export const DaemonSessionsResponse = z.object({ sessions: z.array(DaemonLiveSessionShape) })

// ── POST /v1/sessions/release ──
// 放掉之后的 session 列表做回读;lister 没接 ⇒ null。
export const DaemonSessionsReleaseResponse = z.object({
  ok: z.literal(true),
  released: z.boolean(),
  sessions: z.array(DaemonLiveSessionShape).nullable(),
})

// ── GET /v1/model ──
export const DaemonModelGetResponse = z.object({ provider: z.string(), model: z.string().nullable() })

// ── POST /v1/model ──
export const DaemonModelSetResponse = z.object({
  ok: z.literal(true),
  provider: z.string(),
  model: z.string().nullable(),
  released: z.number(),
  forgotten: z.number(),
})

// ── POST /v1/daemon/restart ──
export const DaemonRestartResponse = z.object({ ok: z.literal(true), restarting: z.literal(true) })

// ── POST /v1/selftest/converse ──
// SelftestConverseResult(src/daemon/selftest.ts);ok:false 也是 200。
export const SelftestConverseResponse = z.object({
  ok: z.boolean(),
  providerId: z.string(),
  sessionId: z.string().nullable(),
  texts: z.array(z.string()),
  toolCalls: z.array(z.string()),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  eventKinds: z.array(z.string()).optional(),
  durationMs: z.number(),
})

// ── POST /v1/cli/upgrade · POST /v1/cli/rollback ──
// outcome = OpOutcome,status = 这一家的 CliStatusView(core/cli-upgrade/engine.ts),找不到 ⇒ null。
const CliUpgradeOutcomeShape = z.object({
  ok: z.boolean(),
  result: z.string(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  detail: z.string().optional(),
})
const CliUpgradeStatusViewShape = z.object({
  id: z.string(),
  label: z.string(),
  auto: z.boolean(),
  installed: z.string().nullable(),
  latest: z.string().nullable(),
  update_available: z.boolean(),
  accepted: z.string().nullable(),
  verify: z.string(),
  verify_detail: z.string().nullable(),
  last_check_at: z.string().nullable(),
  last_check_error: z.string().nullable(),
  next_check_at: z.string().nullable(),
  pending: z.string().nullable(),
  last_upgrade: z.object({}).passthrough().nullable(),
  known_bad: z.array(z.string()),
}).passthrough()
export const CliUpgradeOpResponse = z.object({
  outcome: CliUpgradeOutcomeShape,
  status: CliUpgradeStatusViewShape.nullable(),
})

// ── GET /v1/llm/health ──
// 没拨过 ⇒ checked_at / default_provider 为 null、results 空。names 老 daemon 不带。
const LlmHealthProbeShape = z.object({
  provider: z.string(),
  ok: z.boolean().nullable(),
  latency_ms: z.number(),
  error: z.string().optional(),
  auth_failed: z.boolean().optional(),
  code: z.string().optional(),
  hint: z.string().optional(),
})
export const LlmHealthResponse = z.object({
  ok: z.literal(true),
  registered: z.array(z.string()),
  names: z.record(z.string(), z.object({ displayName: z.string(), settingsLabel: z.string() })).optional(),
  unconfigured: z.array(z.object({ provider: z.string(), how: z.string() })),
  checked_at: z.string().nullable(),
  default_provider: z.string().nullable(),
  results: z.array(LlmHealthProbeShape),
})

// ── POST /v1/net/probe ──
export const NetProbeResponse = z.object({
  ok: z.literal(true),
  results: z.array(z.object({ id: z.string(), label: z.string(), ok: z.boolean(), latency_ms: z.number(), status: z.number().optional() })),
  verdict: z.enum(['ok', 'no_international', 'offline']),
  dial_advisable: z.boolean(),
})

// ── POST /v1/llm/keys ──
export const LlmKeysSaveResponse = z.object({ ok: z.literal(true), restart_required: z.literal(true) })

// ── GET /v1/settings/link ──
export const SettingsLinkResponse = z.union([
  z.object({ ok: z.literal(true), url: z.string() }),
  D1SoftError,
])

// ── GET /v1/atelier/works ──
// ArtworkRecord 去掉 privateCauseSummary;图 ≤2MB 时内联成 image_data。
const AtelierWorkShape = z.object({
  id: z.string(),
  createdAt: z.string(),
  imageFile: z.string(),
  mime: z.string(),
  width: z.number(),
  height: z.number(),
  impulse: z.object({}).passthrough(),
  caption: z.string().optional(),
  background: z.object({ title: z.string(), origin: z.string(), approach: z.string(), kind: z.string() }).passthrough().optional(),
  rendererId: z.string(),
  shareState: z.enum(['private', 'pending', 'shared']),
  sharedAt: z.string().optional(),
  image_data: z.string().optional(),
}).passthrough()
export const AtelierWorksResponse = z.object({ works: z.array(AtelierWorkShape) })

// ── GET /v1/atelier/model-status ──
// status 是磁盘上的状态文件原样(ModelProvisionStatus);从没开过画室 ⇒ null。
const AtelierModelProvisionShape = z.object({ state: z.string() }).passthrough()
export const AtelierModelStatusResponse = z.object({
  status: AtelierModelProvisionShape.nullable(),
  mode: z.enum(['off', 'private', 'share']),
})

// ══════ 响应契约(F1):记忆 / 知识库 / 配置 / 联邦 ══════

// ════ 记忆:整理 / 每晚 / 编辑 / 小像 / 证据审阅 ════════════════════════════════

/** synthesizeOverview / synthesizeProfile 共有的计数(lib/memory-synthesis.ts)。 */
const MemorySynthStatsShape = {
  projectsFound: z.number(),
  projectNames: z.array(z.string()),
  filesScanned: z.number(),
  promptChars: z.number(),
  observationsFound: z.number(),
  milestonesFound: z.number(),
  memoryNotesFound: z.number(),
  foldersScanned: z.number(),
}
const MemorySynthWrittenShape = z.object({ path: z.string(), bytesWritten: z.number() })

// ── POST /v1/memory/synthesize ──
export const OwnerMemSynthesizeResponse = z.object({
  ok: z.literal(true),
  ...MemorySynthStatsShape,
  overview: z.string().optional(),
  written: MemorySynthWrittenShape.optional(),
})

// ── POST /v1/memory/profile/generate ──
// profile = MemoryProfileDoc(卡片结构在 daemon 里,这里只钉住顶层几样)。
export const OwnerMemProfileGenerateResponse = z.object({
  ok: z.literal(true),
  ...MemorySynthStatsShape,
  profile: z.object({
    version: z.literal(1),
    generatedAt: z.string(),
    chatId: z.string(),
    insight: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
  }).passthrough().optional(),
  written: MemorySynthWrittenShape.optional(),
})

// ── POST /v1/memory/nightly/run ──
// result = NightlyRunResult(src/features/memory/nightly-notify.ts);applied 的条目形状在 nightly-ops 里。
const MemoryNightlyRunResultShape = z.union([
  z.object({ status: z.literal('written'), applied: z.array(z.object({ kind: z.string(), id: z.string(), text: z.string() }).passthrough()), notice: z.string().nullable() }),
  z.object({ status: z.literal('skipped'), reason: z.string() }),
  z.object({ status: z.literal('failed'), reason: z.string() }),
])
export const OwnerMemNightlyRunResponse = z.object({ ok: z.literal(true), result: MemoryNightlyRunResultShape })

// ── POST /v1/memory/view ──
const MemoryEditablePathShape = z.enum(['_overview.md', 'memory.md', 'owner.md'])
const MemoryReplacesShape = z.object({ correctionId: z.string(), text: z.string() })
const MemoryViewLineShape = z.object({
  text: z.string(),
  origin: z.enum(['generated', 'owner']),
  lineKey: z.string().optional(),
  assertionId: z.string().optional(),
  editedAt: z.string().optional(),
  replaces: MemoryReplacesShape.optional(),
})
export const OwnerMemViewResponse = z.object({
  ok: z.literal(true),
  chatId: z.string(),
  path: MemoryEditablePathShape,
  baseHash: z.string(),
  generatedAt: z.string().nullable(),
  stale: z.boolean(),
  lines: z.array(MemoryViewLineShape),
})

// ── POST /v1/memory/edit ──
// 业务拒绝是 200 + ok:false(memory_changed / memory_edit_stale_key / _too_large / _bulk),带各自的附加字段。
export const OwnerMemEditResponse = z.union([
  z.object({
    ok: z.literal(true),
    corrections: z.array(z.object({ id: z.string(), text: z.string() })),
    assertions: z.array(z.object({ id: z.string(), text: z.string(), replaces: MemoryReplacesShape.optional() })),
    regenerate: z.enum(['queued', 'not_needed']),
  }),
  z.object({ ok: z.literal(false), code: z.literal('memory_changed') }),
  z.object({ ok: z.literal(false), code: z.literal('memory_edit_stale_key') }),
  z.object({ ok: z.literal(false), code: z.literal('memory_edit_too_large'), limit: z.object({ lines: z.number(), bytes: z.number(), lineChars: z.number() }) }),
  z.object({ ok: z.literal(false), code: z.literal('memory_edit_bulk'), count: z.number(), deleted: z.number(), rewritten: z.number() }),
])

// ── POST /v1/memory/portrait/generate ──
// generatePortrait 原样回:成功带 path,失败 ok:false + error(bad_chat_id / no_profile / source_changed / unsafe_svg)。
export const OwnerMemPortraitGenerateResponse = z.union([
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── GET /v1/memory/portrait ──
// 没画过 ⇒ svg:null(没有 generated_at);safeSvg 不过 ⇒ svg 也是 null。
export const OwnerMemPortraitResponse = z.union([
  z.object({ ok: z.literal(true), svg: z.null() }),
  z.object({ ok: z.literal(true), svg: z.string().nullable(), generated_at: z.string().nullable() }),
])

// ── GET /v1/memory/source ──
// readSource 去掉 row 之后的那一份;archived 只在 observation 上出现。
export const OwnerMemSourceResponse = z.object({
  ok: z.literal(true),
  content: z.string(),
  revision: z.string(),
  editable: z.boolean(),
  canMarkOutdated: z.boolean(),
  needsRefresh: z.boolean(),
  archived: z.boolean().optional(),
})

// ── POST /v1/memory/source/review ──
// memory 文件:{ok, needsRefresh, revision};observation:再加 id(更正后的新 id 或原 id)。
export const OwnerMemSourceReviewResponse = z.object({
  ok: z.literal(true),
  needsRefresh: z.literal(true),
  revision: z.string(),
  id: z.string().optional(),
})

// ════ 知识库:摄入 / 查询 ════════════════════════════════════════════════════

// ── POST /v1/knowledge/source/put ──
export const KnowledgeSourcePutResponse = z.object({ ok: z.literal(true), watermark: z.number() })

// ── POST /v1/knowledge/semantic/put ──
export const KnowledgeSemanticPutResponse = z.object({ ok: z.literal(true) })

// ── GET /v1/chat/history ──
export const ChatHistoryResponse = z.object({
  messages: z.array(z.object({ ts: z.string(), dir: z.string(), kind: z.string(), text: z.string() })),
})

// ── GET /v1/knowledge/messages ──
// source.db 的行:老库迁移来的列(local_type / kind)可能是 NULL,其余列 SQL 上也可空。
const KnowledgeSourceMsgShape = z.object({
  msg_key: z.string(),
  conversation: z.string().nullable(),
  sender: z.string().nullable(),
  time: z.number().nullable(),
  type: z.string().nullable(),
  text: z.string().nullable(),
  server_id: z.string().nullable(),
  local_type: z.number().nullable(),
  is_group: z.boolean(),
  kind: z.string().nullable(),
})
export const KnowledgeMessagesResponse = z.object({ messages: z.array(KnowledgeSourceMsgShape), watermark: z.number() })

// ── POST /v1/knowledge/search ──
export const KnowledgeSearchResponse = z.object({
  vectors_stale: z.boolean(),
  results: z.array(z.object({
    conversation: z.string().nullable(),
    sender: z.string().nullable(),
    time: z.number().nullable(),
    type: z.string().nullable(),
    text: z.string().nullable(),
    score: z.number(),
  })),
})

// ── GET /v1/knowledge/semantic/status ──
export const KnowledgeSemanticStatusResponse = z.object({
  indexed: z.number(),
  model_id: z.string().nullable(),
  model_version: z.string().nullable(),
})

// ════ 知识图谱 ══════════════════════════════════════════════════════════════

const KnowledgeGraphEdgeShape = z.object({ a: z.string(), b: z.string(), kind: z.string(), weight: z.number() })
const KnowledgeGraphCandidateShape = z.object({ username: z.string(), display: z.string().nullable() })
/** Contact = graph-profiles 的 Profile + display / is_group;画像数值很多,只钉住常用的几样。 */
const KnowledgeGraphContactShape = z.object({
  username: z.string(),
  display: z.string().nullable(),
  is_group: z.boolean(),
  closeness: z.number(),
}).passthrough()
const KnowledgeGraphNodeShape = z.object({ username: z.string(), display: z.string().nullable(), closeness: z.number() })

// ── POST /v1/knowledge/graph/contact_profile ──
export const KnowledgeContactProfileResponse = z.union([
  z.object({ resolved: z.literal(false), candidates: z.array(KnowledgeGraphCandidateShape) }),
  KnowledgeGraphContactShape.extend({ resolved: z.literal(true), mention_partners: z.array(KnowledgeGraphEdgeShape) }),
])

// ── POST /v1/knowledge/graph/top_contacts ──
export const KnowledgeTopContactsResponse = z.object({ contacts: z.array(KnowledgeGraphContactShape) })

// ── POST /v1/knowledge/graph/rank_contacts ──
export const KnowledgeRankContactsResponse = z.object({ contacts: z.array(KnowledgeGraphNodeShape) })

// ── POST /v1/knowledge/graph/relationship_subgraph ──
export const KnowledgeRelationshipSubgraphResponse = z.object({
  owner: z.string().nullable(),
  nodes: z.array(KnowledgeGraphNodeShape),
  edges: z.array(KnowledgeGraphEdgeShape),
})

// ── POST /v1/knowledge/graph/connectors ──
export const KnowledgeConnectorsResponse = z.union([
  z.object({
    resolved: z.literal(true),
    a: z.string(),
    b: z.string(),
    shared_groups_a: z.number(),
    shared_groups_b: z.number(),
    shared_groups: z.number(),
    mention_edges: z.array(KnowledgeGraphEdgeShape),
  }),
  z.object({ resolved: z.literal(false) }),
])

// ── GET /v1/knowledge/graph/status ──
export const KnowledgeGraphStatusResponse = z.object({
  contacts: z.number(),
  owner: z.string().nullable(),
  built_at: z.number().nullable(),
  stale: z.boolean(),
})

// ════ 事实 / 人物 ════════════════════════════════════════════════════════════

/** facts.db 的 FactRow;source_msg_keys 已解析成数组。 */
const KnowledgeFactRowShape = z.object({
  id: z.number(),
  contact: z.string().nullable(),
  kind: z.string().nullable(),
  predicate: z.string().nullable(),
  value: z.string().nullable(),
  status: z.string().nullable(),
}).passthrough()

// ── POST /v1/knowledge/facts/extraction_batch ──
export const KnowledgeExtractionBatchResponse = z.union([
  z.object({ done: z.literal(true) }),
  z.object({
    batch_id: z.string(),
    contact: z.string(),
    display: z.string().nullable(),
    covers_until_ts: z.number(),
    messages: z.array(z.object({ msg_key: z.string(), sender: z.string().nullable(), time: z.number(), text: z.string().nullable() })),
  }),
])

// ── POST /v1/knowledge/facts/record_facts ──
export const KnowledgeRecordFactsResponse = z.object({
  recorded: z.number(),
  merged: z.number(),
  advanced_to: z.number().nullable(),
  conflicts: z.array(z.object({
    id: z.number(),
    predicate: z.string(),
    value: z.string(),
    against: z.array(z.object({ id: z.number(), value: z.string().nullable() })),
  })),
})

// ── POST /v1/knowledge/facts/contact_facts ──
export const KnowledgeContactFactsResponse = z.object({
  resolved: z.literal(true),
  contact: z.string(),
  display: z.string().nullable(),
  by_kind: z.record(z.string(), z.array(KnowledgeFactRowShape)),
})

// ── POST /v1/knowledge/facts/find_facts ──
export const KnowledgeFindFactsResponse = z.object({ results: z.array(KnowledgeFactRowShape) })

// ── POST /v1/knowledge/facts/set_fact_status ──
export const KnowledgeSetFactStatusResponse = z.object({ ok: z.boolean() })

// ── GET /v1/knowledge/facts/extraction_status ──
export const KnowledgeExtractionStatusResponse = z.object({
  contacts: z.number(),
  caught_up: z.number(),
  facts_by_kind: z.record(z.string(), z.number()),
  backlog: z.array(z.object({ contact: z.string(), extracted_until: z.number().nullable(), remaining: z.number() })),
})

// ── POST /v1/knowledge/person/brief ──
// 各段在 person.ts 里各自 safe() 包着,失败给 null / []。
export const KnowledgePersonBriefResponse = z.union([
  z.object({ name: z.string(), resolved: z.literal(false), candidates: z.array(KnowledgeGraphCandidateShape) }),
  z.object({
    name: z.string(),
    resolved: z.literal(true),
    wxid: z.string(),
    relationship: z.object({ resolved: z.boolean() }).passthrough().nullable(),
    facts: z.object({ resolved: z.boolean() }).passthrough().nullable(),
    obligations: z.array(KnowledgeFactRowShape),
    recent_messages: z.array(z.object({}).passthrough()),
  }),
])

// ════ 配置面 / 联邦 ══════════════════════════════════════════════════════════

const ConfigSurfaceEffectShape = z.enum(['immediate', 'daemon-restart', 'next-tick', 'reinstall'])
const ConfigSurfaceValueShape = z.union([z.string(), z.boolean(), z.number(), z.null()])

// ── GET /v1/config/surface ──
export const ConfigSurfaceResponse = z.object({
  keys: z.array(z.object({
    key: z.string(),
    value: ConfigSurfaceValueShape,
    type: z.enum(['string', 'boolean', 'enum', 'number']),
    values: z.array(z.string()).optional(),
    writable: z.boolean(),
    effect: ConfigSurfaceEffectShape,
    description: z.string(),
  })),
})

// ── POST /v1/config/set ──
// writeConfigKey 原样回:业务拒绝也是 200 + ok:false。
export const ConfigSetResponse = z.union([
  z.object({ ok: z.literal(true), key: z.string(), effect: ConfigSurfaceEffectShape, previous: ConfigSurfaceValueShape }),
  z.object({ ok: z.literal(false), error: z.enum(['unknown_key', 'read_only_key', 'invalid_value']), detail: z.string().optional() }),
])

// ── POST /v1/federation/mint ──
export const FederationMintResponse = z.object({ token: z.string() })

// ══════ 响应契约(F1):桌宠 / A2A / 社交 / 权限 / 自改 / 手帐 / 配对 / 笔友 ══════

/** `{ok:true}` / `{ok:false, error}` —— a2a remove/pause 的 try/catch 两面。 */
const A2AMutateOkResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── GET /v1/companion/pet ── 桌宠「在做什么」(core/pet-turn.ts PetTurnPayload)
const PetPendingPermissionShape = z.object({
  hash: z.string(),
  prompt: z.string(),
  since: z.string(),
  expires_at: z.string(),
})
export const PetTurnResponse = z.object({
  owner_last_contact_at: z.string().nullable(),
  turn: z.object({
    phase: z.enum(['idle', 'thinking', 'working', 'permission']),
    since: z.string().nullable(),
  }),
  last_done_at: z.string().nullable(),
  pending_permissions: z.array(PetPendingPermissionShape),
})
export type PetTurnResponseT = z.infer<typeof PetTurnResponse>

// ── GET /v1/a2a/list ── 逐字段投影(不含密钥)
const A2AListAgentShape = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().optional(),
  paused: z.boolean().optional(),
  transport: z.enum(['push', 'ws', 'mailbox']).optional(),
  mailbox_addr: z.string().optional(),
  relays: z.array(z.string()).optional(),
  counts: z.object({ inbound: z.number(), outbound: z.number() }),
})
export const A2AListResponse = z.object({ agents: z.array(A2AListAgentShape) })
export type A2AListResponseT = z.infer<typeof A2AListResponse>

// ── GET /v1/a2a/info ──
export const A2AInfoResponse = z.object({
  enabled: z.boolean(),
  base_url: z.string().nullable(),
})

// ── GET /v1/a2a/activity ── a2a_events 行(core/a2a-events-store.ts EventRow)
const A2AActivityEventShape = z.object({
  id: z.string(),
  ts: z.string(),
  direction: z.enum(['in', 'out']),
  agent_id: z.string(),
  text: z.string(),
  urgency: z.enum(['normal', 'critical']).nullable(),
  status: z.string(),
  http_status: z.number().nullable(),
})
export const A2AActivityResponse = z.object({ events: z.array(A2AActivityEventShape) })
export type A2AActivityResponseT = z.infer<typeof A2AActivityResponse>

// ── POST /v1/a2a/remove · POST /v1/a2a/pause ──
export const A2ARemoveResponse = A2AMutateOkResponse
export const A2APauseResponse = A2AMutateOkResponse

// ── POST /v1/social/enable ── 社交总开关(cli/social-enable.ts applySocialSwitch + restart_required)
export const SocialEnableResponse = z.object({
  enabled: z.boolean(),
  changed: z.array(z.string()),
  restart_required: z.literal(true),
})

// ── POST /v1/social/wish ── propose:只存草稿
export const SocialWishProposeResponse = z.union([
  z.object({ ok: z.literal(true), id: z.string(), preview: z.string() }),
  z.object({
    ok: z.literal(false),
    error: z.enum(['gate_failed', 'checker_unavailable', 'empty']),
    violations: z.array(z.string()).optional(),
  }),
])

// ── POST /v1/social/wish/send ──
export const SocialWishSendResponse = z.union([
  z.object({ ok: z.literal(true), sent_to: z.number() }),
  z.object({ ok: z.literal(false), reason: z.enum(['not_found', 'not_draft', 'too_many_open', 'no_channels']) }),
])

// ── POST /v1/social/wish/cancel ──
export const SocialWishCancelResponse = z.union([
  z.object({ ok: z.literal(true), status: z.enum(['closed', 'cancelled']) }),
  z.object({ ok: z.literal(false), reason: z.enum(['not_found', 'already_done']) }),
])

// ── GET /v1/social/wishes ── 只给 redacted 文本 + 有效状态
const SocialWishPostcardShape = z.object({
  reply_id: z.string(),
  via_label: z.string(),
  preview: z.string(),
  at: z.string(),
  requested: z.boolean(),
})
const SocialWishItemShape = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(['draft', 'open', 'closed', 'cancelled', 'expired']),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  sent_to: z.number(),
  replies: z.number(),
  postcards: z.array(SocialWishPostcardShape).optional(),
})
export const SocialWishesResponse = z.object({ wishes: z.array(SocialWishItemShape) })
export type SocialWishesResponseT = z.infer<typeof SocialWishesResponse>

// ── POST /v1/social/intro/request ──
export const SocialIntroRequestResponse = z.union([
  z.object({ ok: z.literal(true), reply_id: z.string() }),
  z.object({ ok: z.literal(false), reason: z.enum(['not_found', 'ambiguous', 'already_requested', 'send_failed']) }),
])

// ── POST /v1/social/intro/accept · POST /v1/social/intro/decline ──
const SocialIntroDecideResponse = z.union([
  z.object({ ok: z.literal(true), reply_id: z.string() }),
  z.object({ ok: z.literal(false), reason: z.enum(['not_found', 'ambiguous', 'send_failed']) }),
])
export const SocialIntroAcceptResponse = SocialIntroDecideResponse
export const SocialIntroDeclineResponse = SocialIntroDecideResponse

// ── GET /v1/social/intro/offers ──
export const SocialIntroOffersResponse = z.object({
  offers: z.array(z.object({
    reply_id: z.string(),
    hint: z.string(),
    via_label: z.string(),
    at: z.string(),
  })),
})

// ── GET /v1/permissions/pending ── daemon/pending-permissions.ts PendingPermissionView
const PermissionsPendingItemShape = z.object({
  hash: z.string(),
  code: z.string(),
  chatId: z.string(),
  prompt: z.string(),
  since: z.string(),
  expires_at: z.string(),
})
export const PermissionsPendingResponse = z.object({ items: z.array(PermissionsPendingItemShape) })
export type PermissionsPendingResponseT = z.infer<typeof PermissionsPendingResponse>

// ── POST /v1/permissions/resolve ── ok=false:hash 过期 / 已在微信拍过
export const PermissionsResolveResponse = z.object({ ok: z.boolean() })

// ── POST /v1/self-change/notice ── 失败走 409/502
export const SelfChangeNoticeResponse = z.object({ ok: z.literal(true) })

// ── POST /v1/self-change/ask ── delivered=false 仍是 200
export const SelfChangeAskResponse = z.object({
  hash: z.string(),
  code: z.string().nullable(),
  delivered: z.boolean(),
})

// ── GET /v1/self-change/decision ──
export const SelfChangeDecisionResponse = z.object({
  decision: z.enum(['pending', 'allow', 'deny', 'timeout', 'undelivered', 'unknown']),
})

// ── GET /v1/social/inbound ── a2a_listen 开没开
export const SocialInboundStatusResponse = z.union([
  z.object({ enabled: z.literal(true), host: z.string(), port: z.number() }),
  z.object({ enabled: z.literal(false) }),
])

// ── POST /v1/social/inbound ──
export const SocialInboundSetResponse = z.object({
  enabled: z.boolean(),
  restart_required: z.literal(true),
})

// ── GET /v1/social/relationships ── core/relationships.ts Relationship
const SocialRelationshipShape = z.object({
  id: z.string(),
  kind: z.enum(['peer', 'anon', 'neighbor', 'human']),
  label: z.string(),
  channel: z.string().nullable(),
  familiarity: z.object({
    visits: z.number(),
    lastAt: z.string().nullable(),
    note: z.string().nullable(),
  }),
  origin: z.string(),
  autoVisit: z.boolean(),
})
export const SocialRelationshipsResponse = z.object({ relationships: z.array(SocialRelationshipShape) })
export type SocialRelationshipsResponseT = z.infer<typeof SocialRelationshipsResponse>

// ── POST /v1/social/visit ── 起跑就回
export const SocialVisitResponse = z.object({ ok: z.literal(true), started: z.literal(true) })

// ── GET /v1/journal ── journal 行(adapters/store/journal-store.ts CatchRow,SELECT *)
const JournalCatchRowShape = z.object({
  id: z.string(),
  ts: z.string(),
  chat_id: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  note: z.string(),
  status: z.enum(['new', 'tried', 'using', 'dropped']),
  kind: z.enum(['hunt', 'visit', 'postcard', 'recollection']),
  image_svg: z.string().nullable(),
  favorite: z.number().optional(),
  matter_id: z.string().nullable().optional(),
})
export const JournalListResponse = z.object({ items: z.array(JournalCatchRowShape) })
export type JournalListResponseT = z.infer<typeof JournalListResponse>

// ── GET /v1/journal/postcards ── image_svg 过一遍 safeSvg(不合格 → null)
export const JournalPostcardsResponse = z.object({
  items: z.array(JournalCatchRowShape),
  total: z.number(),
})

// ── POST /v1/journal/favorite · status · remove ── 找不到 → ok:false
export const JournalFavoriteResponse = z.object({ ok: z.boolean() })
export const JournalStatusResponse = z.object({ ok: z.boolean() })
export const JournalRemoveResponse = z.object({ ok: z.boolean() })

// ── POST /v1/journal/seen ──
export const JournalSeenResponse = z.object({ ok: z.literal(true), seen_until: z.string() })

// ── POST /v1/pair/start ── core/pairing.ts PairStartResult
export const PairStartResponse = z.union([
  z.object({ ok: z.literal(true), code: z.string(), expiresAt: z.number() }),
  z.object({ ok: z.literal(false), reason: z.literal('relay_drop_failed') }),
])

// ── POST /v1/pair/accept ── core/pairing.ts PairResult
export const PairAcceptResponse = z.union([
  z.object({ ok: z.literal(true), peer: z.object({ self_id: z.string(), name: z.string() }) }),
  z.object({ ok: z.literal(false), reason: z.enum(['expired_or_wrong', 'self_pair', 'id_conflict', 'relay_drop_failed']) }),
])

// ── GET /v1/penpal/channels ── 只列 open 信道
const PenpalChannelShape = z.object({
  id: z.string(),
  title: z.string(),
  peer_label: z.string(),
  degree: z.number(),
  unread: z.number(),
  last_preview: z.string().nullable(),
  last_at: z.string().nullable(),
})
export const PenpalChannelsResponse = z.object({ channels: z.array(PenpalChannelShape) })
export type PenpalChannelsResponseT = z.infer<typeof PenpalChannelsResponse>

// ── GET /v1/penpal/letters ── 只给明文字段,密文不出 daemon
const PenpalLetterShape = z.object({
  id: z.string(),
  direction: z.enum(['in', 'out']),
  plaintext: z.string(),
  created_at: z.string(),
  read_at: z.string().nullable(),
})
export const PenpalLettersResponse = z.object({ letters: z.array(PenpalLetterShape) })
export type PenpalLettersResponseT = z.infer<typeof PenpalLettersResponse>

// ── POST /v1/penpal/letters · POST /v1/penpal/letters/resend ── sendLetter / resendLetter 原样
const PenpalSendResultShape = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  letter_id: z.string().optional(),
})
export const PenpalSendLetterResponse = PenpalSendResultShape
export const PenpalResendLetterResponse = PenpalSendResultShape

// ── POST /v1/penpal/letters/read ──
export const PenpalMarkReadResponse = z.object({ ok: z.literal(true) })

// ── Lookup tables ───────────────────────────────────────────────────────
// REQUEST_SCHEMAS includes both POST body schemas (most routes) and GET
// query schemas (e.g. /v1/memory/list?dir=...). The validation step in
// index.ts uses these to parse the appropriate input before dispatch.
//
// RESPONSE_SCHEMAS: one entry per /v1 route (F1). Production does not
// validate responses; under the test runner index.ts checks every 2xx body
// against it (assertResponseContract).

export const REQUEST_SCHEMAS: Record<string, z.ZodTypeAny | undefined> = {
  // atelier
  'POST /v1/atelier/share': AtelierShareRequest,

  // memory
  'POST /v1/memory/read': MemoryReadRequest,
  'POST /v1/memory/write': MemoryWriteRequest,
  'GET /v1/memory/list': MemoryListQuery,
  'POST /v1/memory/delete': MemoryDeleteRequest,
  'POST /v1/memory/view': MemoryViewRequest,
  'POST /v1/memory/edit': MemoryEditRequest,

  // projects
  'POST /v1/projects/switch': ProjectsSwitchRequest,
  'POST /v1/projects/add': ProjectsAddRequest,
  'POST /v1/projects/remove': ProjectsRemoveRequest,

  // user
  'POST /v1/user/set_name': UserSetNameRequest,

  // share
  'POST /v1/share/page': SharePageRequest,
  'POST /v1/share/resurface': ShareResurfaceRequest,

  // voice
  'POST /v1/voice/save_config': VoiceSaveConfigRequest,

  // companion
  'POST /v1/companion/snooze': CompanionSnoozeRequest,
  'POST /v1/companion/import-local': CompanionImportLocalRequest,

  // customer review

  // wechat
  'POST /v1/wechat/reply': WechatReplyRequest,
  'POST /v1/wechat/reply_voice': WechatReplyVoiceRequest,
  'POST /v1/wechat/send_file': WechatSendFileRequest,
  'POST /v1/wechat/edit_message': WechatEditMessageRequest,
  'POST /v1/wechat/broadcast': WechatBroadcastRequest,

  // delegate
  'POST /v1/delegate': DelegateRequest,

  // cli hook events
  'POST /v1/cli/event': CliEventRequest,
  'POST /v1/cli/permission': CliPermissionRequest,
  'GET /v1/cli/permission': CliPermissionQuery,
  'GET /v1/cli/sessions': CliSessionsQuery,
  'POST /v1/cli/say': CliSayRequest,
  'GET /v1/cli/say': CliSayQuery,
  'POST /v1/cli/hooks/install': CliHooksRequest,
  'POST /v1/cli/hooks/uninstall': CliHooksRequest,

  // CC 的信
  'POST /v1/letters/write': LettersWriteRequest,
  'POST /v1/letters/settings': LettersSettingsRequest,

  // conversation
  'POST /v1/conversation/set-mode': ConversationSetModeRequest,

  // a2a
  'POST /v1/a2a/send': A2ASendRequest,
  'POST /v1/a2a/test': A2ATestRequest,
  'POST /v1/a2a/preview': A2APreviewRequest,
  'POST /v1/a2a/install': A2AInstallRequest,
  'POST /v1/a2a/remove': A2ARemoveRequest,
  'POST /v1/a2a/pause': A2APauseRequest,
  'POST /v1/plugins/toggle': PluginToggleRequest,
  'POST /v1/plugins/install': PluginInstallRequest,
  'POST /v1/plugins/upgrade': PluginInstallRequest,
  'POST /v1/license/activate': LicenseActivateRequest,
  'POST /v1/cli/upgrade': CliUpgradeRequest,
  'POST /v1/cli/rollback': CliRollbackRequest,

  // reminders
  'POST /v1/reminders/schedule': ReminderScheduleRequest,
  'POST /v1/reminders/cancel': ReminderCancelRequest,
  'GET /v1/reminders/list': ReminderListQuery,
}

export const RESPONSE_SCHEMAS: Record<string, z.ZodTypeAny | undefined> = {
  'GET /v1/health': HealthResponse,
  'POST /v1/atelier/share': AtelierShareResponse,
  'POST /v1/memory/read': MemoryReadResponse,
  'POST /v1/memory/write': MemoryWriteResponse,
  'GET /v1/memory/list': MemoryListResponse,
  'POST /v1/memory/delete': MemoryDeleteResponse,
  'GET /v1/projects/list': ProjectsListResponse,
  'POST /v1/projects/switch': ProjectsSwitchResponse,
  'POST /v1/projects/add': ProjectsAddResponse,
  'POST /v1/projects/remove': ProjectsRemoveResponse,
  'POST /v1/user/set_name': UserSetNameResponse,
  'POST /v1/share/page': SharePageResponse,
  'POST /v1/share/resurface': ShareResurfaceResponse,
  'GET /v1/voice/status': VoiceStatusResponse,
  'POST /v1/voice/save_config': VoiceSaveConfigResponse,
  'GET /v1/companion/status': CompanionStatusResponse,
  'GET /v1/companion/presence': PresenceResponse,
  'GET /v1/companion/thoughts': z.object({ items: z.array(z.object({ id: z.string(), ts: z.string(), title: z.string(), note: z.string() })) }),
  'POST /v1/companion/enable': CompanionEnableResponse,
  'POST /v1/companion/disable': CompanionDisableResponse,
  'POST /v1/companion/snooze': CompanionSnoozeResponse,
  'POST /v1/companion/import-local': CompanionImportLocalResponse,
  'POST /v1/wechat/reply': WechatReplyResponse,
  'POST /v1/wechat/reply_voice': WechatReplyVoiceResponse,
  'POST /v1/wechat/send_file': WechatSendFileResponse,
  'POST /v1/wechat/edit_message': WechatEditMessageResponse,
  'POST /v1/wechat/broadcast': WechatBroadcastResponse,
  'POST /v1/delegate': DelegateResponse,
  'POST /v1/conversation/set-mode': ConversationSetModeResponse,
  'POST /v1/a2a/send': A2ASendResponse,
  'POST /v1/a2a/test': A2ATestResponse,
  'POST /v1/a2a/preview': A2APreviewResponse,
  'POST /v1/a2a/install': A2AInstallResponse,

  // reminders
  'POST /v1/reminders/schedule': ReminderScheduleResponse,
  'POST /v1/reminders/cancel': ReminderCancelResponse,
  'GET /v1/reminders/list': ReminderListResponse,

  // 工作台
  'GET /v1/workbench/entry-options': WorkbenchEntryOptionsResponse,
  'POST /v1/workbench/create-entry': WorkbenchEntryResultResponse,
  'GET /v1/workbench/entry-receipt': WorkbenchEntryResultResponse,
  'GET /v1/workbench': WorkbenchListResponse,
  'GET /v1/workbench/models': WorkbenchModelsResponse,
  'POST /v1/workbench/attachment': WorkbenchAttachmentUploadResponse,
  'GET /v1/workbench/attachment': WorkbenchAttachmentReadResponse,
  'POST /v1/workbench/discard-attachment': WorkbenchOkResponse,
  'GET /v1/workbench/attention': WorkbenchAttentionResponse,
  'POST /v1/workbench/input': WorkbenchInputResponse,
  'POST /v1/workbench/answer': WorkbenchOkResponse,
  'POST /v1/workbench/withdraw-input': WorkbenchOkResponse,
  'GET /v1/workbench/sessions': WorkbenchSessionsResponse,
  'GET /v1/workbench/session': WorkbenchSessionResponse,
  'GET /v1/workbench/task': WorkbenchTaskDetailResponse,
  'POST /v1/workbench/project': WorkbenchProjectResponse,
  'POST /v1/workbench/create': WorkbenchTaskResponse,
  'POST /v1/workbench/continue': WorkbenchTaskResponse,
  'POST /v1/workbench/cancel': WorkbenchTaskResponse,
  'GET /v1/workbench/artifact': WorkbenchArtifactResponse,
  'POST /v1/workbench/approve': WorkbenchOkResponse,
  'POST /v1/workbench/permission': WorkbenchOkResponse,
  'POST /v1/workbench/archive': WorkbenchTaskResponse,
  'POST /v1/workbench/writer-exited': WorkbenchTaskResponse,
  'POST /v1/workbench/unattended-ack': WorkbenchUnattendedAckResponse,
  'GET /v1/workbench/review': WorkbenchReviewResponse,
  'POST /v1/workbench/review-mark': WorkbenchReviewMarkResponse,
  'POST /v1/workbench/review-return': WorkbenchReviewReturnResponse,
  'POST /v1/workbench/review-revert': WorkbenchReviewRevertResponse,
  'POST /v1/workbench/review-comment': WorkbenchReviewCommentResponse,
  'POST /v1/workbench/review-comments-send': WorkbenchReviewCommentsSendResponse,
  'POST /v1/workbench/review-hunk': WorkbenchReviewHunkResponse,
  'POST /v1/workbench/worktree': WorkbenchWorktreeResponse,
  'POST /v1/workbench/script-approve': WorkbenchScriptApproveResponse,
  'GET /v1/workbench/rewind-preview': WorkbenchRewindPreviewResponse,
  'POST /v1/workbench/rewind': WorkbenchRewindResponse,
  'POST /v1/workbench/rewind-resolve': WorkbenchRewindResolveResponse,
  'POST /v1/workbench/import': WorkbenchImportResponse,
  'POST /v1/workbench/prepare-resume': WorkbenchPrepareResumeResponse,
  'POST /v1/workbench/prepare-continuation': WorkbenchPrepareContinuationResponse,
  'POST /v1/workbench/quota-handoff': WorkbenchQuotaHandoffResponse,
  'POST /v1/workbench/handoff-preview': WorkbenchHandoffPreviewResponse,
  'POST /v1/workbench/handoff': WorkbenchHandoffResponse,
  'GET /v1/workbench/handoff': WorkbenchHandoffRecordResponse,
  // 一件事 / 连接 / 手机 / 插件 / 许可 / 终端会话 / 日历 / 信
  'GET /v1/matters': MattersListResponse,
  'GET /v1/matter': MatterDetailResponse,
  'GET /v1/matter/owner-chat': MatterOwnerChatResponse,
  'GET /v1/matter/owner-chat/search': MatterOwnerChatSearchResponse,
  'POST /v1/matter/say': MatterSayResponse,
  'GET /v1/connections': ConnectionsResponse,
  'POST /v1/phone/link': PhoneLinkResponse,
  'GET /v1/phone/devices': PhoneDevicesResponse,
  'GET /v1/plugins/list': PluginsListResponse,
  'POST /v1/plugins/toggle': PluginToggleResponse,
  'GET /v1/plugins/registry': PluginsRegistryResponse,
  'POST /v1/plugins/install': PluginInstallResponse,
  'POST /v1/plugins/upgrade': PluginUpgradeResponse,
  'GET /v1/license/status': LicenseStatusResponse,
  'POST /v1/license/activate': LicenseActivateResponse,
  'POST /v1/license/deactivate': LicenseDeactivateResponse,
  'POST /v1/cli/event': CliEventResponse,
  'POST /v1/cli/permission': CliPermissionOpenResponse,
  'GET /v1/cli/permission': CliPermissionStatusResponse,
  'GET /v1/cli/sessions': CliSessionsResponse,
  'POST /v1/cli/say': CliSayStartResponse,
  'GET /v1/cli/say': CliSayWaitResponse,
  'GET /v1/overseer/today': OverseerTodayResponse,
  'GET /v1/calendar/agenda': CalendarAgendaResponse,
  'POST /v1/cli/hooks/install': CliHooksResponse,
  'POST /v1/cli/hooks/uninstall': CliHooksResponse,
  'GET /v1/letters': LettersStatusResponse,
  'POST /v1/letters/write': LettersWriteResponse,
  'POST /v1/letters/settings': LettersSettingsResponse,
  'GET /v1/locate': LocateResponse,
  'GET /v1/health/incidents': HealthIncidentsResponse,
  // 回合 / 贴纸 / 语音 / 会话 / 后台控制 / 模型健康 / 画室
  'POST /v1/turn/attach': TurnAttachResponse,
  'POST /v1/wechat/message': WechatMessageResponse,
  'POST /v1/wechat/send_sticker': WechatSendStickerResponse,
  'POST /v1/wechat/search_online_sticker': WechatSearchOnlineStickerResponse,
  'POST /v1/wechat/search_online_sticker_candidates': WechatOnlineStickerCandidatesResponse,
  'POST /v1/wechat/send_online_sticker_candidate': WechatSendOnlineStickerCandidateResponse,
  'POST /v1/wechat/sticker_feedback': WechatStickerFeedbackResponse,
  'GET /v1/stickers': StickersListResponse,
  'POST /v1/stt/save_config': SttSaveConfigResponse,
  'GET /v1/stt/status': SttStatusResponse,
  'POST /v1/chat-prefs': ChatPrefsSetResponse,
  'POST /v1/stickers': StickersSaveResponse,
  'POST /v1/companion/converse': CompanionConverseResponse,
  'POST /v1/companion/speak': CompanionSpeakResponse,
  'POST /v1/companion/transcribe': CompanionTranscribeResponse,
  'GET /v1/turns': DaemonTurnsResponse,
  'GET /v1/sessions': DaemonSessionsResponse,
  'GET /v1/model': DaemonModelGetResponse,
  'POST /v1/sessions/release': DaemonSessionsReleaseResponse,
  'POST /v1/model': DaemonModelSetResponse,
  'POST /v1/daemon/restart': DaemonRestartResponse,
  'POST /v1/selftest/converse': SelftestConverseResponse,
  'POST /v1/cli/upgrade': CliUpgradeOpResponse,
  'POST /v1/cli/rollback': CliUpgradeOpResponse,
  'GET /v1/llm/health': LlmHealthResponse,
  'POST /v1/net/probe': NetProbeResponse,
  'POST /v1/llm/keys': LlmKeysSaveResponse,
  'GET /v1/settings/link': SettingsLinkResponse,
  'GET /v1/atelier/works': AtelierWorksResponse,
  'GET /v1/atelier/model-status': AtelierModelStatusResponse,
  // 记忆 / 知识库 / 配置 / 联邦
  'POST /v1/memory/synthesize': OwnerMemSynthesizeResponse,
  'POST /v1/memory/nightly/run': OwnerMemNightlyRunResponse,
  'GET /v1/memory/source': OwnerMemSourceResponse,
  'POST /v1/memory/source/review': OwnerMemSourceReviewResponse,
  'POST /v1/memory/profile/generate': OwnerMemProfileGenerateResponse,
  'POST /v1/memory/view': OwnerMemViewResponse,
  'POST /v1/memory/edit': OwnerMemEditResponse,
  'POST /v1/memory/portrait/generate': OwnerMemPortraitGenerateResponse,
  'GET /v1/memory/portrait': OwnerMemPortraitResponse,
  'POST /v1/knowledge/source/put': KnowledgeSourcePutResponse,
  'POST /v1/knowledge/semantic/put': KnowledgeSemanticPutResponse,
  'GET /v1/chat/history': ChatHistoryResponse,
  'GET /v1/knowledge/messages': KnowledgeMessagesResponse,
  'POST /v1/knowledge/search': KnowledgeSearchResponse,
  'GET /v1/knowledge/semantic/status': KnowledgeSemanticStatusResponse,
  'POST /v1/knowledge/graph/contact_profile': KnowledgeContactProfileResponse,
  'POST /v1/knowledge/graph/top_contacts': KnowledgeTopContactsResponse,
  'POST /v1/knowledge/graph/rank_contacts': KnowledgeRankContactsResponse,
  'POST /v1/knowledge/graph/relationship_subgraph': KnowledgeRelationshipSubgraphResponse,
  'POST /v1/knowledge/graph/connectors': KnowledgeConnectorsResponse,
  'GET /v1/knowledge/graph/status': KnowledgeGraphStatusResponse,
  'POST /v1/knowledge/facts/extraction_batch': KnowledgeExtractionBatchResponse,
  'POST /v1/knowledge/facts/record_facts': KnowledgeRecordFactsResponse,
  'POST /v1/knowledge/facts/contact_facts': KnowledgeContactFactsResponse,
  'POST /v1/knowledge/facts/find_facts': KnowledgeFindFactsResponse,
  'POST /v1/knowledge/facts/set_fact_status': KnowledgeSetFactStatusResponse,
  'GET /v1/knowledge/facts/extraction_status': KnowledgeExtractionStatusResponse,
  'POST /v1/knowledge/person/brief': KnowledgePersonBriefResponse,
  'GET /v1/config/surface': ConfigSurfaceResponse,
  'POST /v1/config/set': ConfigSetResponse,
  'POST /v1/federation/mint': FederationMintResponse,
  // 桌宠 / A2A / 社交 / 权限 / 自改 / 手帐 / 配对 / 笔友
  'GET /v1/companion/pet': PetTurnResponse,
  'GET /v1/a2a/list': A2AListResponse,
  'GET /v1/a2a/info': A2AInfoResponse,
  'GET /v1/a2a/activity': A2AActivityResponse,
  'POST /v1/a2a/remove': A2ARemoveResponse,
  'POST /v1/a2a/pause': A2APauseResponse,
  'POST /v1/social/enable': SocialEnableResponse,
  'POST /v1/social/wish': SocialWishProposeResponse,
  'POST /v1/social/wish/send': SocialWishSendResponse,
  'POST /v1/social/wish/cancel': SocialWishCancelResponse,
  'GET /v1/social/wishes': SocialWishesResponse,
  'POST /v1/social/intro/request': SocialIntroRequestResponse,
  'POST /v1/social/intro/accept': SocialIntroAcceptResponse,
  'POST /v1/social/intro/decline': SocialIntroDeclineResponse,
  'GET /v1/social/intro/offers': SocialIntroOffersResponse,
  'GET /v1/permissions/pending': PermissionsPendingResponse,
  'POST /v1/permissions/resolve': PermissionsResolveResponse,
  'POST /v1/self-change/notice': SelfChangeNoticeResponse,
  'POST /v1/self-change/ask': SelfChangeAskResponse,
  'GET /v1/self-change/decision': SelfChangeDecisionResponse,
  'GET /v1/social/inbound': SocialInboundStatusResponse,
  'POST /v1/social/inbound': SocialInboundSetResponse,
  'GET /v1/social/relationships': SocialRelationshipsResponse,
  'POST /v1/social/visit': SocialVisitResponse,
  'GET /v1/journal': JournalListResponse,
  'GET /v1/journal/postcards': JournalPostcardsResponse,
  'POST /v1/journal/favorite': JournalFavoriteResponse,
  'POST /v1/journal/status': JournalStatusResponse,
  'POST /v1/journal/seen': JournalSeenResponse,
  'POST /v1/journal/remove': JournalRemoveResponse,
  'POST /v1/pair/start': PairStartResponse,
  'POST /v1/pair/accept': PairAcceptResponse,
  'GET /v1/penpal/channels': PenpalChannelsResponse,
  'GET /v1/penpal/letters': PenpalLettersResponse,
  'POST /v1/penpal/letters': PenpalSendLetterResponse,
  'POST /v1/penpal/letters/read': PenpalMarkReadResponse,
  'POST /v1/penpal/letters/resend': PenpalResendLetterResponse,
}
