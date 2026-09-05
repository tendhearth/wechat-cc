import { randomUUID } from 'node:crypto'
import {
  type AgentProvider,
  type AgentSession,
  type AgentEvent,
  type AgentProject,
  type SpawnContext,
  type ProviderCapabilities,
  assertNotAuthFailed,
} from './agent-provider'
import { isAuthFailError } from './auth-fail'
import type { ChatModelClient, ChatMessage, ToolSpec, TurnDelta } from './openai-chat-model'
import type { McpToolBridge } from './openai-mcp-bridge'
import { builtinTools, type BuiltinTool } from './openai-tools'
import { gateTool } from './openai-gate'
import { makeTurnEmitter } from './turn-emitter'

export const OPENAI_CAPABILITIES: ProviderCapabilities = {
  // We own the loop, so per-tool gating IS realisable.
  perToolCallback: true,
  // openai-mcp-bridge threads WECHAT_SESSION_TIER per session.
  adminMcpTools: true,
  // No SDK/OS sandbox in v1 — the tier gate is the only barrier.
  sandboxLevels: new Set(),
  supportsDelegation: true,
  supportsResume: false,
  defaultPeer: 'claude',
  authFailHint: 'openai: set WECHAT_OPENAI_API_KEY (and check base_url/model in agent config).',
}

/**
 * Text-delta → event mapping only. `tool_call` deltas are NOT handled here:
 * their `server` field depends on which MCP server actually owns the tool
 * (`McpToolBridge.serverOf`), which this pure function has no access to —
 * building that event is the loop's job (see `makeOpenAiSession`) so the
 * `server` stamp reflects the real owning server instead of guessing
 * `wechat` for every MCP tool.
 */
export function mapDeltaToEvent(d: Extract<TurnDelta, { kind: 'text' }>): AgentEvent {
  return { kind: 'text', text: d.text }
}

export interface OpenAiAgentProviderOptions {
  // Builds a ChatModelClient for a given model id (undefined → the
  // provider's configured default). A thunk rather than a single instance so
  // `spawn` can honor `ctx.model` per-session (the operator's pinned model,
  // hot-reloaded via the daemon's mtime-cached config reader — see
  // bootstrap/index.ts currentModelFor) instead of the model baked in at
  // provider construction. `cheapEval`/`strongEval` are background calls with
  // no per-chat pin, so they always pass `undefined` (the default model).
  makeChatModel: (model?: string) => ChatModelClient
  makeMcpBridge: (mcpEnv: Record<string, string>) => Promise<McpToolBridge>
  cwd?: string
  maxSteps?: number
  log?: (tag: string, line: string) => void
}

const DEFAULT_MAX_STEPS = 25

/**
 * Build a live session's `dispatch` closure — the owned tool loop. Extracted
 * from `spawn` so the loop's shape (drain deltas, THEN await finished; gate
 * each tool call; step-budget guard) is testable/readable on its own.
 *
 * Drain-then-finish is load-bearing: `ChatModelClient.streamTurn`'s
 * `finished` promise only resolves correctly once `deltas` has been fully
 * iterated (see openai-chat-model's tee comment) — awaiting `finished`
 * first would deadlock against a real AI SDK stream.
 */
function makeOpenAiSession(args: {
  sessionId: string
  chatModel: ChatModelClient
  bridge: McpToolBridge
  builtinByName: Map<string, BuiltinTool>
  toolSpecs: ToolSpec[]
  ctx: SpawnContext
  maxSteps: number
  messages: ChatMessage[]
  firstRef: { first: boolean }
}): AgentSession {
  const { sessionId, chatModel, bridge, builtinByName, toolSpecs, ctx, maxSteps, messages, firstRef } = args

  // Per-dispatch AbortController holder. We own the loop, so cancel() is
  // boundary-checked rather than a true mid-stream abort: `streamTurn`'s
  // signature is unchanged (no `signal` param — see class doc), so /stop
  // takes effect at the next loop boundary (top of the round, or right
  // after the tool-execution block), not instantly. Session-scoped rather
  // than dispatch()-scoped so cancel()/close() can reach whichever
  // dispatch is currently in flight without the caller holding a
  // reference to it.
  let activeAbort: AbortController | null = null

  return {
    dispatch(text: string): AsyncIterable<AgentEvent> {
      messages.push(chatModel.userMessage(text))
      // Hoisted out of the generator body: an async generator FUNCTION's
      // code doesn't run until the caller's first `.next()` — constructing
      // the controller inside `run()` would leave `activeAbort` null/stale
      // until then, so a cancel() called between dispatch() returning and
      // the first iteration would be silently lost. Creating it here, in
      // dispatch()'s own synchronous body, guarantees activeAbort is set
      // the instant dispatch() is called. Mirrors gemini-agent-provider.ts's
      // createGeminiAgentProvider dispatch(), which has the same comment.
      const abort = new AbortController()
      activeAbort = abort
      return (async function* run(): AsyncIterable<AgentEvent> {
        if (firstRef.first) { firstRef.first = false; yield { kind: 'init', sessionId } }
        const em = makeTurnEmitter()
        try {
          let steps = 0
          for (;;) {
            // Boundary check #1 — top of the round, before the next model
            // call. Mirrors the step_budget shape below: error then break,
            // falling through to the single terminal `finish` event.
            if (abort.signal.aborted) {
              yield em.errorText('cancelled', { code: 'cancelled' })
              break
            }
            steps++
            const turn = chatModel.streamTurn(messages, toolSpecs)
            // MUST fully drain `deltas` before awaiting `finished` — see
            // function doc + Task 6 contract #1.
            // 文本 delta **要攒起来,一步只发一个 text 事件**。
            //
            // `AgentEvent{kind:'text'}` 的契约是「一条完整的助手消息」——
            // claude/codex 的 SDK 就是这么发的,agy 的解析器按 step 聚合,
            // cursor 按 block 聚合。此前只有这里把原始流式 delta 逐个抛出去,
            // 而所有消费者(collectTurn → assistantText)都按「一条消息一项」
            // 用 `join('\n')` 拼 —— 于是每个 token 之间多一个换行:
            //
            //   已 读取  `C:\ Users\030103 49\wcc \ package.json`
            //
            // 之前没人发现,是因为正常聊天走 reply 工具、根本不用
            // assistantText;只有回落路径才拼(chatroom 每一拍 / parallel /
            // 派活的 exec 返回),而这三条 2026-09-02 刚好全变成了主路径。
            let textBuf = ''
            const flushText = function* (): Generator<AgentEvent> {
              if (textBuf === '') return
              yield mapDeltaToEvent({ kind: 'text', text: textBuf })
              textBuf = ''
            }
            for await (const d of turn.deltas) {
              if (d.kind === 'text') { textBuf += d.text; continue }
              // 工具调用之前先把已攒的文本吐出来,保持「先说后做」的事件顺序。
              yield* flushText()
              // Stamp `server` from the REAL owning MCP server (never assume
              // `wechat` for every MCP tool) — see McpToolBridge.serverOf doc
              // and isReplyToolCall, which keys reply-detection on this field.
              const mcpServer = bridge.serverOf(d.name)
              yield { kind: 'tool_call', tool: d.name, ...(mcpServer !== undefined ? { server: mcpServer } : {}) }
            }
            yield* flushText()
            const { messages: assistantMsgs, toolCalls } = await turn.finished
            messages.push(...assistantMsgs)
            if (toolCalls.length === 0) break
            for (const tc of toolCalls) {
              const mcpServer = bridge.serverOf(tc.name)
              const decision = gateTool({
                toolName: tc.name,
                mcpServer,
                input: (tc.input ?? {}) as Record<string, unknown>,
                tierProfile: ctx.tierProfile,
                permissionMode: ctx.permissionMode,
              })
              let result: string
              if (decision === 'deny') {
                result = `Permission denied: tool "${tc.name}" is not allowed for this chat.`
              } else {
                try {
                  result = mcpServer !== undefined
                    ? await bridge.call(tc.name, tc.input)
                    : await builtinByName.get(tc.name)!.execute((tc.input ?? {}) as Record<string, unknown>)
                } catch (err) {
                  result = `Tool error: ${err instanceof Error ? err.message : String(err)}`
                }
              }
              messages.push(chatModel.toolResultMessage(tc.id, tc.name, result))
            }
            // Boundary check #2 — right after tool execution, before the
            // step-budget check. Same shape as step_budget: error then
            // break, finish still fires.
            if (abort.signal.aborted) {
              yield em.errorText('cancelled', { code: 'cancelled' })
              break
            }
            if (steps >= maxSteps) {
              yield em.errorText(`step budget ${maxSteps} exhausted`, { code: 'step_budget' })
              break
            }
          }
          yield em.finish({ sessionId, numTurns: steps })
        } catch (err) {
          yield em.error(err)
        } finally {
          if (activeAbort === abort) activeAbort = null
        }
      })()
    },
    async cancel() {
      activeAbort?.abort()
    },
    async close() {
      activeAbort?.abort()
      await bridge.close().catch(() => {})
    },
  }
}

/**
 * Shared cheapEval/strongEval body: run `chatModel.generate` and normalize
 * BOTH ways an eval call can signal auth failure into the same shape:
 *  - error-shaped TEXT (Claude/Codex sentinel strings) → assertNotAuthFailed
 *    below throws on the returned text, as before.
 *  - a THROWN transport error (e.g. a real gateway 401 APICallError, now
 *    surfaced instead of masked — see openai-chat-model.ts generate()) →
 *    classified via isAuthFailError and rethrown as `Error('auth_failed: …')`,
 *    mirroring the shape assertNotAuthFailed already produces, for log-tag
 *    consistency — no consumer currently branches on this message text
 *    (wrapCheapEvalWithAuthFailCheck in bootstrap/index.ts never catches the
 *    rejection, only screens resolved text; gardener.ts's catch just logs
 *    and counts). The structured, actually-branched-on auth classification
 *    for the live session path is the separate AgentEvent errorCode channel
 *    (turn-emitter's `em.error`/`code: 'auth_failed'`, see D4/B3). This
 *    fix's real value here is accurate error propagation (the 401's real
 *    cause is no longer lost behind a generic NoOutputGeneratedError) plus
 *    a new AUTH_FAILED log line for what was previously an invisible
 *    thrown-401 case.
 * Non-auth throws (network blips, etc.) pass through unchanged.
 */
async function runEval(chatModel: ChatModelClient, prompt: string, log: (tag: string, line: string) => void, source: string): Promise<string> {
  let text: string
  try {
    text = await chatModel.generate([chatModel.userMessage(prompt)])
  } catch (err) {
    if (isAuthFailError(err)) {
      const msg = err instanceof Error ? err.message.slice(0, 160) : String(err)
      log('AUTH_FAILED', `${source} credentials stale: ${msg}`)
      throw new Error(`auth_failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`)
    }
    throw err
  }
  assertNotAuthFailed(text, log, source)
  return text
}

export function createOpenAiAgentProvider(opts: OpenAiAgentProviderOptions): AgentProvider {
  const log = opts.log ?? (() => {})
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS

  return {
    async spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      const sessionId = randomUUID()
      const cwd = opts.cwd ?? project.path
      const bridge = await opts.makeMcpBridge(ctx.mcpEnv ?? {})
      const builtins = builtinTools(cwd)
      const builtinByName = new Map<string, BuiltinTool>(builtins.map(b => [b.spec.name, b]))
      const toolSpecs: ToolSpec[] = [...bridge.tools, ...builtins.map(b => b.spec)]

      // Built once per spawn from ctx.model (the operator's per-chat pinned
      // model, if any) — an in-flight session keeps this model until
      // released, matching the codebase convention (claude/codex/cursor
      // already hot-reload the SAME way: re-read per spawn, not per turn).
      const chatModel = opts.makeChatModel(ctx.model)

      // Conversation history for this live session (in-memory; no resume in v1).
      const messages: ChatMessage[] = []
      if (ctx.appendInstructions) messages.push(chatModel.systemMessage(ctx.appendInstructions))

      const session = makeOpenAiSession({
        sessionId,
        chatModel,
        bridge,
        builtinByName,
        toolSpecs,
        ctx,
        maxSteps,
        messages,
        firstRef: { first: true },
      })
      log('SESSION_SPAWN', `alias=${project.alias} provider=openai session=${sessionId}`)
      return session
    },

    async cheapEval(prompt: string): Promise<string> {
      // Background eval, no per-chat pin — always the configured default model.
      const chatModel = opts.makeChatModel(undefined)
      return runEval(chatModel, prompt, log, 'openai cheapEval')
    },

    async strongEval(prompt: string): Promise<string> {
      // v1: same model as cheapEval (DeepSeek is already the strong+cheap model).
      const chatModel = opts.makeChatModel(undefined)
      return runEval(chatModel, prompt, log, 'openai strongEval')
    },
  }
}
