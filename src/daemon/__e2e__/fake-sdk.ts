/**
 * Fake SDK installer for daemon e2e tests.
 *
 * Replaces @anthropic-ai/claude-agent-sdk, the codex app-server process seam
 * and @cursor/sdk with script-driven fakes. Each test passes a FakeSdkScript whose onDispatch
 * is invoked when the daemon's AgentSession.dispatch(text) is called.
 *
 * Uses vi.mock — this file MUST be imported in the test file (or via
 * setupFiles) BEFORE the daemon imports the SDKs. The harness.ts ensures
 * this ordering.
 *
 * ## Audit findings (Step 0)
 *
 * ### @anthropic-ai/claude-agent-sdk
 *   - Used in two places:
 *     1. claude-agent-provider.ts: `query({ prompt: AsyncIterable<SDKUserMessage>, options })`
 *        yields SDKMessage objects; the provider iterates `type='assistant'`,
 *        `type='result'`, `type='system'` messages.
 *     2. claude-agent-provider.ts's `oneShot`: `query({ prompt: string, options })`
 *        — single-shot eval shared by `cheapEval` (haiku-class) and
 *        `strongEval` (the /chat verdict). Reads assistant text blocks only.
 *   - The fake query handles both calling conventions (string OR AsyncIterable
 *     prompt). When prompt is an AsyncIterable we drive dispatches from
 *     claudeScript; when it's a plain string we do a single onDispatch call.
 *
 * ### codex app-server (B1 2026-10-25)
 *   - Chat and workbench spawn `codex app-server` via codex-app-server-process.ts;
 *     the mock below swaps that one module for the scripted app-server
 *     (test-support/executors/codex-scripted.ts). No real codex runs.
 */
import { vi } from 'vitest'

export interface FakeSdkScript {
  /**
   * Called when AgentSession.dispatch(text) runs. Returns what tool calls
   * to "emit" and the final reply text the agent produces.
   */
  onDispatch(text: string): Promise<{
    toolCalls: Array<{ name: string; input: unknown }>
    finalText: string
  }>
}

/**
 * Single-shot haiku eval script. Used by the chatroom conductor (convergence
 * check and verdict beats) and side-effects.ts isolated evals. Returns
 * the assistant text the caller will parse or display.
 */
export interface ModeratorScript {
  onEval(prompt: string): Promise<string>
}

let claudeScript: FakeSdkScript | null = null
let codexScript: FakeSdkScript | null = null
let cursorScript: FakeSdkScript | null = null
let moderatorScript: ModeratorScript | null = null

/**
 * Optional recorder fired on every fake `query({ prompt, options })` call
 * with a streaming AsyncIterable prompt (i.e. the path
 * claude-agent-provider.ts uses for spawned sessions — NOT cheapEval).
 * Tests use this to assert the spawn-time SDK options (e.g.
 * `permissionMode`, `disallowedTools`) match the user's tier.
 *
 * Stays null unless a test calls installFakeClaudeSpawnRecorder().
 */
let claudeSpawnRecorder: ((options: Record<string, unknown>) => void) | null = null

/**
 * Optional recorder fired on every scripted app-server `thread/start` /
 * `thread/resume` for a session thread — i.e. the codex provider's spawn
 * path (NOT cheapEval's one-shot threads). Tests use this to assert the
 * spawn-time codex options (`sandboxMode`, `approvalPolicy`, `model`)
 * match the user's tier.
 *
 * Stays null unless a test calls installCodexSpawnRecorder().
 */
let codexSpawnRecorder: ((options: Record<string, unknown>) => void) | null = null

/**
 * Optional recorder fired on every fake `Agent.create(options)` call —
 * i.e. the cursor provider's spawn path. Tests use this to assert
 * tier → cursor SDK options translation (parallel to
 * installClaudeSpawnRecorder / installCodexSpawnRecorder); the
 * `local.sandboxOptions.enabled` field is the entire permission
 * surface so a single recorder snapshot is enough.
 *
 * Stays null unless a test calls installCursorSpawnRecorder().
 */
let cursorSpawnRecorder: ((options: Record<string, unknown>) => void) | null = null

export function installFakeClaude(script: FakeSdkScript): { uninstall(): void } {
  claudeScript = script
  return { uninstall() { claudeScript = null } }
}

/**
 * Install a recorder that's called with the SDK options passed to
 * `query()` for every streaming (AgentSession) spawn. Returns an
 * uninstaller. Tests that want to verify tier → SDK options translation
 * (Task 17 e2e) use this.
 */
export function installClaudeSpawnRecorder(
  fn: (options: Record<string, unknown>) => void,
): { uninstall(): void } {
  claudeSpawnRecorder = fn
  return { uninstall() { claudeSpawnRecorder = null } }
}

export function installFakeCodex(script: FakeSdkScript): { uninstall(): void } {
  codexScript = script
  return { uninstall() { codexScript = null } }
}

/**
 * Install a recorder that's called with the app-server thread/start
 * params for every spawned codex session. Returns an uninstaller. Tests
 * that want to verify tier → codex options translation (parallel to
 * installClaudeSpawnRecorder) use this.
 *
 * Only the per-session spawn path fires this — cheapEval's one-shot
 * threads (read-only / never / network_access=false) are NOT recorded
 * (they don't reflect a user's tier).
 */
export function installCodexSpawnRecorder(
  fn: (options: Record<string, unknown>) => void,
): { uninstall(): void } {
  codexSpawnRecorder = fn
  return { uninstall() { codexSpawnRecorder = null } }
}

export function installFakeCursor(script: FakeSdkScript): { uninstall(): void } {
  cursorScript = script
  return { uninstall() { cursorScript = null } }
}

/**
 * Install a recorder that's called with the options passed to
 * `Agent.create(opts)` / `Agent.resume(id, opts)` for every spawned
 * cursor session. Returns an uninstaller. Tests that want to verify
 * tier → cursor SDK options translation (parallel to
 * installClaudeSpawnRecorder / installCodexSpawnRecorder) use this.
 *
 * Unlike Claude and Codex, Cursor has no cheap-eval path — all
 * Agent.create calls reflect a real spawn, so we don't need an
 * "only-the-streaming-path" filter here.
 */
export function installCursorSpawnRecorder(
  fn: (options: Record<string, unknown>) => void,
): { uninstall(): void } {
  cursorSpawnRecorder = fn
  return { uninstall() { cursorSpawnRecorder = null } }
}

export function installFakeModerator(script: ModeratorScript): { uninstall(): void } {
  moderatorScript = script
  return { uninstall() { moderatorScript = null } }
}

// ───────────────────────────────────────────────────────────────────────
// wechat MCP 工具名
//
// 剧本里写裸名(`reply`)的工具调用按 wechat MCP 的命名空间包一层(`mcp__wechat__reply`),和真 SDK 报出来的
// 形状一样。以前这里还有一座「reply 族 → internal-api」的桥,让旧路(执行者调 reply 说话)在假 SDK 里也能
// 真发出一条;回复交付 D3 删了旧路,回复是最后写下的文字、由 daemon 送达,桥也跟着删了。
// ───────────────────────────────────────────────────────────────────────
const WECHAT_MCP_TOOL_NAMES = new Set(['reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast'])

// ---------------------------------------------------------------------------
// Claude SDK mock
//
// `query` is called with either:
//   { prompt: string, options }          — single-shot eval (side-effects.ts)
//   { prompt: AsyncIterable<msg>, options } — streaming session (claude-agent-provider.ts)
//
// For the streaming (AgentSession) case:
//   The provider pushes one SDKUserMessage per dispatch() call onto the queue
//   and awaits a `result` event to resolve each dispatch(). We must therefore
//   iterate the prompt iterable and emit one (assistant? + result) cycle per
//   message consumed from it. When the iterable ends (queue.end() called on
//   close()), we stop.
//
// For the single-shot string case we emit exactly one cycle then stop.
// ---------------------------------------------------------------------------
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeId(): string {
    return Math.random().toString(36).slice(2, 10)
  }

  /**
   * Build a single dispatch cycle: tool-use blocks + final text + result event.
   * Returns the array of SDKMessage-shaped objects to yield.
   */
  async function buildCycle(
    dispatchResult: { toolCalls: Array<{ name: string; input: unknown }>; finalText: string },
  ): Promise<Array<Record<string, unknown>>> {
    const msgs: Array<Record<string, unknown>> = []

    // Emit tool_use + tool_result pairs for each tool call.
    //
    // Name shape: claude-agent-provider parses `mcp__<server>__<tool>` to
    // populate AgentEvent.server. Tests pass the bare tool name (e.g.
    // `reply`); we wrap with the wechat-mcp prefix here. Tests that
    // genuinely want a non-MCP tool can pass a name with no `__` and
    // bypass the prefix.
    for (const tc of dispatchResult.toolCalls) {
      const toolUseId = `tu${makeId()}`
      const sdkToolName = WECHAT_MCP_TOOL_NAMES.has(tc.name) && !tc.name.includes('__')
        ? `mcp__wechat__${tc.name}`
        : tc.name
      msgs.push({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: toolUseId, name: sdkToolName, input: tc.input }],
        },
      })
      msgs.push({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
        },
      })
    }

    // Emit text reply if present.
    if (dispatchResult.finalText) {
      msgs.push({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: dispatchResult.finalText }],
        },
      })
    }

    // Always emit a result event so the provider resolves the pending turn.
    msgs.push({
      type: 'result',
      subtype: 'success',
      session_id: `sess_${makeId()}`,
      num_turns: 1,
      duration_ms: 10,
      total_cost_usd: 0,
    })

    return msgs
  }

  /**
   * Fake `query` implementation.
   *
   * Accepts both { prompt: string } and { prompt: AsyncIterable<SDKUserMessage> }.
   * Returns an AsyncGenerator of SDKMessage-shaped objects.
   */
  const fakeQuery = (opts: { prompt: unknown; options?: unknown }) => {
    return (async function* () {
      const { prompt } = opts

      if (typeof prompt === 'string') {
        // Single-shot path: chatroom haiku moderator (bootstrap inline
        // haikuEval) + claude-agent-provider.ts's `oneShot` (cheapEval /
        // strongEval). Both consume only assistant text blocks. Prefer
        // moderatorScript when installed; fall back to claudeScript.onDispatch
        // for tests that don't distinguish.
        if (moderatorScript) {
          const decision = await moderatorScript.onEval(prompt)
          yield { type: 'assistant', message: { content: [{ type: 'text', text: decision }] } }
          yield {
            type: 'result',
            subtype: 'success',
            session_id: `sess_${makeId()}`,
            num_turns: 1,
            duration_ms: 1,
            total_cost_usd: 0,
          }
          return
        }
        const script = claudeScript
        if (!script) {
          // Emit empty assistant message so callers don't hang on an empty
          // generator. `oneShot` (cheapEval / strongEval) only reads
          // assistant text blocks.
          yield { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } }
          return
        }
        const result = await script.onDispatch(prompt)
        // This branch is the one-shot eval (moderator / companion introspect /
        // the 2026-09-08 claude first-use probe「只回复两个字母:ok」), which
        // in production runs via `oneShot` with `tools: []` — structurally
        // incapable of producing a tool_use block. Drop any scripted
        // toolCalls before building the cycle so the fake can't emit one
        // either.
        for (const msg of await buildCycle({ ...result, toolCalls: [] })) yield msg
        return
      }

      // Streaming iterable path (claude-agent-provider.ts).
      // Drain the prompt iterable; each message is one user dispatch.
      // The provider's queue emits SDKUserMessage objects.
      //
      // Fire the spawn recorder ONCE per `query()` invocation — the
      // provider calls `query({ prompt: iterable, options })` once per
      // spawn(), so this captures the spawn-time options snapshot.
      if (claudeSpawnRecorder && opts.options && typeof opts.options === 'object') {
        try { claudeSpawnRecorder(opts.options as Record<string, unknown>) } catch {}
      }
      const iterable = prompt as AsyncIterable<{ message?: { content?: Array<{ type?: string; text?: string }> } }>
      for await (const userMsg of iterable) {
        // Extract the user text from the SDKUserMessage payload.
        const content = userMsg?.message?.content
        const text = Array.isArray(content)
          ? content.map(b => (b?.type === 'text' ? (b.text ?? '') : '')).join('')
          : ''

        const script = claudeScript
        if (!script) {
          // No script installed — yield empty cycle so the turn resolves.
          yield { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } }
          yield {
            type: 'result',
            subtype: 'success',
            session_id: `sess_${makeId()}`,
            num_turns: 1,
            duration_ms: 10,
            total_cost_usd: 0,
          }
          continue
        }

        const result = await script.onDispatch(text)
        for (const msg of await buildCycle(result)) yield msg
      }
    })()
  }

  return { query: fakeQuery }
})

// ---------------------------------------------------------------------------
// Codex app-server mock (B1 2026-10-25: chat moved off @openai/codex-sdk)
//
// Codex chat and workbench both spawn `codex app-server` through ONE seam,
// `adapters/executors/codex/codex-app-server-process.ts`. We replace that module
// with the scripted app-server (test-support/executors/codex-scripted.ts):
//   - session threads: each turn/start asks codexScript.onDispatch(text) and plays
//     its tool calls as completed `mcpToolCall` items (server 'wechat') plus the
//     final text as one `agentMessage`;
//   - one-shot threads (cheapEval: read-only + thread config network_access=false
//     — sessions never set it, codex-chat-provider.test.ts pins both halves) are
//     NOT wired to codexScript and never fire the spawn recorder; they answer via
//     the moderator script (or 'ok', which the first-use probe needs).
// ---------------------------------------------------------------------------
vi.mock('../../adapters/executors/codex/codex-app-server-process', async () => {
  const { createScriptedCodex } = await import('../../test-support/executors/codex-scripted')
  const scripted = createScriptedCodex({
    // Same as the old SDK fake: tool calls always "go through" (no approval gate).
    rejectMcp: false,
    turns: async (text) => {
      const script = codexScript
      if (!script) return { steps: [] }
      const result = await script.onDispatch(text)
      return { steps: [
        ...result.toolCalls.map(tc => ({ mcp: { server: 'wechat', tool: tc.name, args: (tc.input ?? {}) as Record<string, unknown> } })),
        ...(result.finalText ? [{ say: result.finalText }] : []),
      ] }
    },
    cheapAnswer: async (prompt) => moderatorScript ? await moderatorScript.onEval(prompt) : 'ok',
    onThreadStart: (_method, params, cheap) => {
      if (cheap || !codexSpawnRecorder) return
      try { codexSpawnRecorder({ ...params, sandboxMode: params.sandbox, workingDirectory: params.cwd }) } catch {}
    },
  })
  return { spawnCodexAppServerProcess: scripted.spawn }
})

// ---------------------------------------------------------------------------
// Cursor SDK mock
//
// @cursor/sdk exports:
//   Agent.create(options): Promise<Agent>
//   Agent.resume(agentId, options?): Promise<Agent>
//   Agent: { agentId: string; send(message): Promise<Run>; close(): void; reload?(): Promise<void> }
//   Run:   { id: string; agentId: string; stream(): AsyncIterable<SDKMessage> }
//
// SDKMessage shapes consumed by cursor-agent-provider.ts:
//   { type: 'assistant', message: { content: Array<{type:'text'|'tool_use', text?, name?, input?}> } }
//   { type: 'status', status: 'FINISHED' | 'ERROR' | 'CANCELLED' | 'EXPIRED' | 'RUNNING' | 'CREATING',
//                     error?: { message?: string } }
//
// The cursor provider has no cheap-eval path (cf. Claude/Codex), so every
// Agent.create call is a real session spawn and is unconditionally recorded
// when cursorSpawnRecorder is installed.
// ---------------------------------------------------------------------------
vi.mock('@cursor/sdk', () => {
  function makeId(): string {
    return Math.random().toString(36).slice(2, 10)
  }

  let agentSeq = 0

  /**
   * Build the SDKMessage stream for one send() call.
   *
   * Mirrors the Claude buildCycle shape — emit one assistant message per
   * tool call (with a `tool_use` content block), one assistant message
   * with the final text, then a `status: FINISHED` terminator so the
   * provider emits a `result` event with real timings.
   *
   * Tool names get wrapped with `mcp__wechat__<name>` for wechat MCP
   * tools (matching the Claude fake).
   */
  async function* buildCursorStream(
    dispatchResult: { toolCalls: Array<{ name: string; input: unknown }>; finalText: string },
  ): AsyncGenerator<Record<string, unknown>> {
    for (const tc of dispatchResult.toolCalls) {
      const sdkToolName = WECHAT_MCP_TOOL_NAMES.has(tc.name) && !tc.name.includes('__')
        ? `mcp__wechat__${tc.name}`
        : tc.name
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: sdkToolName, input: tc.input }],
        },
      }
    }
    if (dispatchResult.finalText) {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: dispatchResult.finalText }],
        },
      }
    }
    yield { type: 'status', status: 'FINISHED' }
  }

  class FakeCursorRun {
    readonly id: string
    readonly agentId: string
    private readonly _text: string
    constructor(agentId: string, text: string) {
      this.id = `run_${makeId()}`
      this.agentId = agentId
      this._text = text
    }
    stream(): AsyncGenerator<Record<string, unknown>> {
      const script = cursorScript
      if (!script) {
        // No script installed — emit a single FINISHED so the dispatch
        // generator concludes (provider yields a `result` event).
        return (async function* () {
          yield { type: 'status', status: 'FINISHED' } as Record<string, unknown>
        })()
      }
      const text = this._text
      return (async function* () {
        const result = await script.onDispatch(text)
        for await (const msg of buildCursorStream(result)) yield msg
      })()
    }
    async cancel(): Promise<void> { /* no-op */ }
  }

  class FakeCursorAgent {
    readonly agentId: string
    constructor(agentId: string) {
      this.agentId = agentId
    }
    async send(message: string): Promise<FakeCursorRun> {
      return new FakeCursorRun(this.agentId, message)
    }
    close(): void { /* no-op */ }
    async reload(): Promise<void> { /* no-op */ }
  }

  const Agent = {
    create: vi.fn(async (options: Record<string, unknown>): Promise<FakeCursorAgent> => {
      if (cursorSpawnRecorder) {
        try { cursorSpawnRecorder(options) } catch {}
      }
      agentSeq++
      return new FakeCursorAgent(`fake-cursor-agent-${agentSeq}`)
    }),
    resume: vi.fn(async (agentId: string, options?: Record<string, unknown>): Promise<FakeCursorAgent> => {
      if (cursorSpawnRecorder && options) {
        try { cursorSpawnRecorder(options) } catch {}
      }
      return new FakeCursorAgent(agentId)
    }),
  }

  return { Agent }
})
