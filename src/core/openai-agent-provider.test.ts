import { describe, it, expect } from 'vitest'
import { OPENAI_CAPABILITIES, mapDeltaToEvent, createOpenAiAgentProvider } from './openai-agent-provider'
import { collectTurn } from './agent-provider'
import type { AgentEvent } from './agent-provider'
import type { ChatModelClient, ToolSpec } from './openai-chat-model'
import type { McpToolBridge } from './openai-mcp-bridge'

// A scripted ChatModelClient: turn 1 asks to call `reply`, turn 2 answers.
function scriptedModel(): ChatModelClient {
  let turn = 0
  return {
    streamTurn(_messages, _tools) {
      turn++
      const isFirst = turn === 1
      const toolCalls = isFirst ? [{ id: 'c1', name: 'reply', input: { text: 'hi' } }] : []
      async function* deltas() {
        if (isFirst) yield { kind: 'tool_call' as const, id: 'c1', name: 'reply', input: { text: 'hi' } }
        else yield { kind: 'text' as const, text: 'done' }
      }
      return { deltas: deltas(), finished: Promise.resolve({ messages: [{ role: 'assistant', content: '' }] as any, toolCalls }) }
    },
    async generate() { return 'ok' },
    userMessage: (t) => ({ role: 'user', content: t } as any),
    systemMessage: (t) => ({ role: 'system', content: t } as any),
    toolResultMessage: (id, name, r) => ({ role: 'tool', content: `${name}:${JSON.stringify(r)}` } as any),
  }
}

function fakeBridge(calls: string[]): McpToolBridge {
  const tools: ToolSpec[] = [{ name: 'reply', description: 'r', parameters: { type: 'object' } }]
  return {
    tools,
    async call(name) { calls.push(name); return `ran:${name}` },
    async close() {},
    serverOf(name) { return name === 'reply' ? 'wechat' : undefined },
  }
}

const guestSpawn = {
  tierProfile: { allow: new Set(['reply']), relay: new Set(), deny: new Set() } as any,
  permissionMode: 'strict' as const,
  chatId: 'c',
}

describe('openai provider loop', () => {
  it('runs the tool loop: executes reply, then produces final text', async () => {
    const calls: string[] = []
    const provider = createOpenAiAgentProvider({
      makeChatModel: () => scriptedModel(),
      makeMcpBridge: async () => fakeBridge(calls),
    })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const summary = await collectTurn(session.dispatch('hi'))
    expect(calls).toEqual(['reply'])            // tool executed
    expect(summary.replyToolCalled).toBe(true)  // reply detected
    expect(summary.assistantText.join('')).toContain('done')
    await session.close()
  })

  it('terminates with a step_budget error + exactly one result event once the loop exceeds DEFAULT_MAX_STEPS (25)', async () => {
    // A ChatModelClient that ALWAYS asks to call `reply`, never emitting a
    // turn with zero tool calls — without the step-budget guard this would
    // loop forever. `maxSteps` is intentionally left at its default (25,
    // DEFAULT_MAX_STEPS in openai-agent-provider.ts) so this proves the
    // real default, not a test-configured shortcut.
    let turn = 0
    const alwaysToolCall: ChatModelClient = {
      streamTurn(_messages, _tools) {
        turn++
        const id = `c${turn}`
        async function* deltas() {
          yield { kind: 'tool_call' as const, id, name: 'reply', input: { text: 'hi' } }
        }
        return {
          deltas: deltas(),
          finished: Promise.resolve({
            messages: [{ role: 'assistant', content: '' } as any],
            toolCalls: [{ id, name: 'reply', input: { text: 'hi' } }],
          }),
        }
      },
      async generate() { return 'ok' },
      userMessage: (t) => ({ role: 'user', content: t } as any),
      systemMessage: (t) => ({ role: 'system', content: t } as any),
      toolResultMessage: (id, name, r) => ({ role: 'tool', content: `${name}:${JSON.stringify(r)}` } as any),
    }
    const calls: string[] = []
    const provider = createOpenAiAgentProvider({
      makeChatModel: () => alwaysToolCall,
      makeMcpBridge: async () => fakeBridge(calls),
    })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const events: AgentEvent[] = []
    for await (const ev of session.dispatch('go')) events.push(ev)

    const errorEvents = events.filter((e) => e.kind === 'error')
    const resultEvents = events.filter((e) => e.kind === 'result')
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0]).toMatchObject({ kind: 'error', code: 'step_budget' })
    expect(resultEvents).toHaveLength(1)
    // The error must precede the single terminal result — the loop breaks
    // out and yields the wrap-up result event exactly once, not zero or many.
    expect(events.indexOf(errorEvents[0]!)).toBeLessThan(events.indexOf(resultEvents[0]!))
    expect(calls.length).toBe(25) // ran the tool once per step, for all 25 steps
    await session.close()
  })

  it('cheapEval returns text on success (happy path)', async () => {
    const provider = createOpenAiAgentProvider({ makeChatModel: () => scriptedModel(), makeMcpBridge: async () => fakeBridge([]) })
    expect(await provider.cheapEval!('ping')).toBe('ok')
  })

  it('cheapEval rejects when the model output matches the auth-failure sentinel', async () => {
    // Scripted client whose `generate` returns text matching AUTH_FAIL_RE
    // (see agent-provider.ts assertNotAuthFailed) — proves cheapEval actually
    // screens auth failures rather than just passing through the happy path.
    const authFailModel: ChatModelClient = {
      streamTurn() { throw new Error('not used in this test') },
      async generate() { return 'Please run /login to continue.' },
      userMessage: (t) => ({ role: 'user', content: t } as any),
      systemMessage: (t) => ({ role: 'system', content: t } as any),
      toolResultMessage: (id, name, r) => ({ role: 'tool', content: `${name}:${JSON.stringify(r)}` } as any),
    }
    const provider = createOpenAiAgentProvider({ makeChatModel: () => authFailModel, makeMcpBridge: async () => fakeBridge([]) })
    await expect(provider.cheapEval!('ping')).rejects.toThrow(/auth_failed/)
  })

  it('strongEval rejects when the model output matches the auth-failure sentinel', async () => {
    const authFailModel: ChatModelClient = {
      streamTurn() { throw new Error('not used in this test') },
      async generate() { return 'Not logged in.' },
      userMessage: (t) => ({ role: 'user', content: t } as any),
      systemMessage: (t) => ({ role: 'system', content: t } as any),
      toolResultMessage: (id, name, r) => ({ role: 'tool', content: `${name}:${JSON.stringify(r)}` } as any),
    }
    const provider = createOpenAiAgentProvider({ makeChatModel: () => authFailModel, makeMcpBridge: async () => fakeBridge([]) })
    await expect(provider.strongEval!('ping')).rejects.toThrow(/auth_failed/)
  })

  it('spawn builds its chatModel from ctx.model (per-chat pinned model); cheapEval always uses the default (undefined)', async () => {
    // Proves the provider no longer bakes ONE model in at construction —
    // `spawn` must honor `ctx.model` (the operator's per-chat pin, forwarded
    // by session-manager via SpawnContext.model) instead of ignoring it, and
    // background evals (no per-chat context) must request the default.
    const calledWith: Array<string | undefined> = []
    const makeChatModel = (model?: string) => {
      calledWith.push(model)
      return scriptedModel()
    }
    const provider = createOpenAiAgentProvider({ makeChatModel, makeMcpBridge: async () => fakeBridge([]) })

    const session = await provider.spawn(
      { alias: 'a', path: '/tmp' },
      { ...guestSpawn, model: 'deepseek-x' } as any,
    )
    await collectTurn(session.dispatch('hi'))
    await session.close()
    expect(calledWith).toEqual(['deepseek-x'])

    await provider.cheapEval!('ping')
    expect(calledWith).toEqual(['deepseek-x', undefined])
  })
})

describe('openai capabilities + mapping', () => {
  it('declares perToolCallback true, empty sandbox, no resume', () => {
    expect(OPENAI_CAPABILITIES.perToolCallback).toBe(true)
    expect(OPENAI_CAPABILITIES.sandboxLevels.size).toBe(0)
    expect(OPENAI_CAPABILITIES.supportsResume).toBe(false)
  })

  it('maps a text delta to a text event', () => {
    expect(mapDeltaToEvent({ kind: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' })
  })

  // tool_call deltas are no longer mapped by mapDeltaToEvent (it's text-only
  // now — see its doc comment): the `server` stamp requires knowing which
  // MCP server actually owns the tool (McpToolBridge.serverOf), which this
  // pure function has no access to. That event construction — and its
  // "real server, not hardcoded wechat" behavior — is covered by the loop
  // tests below ('runs the tool loop...' asserts server:'wechat' via
  // isReplyToolCall/replyToolCalled for a genuine wechat reply tool).
})
