import {
  streamText,
  jsonSchema,
  tool,
  type ModelMessage,
  type LanguageModel,
} from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

// Opaque re-export: the rest of the provider treats ChatMessage as a black box
// it only ever appends. Keeps AI SDK's ModelMessage type from leaking outward.
export type ChatMessage = ModelMessage

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>
}

export type TurnDelta =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }

export interface StreamedTurn {
  deltas: AsyncIterable<TurnDelta>
  finished: Promise<{
    messages: ChatMessage[]
    toolCalls: { id: string; name: string; input: unknown }[]
  }>
}

export interface ChatModelClient {
  streamTurn(messages: ChatMessage[], tools: ToolSpec[]): StreamedTurn
  generate(messages: ChatMessage[]): Promise<string>
  userMessage(text: string): ChatMessage
  systemMessage(text: string): ChatMessage
  toolResultMessage(toolCallId: string, toolName: string, result: unknown): ChatMessage
}

/**
 * Build the ChatModelClient from a concrete AI SDK LanguageModel. Split out so
 * tests can inject a MockLanguageModelV2 without a provider/base_url. Schema-only
 * tools (no `execute`) => AI SDK surfaces tool-call parts but never runs them and
 * stops after one step — WE own the loop (openai-agent-provider, later task).
 */
export function createChatModelFromLanguageModel(model: LanguageModel): ChatModelClient {
  const toAiTools = (specs: ToolSpec[]): Record<string, ReturnType<typeof tool>> =>
    Object.fromEntries(
      specs.map(s => [s.name, tool({ description: s.description, inputSchema: jsonSchema(s.parameters) })]),
    )

  return {
    streamTurn(messages, tools) {
      const result = streamText({ model, messages, tools: toAiTools(tools) })
      const toolCalls: { id: string; name: string; input: unknown }[] = []

      // Single shared generator: the caller drains `deltas` exactly once, and
      // `finished` awaits `result.response`, which AI SDK only settles once the
      // underlying stream has fully drained. We do NOT re-consume `fullStream`
      // from `finished` — that would race a second reader against the caller's
      // `for await` loop and silently drop deltas.
      async function* deltas(): AsyncIterable<TurnDelta> {
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            // v5 fullStream text-delta carries `.text` (confirmed against the
            // installed `ai@5.0.210` types: TextStreamPart's text-delta variant).
            yield { kind: 'text', text: part.text }
          } else if (part.type === 'tool-call') {
            // v5 tool-call parts carry toolCallId/toolName/input (TypedToolCall).
            toolCalls.push({ id: part.toolCallId, name: part.toolName, input: part.input })
            yield { kind: 'tool_call', id: part.toolCallId, name: part.toolName, input: part.input }
          }
          // text-start/end, finish, step markers, etc. are ignored — callers
          // drive their loop off `toolCalls` / the finished text, not these.
        }
      }

      const sharedDeltas = deltas()
      const finished = (async () => {
        // `result.response` internally tees a second branch off the same
        // underlying stream `sharedDeltas` is draining (AI SDK's fullStream
        // getter calls .tee() on each access) and awaits its own full drain
        // before resolving — so this never resolves before the caller has
        // seen every delta, regardless of which side reads first (the tee
        // buffers whichever branch lags).
        const response = await result.response
        return { messages: response.messages as ChatMessage[], toolCalls }
      })()

      return { deltas: sharedDeltas, finished }
    },

    async generate(messages) {
      // Deliberately built on streamText, not generateText: generateText calls
      // model.doGenerate(), a separate code path from doStream() that a
      // stream-only test double (or a provider that only implements
      // streaming) never satisfies. streamText's `.text` getter drains
      // fullStream internally and resolves once, so one code path serves
      // both one-shot and streamed calls.
      const result = streamText({ model, messages })
      return await result.text
    },

    userMessage(text) {
      return { role: 'user', content: text }
    },
    systemMessage(text) {
      return { role: 'system', content: text }
    },
    toolResultMessage(toolCallId, toolName, result) {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName,
            output: { type: 'text', value: typeof result === 'string' ? result : JSON.stringify(result) },
          },
        ],
      } as ChatMessage
    },
  }
}

/** Production factory: an OpenAI-compatible provider (DeepSeek/Kimi/Qwen/...). */
export function createAiSdkChatModel(opts: { baseURL: string; apiKey: string; model: string }): ChatModelClient {
  const provider = createOpenAICompatible({
    name: 'wechat-openai',
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
  })
  return createChatModelFromLanguageModel(provider.chatModel(opts.model))
}
