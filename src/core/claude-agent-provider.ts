import { query, type CanUseTool, type Options, type PermissionResult, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentActivity, AgentEvent, AgentProject, AgentProvider, AgentSession, PermissionMode, ProviderCapabilities, SpawnContext } from './agent-provider'
import { classifyToolUse, TIER_PROFILES, type TierProfile, type ToolKind } from './user-tier'
import { WORKBENCH_PERMISSION_DESCRIPTION_MAX, WORKBENCH_PERMISSION_TOOL_MAX } from './workbench/permissions'
import { validateUserInputAnswers, validateUserInputRequest } from './workbench/user-input'
import { log } from '../lib/log'
import { AsyncQueue } from './async-queue'
import { isAuthFail } from './auth-fail'

/**
 * RFC 05 Phase 2 — static capabilities. Claude is the only provider with
 * a per-tool callback SDK; sandbox levels are empty because Claude has
 * no SDK-level sandbox knob (relies on canUseTool + disallowedTools).
 */
export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: true,
  adminMcpTools: true,
  sandboxLevels: new Set(),
  supportsDelegation: true,
  supportsResume: true,
  defaultPeer: 'codex',
  authFailHint: '⚠ Claude 登录已过期，请在电脑上跑 `claude login` 后再发消息。',
}

/**
 * Map ToolKind → the Claude Code built-in tool names that fall into it.
 * MCP tools (mcp__wechat__*) are NOT listed — they're gated by canUseTool
 * (a per-tool callback fires for every MCP invocation), which the
 * permission-relay layer sets up.
 */
const TOOL_KIND_TO_CLAUDE_BUILTINS: Record<ToolKind, ReadonlyArray<string>> = {
  reply: [],            // MCP-only
  share_page: [],       // MCP-only
  memory_read: [],      // MCP-only
  memory_write: [],     // MCP-only
  memory_delete: [],    // MCP-only
  observations_read: [],  // MCP-only
  observations_write: [], // MCP-only
  fs_read: ['Read', 'Glob', 'Grep', 'LS'],
  fs_write: ['Write', 'Edit', 'NotebookEdit'],
  shell: ['Bash', 'KillShell'],
  shell_destructive: [],   // virtual; same Bash tool, gated by canUseTool input inspection
  network: ['WebFetch', 'WebSearch'],
  subagent: ['Task'],
  a2a_send: [],            // MCP-only
  daemon_introspect: [],   // MCP-only (mcp__wechat__diagnostic_*), gated by canUseTool
  daemon_remediate: [],    // MCP-only (mcp__wechat__session_release / model_set / daemon_restart)
  file_locate: [],         // MCP-only (mcp__wechat__locate_file), gated by canUseTool
  plugin_tool: [],         // MCP-only (mcp__<plugin>__*), admin-only, gated by canUseTool
  social_seek: [],         // MCP-only (mcp__wechat__social_seek), admin-only, gated by canUseTool
  social_act: [],          // MCP-only (mcp__wechat__wish_list / wish_send / wish_cancel / intro_request / intro_accept / intro_decline / intro_offers / relationships / visit), admin-only, gated by canUseTool
  knowledge_search: [],    // MCP-only (mcp__wechat__knowledge_search), admin-only, gated by canUseTool
  federated_query: [],     // MCP-only (mcp__wechat__federated_query), admin-only, gated by canUseTool
  graph_query: [],         // MCP-only (mcp__wechat__contact_profile / top_contacts / relationship_subgraph / connectors / graph_status), admin-only, gated by canUseTool
  facts_query: [],         // MCP-only (mcp__wechat__extraction_batch / record_facts / contact_facts / find_facts / set_fact_status / extraction_status), admin-only, gated by canUseTool
  person_query: [],        // MCP-only (mcp__wechat__person_brief), admin-only, gated by canUseTool
  config_admin: [],        // MCP-only (mcp__wechat__config_get / config_set), admin-only, gated by canUseTool
  mode_switch: [],         // MCP-only (mcp__wechat__provider_switch), trusted+, gated by canUseTool
}

export interface ClaudeTierSdkOpts {
  permissionMode: 'default' | 'bypassPermissions'
  disallowedTools?: string[]
}

/**
 * Pure translation from (TierProfile, permissionMode) → Claude SDK options.
 * The caller layers `canUseTool` on top of this — `disallowedTools` only
 * covers built-ins (which the SDK knows by name); MCP tools and
 * shell_destructive get filtered inside the canUseTool closure.
 *
 * `permissionMode='dangerously'` bypasses unconditionally — operator
 * opted into full SDK bypass regardless of tier. `permissionMode='strict'`
 * always uses `default` + canUseTool; tier-aware allow/relay/deny
 * decisions happen inside the canUseTool callback (see
 * `effectivePolicy` in permission-relay.ts). Pre-RFC-05 this function
 * inferred "dangerously-equivalent" from `relay.size === 0 && deny.size === 0`
 * (admin tier shape), which broke when admin tier policy changed (C4)
 * and when --dangerously didn't propagate to non-admin chats (C5).
 */
export function tierProfileToClaudeSdkOpts(tp: TierProfile, permissionMode: PermissionMode): ClaudeTierSdkOpts {
  if (permissionMode === 'dangerously') {
    return { permissionMode: 'bypassPermissions' }
  }

  // Build disallowedTools from the deny set's built-in tools only
  const disallowed: string[] = []
  for (const kind of tp.deny) {
    for (const name of TOOL_KIND_TO_CLAUDE_BUILTINS[kind]) disallowed.push(name)
  }

  return {
    permissionMode: 'default',
    ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
  }
}

export interface ClaudeAgentProviderOptions {
  /**
   * Build the Options bag for this spawn. `chatId` is required so the
   * builder can construct a canUseTool whose resolveTier/mode closures
   * are bound to THIS session's chatId — not the process-wide
   * `lastActiveChatId` ref, which under concurrent dispatch could read
   * another chat's id mid-call and cross-resolve the tier.
   */
  sdkOptionsForProject: (alias: string, path: string, tierProfile: TierProfile, chatId: string, mcpEnv?: Record<string, string>, appendInstructions?: string, spawnContext?: SpawnContext) => Options
  /**
   * Path to the `claude` binary, threaded into cheapEval's query() call.
   * Optional — when omitted the SDK's bundled discovery runs. Used in
   * production to bypass the bun-compile findClaudePath() trap that
   * affected the chatroom moderator's haiku eval (see haiku-eval.ts
   * history before its deletion in PR F).
   */
  claudeBin?: string
  /**
   * Resolve the STRONG model id for `strongEval` (the /chat verdict). Reads
   * live so a model hot-reload is picked up per call — bootstrap passes
   * `currentClaudeModel`. Omitted → strongEval is not offered.
   */
  strongModel?: () => string
}

function taskInputPreview(input: Record<string, unknown>): string | null {
  if (typeof input.command === 'string') return `command=${input.command}`
  try {
    const json=JSON.stringify(input)
    return json === '{}' ? '' : `input=${json}`
  } catch {
    return null
  }
}

/** Claude's task-only permission gate. Workbench has no messaging or memory
 * MCP surface; local built-ins retain the existing trusted/solo/strict
 * allow/relay/deny policy, with relay decisions owned by the active task run. */
export function makeWorkbenchClaudeCanUseTool(
  requestPermission?: SpawnContext['requestPermission'],
  requestUserInput?: SpawnContext['requestUserInput'],
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
      return { behavior: 'deny', message: 'Task sessions cannot use messaging, memory, or other MCP tools.' } satisfies PermissionResult
    }
    const kind = classifyToolUse(toolName, input)
    // Load after provider module initialization. permission-relay depends on
    // capability-matrix, whose provider declarations include this module.
    // A static import here would evaluate that cycle before the declarations
    // exist and fail closed by crashing startup instead of denying a tool.
    const [{ effectivePolicy }, { lookup }] = await Promise.all([
      import('./permission-relay'),
      import('./capability-matrix'),
    ])
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
    const inputPreview=taskInputPreview(input)
    const context=options.title?.trim() || options.description?.trim() || options.decisionReason?.trim() || ''
    const description=[context,inputPreview].filter(Boolean).join('\n') || `Run ${toolName}`
    if (toolName.length > WORKBENCH_PERMISSION_TOOL_MAX || inputPreview === null || description.length > WORKBENCH_PERMISSION_DESCRIPTION_MAX) {
      return { behavior:'deny', message:'The complete permission detail is too large to review safely.' } satisfies PermissionResult
    }
    let allowed = false
    try {
      allowed = await requestPermission({
        tool: toolName.slice(0, WORKBENCH_PERMISSION_TOOL_MAX),
        description,
      }, options.signal)
    } catch {
      allowed = false
    }
    return allowed && !options.signal.aborted
      ? { behavior: 'allow' } satisfies PermissionResult
      : { behavior: 'deny', message: 'The task permission request was denied or expired.' } satisfies PermissionResult
  }
}

/**
 * 配置里没设 model 时的兜底。写死的模型名会烂(Anthropic 下线它那天,新装
 * 用户每一轮都报错)—— 所以只允许在这一处出现,/mode 会标出「用的是内置兜底」,
 * 首次使用探测(bootstrap)会把它不可用这件事变成用户看得见的错误。
 * 为什么不干脆不传 model 让 CLI 用自己的默认:2026-05-08 的事故 —— 用户
 * 交互里的别名(`opus[1m]` 之类)在 SDK 子进程里解析不了,整天 404。
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8'
const CLAUDE_CHEAP_MODEL_DEFAULT = 'claude-haiku-4-5'

// Local mirror of the SDK message variants this provider actually reads.
// The SDK's full union (`SDKMessage`) covers many more variants but our
// streaming loop only branches on these variants. Defining a narrow local
// type means every reach into the message shape goes through one cast
// (`narrow` below) — when the SDK changes shape, that's the only place
// to update.
type AssistantBlock = { type?: string; text?: string; name?: string; id?: string }
type AssistantContent = string | Array<AssistantBlock>
type AssistantMsg = { type: 'assistant'; uuid?: string; parent_tool_use_id?: string | null; message?: { id?: string; content?: AssistantContent } }
// SDKUserMessage.message is the Anthropic MessageParam. Its tool_result
// blocks correlate to tool_use.id through tool_use_id; result content can
// contain private file or command output and is deliberately not read here.
type UserMsg = { type: 'user'; parent_tool_use_id?: string | null; message?: { content?: string | Array<{ type?: string; tool_use_id?: string; is_error?: boolean }> } }
type ResultMsg = {
  type: 'result'
  subtype?: string
  session_id?: string
  num_turns?: number
  duration_ms?: number
  result?: unknown
}
type SystemMsg = { type: 'system'; subtype?: string; session_id?: string }
type NarrowedMsg = AssistantMsg | UserMsg | ResultMsg | SystemMsg

// Returns null for SDK message types we don't branch on (rate_limit_event,
// stream_event, partial_assistant, etc.). The caller's for-await loop
// simply skips these.
function narrow(msg: SDKMessage): NarrowedMsg | null {
  const t = (msg as { type?: string }).type
  if (t === 'assistant' || t === 'user' || t === 'result' || t === 'system') {
    return msg as unknown as NarrowedMsg
  }
  return null
}

function extractText(content: AssistantContent | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content.map(b => (b?.type === 'text' ? b.text ?? '' : '')).join('')
}

// The claude binary prints these literal phrases as assistant text when it
// has no usable credentials (verified by inspecting the binary's string
// table). Two distinct markers because the SDK can split a single message
// across multiple `assistant` events — matching only "/login" would leak
// the first chunk ("Not logged in") to the user before the second arrives.
// Without interception the phrase leaks to the user as if it were the AI's
// reply. We tag it with a structured error code so the coordinator can
// suppress the fallback path and respond with a controlled notification
// instead. Detection goes through auth-fail.ts's dedicated claude-sentinel
// profile (spec §1b) — NOT the broader assistant-text set. That widening
// was tried and reverted post-dogfood: assistant-text's wider phrases
// (e.g. "401 unauthorized", "auth...expired") deterministically
// false-positive on legitimate assistant text that merely quotes or
// discusses an auth error (e.g. relaying a curl 401 to the user), which
// falsely releases the session and sends a "login expired" notice — for
// zero true-positive gain, since the claude binary itself only ever
// emits these two sentinel phrases.

/**
 * Fire-and-forget invoker that survives both sync throws and async
 * rejections from SDK lifecycle methods (`interrupt`, `close`). When the
 * underlying claude subprocess has already exited (crash, OOM, abnormal
 * end), the SDK's ProcessTransport rejects with "ProcessTransport is
 * not ready for writing" — unhandled, Bun terminates the daemon.
 * Crashed sessions caught the daemon down in 2026-05-28 PDT incident
 * (sweepIdle → release → close → interrupt path).
 */
function swallowSdkLifecycleError(fn: (() => unknown) | undefined): void {
  if (!fn) return
  try {
    const r = fn()
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      ;(r as Promise<unknown>).catch(() => {})
    }
  } catch {
    /* SDK transport already torn down — nothing to do */
  }
}

/**
 * Parse a Claude SDK tool_use block's `name` (e.g. 'mcp__wechat__reply')
 * into our normalised `{ server, tool }` shape. Built-in tools (Read,
 * Bash) lack the prefix — those return `{ tool: name }` with no server.
 */
function parseToolUseToEvent(block: { name?: string }): Extract<AgentEvent, { kind: 'tool_call' }> {
  const name = block.name ?? ''
  const m = /^mcp__([^_]+)__(.+)$/.exec(name)
  if (m) return { kind: 'tool_call', server: m[1], tool: m[2]! }
  return { kind: 'tool_call', tool: name }
}

type ActivityEvent = Extract<AgentEvent, { kind: 'tool_call' }> & { activity: AgentActivity }

function nativeTimelineId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined
}

// Public activity labels are chosen from tool names only. In particular,
// commands, agent prompts, edit contents, URLs and tool outputs are not
// copied into the persisted workbench timeline.
function claudeActivityLabel(name: string): Pick<AgentActivity, 'type' | 'label'> {
  switch (name) {
    case 'Bash': return { type: 'command', label: '运行命令' }
    case 'KillShell': return { type: 'command', label: '停止命令' }
    case 'Read': return { type: 'read', label: '读取文件' }
    case 'LS': return { type: 'read', label: '查看文件列表' }
    case 'WebFetch': return { type: 'read', label: '读取网页' }
    case 'Glob': return { type: 'search', label: '查找文件' }
    case 'Grep': return { type: 'search', label: '搜索内容' }
    case 'WebSearch': return { type: 'search', label: '搜索网页' }
    case 'Write': return { type: 'edit', label: '写入文件' }
    case 'Edit': return { type: 'edit', label: '编辑文件' }
    case 'NotebookEdit': return { type: 'edit', label: '编辑笔记本' }
    case 'Task': case 'Agent': return { type: 'agent', label: '协作任务' }
    case 'AskUserQuestion': return { type: 'tool', label: '询问用户' }
    default: return { type: 'tool', label: '调用工具' }
  }
}

export function createClaudeAgentProvider(opts: ClaudeAgentProviderOptions): AgentProvider {
  // One-shot eval with no tools, no MCP, no session continuation — shared by
  // cheapEval (haiku-class) and strongEval (the verdict's main model). Both
  // pass an explicit model so the only difference is which model runs.
  const oneShot = async (prompt: string, model: string): Promise<string> => {
    const q = query({
      prompt,
      options: {
        model,
        maxTurns: 1,
        // Background evaluators must not inherit interactive Claude Code
        // hooks, plugins, skills, MCP servers, or project instructions. Those
        // can alter a strict JSON reply (and add a large cached-token bill).
        settingSources: [],
        tools: [],
        persistSession: false,
        ...(opts.claudeBin ? { pathToClaudeCodeExecutable: opts.claudeBin } : {}),
      } as Options,
    })
    let text = ''
    let resultText = ''
    for await (const raw of q as AsyncGenerator<SDKMessage>) {
      const msg = narrow(raw)
      if (msg?.type === 'assistant') {
        text += extractText(msg.message?.content)
      } else if (msg?.type === 'result' && typeof msg.result === 'string') {
        // Recent Claude CLI/SDK combinations can emit the final answer only
        // on the result event for one-shot, maxTurns=1 calls. Prefer streamed
        // assistant text when present, but retain this provider-level fallback
        // so every CheapEval consumer receives the promised string.
        resultText = msg.result
      }
    }
    return text.trim().length > 0 ? text : resultText
  }
  return {
    // One-shot haiku-class eval. Used by chatroom convergence check +
    // companion introspect via ProviderRegistry.getCheapEval(). Env override
    // lets users pin to a newer haiku without a code change.
    cheapEval: (prompt: string) =>
      oneShot(prompt, process.env['WECHAT_CLAUDE_CHEAP_MODEL'] || CLAUDE_CHEAP_MODEL_DEFAULT),
    // One-shot on the STRONG/main model — only offered when bootstrap wires a
    // strongModel resolver. Powers the /chat verdict (deps.verdictEval).
    ...(opts.strongModel ? { strongEval: (prompt: string) => oneShot(prompt, opts.strongModel!()) } : {}),
    async spawn(
      project: AgentProject,
      spawnOpts: SpawnContext,
    ): Promise<AgentSession> {
      const sdkQueue = new AsyncQueue<SDKUserMessage>()
      // chatId is threaded into sdkOptionsForProject so the builder can
      // produce a canUseTool whose tier/mode closures are bound to THIS
      // session — see bootstrap/index.ts:buildCanUseTool().
      const options = opts.sdkOptionsForProject(project.alias, project.path, spawnOpts.tierProfile, spawnOpts.chatId, spawnOpts.mcpEnv, spawnOpts.appendInstructions, spawnOpts)
      if (spawnOpts.resumeSessionId) {
        ;(options as Options & { resume?: string }).resume = spawnOpts.resumeSessionId
      }

      // Wire an AbortController so close() can tell the SDK to stop and tear
      // down the underlying claude subprocess. Per sdk.d.ts: "When aborted,
      // the query will stop and clean up resources." Without it, teardown
      // relied solely on best-effort interrupt()/close() which no-op against
      // an already-dead/wedged ProcessTransport — leaving the child running
      // (the TN-zombie source). The per-turn watchdog's release→close path
      // now actually reaps the subprocess through this.
      const aborter = options.abortController ?? new AbortController()
      options.abortController = aborter

      const q = query({ prompt: sdkQueue.iterable(), options })

      let activeEventQueue: AsyncQueue<AgentEvent> | null = null
      let closed = false
      let droppedAssistantChunks = 0
      const activities = new Map<string, ActivityEvent>()
      let assistantSequence = 0
      let drainResolve: (() => void) | undefined
      const drainPromise = new Promise<void>(resolve => { drainResolve = resolve })

      // Background SDK message consumer — runs for the lifetime of the
      // session, translating SDK messages to AgentEvents on the in-flight
      // dispatch's queue. When no dispatch is in flight, drops with a warn.
      ;(async () => {
        try {
          for await (const raw of q as AsyncGenerator<SDKMessage>) {
            const msg = narrow(raw)
            if (!msg) continue

            if (!activeEventQueue) {
              // No in-flight dispatch — preserves [STREAM_DROP] behavior.
              // Trailing chunks after a result, or assistant text from an SDK
              // quirk, get logged but not attributed to a future turn.
              if (msg.type === 'assistant') {
                const text = extractText(msg.message?.content)
                if (text) {
                  droppedAssistantChunks++
                  log('STREAM_DROP', `alias=${project.alias} count=${droppedAssistantChunks} preview=${JSON.stringify(text.slice(0, 80))}`)
                }
              }
              continue
            }

            // Use a type-cast reference to work around TS6's exhaustive-narrowing
            // of the discriminated-union if/else chain, which otherwise infers
            // 'never' for activeEventQueue within individual branches.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const aq = activeEventQueue as AsyncQueue<AgentEvent>

            if (msg.type === 'system' && msg.subtype === 'init') {
              // Routed via log() (info-level) so the line lands in
              // channel.log + dashboard, not just stderr.
              log('SESSION_INIT', `alias=${project.alias} session_id=${msg.session_id ?? ''}`)
              aq.push({ kind: 'init', sessionId: msg.session_id ?? '' })
            } else if (msg.type === 'assistant') {
              const content = msg.message?.content
              if (spawnOpts.workbenchTimeline) {
                const messageId = nativeTimelineId(msg.uuid) ?? nativeTimelineId(msg.message?.id) ?? `message-${++assistantSequence}`
                const parentId = nativeTimelineId(msg.parent_tool_use_id)
                const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? []
                // Inspect the combined text before emitting any block, so a
                // login sentinel split across blocks cannot leak as a reply.
                const text = extractText(content)
                const authFailed = isAuthFail('claude-sentinel', text)
                let authReported = false
                for (const [index, block] of blocks.entries()) {
                  if (block?.type === 'text' && block.text) {
                    if (authFailed) {
                      if (!authReported) aq.push({ kind: 'error', code: 'auth_failed', message: `claude reports not logged in: ${text.slice(0, 160)}` })
                      authReported = true
                    } else {
                      aq.push({ kind: 'text', text: block.text, itemId: `claude:${messageId}:text:${index}`, textMode: 'replace' })
                    }
                  } else if (block?.type === 'tool_use') {
                    const event = parseToolUseToEvent(block)
                    const id = nativeTimelineId(block.id)
                    if (!id) { aq.push(event); continue }
                    // A replay must not create a second start or regress a
                    // completed tool back to running.
                    if (activities.has(id)) continue
                    const activity: AgentActivity = { id, ...claudeActivityLabel(block.name ?? ''), status: 'running', ...(parentId ? { parentId } : {}) }
                    if (activity.type === 'tool') {
                      const identifier = [event.server, event.tool].filter(Boolean).join('/')
                      const detail = identifier.replace(/[^A-Za-z0-9_.:/-]+/g, '_').slice(0, 160)
                      if (detail) activity.detail = detail
                    }
                    const start = { ...event, activity }
                    activities.set(id, start)
                    aq.push(start)
                  }
                }
                continue
              }
              // Emit tool_call events for each tool_use block
              if (Array.isArray(content)) {
                for (const block of content as Array<{ type?: string; name?: string }>) {
                  if (block?.type === 'tool_use') {
                    aq.push(parseToolUseToEvent(block))
                  }
                }
              }
              // Emit text event for any text content — UNLESS the binary is
              // surfacing its "not logged in" sentinel as assistant text. In
              // that case route it as a structured error; coordinator drops
              // the fallback-reply and emits a controlled user-facing notice.
              const text = extractText(content)
              if (text) {
                if (isAuthFail('claude-sentinel', text)) {
                  aq.push({
                    kind: 'error',
                    code: 'auth_failed',
                    message: `claude reports not logged in: ${text.slice(0, 160)}`,
                  })
                } else {
                  aq.push({ kind: 'text', text })
                }
              }
            } else if (msg.type === 'user' && spawnOpts.workbenchTimeline) {
              const content = msg.message?.content
              if (Array.isArray(content)) for (const block of content) {
                if (block?.type !== 'tool_result') continue
                const id = nativeTimelineId(block.tool_use_id)
                const previous = id ? activities.get(id) : undefined
                if (!previous || previous.activity.status !== 'running' || previous.activity.parentId !== nativeTimelineId(msg.parent_tool_use_id)) continue
                const event: ActivityEvent = { ...previous, activity: { ...previous.activity, status: block.is_error === true ? 'failed' : 'completed' } }
                activities.set(previous.activity.id, event)
                aq.push(event)
              }
            } else if (msg.type === 'result') {
              if (msg.subtype && msg.subtype !== 'success') {
                const summary = typeof msg.result === 'string'
                  ? msg.result.slice(0, 400)
                  : JSON.stringify(msg).slice(0, 400)
                log('SESSION_RESULT', `alias=${project.alias} subtype=${msg.subtype} result=${summary}`)
                aq.push({ kind: 'error', message: `subtype=${msg.subtype}` })
              }
              aq.push({
                kind: 'result',
                sessionId: msg.session_id ?? '',
                numTurns: msg.num_turns ?? 0,
                durationMs: msg.duration_ms ?? 0,
              })
              aq.end()
              activeEventQueue = null
            }
          }
        } catch (e) {
          log('SESSION_ERROR', `alias=${project.alias} ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)}`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const catchQueue = activeEventQueue as AsyncQueue<AgentEvent> | null
          if (catchQueue) {
            const errMsg = e instanceof Error ? e.message : String(e)
            catchQueue.push({ kind: 'error', message: errMsg })
            catchQueue.end()
            activeEventQueue = null
          }
        } finally {
          drainResolve?.()
        }
      })()

      return {
        dispatch(text: string): AsyncIterable<AgentEvent> {
          if (closed) {
            // Already closed — return an iterable that yields nothing.
            return { async *[Symbol.asyncIterator]() {} }
          }
          if (activeEventQueue) {
            throw new Error(`claude provider: previous dispatch still in flight (alias=${project.alias})`)
          }
          const queue = new AsyncQueue<AgentEvent>()
          activities.clear()
          assistantSequence = 0
          activeEventQueue = queue
          sdkQueue.push({
            type: 'user',
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'text', text }] },
          } as SDKUserMessage)
          return queue.iterable()
        },
        async cancel() {
          if (closed) return
          // Signal the SDK to interrupt the in-flight dispatch (if any).
          // Don't close, don't end the queue — we rely on the SDK to emit
          // a final `result` (or `error`) message in response to interrupt,
          // which the background consumer translates into a queue end and
          // clears `activeEventQueue`. Future dispatches on this same
          // session keep working.
          //
          // SDK assumption: this contract is observed by
          // @anthropic-ai/claude-agent-sdk's binary harness but is NOT
          // documented in the SDK's public types. If a future SDK version
          // silently drops interrupts (or the underlying claude process
          // exits without flushing), the symptom would be a `collectTurn`
          // call hanging until close() is invoked. Caller mitigates by
          // also wiring the abort signal at the coordinator level so the
          // next round-entry check still terminates the loop.
          //
          // SDK lifecycle methods can synchronously throw OR return a
          // rejected promise when the underlying claude subprocess is
          // dead (ProcessTransport gone). `swallowSdkLifecycleError`
          // shields the daemon from those — see helper doc for context.
          const qIface = q as unknown as { interrupt?: () => unknown }
          swallowSdkLifecycleError(qIface.interrupt?.bind(q))
        },
        async close() {
          closed = true
          sdkQueue.end()
          const qIface = q as unknown as { close?: () => unknown; interrupt?: () => unknown }
          swallowSdkLifecycleError(qIface.close?.bind(q))
          swallowSdkLifecycleError(qIface.interrupt?.bind(q))
          // Abort last — the SDK's documented teardown. Reaps the claude
          // subprocess even when interrupt()/close() above no-op'd against a
          // dead transport. abort() itself never throws, but guard anyway.
          try { aborter.abort() } catch { /* never throws */ }
          if (activeEventQueue) {
            activeEventQueue.end()
            activeEventQueue = null
          }
          drainResolve?.()
          await drainPromise
        },
      }
    },
  }
}
