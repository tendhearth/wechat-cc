import { describe, it, expect } from 'vitest'
import { gateTool } from './openai/openai-gate'
import { createOpenAiAgentProvider } from './openai/openai-agent-provider'
import { makeCanUseTool } from './claude/permission-relay'
import { createGeminiAgentProvider, makeGeminiToolGate } from './gemini/gemini-agent-provider'
import { ChatApprovalTurn } from './chat-approval'
import { TIER_PROFILES } from '../../domain/user-tier'
import { collectTurn } from '../../ports/agent-provider'
import { scriptedOpenAiModel, scriptedMcpTools } from '../../test-support/executors/openai-scripted'

function setup(provider: string, answer: 'allow' | 'deny', maxCards?: number) {
  const cards: string[] = []
  const askUser = async (_chat: string, prompt: string) => { cards.push(prompt); return answer }
  const ctx = { chatId: 'owner', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' as const }
  const claude = makeCanUseTool({ askUser, maxCards, initiatingChatId: () => 'owner', adminChatId: () => 'owner', resolveTier: () => 'admin', log: () => {}, mode: () => 'solo', provider: 'claude', permissionMode: 'strict' })
  const gemini = () => makeGeminiToolGate({ askUser, maxCards, adminFor: () => 'owner', modeFor: () => 'solo', lookupBase: () => ({ askUser: 'per-tool' }) })(ctx)
  let g = gemini(), turn = new ChatApprovalTurn(maxCards)
  return { cards, next() { claude.beginTurn(); g = gemini(); turn = new ChatApprovalTurn(maxCards) }, async call(tool: string, input = {}) {
    if (provider === 'OpenAI') return (await gateTool({ toolName: tool, mcpServer: 'wechat', input, ...ctx, approvalTurn: turn, approval: { askUser, adminFor: () => 'owner' } })).decision === 'allow'
    if (provider === 'Claude') return (await claude(`mcp__wechat__${tool}`, input, { signal: new AbortController().signal, toolUseID: `${tool}-${cards.length}` } as any)).behavior === 'allow'
    return (await g(tool, input)).allow
  } }
}

for (const provider of ['Claude', 'OpenAI', 'Gemini']) describe(`${provider} per-turn approval limit`, () => {
  it('same denied tool with different input is denied without another card; next turn resets', async () => {
    const s = setup(provider, 'deny')
    expect(await s.call('matter_handoff', { id: 'first' })).toBe(false)
    expect(await s.call('matter_handoff', { id: 'different' })).toBe(false)
    expect(s.cards).toHaveLength(1)
    s.next()
    expect(await s.call('matter_handoff')).toBe(false)
    expect(s.cards).toHaveLength(2)
  })
  it('at most three cards per turn, even after approvals; safe tools still run', async () => {
    const s = setup(provider, 'allow')
    for (const name of ['matter_handoff', 'model_set', 'session_release']) expect(await s.call(name)).toBe(true)
    expect(await s.call('daemon_restart')).toBe(false)
    expect(await s.call('topic_search')).toBe(true)
    expect(s.cards).toHaveLength(3)
    s.next()
    expect(await s.call('daemon_restart')).toBe(true)
    expect(s.cards).toHaveLength(4)
  })
  it('concurrent tool requests share the same three-card budget', async () => {
    const s = setup(provider, 'allow')
    expect(await Promise.all(['matter_handoff', 'model_set', 'session_release', 'daemon_restart'].map(name => s.call(name)))).toEqual([true, true, true, false])
    expect(s.cards).toHaveLength(3)
  })
  it('respects an explicit smaller N', async () => {
    const s = setup(provider, 'allow', 1)
    expect(await s.call('matter_handoff')).toBe(true)
    expect(await s.call('model_set')).toBe(false)
    expect(s.cards).toHaveLength(1)
  })
})

it('OpenAI reused session resets its actual dispatch budget', async () => {
  const bridge = scriptedMcpTools({ tools: [{ name: 'matter_handoff', server: 'wechat' }] })
  const model = scriptedOpenAiModel([{ calls: [{ name: 'matter_handoff' }] }, { calls: [{ name: 'matter_handoff', input: { different: true } }] }, { text: 'done' }, { calls: [{ name: 'matter_handoff' }] }, { text: 'done again' }])
  const cards: string[] = []
  const provider = createOpenAiAgentProvider({ makeChatModel: () => model.model, makeMcpBridge: async () => bridge.bridge, approval: { adminFor: () => 'owner', askUser: async (_to, prompt) => { cards.push(prompt); return 'deny' } } })
  const session = await provider.spawn({ alias: 'offline', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'owner' })
  try {
    await collectTurn(session.dispatch('first'))
    expect(cards).toHaveLength(1)
    await collectTurn(session.dispatch('second'))
    expect(cards).toHaveLength(2)
    expect(bridge.calls).toEqual([])
  } finally { await session.close() }
})

it('Gemini reused session resets its actual dispatch budget', async () => {
  const cards: string[] = []
  const responses = [{ functionCalls: [{ name: 'matter_handoff', args: {} }] }, { functionCalls: [{ name: 'matter_handoff', args: { different: true } }] }, { text: 'done' }, { functionCalls: [{ name: 'matter_handoff', args: {} }] }, { text: 'done again' }]
  const provider = createGeminiAgentProvider({ model: 'offline', systemInstruction: '', genai: { models: { generateContent: async () => responses.shift()! } } as any,
    mcpConnect: async () => ({ listTools: async () => [{ name: 'matter_handoff', inputSchema: {} }], callTool: async () => { throw Error('denied tool ran') }, close: async () => {} }),
    buildGate: makeGeminiToolGate({ askUser: async (_to, prompt) => { cards.push(prompt); return 'deny' }, adminFor: () => 'owner', modeFor: () => 'solo', lookupBase: () => ({ askUser: 'per-tool' }) }),
  })
  const session = await provider.spawn({ alias: 'offline', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'owner' })
  try {
    await collectTurn(session.dispatch('first')); expect(cards).toHaveLength(1)
    await collectTurn(session.dispatch('second')); expect(cards).toHaveLength(2)
  } finally { await session.close() }
})
