import type { TierProfile } from './user-tier'
import type { PermissionMode } from './permission-mode'
import type { ProviderId } from './conversation'
import { isAuthFail } from './auth-fail'

// Re-export so existing imports `import type { PermissionMode } from
// './agent-provider'` keep working.
export type { PermissionMode }

export interface AgentProject {
  alias: string
  path: string
}

/**
 * The provider-agnostic event a session yields on a dispatch turn.
 *
 * Variant semantics:
 *   text      — assistant produced visible text (one event per SDK
 *               assistant block; can occur multiple times per turn).
 *   tool_call — assistant invoked a tool. `server` is set when the SDK
 *               distinguishes MCP server (Codex always; Claude after
 *               parsing the `mcp__SERVER__TOOL` name pattern). For
 *               built-in tools (Read, Bash, etc.) `server` is omitted.
 *   init      — session initialised; emitted once per dispatch by Codex
 *               (thread.started) and by Claude on first dispatch only
 *               (system{init} message). Consumers can ignore.
 *   result    — turn completed cleanly. Always followed by iterator
 *               close; one per dispatch.
 *   error     — turn failed at the SDK semantic layer (turn.failed,
 *               result.subtype !== 'success'). Iterator continues to
 *               close normally — true exceptions throw instead.
 */
/** Public execution activity, never raw model reasoning or unrestricted tool input. */
export interface AgentActivity {
  id: string
  type: 'command' | 'read' | 'edit' | 'search' | 'tool' | 'agent'
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  label: string
  detail?: string
  parentId?: string
  agentIds?: string[]
}

export type AgentEvent =
  | { kind: 'text'; text: string; itemId?: string; textMode?: 'append' | 'replace' }
  | { kind: 'tool_call'; server?: string; tool: string; activity?: AgentActivity }
  | { kind: 'init'; sessionId: string }
  | { kind: 'result'; sessionId: string; numTurns: number; durationMs: number }
  | { kind: 'error'; message: string; code?: string }

export interface AgentSession {
  /** Native acknowledgement of supplemental input to the current turn only. */
  steer?(text: string): Promise<void>
  /**
   * Send `text` to the agent and yield events as they arrive. The
   * iterator closes after the first `result` (or `error`) event.
   *
   * Concurrency: providers are NOT required to support overlapping
   * dispatches. Claude provider serialises (one in-flight per session);
   * Codex provider runs each turn as a separate runStreamed.
   */
  dispatch(text: string): AsyncIterable<AgentEvent>
  /**
   * Interrupt the in-flight dispatch (if any) without closing the
   * session — future dispatches still work. Wired into the chatroom
   * loop's `/stop` and the "new dispatch preempts prior" paths.
   *
   * Optional because not every provider may have a per-turn interrupt
   * mechanism. Coordinators should treat a missing implementation as
   * "best effort" — the abort signal still propagates at round entry,
   * mid-stream cancellation just isn't available.
   */
  cancel?(): Promise<void>
  close(): Promise<void>
}

/**
 * One-shot LLM eval used for routing / observation / decision flows that
 * don't need a full session (no tools, no memory, no chat history).
 *
 * Each provider implements with its cheapest practical model + reasoning
 * effort. Latency target ≤ 5 s for ~500-token prompts; cost target
 * ≪ $0.01 per call. Replaces the prior hardcoded `claude-haiku-4-5`
 * callsites in chatroom moderator + companion introspect.
 */
export type CheapEval = (prompt: string) => Promise<string>

export interface AgentUserQuestion {
  id: string
  header: string
  question: string
  options: Array<{label:string;description:string}>
  multiSelect?: boolean
  allowOther?: boolean
}
export interface AgentUserInputRequest { questions: AgentUserQuestion[] }
export type AgentUserInputAnswers = Record<string, string[]>

/**
 * Per-spawn context passed to every `AgentProvider.spawn`. RFC 05 — the
 * uniform shape lets providers (Claude / Codex / Cursor / future
 * gemini-cli) translate daemon-owned policy (tierProfile +
 * permissionMode) into their own SDK options without the daemon having
 * to know provider-specific SDK shapes.
 *
 * **`permissionMode`** is the daemon-wide flag (`--dangerously` ⇒
 * `'dangerously'`; otherwise `'strict'`). Providers MUST honor this —
 * dangerously means "operator opted into full bypass, regardless of
 * what tier this chat is in".
 *
 * Why this lives next to `tierProfile`: pre-RFC-05, providers tried to
 * infer "is this a dangerously spawn" from `tierProfile.relay.size === 0
 * && tierProfile.deny.size === 0` (admin tier shape) — that conflated
 * "this user is admin" with "operator launched --dangerously", and
 * broke silently when admin tier policy changed (C4) or when the
 * dangerously flag changed without bumping tier (C5). The fix is to
 * thread `permissionMode` explicitly.
 */
export interface SpawnContext {
  /** Workbench-only ordered activity updates. Normal chat consumers keep legacy events. */
  workbenchTimeline?: boolean
  tierProfile: TierProfile
  permissionMode: PermissionMode
  /** Bound at spawn time so per-session canUseTool closures resolve the
   *  right chat's tier under concurrent dispatch (no `lastActiveChatId`
   *  process-wide reads). */
  chatId: string
  /** When set, the provider should resume an existing session (claude
   *  jsonl, codex thread id, cursor agent id) instead of cold-starting. */
  resumeSessionId?: string
  /** Per-spawn env overlay the provider merges into every stdio MCP child's
   *  env (via mergeEnvIntoMcpServers). Computed once by the daemon
   *  (session-manager) from the session's resolved tier + minted token —
   *  carries `WECHAT_SESSION_TOKEN` (the env-only bearer secret) and
   *  `WECHAT_SESSION_TIER` (non-secret; the wechat child gates admin tools on
   *  it) so route calls carry the caller's tier. The provider stays oblivious
   *  to the var names — it just merges. Absent in embeddings/tests that don't
   *  wire the registry (nothing to inject). See
   *  docs/superpowers/specs/2026-06-21-internal-api-tier-authz-design.md. */
  mcpEnv?: Record<string, string>
  /**
   * The per-session system prompt, assembled ONCE by the daemon
   * (session-manager, via an injected `buildInstructions` thunk) from this
   * spawn's provider + resolved tier — the single provider-agnostic source
   * (`buildSystemPrompt`). Each provider injects it through its own transport
   * (claude → SDK `systemPrompt.append`; codex → first-message prepend; cursor
   * → its slot once wired) and stays oblivious to the content, exactly like
   * `mcpEnv`. Absent in tests/embeddings that don't wire the thunk — providers
   * then fall back to whatever prompt their construction opts carried (or none).
   */
  appendInstructions?: string
  /**
   * The pinned model id for this spawn, read per-spawn by the daemon
   * (session-manager via `currentModelFor`) from agent-config — so an operator's
   * `/model` switch takes effect on the NEXT session without a daemon restart.
   * Undefined ⇒ the provider falls back to its construction-time model (or SDK
   * default). Mirrors the `mcpEnv` / `appendInstructions` seam: the provider
   * just injects it. (Claude has an equivalent per-spawn reader of its own.)
   */
  model?: string
  /** A task-local approval bridge. It is bound to one active run and fails
   * closed after that run is cancelled, completed, or restarted. */
  requestPermission?: (
    request: { tool: string; description: string },
    signal?: AbortSignal,
  ) => Promise<boolean>
  requestUserInput?: (request: AgentUserInputRequest, signal?: AbortSignal) => Promise<AgentUserInputAnswers | null>
}

/**
 * Merge `extra` env into EVERY stdio MCP child's `env`, returning a fresh map
 * (inputs untouched). The per-spawn seam that carries a session's
 * `WECHAT_SESSION_TOKEN`/`_TIER` into MCP children — codex's and cursor's MCP
 * specs are fixed at provider construction, so each provider applies this at
 * spawn. Generic over the server shape so both providers' spec types flow
 * through; child env wins over `extra` only where keys don't collide (extra is
 * spread last, so the injected auth env takes precedence by design).
 */
/**
 * MCP servers that legitimately consume the per-session internal-api auth env
 * (`WECHAT_SESSION_TOKEN`/`_TIER`). ONLY these get it — third-party plugins
 * (any other server name) must never receive the daemon's bearer token, or
 * enabled plugin code could impersonate the agent against the loopback API.
 */
export const CORE_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(['wechat', 'delegate'])

export function mergeEnvIntoMcpServers<T extends { env?: Record<string, string> }>(
  servers: Record<string, T>,
  extra: Record<string, string>,
  onlyNames?: ReadonlySet<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, srv]) =>
      onlyNames && !onlyNames.has(name)
        ? [name, srv]                                              // e.g. plugin — no auth env
        : [name, { ...srv, env: { ...(srv.env ?? {}), ...extra } }],
    ),
  ) as Record<string, T>
}

/**
 * SDK-level sandbox granularity. Codex maps these directly; Cursor only
 * supports a coarse subset; Claude has none (relies on per-tool callback).
 * Used by capability-matrix derivation to decide what tier→sandbox
 * translations are realisable for each provider.
 */
export type SandboxLevel = 'none' | 'read-only' | 'workspace-write' | 'full'

/**
 * Per-provider static capability declaration (RFC 05 Phase 2). Each
 * provider exports a constant of this shape; capability-matrix derives
 * the (mode × provider × permissionMode) row from it without a 24-row
 * hand-written constant.
 *
 * Adding a new provider (gemini-cli, etc.) means filling these fields,
 * not authoring 8 new matrix rows or editing per-provider branches in
 * bootstrap (peer pairing / delegate availability derive from here).
 */
export interface ProviderCapabilities {
  /**
   * In `primary_tool` mode this provider delegates to `delegate_<peer>`;
   * the single source for provider pairing (replaces the old 2-provider
   * `=== 'codex' ? 'claude' : 'codex'` ternary in bootstrap). Undefined ⇒
   * no default delegation peer. NOTE: orthogonal to `supportsDelegation`,
   * which is whether this provider can be a delegate TARGET.
   */
  defaultPeer?: ProviderId
  /**
   * User-facing notice shown (throttled) when this provider's credentials go
   * stale mid-turn — the login/credential fix differs per provider (claude/codex
   * `login`, cursor an API key), so the copy lives with the provider rather than
   * in a coordinator ternary. Falls back to a generic message when omitted.
   */
  authFailHint?: string
  /**
   * SDK supports per-tool callback (Claude's `canUseTool`). Decides:
   *   - whether `askUser='per-tool'` is realisable in strict mode
   *   - whether `runtime.buildCanUseTool` gets called at spawn
   */
  perToolCallback: boolean
  /**
   * Can this provider's MCP child session ever be granted admin tier, so
   * that `SESSION_IS_ADMIN`-gated tool registration (daemon self-diag,
   * file_locate, knowledge_search, the social-tools family, …) actually
   * runs? False ⇒ the provider's MCP config pins `WECHAT_SESSION_TIER`
   * to a static value (agy/cursor: `'trusted'`, one token for every
   * session — see `agy-mcp-config.ts` / `cursor-mcp-config.ts`), so
   * `SESSION_IS_ADMIN` is always false there regardless of who is
   * chatting, and admin-only tools never register for this provider.
   * True ⇒ the MCP env is threaded per-session (claude/codex/gemini/
   * openai), so an owner/admin chat does reach admin tier.
   */
  adminMcpTools: boolean
  /**
   * Sandbox levels the SDK exposes. Decides which tier→sandbox
   * translations are realisable. Empty set ⇒ no SDK sandbox (Claude).
   */
  sandboxLevels: ReadonlySet<SandboxLevel>
  /**
   * Can act as a `delegate_<peer>` target in primary_tool mode. Cursor
   * is false in v1 (SDK has no sub-agent surface — see RFC 05 §7 #3);
   * flip when it lands.
   */
  supportsDelegation: boolean
  /** Can resume an existing session id across daemon restarts. */
  supportsResume: boolean
}

export interface AgentProvider {
  /**
   * Spawn a session. See `SpawnContext` for the per-spawn shape;
   * provider-construction opts (model, mcpServers, claude binary,
   * etc.) come from the factory call.
   *
   * Concurrency: providers are NOT required to support overlapping
   * spawns or dispatches on the same session. Coordinators serialise
   * per-chat.
   */
  spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession>
  /**
   * Optional one-shot eval. Coordinators that need cheap routing /
   * decision LLM calls should resolve via `ProviderRegistry.getCheapEval()`
   * instead of calling this directly — the registry picks the cheapest
   * available provider's implementation. Missing implementation means
   * the provider doesn't have a lightweight one-shot path; callers
   * should fall back gracefully (skip the eval-driven feature).
   */
  cheapEval?: CheapEval
  /**
   * 一次 `cheapEval` 调用的**预期上限**(毫秒)。缺省 ⇒ in-process 一档。
   *
   * WHY(2026-09-01,真机实测):agy 的 cheapEval(订阅版 Gemini,每次一个
   * CLI 冷启动)单次 10.3–14.3s;in-process 的 claude/openai 约 1s。披露
   * 闸门 `GATE_TIMEOUT_MS` 写死 12s,于是派心愿**时灵时不灵**地报
   * `checker_unavailable` —— 看起来像随机故障,其实是闸门的常数低于
   * provider 的下限。一个常数服务不了差一个数量级的两档。
   *
   * 声明的是「慢到什么程度还算正常」,不是「保证多快」。延迟敏感的调用方
   * 通过 `ProviderRegistry.getCheapEvalBudgetMs()` 拿到汇总值来定自己的
   * 超时,而不是各自拍一个常数。
   */
  cheapEvalBudgetMs?: number
  /**
   * Optional one-shot eval on the provider's STRONG (main) model — same
   * no-tools/no-session shape as cheapEval but a more capable model. Used
   * for the /chat verdict, where synthesis quality matters more than cost.
   * Resolve via `ProviderRegistry.getStrongEval(providerId)` for the DEFAULT
   * provider specifically (unlike getCheapEval, which picks the cheapest).
   * Missing → caller falls back to cheapEval.
   */
  strongEval?: CheapEval
}

/**
 * Shared sentinel detector for the Claude binary's "not logged in" /
 * Codex's auth-failure markers when surfaced as the response text of a
 * cheapEval call. Lifted out of bootstrap/haiku-eval so all callers
 * (chatroom moderator + companion introspect) handle auth_failed
 * consistently — throw, let the caller decide on fallback.
 * See auth-fail.ts for the regex definitions and rationale.
 */

export function assertNotAuthFailed(text: string, log: (tag: string, line: string) => void, source: string): void {
  if (isAuthFail('assistant-text', text)) {
    log('AUTH_FAILED', `${source} credentials stale: ${text.slice(0, 160)}`)
    throw new Error(`auth_failed: ${text.slice(0, 120)}`)
  }
}

/**
 * Reply-tool detection — moved out of the providers so the wechat-channel
 * concept doesn't leak into the provider interface. Coordinator and any
 * other consumer derives "did the agent call a reply tool this turn?" by
 * walking events and checking each `tool_call` event with this helper.
 */
const REPLY_TOOLS = new Set(['reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast', 'send_sticker', 'search_online_sticker', 'send_online_sticker_candidate', 'sticker_feedback'])

/** 我们的 wechat MCP 服务器的规范名 —— 进程内 SDK(claude / codex /
 *  cursor-SDK / gemini)都按这个键注册,工具名因此是 `mcp__wechat__reply`。 */
export const WECHAT_MCP_SERVER = 'wechat'

/**
 * 外部 CLI(agy、cursor-agent)不吃我们传的 mcpServers:它们只读自己的
 * **全局** 配置文件,我们的条目必须带命名空间前缀才不会撞上主人自己装的
 * 服务器 —— 于是它们回报的 `ServerName` 是那个命名空间键,不是 `wechat`。
 * 这两个常量是 bootstrap 的 agy-mcp-config / cursor-mcp-config 与这里
 * 共用的唯一事实源(那两个文件从这里 re-export)。
 *
 * WHY 这条是承重的(真机 2026-09-08):`isReplyToolCall` 用 server 名判定
 * 「这一轮 agent 自己发消息了吗」。agy 的 `wechat-cc-wechat` 没折回规范名,
 * 于是每个 agy 回合都 replyToolCalled=false,协调器的 FALLBACK_REPLY 在
 * agent 已经把正文发出去之后,又把模型的旁白(「已回复用户的问候。」)当
 * 成回复发了一遍 —— 主人每问一句收到两条。
 */
export const AGY_WECHAT_MCP_NAMESPACE_ID = 'wechat-cc-wechat'
export const CURSOR_WECHAT_MCP_NAMESPACE_ID = 'wechat-cc:wechat'

const WECHAT_MCP_SERVER_ALIASES: ReadonlySet<string> = new Set([
  WECHAT_MCP_SERVER,
  AGY_WECHAT_MCP_NAMESPACE_ID,
  CURSOR_WECHAT_MCP_NAMESPACE_ID,
])

/**
 * 把外部 CLI 报上来的命名空间键折回规范名;其他服务器名原样返回。
 * Provider 在 **发事件之前** 调用它(见 agy-agent-provider),这样下游
 * 所有消费者(reply 判定、TURN 日志的 tools=、桌宠活动信号)看到的都是
 * 同一个 `wechat`。`isReplyToolCall` 内部也过一道,是纵深防御:将来新加
 * 的 provider 忘了折,回复判定也不会再静默失效。
 */
export function normalizeWechatMcpServer(server: string | undefined): string | undefined {
  return server !== undefined && WECHAT_MCP_SERVER_ALIASES.has(server) ? WECHAT_MCP_SERVER : server
}

export function isReplyToolCall(ev: AgentEvent): boolean {
  return ev.kind === 'tool_call'
    && normalizeWechatMcpServer(ev.server) === WECHAT_MCP_SERVER
    && REPLY_TOOLS.has(ev.tool)
}

/**
 * Same wechat reply-tool check but against a raw SDK tool name
 * (`mcp__wechat__reply`) — used by the permission relay to DENY the reply
 * tool during chatroom beats (the coordinator forwards each agent's plain
 * text prefixed; a direct reply-tool call would escape that framing). Matches
 * the `mcp__<server>__<tool>` shape only.
 */
export function isReplyToolName(name: string): boolean {
  const parts = name.split('__') // mcp__<server>__<tool>
  return parts[0] === 'mcp' && parts[1] === 'wechat' && REPLY_TOOLS.has(parts.slice(2).join('__'))
}

/**
 * One-turn aggregation: drain an event stream and return the summary the
 * coordinator needs. Mirrors the shape consumers used to get from the old
 * dispatch return value, plus optional `result` / `error` for diagnostics.
 */
export interface TurnSummary {
  assistantText: string[]
  replyToolCalled: boolean
  /**
   * 这一轮调过的工具名,按发生顺序。**只有名字,不含参数** —— 参数里是
   * 搜索词、文件路径、消息正文这类隐私。
   *
   * WHY(2026-09-02):owner 问「今天有什么新闻」,bot 答得有名有姓,而
   * channel.log 里只有 `chunks=3 dur=39190ms` —— **看不出这答案是查来的
   * 还是模型编的**,而那恰恰是最该能判断的事。事件流里 `tool_call` 一直
   * 在发(agy 的解析器解得好好的),只是没有任何人记它。
   */
  toolCalls: string[]
  result?: { sessionId: string; numTurns: number; durationMs: number }
  error?: string
  /** Provider-emitted error code (e.g. 'auth_failed') — lets the coordinator
   *  branch on failure category without string-matching the message. */
  errorCode?: string
}

/** Sentinel error code stamped on a TurnSummary when the per-turn watchdog
 *  fires (the stream went silent past `timeoutMs`). Coordinators branch on
 *  this to discard the wedged session and self-heal — see [[handleTurnTimeout]]
 *  in conversation-coordinator. */
export const TURN_TIMEOUT_CODE = 'turn_timeout'

export interface CollectTurnOpts {
  /**
   * Per-turn watchdog (ms). When set, `collectTurn` stops waiting if no
   * event arrives within this window, calls the stream's `return()` to
   * unwind the producer, and resolves with `errorCode: 'turn_timeout'`
   * instead of hanging forever. Omit to drain with no bound (legacy
   * behaviour — used by callers that already bound the turn elsewhere).
   *
   * The watchdog is idle-based: it resets on every event, so a turn that
   * keeps streaming (long tool runs that emit progress) is not killed —
   * only a genuinely silent stall is.
   */
  timeoutMs?: number
  /**
   * Per-event observer, called once per event just before it is folded
   * into the summary — on BOTH consumption paths (plain drain and the
   * watchdog loop). Purely for outside-the-turn bookkeeping (the desktop
   * pet's "what is it doing right now" signals); a throw is swallowed, so
   * an observer can never break or alter a turn.
   */
  onEvent?: (ev: AgentEvent) => void
}

export async function collectTurn(events: AsyncIterable<AgentEvent>, opts?: CollectTurnOpts): Promise<TurnSummary> {
  const texts: string[] = []
  let replyToolCalled = false
  let result: TurnSummary['result']
  let error: string | undefined
  let errorCode: string | undefined
  const toolCalls: string[] = []

  const apply = (ev: AgentEvent): void => {
    if (ev.kind === 'text') {
      // **空的不是一条消息。** 这里是所有路径的共用收口:solo 会为每个
      // chunk 发一次(空的注定失败)、chatroom/parallel 会 join,而
      // `chunks=`/`preview=` 也是从这里数出来的。内容**不 trim** ——
      // 缩进和代码块里的空白是有意义的,只丢「整条都是空白」的那种。
      if (ev.text.trim() !== '') texts.push(ev.text)
    } else if (ev.kind === 'tool_call') {
      toolCalls.push(ev.server ? `${ev.server}/${ev.tool}` : ev.tool)
      if (isReplyToolCall(ev)) replyToolCalled = true
    } else if (ev.kind === 'result') {
      result = { sessionId: ev.sessionId, numTurns: ev.numTurns, durationMs: ev.durationMs }
    } else if (ev.kind === 'error') {
      error = ev.message
      if (ev.code) errorCode = ev.code
    }
  }

  /** 观察者不许影响回合:抛错就地吞掉。 */
  const observe = (ev: AgentEvent): void => {
    try { opts?.onEvent?.(ev) } catch { /* ignore */ }
  }

  const timeoutMs = opts?.timeoutMs
  if (!timeoutMs || timeoutMs <= 0) {
    for await (const ev of events) { observe(ev); apply(ev) }
    return { assistantText: texts, replyToolCalled, toolCalls, result, error, errorCode }
  }

  // Watchdog path: race each `next()` against an idle timer that resets per
  // event. On timeout, unwind the producer via `return()` so its generator
  // `finally` (and any provider cleanup) runs, then surface a timeout summary.
  const it = events[Symbol.asyncIterator]()
  const TIMEOUT = Symbol('timeout')
  let timer: ReturnType<typeof setTimeout> | undefined
  const armTimeout = (): Promise<typeof TIMEOUT> =>
    new Promise(resolve => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs) })
  try {
    for (;;) {
      const step = await Promise.race([it.next(), armTimeout()])
      if (timer) { clearTimeout(timer); timer = undefined }
      if (step === TIMEOUT) {
        // Best-effort unwind — do NOT await. A genuinely wedged producer
        // (generator stuck on an unresolved `await`) never completes its
        // `return()`, so awaiting it would re-introduce the very hang the
        // watchdog exists to break. The real provider's queue iterator
        // (AsyncQueue) resolves `return()` synchronously, closing the queue.
        void Promise.resolve(it.return?.()).catch(() => {})
        return {
          assistantText: texts,
          toolCalls,
          replyToolCalled,
          result,
          error: `turn timed out after ${timeoutMs}ms with no activity`,
          errorCode: TURN_TIMEOUT_CODE,
        }
      }
      if (step.done) break
      observe(step.value)
      apply(step.value)
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
  return { assistantText: texts, replyToolCalled, toolCalls, result, error, errorCode }
}
