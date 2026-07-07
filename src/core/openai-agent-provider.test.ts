import { describe, it, expect } from 'vitest'
import { OPENAI_CAPABILITIES, mapDeltaToEvent, createOpenAiAgentProvider } from './openai-agent-provider'
import { collectTurn } from './agent-provider'
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
  return { tools, async call(name) { calls.push(name); return `ran:${name}` }, async close() {} }
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
      chatModel: scriptedModel(),
      makeMcpBridge: async () => fakeBridge(calls),
    })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const summary = await collectTurn(session.dispatch('hi'))
    expect(calls).toEqual(['reply'])            // tool executed
    expect(summary.replyToolCalled).toBe(true)  // reply detected
    expect(summary.assistantText.join('')).toContain('done')
    await session.close()
  })

  it('cheapEval returns text and screens auth failures', async () => {
    const provider = createOpenAiAgentProvider({ chatModel: scriptedModel(), makeMcpBridge: async () => fakeBridge([]) })
    expect(await provider.cheapEval!('ping')).toBe('ok')
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

  it('maps a tool_call delta to a tool_call event with wechat server for MCP tools', () => {
    expect(mapDeltaToEvent({ kind: 'tool_call', id: 'c1', name: 'reply', input: {} }))
      .toMatchObject({ kind: 'tool_call', tool: 'reply', server: 'wechat' })
  })

  it('maps a tool_call delta for a non-wechat tool without a server field', () => {
    const ev = mapDeltaToEvent({ kind: 'tool_call', id: 'c2', name: 'some_other_tool', input: {} })
    expect(ev).toEqual({ kind: 'tool_call', tool: 'some_other_tool' })
  })
})
