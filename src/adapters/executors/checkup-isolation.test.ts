import { describe, it, expect, vi } from 'vitest'
import { TIER_PROFILES } from '../../domain/user-tier'
import { collectTurn, type AgentEvent, type AgentMcpTools, type SpawnContext } from '../../ports/agent-provider'
import { createOpenAiAgentProvider } from './openai/openai-agent-provider'
import { createClaudeAgentProvider } from './claude/claude-agent-provider'
import { createGeminiAgentProvider } from './gemini/gemini-agent-provider'
import { createAgyAgentProvider } from './agy/agy-agent-provider'
import { createAcpProvider } from './acp/acp-agent-provider'
import { createCodexChatProvider } from './codex/codex-chat-provider'
import { scriptedOpenAiModel } from '../../test-support/executors/openai-scripted'
import { createScriptedClaude } from '../../test-support/executors/claude-scripted'

vi.mock('./codex/codex-cheap-model', () => ({ resolveCodexCheapModel: () => 'offline-mini' }))
const project = { alias: 'checkup', path: '/tmp/fictional-checkup-project' }
function fixture() {
  const call = vi.fn(async () => 'fictional answer')
  const tools: AgentMcpTools = { tools: [{ name: 'checkup_lookup', description: 'Fictional test tool.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }], call, close: async () => {}, serverOf: () => 'checkup' }
  const ctx: SpawnContext = { tierProfile: TIER_PROFILES.guest, permissionMode: 'strict', chatId: 'fictional-checkup', model: 'pinned-model', appendInstructions: 'Only fictional checkup data.', evaluation: { tools, mcpServer: { url: 'http://127.0.0.1:12345/mcp' }, maxSteps: 2, maxOutputTokens: 512 } }
  return { ctx, call }
}
async function events(stream: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of stream) result.push(event); return result }

describe('isolated checkup provider boundary', () => {
  it('OpenAI uses pinned model, fake tools and memory only; image markers remain plain synthetic text', async () => {
    const { ctx, call } = fixture()
    const model = scriptedOpenAiModel([{ calls: [{ name: 'checkup_lookup', input: { code: 'f17' } }] }, { text: ['o', 'k'] }])
    const realBridge = vi.fn(async () => { throw Error('production MCP must not open') })
    const realBuiltins = vi.fn(() => { throw Error('production tools must not open') })
    const realSessions = { create: vi.fn(() => { throw Error('production sessions must not open') }) } as any
    const makeChatModel = vi.fn(() => model.model)
    const provider = createOpenAiAgentProvider({ makeChatModel, makeMcpBridge: realBridge, makeBuiltins: realBuiltins, sessions: realSessions })
    const session = await provider.spawn(project, ctx)
    const output = await events(session.dispatch('Fictional [image:/must-never-be-read]'))
    expect(output.filter(e => e.kind === 'text').map(e => e.text).join('')).toBe('ok')
    expect(call).toHaveBeenCalledWith('checkup_lookup', { code: 'f17' })
    expect(makeChatModel).toHaveBeenCalledWith('pinned-model', { maxOutputTokens: 512, maxRetries: 2 })
    expect(model.tools).toEqual([['checkup_lookup'], ['checkup_lookup']])
    expect(model.seen[0]).toEqual([{ role: 'system', content: ctx.appendInstructions }, { role: 'user', content: 'Fictional [image:/must-never-be-read]' }])
    expect(realBridge).not.toHaveBeenCalled(); expect(realBuiltins).not.toHaveBeenCalled(); expect(realSessions.create).not.toHaveBeenCalled()
    await session.close()
  })

  it('OpenAI cancels the actual in-flight request', async () => {
    const { ctx, call } = fixture(), model = scriptedOpenAiModel([{ hang: true }])
    const provider = createOpenAiAgentProvider({ makeChatModel: () => model.model, makeMcpBridge: async () => { throw Error('production bridge') } })
    const session = await provider.spawn(project, ctx), pending = events(session.dispatch('fictional prompt'))
    await expect.poll(() => model.signals.length).toBe(1)
    await session.cancel?.()
    expect((await pending).filter(e => e.kind === 'error')).toEqual([expect.objectContaining({ code: 'cancelled' })])
    expect(model.signals[0]?.aborted).toBe(true); expect(call).not.toHaveBeenCalled()
    await session.close()
  })

  it('Claude bypasses production instructions, plugins and tools; partial text is emitted once', async () => {
    const { ctx } = fixture()
    const scripted = createScriptedClaude({ turns: [{ steps: [], replay: [
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'o' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'k' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', subtype: 'success', session_id: 'fictional', result: 'ok' },
    ] }] })
    let options: any
    const builder = vi.fn(() => { throw Error('production instruction builder') })
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: builder, queryImpl: ((args: any) => { options = args.options; return scripted.query(args) }) as any })
    const session = await provider.spawn(project, ctx)
    const output = await events(session.dispatch('fictional prompt'))
    expect(output.filter(e => e.kind === 'text').map(e => e.text).join('')).toBe('ok')
    expect(builder).not.toHaveBeenCalled()
    const {env,...safeOptions}=options
    expect(safeOptions).toMatchObject({ maxTurns: 2, model: 'pinned-model', tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, hooks: {}, plugins: [], settings: { disableAllHooks: true, disableSkillShellExecution: true, autoMemoryEnabled: false }, systemPrompt: ctx.appendInstructions, mcpServers: { wechat: { type: 'http', url: ctx.evaluation!.mcpServer.url } } })
    for(const [key,value] of Object.entries({CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1',CLAUDE_CODE_MAX_OUTPUT_TOKENS:'512',CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_RETRY_WATCHDOG:'0'}))expect(env[key]===value).toBe(true)
    expect(await options.canUseTool('Read', { file_path: '/must-not-read' }, {})).toMatchObject({ behavior: 'deny' })
    expect(await options.canUseTool('mcp__wechat__checkup_lookup', { code: 'f17' }, {})).toMatchObject({ behavior: 'allow' })
    await session.close()
  })

  it('Gemini replaces the real connection, gate, model and instructions with the isolated fixture', async () => {
    const { ctx, call } = fixture()
    const generateContent = vi.fn().mockResolvedValueOnce({ functionCalls: [{ name: 'checkup_lookup', args: { code: 'f17' } }] }).mockResolvedValueOnce({ text: 'ok' })
    const connect = vi.fn(async () => { throw Error('production connection') }), gate = vi.fn(() => { throw Error('production gate') })
    const provider = createGeminiAgentProvider({ genai: { models: { generateContent } }, model: 'production-model', systemInstruction: 'production memory', mcpConnect: connect, buildGate: gate })
    const session = await provider.spawn(project, ctx)
    const result = await collectTurn(session.dispatch('fictional prompt'))
    expect(result.finalText).toBe('ok'); expect(call).toHaveBeenCalledWith('checkup_lookup', { code: 'f17' })
    expect(generateContent.mock.calls[0]?.[0]).toMatchObject({ model: 'pinned-model', config: { maxOutputTokens: 512, httpOptions: { retryOptions: { attempts: 1 } }, systemInstruction: ctx.appendInstructions, tools: [{ functionDeclarations: [{ name: 'checkup_lookup' }] }] } })
    expect(connect).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled()
    await session.close()
  })

  it('all supported adapters distinguish a bounded fake-tool loop from an infrastructure failure', async () => {
    const { ctx } = fixture()
    const model = scriptedOpenAiModel(() => ({ calls: [{ name: 'checkup_lookup', input: { code: 'f17' } }] }))
    const claude = createScriptedClaude({ turns: [{ steps: [], replay: [{ type: 'result', subtype: 'error_max_turns', session_id: 'fictional', is_error: true }] }] })
    const generateContent = vi.fn(async () => ({ functionCalls: [{ name: 'checkup_lookup', args: { code: 'f17' } }] }))
    const providers = [
      createOpenAiAgentProvider({ makeChatModel: () => model.model, makeMcpBridge: async () => { throw Error('production bridge') } }),
      createClaudeAgentProvider({ sdkOptionsForProject: () => { throw Error('production builder') }, queryImpl: claude.query }),
      createGeminiAgentProvider({ genai: { models: { generateContent } }, model: 'production-model', systemInstruction: 'production memory', mcpConnect: async () => { throw Error('production MCP') }, buildGate: () => { throw Error('production gate') } }),
    ]
    for (const provider of providers) {
      const session = await provider.spawn(project, ctx)
      const output = await events(session.dispatch('fictional prompt'))
      expect(output.filter(event => event.kind === 'error')).toEqual([expect.objectContaining({ code: 'checkup_step_budget' })])
      await session.close()
    }
    expect(generateContent).toHaveBeenCalledTimes(2)
    expect(model.seen).toHaveLength(2)
  })

  it('unverified native/global tool surfaces refuse before creating a subprocess', async () => {
    const { ctx } = fixture(), spawn = vi.fn(() => { throw Error('must not spawn') })
    const providers = [
      createAgyAgentProvider({ bin: '/fictional/agy', model: 'm', log: () => {}, spawnFn: spawn }),
      createAcpProvider({ command: '/fictional/acp', args: [], displayName: 'Fixture', permissions:'mode',text:'messages', spawn: spawn as any }),
      createCodexChatProvider({ codexPathOverride: '/fictional/codex', spawnProcess: spawn as any }),
    ]
    for (const provider of providers) await expect(provider.spawn(project, ctx)).rejects.toThrow('isolated_evaluation_unavailable')
    expect(spawn).not.toHaveBeenCalled()
  })
})

it('retains observed Claude model capacity for later estimates without a metadata request',async()=>{
  const scripted=createScriptedClaude({turns:[{steps:[],replay:[{type:'result',subtype:'success',session_id:'fictional',result:'done',modelUsage:{'pinned-model':{contextWindow:65536}}} as any]}]})
  const provider=createClaudeAgentProvider({sdkOptionsForProject:()=>({}),queryImpl:scripted.query})
  const {ctx}=fixture(),session=await provider.spawn(project,ctx)
  expect(provider.contextWindowTokens?.('pinned-model')).toBeUndefined()
  await collectTurn(session.dispatch('invented'))
  expect(provider.contextWindowTokens?.('pinned-model')).toBe(65536)
  expect(provider.contextWindowTokens?.('other')).toBeUndefined()
  await session.close()
})

it('uses Gemini model metadata for estimates without sending a generation',async()=>{
  const generateContent=vi.fn(async()=>({text:'never'})),get=vi.fn(async(_request:any)=>({inputTokenLimit:1048576}))
  const provider=createGeminiAgentProvider({genai:{models:{generateContent,get}},model:'m',systemInstruction:'production',mcpConnect:async()=>{throw Error('no tools')},buildGate:()=>async()=>({allow:true})})
  await provider.prepareContextWindow?.('m')
  expect(provider.contextWindowTokens?.('m')).toBe(1048576)
  expect(provider.contextWindowTokens?.('other')).toBeUndefined()
  expect(generateContent).not.toHaveBeenCalled()
  expect(get.mock.calls[0]?.[0]).toMatchObject({model:'m',config:{httpOptions:{retryOptions:{attempts:1}}}})
})
