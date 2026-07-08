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
import type { ChatModelClient, ChatMessage, ToolSpec, TurnDelta } from './openai-chat-model'
import type { McpToolBridge } from './openai-mcp-bridge'
import { builtinTools, type BuiltinTool } from './openai-tools'
import { gateTool } from './openai-gate'

export const OPENAI_CAPABILITIES: ProviderCapabilities = {
  // We own the loop, so per-tool gating IS realisable.
  perToolCallback: true,
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
  chatModel: ChatModelClient
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

  return {
    dispatch(text: string): AsyncIterable<AgentEvent> {
      messages.push(chatModel.userMessage(text))
      const startedAt = Date.now()
      return (async function* run(): AsyncIterable<AgentEvent> {
        if (firstRef.first) { firstRef.first = false; yield { kind: 'init', sessionId } }
        let steps = 0
        for (;;) {
          steps++
          const turn = chatModel.streamTurn(messages, toolSpecs)
          // MUST fully drain `deltas` before awaiting `finished` — see
          // function doc + Task 6 contract #1.
          for await (const d of turn.deltas) {
            if (d.kind === 'text') { yield mapDeltaToEvent(d); continue }
            // Stamp `server` from the REAL owning MCP server (never assume
            // `wechat` for every MCP tool) — see McpToolBridge.serverOf doc
            // and isReplyToolCall, which keys reply-detection on this field.
            const mcpServer = bridge.serverOf(d.name)
            yield { kind: 'tool_call', tool: d.name, ...(mcpServer !== undefined ? { server: mcpServer } : {}) }
          }
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
          if (steps >= maxSteps) {
            yield { kind: 'error', message: `step budget ${maxSteps} exhausted`, code: 'step_budget' }
            break
          }
        }
        yield { kind: 'result', sessionId, numTurns: steps, durationMs: Date.now() - startedAt }
      })()
    },
    async close() {
      await bridge.close().catch(() => {})
    },
  }
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

      // Conversation history for this live session (in-memory; no resume in v1).
      const messages: ChatMessage[] = []
      if (ctx.appendInstructions) messages.push(opts.chatModel.systemMessage(ctx.appendInstructions))

      const session = makeOpenAiSession({
        sessionId,
        chatModel: opts.chatModel,
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
      const text = await opts.chatModel.generate([opts.chatModel.userMessage(prompt)])
      assertNotAuthFailed(text, log, 'openai')
      return text
    },

    async strongEval(prompt: string): Promise<string> {
      // v1: same model as cheapEval (DeepSeek is already the strong+cheap model).
      const text = await opts.chatModel.generate([opts.chatModel.userMessage(prompt)])
      assertNotAuthFailed(text, log, 'openai')
      return text
    },
  }
}
