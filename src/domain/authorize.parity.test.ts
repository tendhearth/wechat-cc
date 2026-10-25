/**
 * authorize() 逐格对照(架构终态 C2):每一处逐工具判定换成 domain/authorize.ts 之前,把原来的实现**原样**抄在这里当
 * 对照(legacy*,只改了函数名;判定规则那一处 effectivePolicy / decideTool 用 C1 之前的四行原文 legacyDecideTool),
 * 新旧两份在同一组格子上跑,结果、问主人的那一下(谁、什么话、哪个码、多久)、日志、通道调用都要一位不差。
 *
 * 格子:面(对话 Claude / Gemini / OpenAI 兼容、定时任务只读档、一起做的 Claude、一起做的放行规则、终端会话)×
 * 档位 × 权限模式 × 对话模式 × 能力表 askUser × 工具(每个类别至少一个,外加每个 wechat MCP 名、别家 MCP、未知工具、
 * 坏名字)× 有没有 admin × 主人怎么答 × 取消 × 登记表 × 放行规则的每一种裁决。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanUseTool, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { lookup, KNOWN_PROVIDER_IDS, type Capability } from './capability-matrix'
import { compilePolicy } from './policy'
import { classifyToolUse, JOB_PROFILE, REVIEW_PROFILE, TIER_PROFILES, type TierProfile, type ToolKind, type UserTier } from './user-tier'
import type { PermissionMode } from './permission-mode'
import type { Mode } from './conversation'
import { toolInputFacts } from './permission-rules/facts'
import { authorize, OWNER_RULE_SURFACES } from './authorize'
import { isReplyToolName, type SpawnContext } from '../ports/agent-provider'
import { makeCanUseTool, type PermissionRelayDeps } from '../core/permission-relay'
import { makeGeminiToolGate, type GeminiGateDeps, type ToolGate } from '../adapters/executors/gemini/gemini-agent-provider'
import { gateTool } from '../adapters/executors/openai/openai-gate'
import { makeWorkbenchClaudeCanUseTool } from '../adapters/executors/claude/claude-agent-provider'
import { isCompanionMcp, nativeMcpInputPreview } from '../adapters/executors/claude/claude-native-config'
import { WORKBENCH_PERMISSION_DESCRIPTION_MAX, WORKBENCH_PERMISSION_TIMEOUT_MS, WORKBENCH_PERMISSION_TOOL_MAX, makeRunPermissions, type PendingWorkbenchPermission, type PermissionDecide, type PermissionDecision, type PermissionFacts, type PermissionOutcome, type WorkbenchPermissionAudit } from '../core/workbench/permissions'
import { validateUserInputAnswers, validateUserInputRequest } from '../core/workbench/user-input'
import { floorReason } from '../core/permission-rules/floor'
import { pathsUnder } from '../core/permission-rules/paths'
import { wireModelOptions } from '../daemon/bootstrap/wire-model-options'
import { workbenchClaudeOptions } from '../daemon/bootstrap/wire-workbench'
import { makeTerminalDecide } from '../daemon/permission-gate'
import type { Decision, Verdict } from './permission-rules/types'

// ───────────────────────── 改之前的实现(原样) ─────────────────────────

/** C1 之前三家各抄一份的那四行(tool-decision.test.ts 已证明 decideTool 与它一格不差)。 */
function legacyDecideTool(tp: TierProfile, kind: ToolKind, askUser: 'per-tool' | 'never' = 'never'): 'allow' | 'relay' | 'deny' {
  if (tp.deny.has(kind)) return 'deny'
  if (tp.relay.has(kind)) return 'relay'
  if (tp.allow.has(kind)) return 'allow'
  return askUser === 'per-tool' ? 'relay' : 'allow'
}
/** permission-relay.ts 的 effectivePolicy(原样)。 */
function effectivePolicy(base: Capability, tp: TierProfile, kind: ToolKind): 'allow' | 'relay' | 'deny' {
  return legacyDecideTool(tp, kind, base.askUser)
}

// permission-relay.ts makeCanUseTool
const LEGACY_RELAY_TIMEOUT_MS = 10 * 60_000

function legacyClaudeChatGate(deps: PermissionRelayDeps): CanUseTool {
  return async (toolName, input, opts) => {
    // Chatroom beats: the coordinator captures each agent's plain text and
    // re-emits it prefixed ([Claude]/[Codex]). A direct reply-tool call would
    // (a) send an UN-prefixed message straight to the chat and (b) lose its
    // real argument to the verdict transcript (collectTurn records only
    // replyToolCalled, not the text). So deny reply outright during a debate
    // beat — force plain text. See conversation-coordinator.runBeat.
    // 2026-09:同样的理由对 parallel(/both)也成立,而且多一条 —— /both
    // 现在会在末尾给一条收口(见 dispatchParallel 的 buildParallelSynthesisPrompt)。
    // reply 工具一走,协调器就**看不到那位说了什么**,收口只能拿到半场,
    // 比不收口更糟。代价:参与者不能在 /both 里直接发图(纯文本会照常前缀
    // 转发);/chat 早就接受了同一个代价。
    // 回复交付 daemon 模式(spec 2026-10-03 §4.9):reply 族不注册了,扇出里要拒的只剩显式的 `message`
    // (往别处发)—— 同一个理由:协调器看不到那句话,前缀 / 收口都管不到它。
    const fanOut = deps.mode() === 'chatroom' || deps.mode() === 'parallel'
    if (fanOut && (isReplyToolName(toolName) || toolName === 'mcp__wechat__message')) {
      deps.log('PERMISSION', `deny-fanout-reply: mode=${deps.mode()} tool=${toolName}`)
      return {
        behavior: 'deny',
        message: 'reply tool is disabled in chatroom/parallel mode — respond with plain text, the host will relay it',
      } satisfies PermissionResult
    }
    const tier = deps.resolveTier()
    const tp = TIER_PROFILES[tier]
    const kind = classifyToolUse(toolName, input as Record<string, unknown>)
    const base = lookup(deps.mode(), deps.provider, deps.permissionMode)
    const decision = effectivePolicy(base, tp, kind)

    if (decision === 'allow') return { behavior: 'allow' } satisfies PermissionResult
    if (decision === 'deny') {
      deps.log('PERMISSION', `deny: tool=${toolName} kind=${kind} tier=${tier}`)
      return {
        behavior: 'deny',
        message: `Tool '${toolName}' (${kind}) not available to tier '${tier}'`,
      } satisfies PermissionResult
    }
    // relay
    const target = deps.adminChatId()
    if (!target) {
      deps.log('PERMISSION', `relay-but-no-admin: tool=${toolName} kind=${kind} — denying`)
      return {
        behavior: 'deny',
        message: 'no admin configured to approve permission requests',
      } satisfies PermissionResult
    }
    const hash = legacyRelayHash(opts.toolUseID ?? '')
    const prompt = opts.title ?? `Claude wants to run ${toolName} ${legacyCompactInput(input)}`
    const answer = await deps.askUser(target, prompt, hash, LEGACY_RELAY_TIMEOUT_MS)
    if (answer === 'allow') return { behavior: 'allow' } satisfies PermissionResult
    deps.log('PERMISSION', `${answer}: tool=${toolName} hash=${hash}`)
    // 'undelivered' ≠ denied: the approver never saw the prompt (their push
    // window was closed). Tell the agent honestly so it can relay a useful
    // message to the initiating user instead of a false "主人拒绝了".
    const message = answer === 'undelivered'
      ? 'Could not deliver the approval request to the admin (their message window is likely closed). Tell the user this action needs the owner’s approval but the owner couldn’t be reached right now — ask them to try again shortly, or have the owner send you a message first.'
      : answer === 'timeout' ? 'User did not reply in time; request denied'
      : 'User denied the request'
    return { behavior: 'deny', message } satisfies PermissionResult
  }
}

function legacyRelayHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  // A base36 uint32 is 1–7 chars; the admin reply regex (pending-permissions.ts
  // PERMISSION_REPLY_RE) requires EXACTLY 5. padStart guards <5, slice(-5) guards >5.
  return (h >>> 0).toString(36).padStart(5, '0').slice(-5)
}

function legacyCompactInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  const first = keys[0]
  if (!first) return ''
  const v = input[first]
  return `${first}=${typeof v === 'string' ? v.slice(0, 40) : typeof v}`
}

// gemini-agent-provider.ts makeGeminiToolGate
const LEGACY_GEMINI_TIMEOUT_MS = 120_000

/** Inlined (NOT imported from permission-relay.ts, which would recreate the
 *  gemini→permission-relay→capability-matrix→gemini import cycle) djb2-ish hash →
 *  5-char base36. The relay hash MUST be exactly 5 alphanumeric chars so the admin's
 *  WeChat reply matches pending-permissions.ts's PERMISSION_REPLY_RE
 *  (/^([yn])\s+([A-Za-z0-9]{5})$/i) — anything else can NEVER be approved. A base36
 *  uint32 is 1–7 chars, so padStart guarantees the low end and slice(-5) the high end:
 *  the result is ALWAYS exactly 5 alphanumeric chars. */
function legacyGeminiHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36).padStart(5, '0').slice(-5)
}

/** Build the per-spawn tool gate. Replicates makeCanUseTool's allow/relay/deny
 *  but returns ToolGateDecision and normalizes the wechat MCP server's BARE tool
 *  names (`reply`) into the `mcp__wechat__reply` form classifyToolUse expects. */
function legacyGeminiGate(deps: GeminiGateDeps): (ctx: SpawnContext) => ToolGate {
  return (ctx: SpawnContext): ToolGate => {
    // Per-spawn relay counter — each session owns its own, so hashes don't couple
    // across chats. Combined with chatId in the hash input → unique per relay.
    let relaySeq = 0
    return async (toolName, input) => {
      if (!compilePolicy('gemini', ctx.tierProfile, ctx.permissionMode).gateEnabled) return { allow: true }
      // Reject any bare name already containing '__': prefixing `mcp__wechat__`
      // onto it (e.g. `mcp__wechat__shell` → `mcp__wechat__mcp__wechat__shell`)
      // yields a malformed name classifyToolUse may misclassify as unknown→allow,
      // letting a gated tool slip through. Deny outright.
      if (toolName.includes('__')) return { allow: false, message: `invalid tool name '${toolName}'` }
      const kind = classifyToolUse(`mcp__wechat__${toolName}`, input)
      const base = deps.lookupBase(deps.modeFor(ctx.chatId), ctx.permissionMode)
      const decision = legacyDecideTool(ctx.tierProfile, kind, base.askUser)
      if (decision === 'allow') return { allow: true }
      if (decision === 'deny') return { allow: false, message: `tool '${toolName}' (${kind}) not allowed for this tier` }
      const admin = deps.adminFor(ctx.chatId)
      if (!admin) return { allow: false, message: 'no admin configured to approve permission requests' }
      const seq = ++relaySeq
      const hash = legacyGeminiHash(`${ctx.chatId}:${toolName}:${seq}`)
      const answer = await deps.askUser(admin, `Gemini wants to run ${toolName}`, hash, LEGACY_GEMINI_TIMEOUT_MS)
      if (answer === 'allow') return { allow: true }
      const message = answer === 'undelivered'
        ? 'could not reach the owner for approval (their message window is likely closed) — tell the user to try again shortly or have the owner message first'
        : answer === 'timeout' ? 'no reply in time; denied' : 'denied by operator'
      return { allow: false, message }
    }
  }
}


// openai-gate.ts gateTool
type GateDecision = 'allow' | 'deny'
function legacyOpenaiGate(args: {
  toolName: string
  /**
   * The REAL MCP server that owns this tool call (from
   * `McpToolBridge.serverOf`), or `undefined` for a built-in tool. Must be
   * the actual owning server — never assume `wechat` for every MCP tool,
   * or a same-named tool from another server (a plugin, `delegate`, …)
   * gets misclassified as the wechat tool of that name, which can
   * escalate a guest-denied tool into a guest-allowed one.
   */
  mcpServer?: string
  input: Record<string, unknown>
  tierProfile: TierProfile
  permissionMode: PermissionMode
}): GateDecision {
  const policy = compilePolicy('openai', args.tierProfile, args.permissionMode)
  if (policy.bypass) return 'allow'

  // classifyToolUse recognizes wechat MCP tools by their SDK-prefixed name
  // (`mcp__wechat__<name>`); built-in tools (Read/Write/Edit/Bash/...) pass
  // through unchanged. Other MCP servers get their own `mcp__<server>__<name>`
  // prefix, which classifyToolUse does NOT special-case — it falls through to
  // the fail-safe default ('subagent'), never the wechat tool's kind.
  const sdkName = args.mcpServer ? `mcp__${args.mcpServer}__${args.toolName}` : args.toolName
  const kind = classifyToolUse(sdkName, args.input)

  // 判定在 ./tool-decision.ts(三家共用);openai 不看能力表(它没有 per-tool 的那一档)。
  // v1: relay collapses to deny in strict mode — mid-turn WeChat confirmation round-trip is deferred.
  const verdict = legacyDecideTool(args.tierProfile, kind)
  return verdict === 'relay' ? policy.relayAs : verdict
}

// wire-model-options.ts profileGate
function legacyJobGate(tp: TierProfile, scope: { root: string; stateDir: string }): NonNullable<Options['canUseTool']> {
  let tainted = false
  const deny = (toolName: string, why: string) => ({ behavior: 'deny' as const, message: `这一轮是只读的定时任务,不能用 ${toolName}(${why})。` })
  return async (toolName, input) => {
    const args = (input ?? {}) as Record<string, unknown>
    const kind = classifyToolUse(toolName, args)
    if (!tp.allow.has(kind)) return deny(toolName, '不在只读档里')
    if (kind === 'network' && tainted) return deny(toolName, '这一轮已经读过本机的东西,不再上网')
    if (kind === 'fs_read') {
      const facts = toolInputFacts(args)
      const glob = typeof args.pattern === 'string' && isAbsolute(args.pattern) ? [args.pattern] : []
      const paths = [...facts.paths, ...glob].map(p => (isAbsolute(p) ? p : join(scope.root, p)))
      if (toolName.startsWith('mcp__') && paths.length === 0) return deny(toolName, '没有路径')
      if (paths.length && !pathsUnder(paths, scope.root)) return deny(toolName, '只能读这个项目目录里的文件')
      const red = floorReason({ surface: 'workbench', provider: 'job', tool: 'Read', paths, cwd: scope.root, project: scope.root, isolatedWorktree: false, tier: 'admin', scope: 'job' }, homedir(), { stateDir: scope.stateDir })
      if (red) return deny(toolName, red)
    }
    if (kind === 'fs_read' || kind === 'memory_read' || kind === 'observations_read') tainted = true
    return { behavior: 'allow', updatedInput: input }
  }
}

// claude-agent-provider.ts taskInputPreview + makeWorkbenchClaudeCanUseTool
function legacyTaskInputPreview(input: Record<string, unknown>): string | null {
  if (typeof input.command === 'string') return `command=${input.command}`
  try {
    const json=JSON.stringify(input)
    return json === '{}' ? '' : `input=${json}`
  } catch {
    return null
  }
}

/** Claude's task-only permission gate. Workbench has no CC-private messaging
 * or personal-memory MCP surface; local built-ins retain trusted/solo/strict
 * allow/relay/deny policy, with relay decisions owned by the active task run. */
function legacyWorkbenchGateInner(
  requestPermission?: SpawnContext['requestPermission'],
  requestUserInput?: SpawnContext['requestUserInput'],
  admittedMcpServers: readonly string[] = [],
): CanUseTool {
  return async (toolName, input, options) => {
    if (options.signal.aborted) {
      return { behavior:'deny', message:'This task tool call was cancelled.' } satisfies PermissionResult
    }
    if (toolName === 'AskUserQuestion') {
      // Native answers are supplied through updatedInput, keyed by the exact
      // question text. This is a question callback, never an execution grant.
      const denied = { behavior: 'deny', message: 'The task question was declined, invalid, or is no longer active.' } satisfies PermissionResult
      if (!requestUserInput) return denied
      try {
        if (typeof options.toolUseID !== 'string' || !options.toolUseID || !Array.isArray(input.questions)) return denied
        const texts = new Set<string>()
        const request = validateUserInputRequest({ questions: input.questions.map((value: unknown, index: number) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_question')
          const q = value as Record<string, unknown>
          if (typeof q.question !== 'string' || texts.has(q.question) || typeof q.multiSelect !== 'boolean' || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) throw new Error('invalid_question')
          texts.add(q.question)
          return {
            id: `${options.toolUseID}:${index}`, header: q.header, question: q.question, multiSelect: q.multiSelect, allowOther: true,
            options: q.options.map((value: unknown) => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_question')
              const option = value as Record<string, unknown>
              if (option.preview !== undefined && typeof option.preview !== 'string') throw new Error('invalid_question')
              return { label: option.label, description: option.preview && typeof option.description === 'string' ? `${option.description}\n${option.preview}` : option.description }
            }),
          }
        }) })
        const response = await requestUserInput(request, options.signal)
        if (response === null || options.signal.aborted) return denied
        const answers = validateUserInputAnswers(request, response)
        return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(request.questions.map(question => [question.question, answers[question.id]!.join(', ')])) } } satisfies PermissionResult
      } catch { return denied }
    }
    if (toolName.startsWith('mcp__')) {
      const denied = { behavior:'deny',message:'The task tool was not admitted, or approval was denied or expired.' } satisfies PermissionResult
      const server = admittedMcpServers.find(name => !isCompanionMcp(name) && toolName.startsWith(`mcp__${name}__`) && toolName.length > name.length + 7)
      if (!server || !requestPermission || toolName.length > WORKBENCH_PERMISSION_TOOL_MAX) return denied
      const inputPreview = nativeMcpInputPreview(input)
      if (!inputPreview || inputPreview.length > WORKBENCH_PERMISSION_DESCRIPTION_MAX - 256) return denied
      try {
        const allowed = await requestPermission({tool:toolName,description:`${toolName}\n${inputPreview}`}, options.signal)
        return allowed && !options.signal.aborted ? {behavior:'allow'} : denied
      } catch { return denied }
    }
    const kind = classifyToolUse(toolName, input)
    if (options.signal.aborted) {
      return { behavior:'deny', message:'This task tool call was cancelled.' } satisfies PermissionResult
    }
    const decision = effectivePolicy(
      lookup('solo','claude','strict'),
      TIER_PROFILES.trusted,
      kind,
    )
    if (decision === 'allow') return { behavior: 'allow' } satisfies PermissionResult
    if (decision === 'deny') {
      return { behavior: 'deny', message: `Tool '${toolName}' (${kind}) is unavailable in this task.` } satisfies PermissionResult
    }
    if (!requestPermission || options.signal.aborted) {
      return { behavior: 'deny', message: 'This task permission request is no longer active.' } satisfies PermissionResult
    }
    const inputPreview=legacyTaskInputPreview(input)
    const context=options.title?.trim() || options.description?.trim() || options.decisionReason?.trim() || ''
    const description=[context,inputPreview].filter(Boolean).join('\n') || `Run ${toolName}`
    if (toolName.length > WORKBENCH_PERMISSION_TOOL_MAX || inputPreview === null || description.length > WORKBENCH_PERMISSION_DESCRIPTION_MAX) {
      return { behavior:'deny', message:'The complete permission detail is too large to review safely.' } satisfies PermissionResult
    }
    let allowed = false
    try {
      // 放行规则(2026-10-19)要原文:命令、文件路径(拿不到就不给)。
      const facts = toolInputFacts(input)
      allowed = await requestPermission({
        tool: toolName.slice(0, WORKBENCH_PERMISSION_TOOL_MAX),
        description,
        ...(facts.command ? { command: facts.command } : {}),
        ...(facts.paths.length ? { paths: facts.paths } : {}),
      }, options.signal)
    } catch {
      allowed = false
    }
    return allowed && !options.signal.aborted
      ? { behavior: 'allow' } satisfies PermissionResult
      : { behavior: 'deny', message: 'The task permission request was denied or expired.' } satisfies PermissionResult
  }
}


// core/workbench/permissions.ts makeRunPermissions
interface Entry {
  permission: PendingWorkbenchPermission
  expiresAt: number
  finish: (allowed: boolean, outcome: PermissionOutcome) => void
  /** 冻住期间撤掉的到期计时器,放开时按剩下的时间重起(网络守护暂停,2026-10-03)。 */
  rearm: (ms: number) => void
  disarm: () => void
}

function legacyRunPermissions(opts: {
  taskId: string
  timeoutMs?: number
  audit?: (event: WorkbenchPermissionAudit) => void
  /** 放行规则:登记之前先问。allow / deny ⇒ 不登记、不发 request 审计(主人收不到通知),只记 outcome 带 by。 */
  decide?: PermissionDecide
}) {
  const entries = new Map<string, Entry>()
  let closed = false
  /** 暂停时刻(网络守护把执行者冻住时):期间不算进五分钟的批准期限。null = 没暂停。 */
  let pausedAt: number | null = null
  const audit = (event: WorkbenchPermissionAudit): boolean => {
    try { opts.audit?.(event); return true } catch { return false }
  }

  function request(
    raw: { tool: string; description: string; command?: string; paths?: string[]; cwd?: string },
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (closed || typeof raw?.tool !== 'string' || typeof raw?.description !== 'string') return Promise.resolve(false)
    const tool = raw.tool.trim()
    const description = raw.description.trim()
    if (!tool || !description || tool.length > WORKBENCH_PERMISSION_TOOL_MAX ||
        description.length > WORKBENCH_PERMISSION_DESCRIPTION_MAX || signal?.aborted) return Promise.resolve(false)
    if (!opts.decide) return register(tool, description, signal)
    const facts: PermissionFacts = { tool, description }
    if (typeof raw.command === 'string' && raw.command.trim()) facts.command = raw.command
    if (Array.isArray(raw.paths) && raw.paths.length && raw.paths.every(p => typeof p === 'string' && p)) facts.paths = [...raw.paths]
    if (typeof raw.cwd === 'string' && raw.cwd) facts.cwd = raw.cwd
    return opts.decide(facts).catch(() => ({ verdict: 'ask' as const, by: 'default' })).then(d => {
      if (closed || signal?.aborted) return false
      if ((d.verdict === 'allow' || d.verdict === 'deny') && (d.by === 'rule' || d.by === 'review' || d.by === 'floor')) {
        const permission: PendingWorkbenchPermission = { id: randomUUID(), taskId: opts.taskId, tool, description, createdAt: Date.now() }
        const audited = audit({ type: 'outcome', permission, outcome: d.verdict, by: d.by })
        return audited && d.verdict === 'allow'
      }
      return register(tool, description, signal)
    })
  }

  function register(tool: string, description: string, signal?: AbortSignal): Promise<boolean> {
    const permission: PendingWorkbenchPermission = {
      id: randomUUID(),
      taskId: opts.taskId,
      tool,
      description,
      createdAt: Date.now(),
    }
    return new Promise<boolean>(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => entry.finish(false, 'aborted')
      const finish = (allowed: boolean, outcome: PermissionOutcome) => {
        if (settled) return
        settled = true
        entries.delete(permission.id)
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const audited = audit({ type: 'outcome', permission, outcome })
        resolve(audited ? allowed : false)
      }
      const timeoutMs = opts.timeoutMs ?? WORKBENCH_PERMISSION_TIMEOUT_MS
      const rearm = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => finish(false, 'expired'), Math.max(0, ms)); timer.unref?.() }
      const disarm = () => { if (timer) clearTimeout(timer); timer = undefined }
      const entry: Entry = { permission, expiresAt:permission.createdAt + Math.max(0,timeoutMs), finish, rearm, disarm }
      entries.set(permission.id, entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (pausedAt === null) rearm(timeoutMs)
      if (!audit({ type: 'request', permission })) finish(false,'ended')
    })
  }

  return {
    request,
    pending: (): PendingWorkbenchPermission[] => Array.from(entries.values(), entry => ({ ...entry.permission })),
    /** 网络守护冻住执行者:批准期限停表(到期计时器撤掉;放开时期限按冻住的时长顺延)。 */
    pause(): void {
      if (pausedAt !== null) return
      pausedAt = Date.now()
      for (const entry of entries.values()) entry.disarm()
    },
    /** 放开:冻住的那段不算,期限顺延,计时器按剩下的时间重起。 */
    resume(): void {
      if (pausedAt === null) return
      const held = Date.now() - pausedAt
      pausedAt = null
      for (const entry of entries.values()) { entry.expiresAt += held; entry.rearm(entry.expiresAt - Date.now()) }
    },
    resolve(id: string, decision: PermissionDecision): boolean {
      const entry = entries.get(id)
      if (!entry) return false
      if (pausedAt === null && Date.now() >= entry.expiresAt) {
        entry.finish(false,'expired')
        return false
      }
      entry.finish(decision === 'allow', decision)
      return true
    },
    rejectAll(outcome: Extract<PermissionOutcome, 'cancelled' | 'ended'> = 'ended'): void {
      closed = true
      for (const entry of [...entries.values()]) entry.finish(false, outcome)
    },
  }
}


// ───────────────────────── 格子 ─────────────────────────

const TIER_NAMES: UserTier[] = ['admin', 'trusted', 'guest']
const ALL_PROFILES: [string, TierProfile][] = [...TIER_NAMES.map(t => [t, TIER_PROFILES[t]] as [string, TierProfile]), ['job', JOB_PROFILE], ['review', REVIEW_PROFILE]]
const PERMISSION_MODES: PermissionMode[] = ['strict', 'dangerously']
const CHAT_MODES: Mode['kind'][] = ['solo', 'primary_tool', 'parallel', 'chatroom']
const ANSWERS = ['allow', 'deny', 'timeout', 'undelivered'] as const

/** wechat MCP 的每一个名字(classifyToolUse 认得的全部,加 reply 族与一个不认得的)。 */
const WECHAT_SUBS = [
  'reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast', 'send_sticker', 'search_online_sticker', 'send_online_sticker_candidate', 'sticker_feedback',
  'share_page', 'memory_list', 'memory_read', 'memory_write', 'memory_edit', 'memory_delete',
  'observations_list', 'observations_read', 'observations_write', 'observations_archive',
  'a2a_send', 'social_seek', 'wish_list', 'wish_send', 'wish_cancel', 'intro_request', 'intro_accept', 'intro_decline', 'intro_offers', 'relationships', 'visit',
  'knowledge_search', 'federated_query', 'contact_profile', 'top_contacts', 'relationship_subgraph', 'connectors', 'graph_status',
  'extraction_batch', 'record_facts', 'contact_facts', 'find_facts', 'set_fact_status', 'extraction_status', 'person_brief',
  'config_get', 'config_set', 'provider_switch', 'message', 'diagnostic_turns', 'diagnostic_health', 'daemon_restart', 'session_release', 'model_get', 'model_set',
  'locate_file', 'attach_file', 'calendar_agenda', 'cc_letter', 'list_stickers', 'save_sticker', 'set_chat_pref', 'terminal_say', 'terminal_say_result',
  'terminal_sessions', 'today_digest', 'view_image', 'voice', 'not_a_real_tool',
]
const BUILTINS: [string, Record<string, unknown>][] = [
  ['Read', { file_path: '/tmp/a.txt' }], ['Glob', { pattern: '**/*.ts' }], ['Grep', { pattern: 'x' }], ['LS', {}],
  ['Write', { file_path: '/tmp/a.txt', content: 'x' }], ['Edit', { file_path: '/tmp/a.txt' }], ['NotebookEdit', { notebook_path: '/tmp/a.ipynb' }], ['MultiEdit', { file_path: '/tmp/a' }],
  ['Bash', { command: 'ls -la' }], ['Bash', { command: 'rm -rf /' }], ['Bash', { command: 'git reset --hard HEAD' }], ['Bash', {}], ['KillShell', {}],
  ['WebFetch', { url: 'https://example.com' }], ['WebSearch', { query: 'x' }], ['Task', {}], ['TodoWrite', {}], ['AskUserQuestion', {}], ['SomethingNew', {}],
]
const OTHER_MCP: [string, Record<string, unknown>][] = [
  ['mcp__delegate__run', {}], ['mcp__wxvault__get_messages', {}], ['mcp__catalog__lookup', { query: 'x' }], ['mcp__wechat__', {}], ['mcp__x__y', {}],
]
const CLAUDE_TOOLS: [string, Record<string, unknown>][] = [...BUILTINS, ...WECHAT_SUBS.map(s => [`mcp__wechat__${s}`, { text: 'hi' }] as [string, Record<string, unknown>]), ...OTHER_MCP]

let cells = 0

describe('authorize 逐格对照:对话 · Claude(permission-relay)', () => {
  it('档位 × 对话模式 × 能力表那一家 × 权限模式 × 有没有 admin × 主人怎么答 × 工具', async () => {
    for (const tier of TIER_NAMES) for (const mode of CHAT_MODES) for (const provider of KNOWN_PROVIDER_IDS) for (const permissionMode of PERMISSION_MODES)
      for (const admin of ['owner', null] as const) for (const answer of ANSWERS) {
        const run = async (build: (d: PermissionRelayDeps) => CanUseTool) => {
          const trace: unknown[] = []
          const gate = build({
            askUser: async (...a) => { trace.push(['ask', ...a]); return answer },
            initiatingChatId: () => 'chat', adminChatId: () => { trace.push('admin?'); return admin },
            resolveTier: () => { trace.push('tier?'); return tier },
            log: (t, l) => trace.push(['log', t, l]), mode: () => mode, provider, permissionMode,
          })
          const out: unknown[] = []
          for (const [name, input] of CLAUDE_TOOLS) out.push(await gate(name, input, { signal: new AbortController().signal, toolUseID: `id-${name}`, ...(name === 'Bash' ? { title: 'Run it' } : {}) } as never))
          return { out, trace }
        }
        expect(await run(makeCanUseTool), `${tier}/${mode}/${provider}/${permissionMode}/${admin}/${answer}`).toEqual(await run(legacyClaudeChatGate))
        cells += CLAUDE_TOOLS.length
      }
  })
})

describe('authorize 逐格对照:对话 · Gemini 闸门', () => {
  const BARE = [...WECHAT_SUBS, 'Bash', 'Read', 'mcp__wechat__shell', 'a__b', '__', 'shell']
  it('档位(含定时 / 审查档)× 权限模式 × 对话模式 × 能力表 askUser × 有没有 admin × 主人怎么答 × 裸名', async () => {
    for (const [tn, tierProfile] of ALL_PROFILES) for (const permissionMode of PERMISSION_MODES) for (const mode of CHAT_MODES)
      for (const askUser of ['per-tool', 'never'] as const) for (const admin of ['owner', null] as const) for (const answer of ANSWERS) {
        const run = async (build: (d: GeminiGateDeps) => (ctx: SpawnContext) => ToolGate) => {
          const trace: unknown[] = []
          const gate = build({
            askUser: async (...a) => { trace.push(['ask', ...a]); return answer },
            adminFor: (c) => { trace.push(['admin?', c]); return admin },
            modeFor: (c) => { trace.push(['mode?', c]); return mode },
            lookupBase: (m, p) => { trace.push(['base?', m, p]); return { askUser } as never },
          })({ chatId: 'chat', tierProfile, permissionMode } as SpawnContext)
          const out: unknown[] = []
          for (const name of BARE) out.push(await gate(name, { text: 'hi', command: 'rm -rf /' }))
          return { out, trace }
        }
        expect(await run(makeGeminiToolGate), `${tn}/${permissionMode}/${mode}/${askUser}/${admin}/${answer}`).toEqual(await run(legacyGeminiGate))
        cells += BARE.length
      }
  })
})

describe('authorize 逐格对照:对话 · OpenAI 兼容闸门', () => {
  const CALLS: { toolName: string; mcpServer?: string; input: Record<string, unknown> }[] = [
    ...BUILTINS.map(([toolName, input]) => ({ toolName, input })),
    ...WECHAT_SUBS.map(toolName => ({ toolName, mcpServer: 'wechat', input: {} })),
    ...['get_messages', 'search_messages', 'reply', 'run'].flatMap(toolName => ['wxvault', 'delegate', 'catalog'].map(mcpServer => ({ toolName, mcpServer, input: {} }))),
  ]
  it('档位(含定时 / 审查档)× 权限模式 × 工具(带真实的 MCP server)', () => {
    for (const [tn, tierProfile] of ALL_PROFILES) for (const permissionMode of PERMISSION_MODES) for (const c of CALLS) {
      expect(gateTool({ ...c, tierProfile, permissionMode }), `${tn}/${permissionMode}/${c.mcpServer ?? ''}/${c.toolName}`).toBe(legacyOpenaiGate({ ...c, tierProfile, permissionMode }))
      cells++
    }
  })
})

describe('authorize 逐格对照:定时任务只读档(wire-model-options)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'authz-job-')))
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'authz-state-')))
  mkdirSync(join(root, 'src'), { recursive: true })
  const CALLS: [string, Record<string, unknown>][] = [
    ['Read', { file_path: join(root, 'a.txt') }], ['Read', { file_path: 'src/b.ts' }], ['Read', { file_path: '/etc/passwd' }], ['Read', { file_path: join(root, '.env') }],
    ['Read', { file_path: join(root, '.ssh', 'id_rsa') }], ['Read', { file_path: join(stateDir, 'access.json') }], ['Read', { file_path: join(root, '..', 'x') }],
    ['Read', { file_path: join(homedir(), '.aws', 'credentials') }], ['Read', {}], ['Glob', { pattern: '/abs/**' }], ['Glob', { pattern: 'src/**' }], ['Grep', { pattern: 'x', path: root }],
    ['LS', { path: '/' }], ['mcp__wechat__memory_read', {}], ['mcp__wechat__observations_list', {}], ['mcp__wechat__reply', { text: 'x' }], ['mcp__wechat__memory_write', {}],
    ['mcp__wxvault__get_messages', {}], ['WebFetch', { url: 'https://example.com' }], ['WebSearch', { query: 'x' }], ['Bash', { command: 'ls' }], ['Write', { file_path: join(root, 'a') }],
    ['Task', {}], ['SomethingNew', {}],
  ]
  const newGate = (tp: TierProfile) => wireModelOptions({ stateDir }, {
    plugins: { wechatStdioForClaude: null, delegateStdioForClaude: null, pluginMcpForClaude: {} }, permissionMode: 'strict',
    buildCanUseTool: () => { throw new Error('standard tier gate must not be built for a job profile') }, claudeBin: undefined,
  }).sdkOptionsForProject('P', root, tp, 'chat', undefined, undefined, { permissionMode: 'strict' }).canUseTool!
  it('定时 / 审查两档 × 每一对先后调用(污点跨调用)', async () => {
    for (const tp of [JOB_PROFILE, REVIEW_PROFILE]) for (const first of CALLS) for (const second of CALLS) {
      const nu = newGate(tp), old = legacyJobGate(tp, { root, stateDir })
      const opts = { signal: new AbortController().signal } as never
      const got = [await nu(first[0], first[1], opts), await nu(second[0], second[1], opts)]
      const want = [await old(first[0], first[1], opts), await old(second[0], second[1], opts)]
      expect(got, `${first[0]}${JSON.stringify(first[1])} → ${second[0]}${JSON.stringify(second[1])}`).toEqual(want)
      cells += 2
    }
  })
})

describe('authorize 逐格对照:一起做 · Claude(登记表 + 档位,原 wire-workbench 手包的一层收进来)', () => {
  const REGISTRIES = [[], ['catalog'], ['catalog', 'wechat'], ['my_catalog'], ['delegate', 'catalog'], ['catalog', 'my_catalog']]
  const QUESTION = { questions: [{ header: 'F', question: 'Which?', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }] }
  const TOOLS: [string, Record<string, unknown>][] = [
    ...BUILTINS.filter(([n]) => n !== 'AskUserQuestion'), ['Bash', { command: `rm -rf ${'x'.repeat(30_000)}` }],
    ['AskUserQuestion', QUESTION], ['AskUserQuestion', { questions: 'bad' }],
    ['mcp__catalog__lookup', { query: 'x', api_key: 'secret' }], ['mcp__catalog__', {}], ['mcp__my_catalog__lookup', { query: 'x' }], ['mcp__my_catalog_other__lookup', {}],
    ['mcp__wechat__reply', { text: 'x' }], ['mcp__delegate__run', {}], ['mcp__other__x', {}], [`mcp__catalog__${'x'.repeat(200)}`, {}],
  ]
  const PERMITS = ['missing', 'yes', 'no', 'throws'] as const
  it('登记表 × 取消与否 × 有没有问的通道 / 主人怎么答 × 有没有提问通道 × 工具', async () => {
    for (const registry of REGISTRIES) for (const aborted of [false, true]) for (const permit of PERMITS) for (const questions of [false, true]) {
      const run = async (build: (rp: SpawnContext['requestPermission'], ru: SpawnContext['requestUserInput']) => CanUseTool) => {
        const trace: unknown[] = []
        const rp: SpawnContext['requestPermission'] = permit === 'missing' ? undefined : async (req) => { trace.push(['permit', req]); if (permit === 'throws') throw Error('gone'); return permit === 'yes' }
        const ru: SpawnContext['requestUserInput'] = questions ? async (req) => { trace.push(['question', req]); return { [req.questions[0]!.id]: ['A'] } } : undefined
        const gate = build(rp, ru)
        const out: unknown[] = []
        for (const [name, input] of TOOLS) {
          const c = new AbortController(); if (aborted) c.abort()
          out.push(await gate(name, input, { signal: c.signal, toolUseID: 'tool-1', title: 'Do it' } as never))
        }
        return { out, trace }
      }
      const servers = Object.fromEntries(registry.map(n => [n, { command: 'srv' }]))
      // 新:生产里 wire-workbench 那样接 —— permit 带登记表,workbenchClaudeOptions 原样交给 SDK。
      const got = await run((rp, ru) => workbenchClaudeOptions({ cwd: '/p' }, '', makeWorkbenchClaudeCanUseTool(rp, ru, registry, registry), { servers, omitted: [] }).canUseTool!)
      // 旧:workbenchClaudeOptions 外面那层手写的拒 + 原来的 makeWorkbenchClaudeCanUseTool。
      const want = await run((rp, ru) => {
        const inner = legacyWorkbenchGateInner(rp, ru, registry)
        return async (tool, input, context) => tool.startsWith('mcp__') && !Object.keys(servers).some(name => tool.startsWith(`mcp__${name}__`))
          ? { behavior: 'deny', message: 'This tool is not registered for the task.' }
          : inner(tool, input, context)
      })
      expect(got, `${registry.join(',')}/${aborted}/${permit}/${questions}`).toEqual(want)
      cells += TOOLS.length
    }
  })
})

/** 放行规则能给出的每一种裁决(verdict × by),外加认不出的 by 与抛错。 */
const RULINGS: (Decision | { verdict: Verdict; by: string } | 'throws')[] = [
  ...(['allow', 'ask', 'deny'] as const).flatMap(verdict => (['rule', 'review', 'floor', 'default', 'other'] as const).map(by => ({ verdict, by }))),
  'throws',
]

describe('authorize 逐格对照:一起做 · 放行规则(makeRunPermissions)', () => {
  const settle = async (factory: typeof makeRunPermissions, decide: PermissionDecide | undefined, answer: 'allow' | 'deny' | 'none', aborted: boolean) => {
    const audits: unknown[] = []
    const perms = factory({ taskId: 't', timeoutMs: 60_000, audit: e => audits.push({ type: e.type, tool: e.permission.tool, description: e.permission.description, ...(e.type === 'outcome' ? { outcome: e.outcome, by: e.by } : {}) }), ...(decide ? { decide } : {}) })
    const c = new AbortController(); if (aborted) c.abort()
    const p = perms.request({ tool: 'Bash', description: 'run', command: 'git status', paths: ['/p/a'], cwd: '/p' }, c.signal)
    const syncPending = perms.pending().length
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const pending = perms.pending()
    if (answer !== 'none') for (const e of pending) perms.resolve(e.id, answer)
    else perms.rejectAll('ended')
    return { result: await p, syncPending, pending: pending.length, audits }
  }
  it('每一种裁决 × 主人怎么答 × 取消与否,外加没接放行规则', async () => {
    for (const ruling of [...RULINGS, 'unwired' as const]) for (const answer of ['allow', 'deny', 'none'] as const) for (const aborted of [false, true]) {
      const decide: PermissionDecide | undefined = ruling === 'unwired' ? undefined : async () => { if (ruling === 'throws') throw Error('x'); return ruling }
      expect(await settle(makeRunPermissions, decide, answer, aborted), `${JSON.stringify(ruling)}/${answer}/${aborted}`).toEqual(await settle(legacyRunPermissions as typeof makeRunPermissions, decide, answer, aborted))
      cells++
    }
  })
})

describe('authorize 逐格对照:终端会话(cli-permission-relay 的 decide)', () => {
  const req = { session_id: 's', tool_name: 'Bash', cwd: '/p', source: 'claude', command: 'git status' } as never
  // permission-gate.decide 实际能给出的裁决:关着 / 出错 ⇒ ask·default;decideCore ⇒ deny·rule、ask·floor、ask·rule、
  // ask·default、allow·rule、allow·review(decide.ts)。原来取 .verdict,一起做原来只认 by ∈ rule/review/floor —— 这几种上两者相同。
  const REACHABLE: Decision[] = [
    { verdict: 'ask', by: 'default', reason: '' }, { verdict: 'deny', by: 'rule', reason: '' }, { verdict: 'ask', by: 'floor', reason: '' },
    { verdict: 'ask', by: 'rule', reason: '' }, { verdict: 'allow', by: 'rule', reason: '' }, { verdict: 'allow', by: 'review', reason: '' },
  ]
  it('permission-gate 能给出的每一种裁决:与原来的 (await gate.decide(...)).verdict 相同', async () => {
    for (const d of REACHABLE) {
      const seen: unknown[] = []
      const gate = { decide: async (src: unknown) => { seen.push(typeof src); return d } }
      const decide = makeTerminalDecide(gate, async () => ({ surface: 'terminal' }) as never)
      expect(await decide(req), JSON.stringify(d)).toBe(d.verdict)
      expect(seen).toEqual(['function'])   // 规则关着时不造请求:照旧交一个函数进去
      cells++
    }
  })
  it('gate 抛错 ⇒ 照旧往外抛(中继那边 catch 成 ask)', async () => {
    const decide = makeTerminalDecide({ decide: async () => { throw Error('boom') } })
    await expect(decide(req)).rejects.toThrow('boom')
  })
})

describe('放行规则只在终端会话和一起做两个面上生效', () => {
  it('对话 / 定时任务:落到「问」也不看放行规则(对话要不要也走,是看得见的变化,等主人)', () => {
    expect([...OWNER_RULE_SURFACES].sort()).toEqual(['terminal', 'workbench'])
    for (const surface of ['chat', 'job'] as const) {
      const a = authorize({ surface, tier: TIER_PROFILES.admin, permissionMode: 'strict', executor: 'claude' }, { name: 'Bash', kind: 'shell_destructive' }, { ownerRuling: { verdict: 'allow', by: 'rule' } })
      expect(a.consultOwnerRules).toBe(false)
      expect(a.reason).not.toBe('owner_rules')
    }
    const chat = authorize({ surface: 'chat', tier: TIER_PROFILES.admin, permissionMode: 'strict', executor: 'claude' }, { name: 'Bash', kind: 'shell_destructive' }, { ownerRuling: { verdict: 'allow', by: 'rule' } })
    expect(chat.verdict).toBe('ask')
  })
  it('格子总数(防有人把循环删空了)', () => {
    expect(cells).toBeGreaterThan(150_000)
  })
})
