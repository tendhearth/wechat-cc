import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { removeTempDir } from '../../../lib/test-temp'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPENAI_CAPABILITIES, createOpenAiAgentProvider } from './openai-agent-provider'
import { collectTurn } from '../../../ports/agent-provider'
import type { AgentEvent } from '../../../ports/agent-provider'
import { TIER_PROFILES } from '../../../domain/user-tier'
import { openDb, type Db } from '../../../lib/db'
import { makeChatSessionStore, openAiConnectionHash, CHAT_RESUME_MAX_BYTES } from './api-sessions'
import { trimDanglingToolCalls } from './openai-session'
import { scriptedOpenAiModel, scriptedMcpTools, type OpenAiScriptedStep } from '../../../test-support/executors/openai-scripted'

const guestSpawn = {
  tierProfile: { allow: new Set(['reply']), relay: new Set(), deny: new Set() } as any,
  permissionMode: 'strict' as const,
  chatId: 'c',
}
const replyBridge = () => scriptedMcpTools({ tools: [{ name: 'reply', server: 'wechat' }] })
const drain = async (it: AsyncIterable<AgentEvent>) => { const out: AgentEvent[] = []; for await (const e of it) out.push(e); return out }

const dirs: string[] = []
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d }
// Windows:库文件还开着就删目录会 EBUSY —— 先关(下面那组的 afterEach),再用 removeTempDir(win32 上会重试)
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d) })

describe('openai provider loop(对话这一份用途)', () => {
  it('view_image:工具结果是文字,图另起一条用户消息紧跟其后再进下一轮', async () => {
    const dir = tmp('oai-view-')
    const png = new Uint8Array(33); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); const dv = new DataView(png.buffer)
    dv.setUint32(8, 13); png.set([0x49, 0x48, 0x44, 0x52], 12); dv.setUint32(16, 8); dv.setUint32(20, 8)
    writeFileSync(join(dir, 'shot.png'), png)
    const m = scriptedOpenAiModel([{ calls: [{ id: 'v1', name: 'view_image', input: { path: 'shot.png' } }] }, { text: '看到了' }])
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge })
    const session = await provider.spawn({ alias: 'a', path: dir }, { ...guestSpawn, tierProfile: { allow: new Set(['reply', 'fs_read']), relay: new Set(), deny: new Set() } } as any)
    const summary = await collectTurn(session.dispatch('看看 shot.png'))
    expect(summary.assistantText.join('')).toContain('看到了')
    const second = m.seen[1]!
    const toolIdx = second.findIndex((x: any) => x.role === 'tool' && JSON.stringify(x.content).includes('Loaded image'))
    expect(toolIdx).toBeGreaterThan(0)
    expect(second[toolIdx + 1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: '[view_image 的结果]' }, { type: 'image', mediaType: 'image/png' }] })
    expect((second[toolIdx + 1] as any).content[1].image).toMatch(/^data:image\/png;base64,/)
    await session.close()
  })

  it('dispatch 文本里的 [image:path] 会读成图块(data URL)随用户消息送(openai-vision)', async () => {
    const dir = tmp('oai-vision-')
    const img = join(dir, 'poster.png')
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const m = scriptedOpenAiModel([{ text: 'ok' }])
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    await collectTurn(session.dispatch(`帮我做成 html [image:${img}] 海报`))
    const user = m.seen[0]!.at(-1) as any
    expect(user.content[0].text).toContain('[image:')
    expect(user.content).toHaveLength(2)
    expect(user.content[1]).toEqual({ type: 'image', image: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`, mediaType: 'image/png' })
    await session.close()
  })

  it('runs the tool loop: executes reply, then produces final text', async () => {
    const tools = replyBridge()
    const m = scriptedOpenAiModel([{ calls: [{ name: 'reply', input: { text: 'hi' } }] }, { text: 'done' }])
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => tools.bridge })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const summary = await collectTurn(session.dispatch('hi'))
    expect(tools.calls.map(c => c.name)).toEqual(['reply'])
    expect(summary.replyToolCalled).toBe(true)
    expect(summary.assistantText.join('')).toContain('done')
    await session.close()
    expect(tools.closed()).toBe(1)
  })

  it('terminates with a step_budget error + exactly one result event once the loop exceeds DEFAULT_MAX_STEPS (25)', async () => {
    const tools = replyBridge()
    const m = scriptedOpenAiModel(() => ({ calls: [{ name: 'reply', input: { text: 'hi' } }] }))
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => tools.bridge })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const events = await drain(session.dispatch('go'))
    const errorEvents = events.filter((e) => e.kind === 'error')
    const resultEvents = events.filter((e) => e.kind === 'result')
    expect(errorEvents).toEqual([expect.objectContaining({ kind: 'error', code: 'step_budget', message: 'step budget 25 exhausted' })])
    expect(resultEvents).toHaveLength(1)
    expect(resultEvents[0]).toMatchObject({ numTurns: 25 })
    expect(events.indexOf(errorEvents[0]!)).toBeLessThan(events.indexOf(resultEvents[0]!))
    expect(tools.calls.length).toBe(25)
    await session.close()
  })

  it('cancel() while the model is still answering: the request is aborted, no tool runs, cancelled error + result', async () => {
    const tools = replyBridge()
    let session: any
    const m = scriptedOpenAiModel((_msgs, n) => {
      if (n === 1) queueMicrotask(() => { void session.cancel() })
      return { text: ['半', '句'], calls: [{ name: 'reply' }] }
    })
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => tools.bridge })
    session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const events = await drain(session.dispatch('go'))
    expect(m.signals[0]!.aborted).toBe(true)
    expect(tools.calls).toEqual([])
    expect(m.seen).toHaveLength(1)
    expect(events.filter(e => e.kind === 'error')).toEqual([expect.objectContaining({ code: 'cancelled' })])
    expect(events.at(-1)).toMatchObject({ kind: 'result' })
    await session.close()
  })

  it('/stop 掐断一直不说完的请求(以前要等这一步自己说完)', async () => {
    const m = scriptedOpenAiModel([{ hang: true }])
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const work = drain(session.dispatch('go'))
    await expect.poll(() => m.signals.length).toBe(1)
    await session.cancel!()
    const events = await work
    expect(m.signals[0]!.aborted).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'cancelled' }))
    expect(events.at(-1)).toMatchObject({ kind: 'result' })
    await session.close()
  })

  it('cancel() during a multi-tool batch skips the remaining tool calls but still answers every call id', async () => {
    let session: any
    const tools = scriptedMcpTools({ tools: [{ name: 'reply' }], call: async () => { await session.cancel(); return 'ok' } })
    const m = scriptedOpenAiModel([
      { calls: [{ id: 'c1', name: 'reply', input: { text: 'a' } }, { id: 'c2', name: 'reply', input: { text: 'b' } }, { id: 'c3', name: 'reply', input: { text: 'c' } }] },
      { text: 'again' },
    ])
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => tools.bridge })
    session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const events = await drain(session.dispatch('go'))
    expect(tools.calls).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'cancelled' }))
    await drain(session.dispatch('again'))
    const results = m.seen[1]!.filter((x: any) => x.role === 'tool').map((x: any) => x.content[0].toolCallId)
    expect(results).toEqual(['c1', 'c2', 'c3'])
    expect(JSON.stringify(m.seen[1])).toContain('Cancelled: the user stopped this turn')
    await session.close()
  })

  it('cancel() called between dispatch() returning and the first .next() still reaches the turn', async () => {
    const m = scriptedOpenAiModel(() => ({ calls: [{ name: 'reply' }] }))
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const iterable = session.dispatch('go')
    await session.cancel!()
    const events = await drain(iterable)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'cancelled' }))
    expect(events.some((e) => e.kind === 'result')).toBe(true)
    expect(m.seen).toHaveLength(0)
    await session.close()
  })

  it('cancel() with no dispatch in flight is a safe no-op', async () => {
    const provider = createOpenAiAgentProvider({ makeChatModel: () => scriptedOpenAiModel([]).model, makeMcpBridge: async () => replyBridge().bridge })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    await expect(session.cancel!()).resolves.toBeUndefined()
    await session.close()
  })

  it('classifies a thrown auth error as an error event (auth_failed) instead of propagating; no result follows', async () => {
    const m = scriptedOpenAiModel([{ fail: new Error('401 unauthorized') }])
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const events = await drain(session.dispatch('hi'))
    expect(events[events.length - 1]).toMatchObject({ kind: 'error', code: 'auth_failed' })
    expect(events.some((e) => e.kind === 'result')).toBe(false)
    await session.close()
  })

  it('a failed turn leaves the history usable: the next turn carries the earlier tool call and its result', async () => {
    const m = scriptedOpenAiModel([{ calls: [{ id: 'r1', name: 'reply' }] }, { fail: Object.assign(new Error('Too Many Requests'), { statusCode: 429 }) }, { text: 'back' }])
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    expect((await drain(session.dispatch('one'))).at(-1)).toMatchObject({ kind: 'error', code: 'rate_limited' })
    expect((await collectTurn(session.dispatch('two'))).finalText).toBe('back')
    const roles = m.seen[2]!.map((x: any) => x.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'user'])
    await session.close()
  })

  it('reports the usage the endpoint returned (summed over steps) on the result', async () => {
    const m = scriptedOpenAiModel([{ calls: [{ name: 'reply' }], usage: { input: 10, output: 2 } }, { text: 'ok', usage: { input: 20, output: 3 } }])
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const events = await drain(session.dispatch('go'))
    expect(events.find(e => e.kind === 'result')).toMatchObject({ numTurns: 2, usage: { input: 30, output: 5 } })
    await session.close()
  })

  it('cheapEval returns text on success (happy path)', async () => {
    const m = scriptedOpenAiModel([], { generate: () => 'ok' })
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge })
    expect(await provider.cheapEval!('ping')).toBe('ok')
    expect(m.prompts[0]).toEqual([{ role: 'user', content: 'ping' }])
  })

  it.each([['cheapEval', 'Please run /login to continue.'], ['strongEval', 'Not logged in.']] as const)('%s rejects when the model output matches the auth-failure sentinel', async (kind, text) => {
    const provider = createOpenAiAgentProvider({ makeChatModel: () => scriptedOpenAiModel([], { generate: () => text }).model, makeMcpBridge: async () => replyBridge().bridge })
    await expect(provider[kind]!('ping')).rejects.toThrow(/auth_failed/)
  })

  it.each(['cheapEval', 'strongEval'] as const)('%s rethrows a thrown 401 with code auth_rejected, status and message intact', async (kind) => {
    const provider = createOpenAiAgentProvider({ makeChatModel: () => scriptedOpenAiModel([], { generate: () => { throw Object.assign(new Error('Authentication Error'), { statusCode: 401 }) } }).model, makeMcpBridge: async () => replyBridge().bridge })
    const err = await provider[kind]!('ping').catch(e => e)
    expect(err).toMatchObject({ message: 'Authentication Error', statusCode: 401, providerErrorCode: 'auth_rejected' })
  })

  it('cheapEval passes through a non-auth thrown error unchanged (no false auth_failed classification)', async () => {
    const provider = createOpenAiAgentProvider({ makeChatModel: () => scriptedOpenAiModel([], { generate: () => { throw new Error('ECONNRESET: socket hang up') } }).model, makeMcpBridge: async () => replyBridge().bridge })
    await expect(provider.cheapEval!('ping')).rejects.toThrow('ECONNRESET: socket hang up')
    await expect(provider.cheapEval!('ping')).rejects.not.toThrow(/auth_failed/)
  })

  it('spawn builds its model from ctx.model (per-chat pinned model); cheapEval always uses the default (undefined)', async () => {
    const calledWith: Array<string | undefined> = []
    const makeChatModel = (model?: string) => { calledWith.push(model); return scriptedOpenAiModel([{ text: 'x' }], { generate: () => 'ok' }).model }
    const provider = createOpenAiAgentProvider({ makeChatModel, makeMcpBridge: async () => replyBridge().bridge })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, { ...guestSpawn, model: 'deepseek-x' } as any)
    await collectTurn(session.dispatch('hi'))
    await session.close()
    expect(calledWith).toEqual(['deepseek-x'])
    await provider.cheapEval!('ping')
    expect(calledWith).toEqual(['deepseek-x', undefined])
  })

  it('evalModel(现取):后台评估 / 它的闸门目标走它;没设 ⇒ 默认模型;对话不受影响', async () => {
    let evalModel: string | undefined = 'DeepSeek'
    const calledWith: Array<string | undefined> = []
    const makeChatModel = (model?: string) => { calledWith.push(model); return scriptedOpenAiModel([{ text: 'x' }], { generate: () => 'ok' }).model }
    const provider = createOpenAiAgentProvider({ makeChatModel, evalModel: () => evalModel, endpoint: { baseUrl: 'https://gw/v1', model: 'Qwen3.8' }, makeMcpBridge: async () => replyBridge().bridge })
    await provider.cheapEval!('ping')
    await provider.strongEval!('ping')
    expect(provider.callTarget!('cheapEval')).toMatchObject({ model: 'DeepSeek' })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    await collectTurn(session.dispatch('hi'))
    await session.close()
    expect(provider.callTarget!('spawn')).toMatchObject({ model: 'Qwen3.8' })
    evalModel = undefined
    await provider.cheapEval!('ping')
    expect(calledWith).toEqual(['DeepSeek', 'DeepSeek', undefined, undefined])
    expect(provider.callTarget!('cheapEval')).toMatchObject({ model: 'Qwen3.8' })
  })

  it('a tool the model invented (not on any surface) gets an error result instead of crashing the loop', async () => {
    const m = scriptedOpenAiModel([{ calls: [{ name: 'Shell', input: { command: 'touch x' } }] }, { text: 'sorry' }])
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'dangerously', chatId: 'c' })
    expect((await collectTurn(session.dispatch('go'))).finalText).toBe('sorry')
    expect(JSON.stringify(m.seen[1])).toContain('there is no tool named \\"Shell\\"')
    await session.close()
  })
})

describe('openai capabilities', () => {
  it('declares perToolCallback true, empty sandbox; supportsResume stays false (sessions report resumedHistory themselves)', () => {
    expect(OPENAI_CAPABILITIES.perToolCallback).toBe(true)
    expect(OPENAI_CAPABILITIES.sandboxLevels.size).toBe(0)
    expect(OPENAI_CAPABILITIES.supportsResume).toBe(false)
  })
})

// 2026-09-02 真机:每个流式 delta 曾各是一个 text 事件,消费者按「一条消息一项」用 '\n' 拼 ⇒ 每个 token 之间多一个换行。
// AgentEvent{kind:'text'} 的契约是一条完整消息 —— 对话这一份用途一步只发一个 text 事件。
describe('openai provider —— 流式 delta 必须聚合成完整消息再发', () => {
  const run = async (script: OpenAiScriptedStep[]) => {
    const provider = createOpenAiAgentProvider({ makeChatModel: () => scriptedOpenAiModel(script).model, makeMcpBridge: async () => scriptedMcpTools().bridge })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, { chatId: 'c', tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict' })
    const events = await drain(session.dispatch('x'))
    await session.close()
    return events
  }

  it('一步里的所有 delta 聚合成 ONE text 事件', async () => {
    const texts = (await run([{ text: ['claude-', 'channel-', 'wechat', ' 0.6.4'] }])).filter(e => e.kind === 'text').map(e => (e as { text: string }).text)
    expect(texts).toEqual(['claude-channel-wechat 0.6.4'])
    expect(texts.join('\n').trim()).toBe('claude-channel-wechat 0.6.4')
  })

  it('工具调用之前先把已攒的文本吐出来,保持事件顺序', async () => {
    const events = await run([{ text: '先说一句', calls: [{ name: 'Read', input: { path: '/nonexistent' } }] }, { text: ['后', '半', '段'] }])
    const kinds = events.filter(e => e.kind === 'text' || e.kind === 'tool_call').map(e => e.kind)
    const texts = events.filter(e => e.kind === 'text').map(e => (e as { text: string }).text)
    expect(kinds).toEqual(['text', 'tool_call', 'text'])
    expect(texts).toEqual(['先说一句', '后半段'])
    expect(events.find(e => e.kind === 'tool_call')).toEqual({ kind: 'tool_call', tool: 'Read' })
  })
})

describe('openai provider — makeBuiltins 注入口(实验 / 测试专用)', () => {
  it('给了 makeBuiltins ⇒ 内置工具换成注入的(模型调 Bash 只记账,不真跑)', async () => {
    const dir = tmp('oai-builtins-')
    const sentinel = join(dir, 'ran')
    const command = `touch ${JSON.stringify(sentinel)}`
    const ran: string[] = []
    const m = scriptedOpenAiModel([{ calls: [{ id: 'b1', name: 'Bash', input: { command } }] }, { text: '好了' }])
    const provider = createOpenAiAgentProvider({
      makeChatModel: () => m.model,
      makeMcpBridge: async () => replyBridge().bridge,
      makeBuiltins: () => [{
        spec: { name: 'Bash', description: 'fake', parameters: { type: 'object' } },
        risk: 'caution',
        async execute(input) { ran.push(String((input as any).command)); return '(实验:未执行)' },
      }],
      cwd: dir,
    })
    const session = await provider.spawn({ alias: 'a', path: dir }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'dangerously', chatId: 'c' } as any)
    const summary = await collectTurn(session.dispatch('跑一下'))
    expect(m.tools[0]).toContain('Bash')
    expect(ran).toEqual([command])
    expect(existsSync(sentinel)).toBe(false)
    expect(summary.finalText).toBe('好了')
    await session.close()
  })
})

// B2(2026-10-25):对话的历史存进 api-sessions,daemon 重启 / 会话释放后接得上(以前只在内存里)。
describe('openai 对话 —— 会话历史存进 api-sessions、能续接', () => {
  // 一个测试里可能 setup 不止一次:每个打开过的库都要关,不然 Windows 删不掉目录(10-25 CI EBUSY)
  const opened: Db[] = []
  let db: Db
  afterEach(() => { for (const d of opened.splice(0)) d.close() })
  const setup = () => {
    const root = tmp('oai-chat-db-')
    db = openDb({ path: join(root, 'state.db') })
    opened.push(db)
    const sessions = makeChatSessionStore(db)
    const connectionHash = openAiConnectionHash({ baseURL: 'https://gateway.example/v1', apiKey: 'k' })
    return { sessions, connectionHash }
  }
  const spawnCtx = (extra: Record<string, unknown> = {}) => ({ tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict' as const, chatId: 'owner', appendInstructions: 'old rules', ...extra })

  it('关掉再起(带 resumeSessionId)⇒ 接着上一次的历史,系统提示换成这一次的;报 resumedHistory', async () => {
    const store = setup()
    const m = scriptedOpenAiModel([{ calls: [{ id: 'r1', name: 'reply' }] }, { text: 'one' }, { text: 'two' }])
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge, ...store })
    const s1 = await provider.spawn({ alias: 'a', path: '/proj' }, spawnCtx())
    expect(s1.resumedHistory).toBe(false)
    const events = await drain(s1.dispatch('first'))
    const id = (events.find(e => e.kind === 'init') as { sessionId: string }).sessionId
    await s1.close()
    expect(provider.canResume('/proj', id)).toBe(true)
    expect(provider.canResume('/elsewhere', id)).toBe(false)

    const s2 = await provider.spawn({ alias: 'a', path: '/proj' }, spawnCtx({ resumeSessionId: id, appendInstructions: 'new rules' }))
    expect(s2.resumedHistory).toBe(true)
    const again = await drain(s2.dispatch('second'))
    expect(again.find(e => e.kind === 'init')).toEqual({ kind: 'init', sessionId: id })
    expect(m.seen[2]!.map(x => x.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user'])
    expect(m.seen[2]![0]).toEqual({ role: 'system', content: 'new rules' })
    await s2.close()
  })

  it('续不上(别的对话 / 换了连接)⇒ 开新会话,这一轮照常;resumedHistory=false(协调器照旧补近况块)', async () => {
    const store = setup()
    const m = scriptedOpenAiModel(() => ({ text: 'ok' }))
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge, ...store })
    const s1 = await provider.spawn({ alias: 'a', path: '/proj' }, spawnCtx())
    const id = ((await drain(s1.dispatch('first'))).find(e => e.kind === 'init') as { sessionId: string }).sessionId
    await s1.close()
    const s2 = await provider.spawn({ alias: 'a', path: '/proj' }, spawnCtx({ resumeSessionId: id, chatId: 'someone-else' }))
    expect(s2.resumedHistory).toBe(false)
    expect((await collectTurn(s2.dispatch('hi'))).finalText).toBe('ok')
    expect(m.seen[1]!.map(x => x.role)).toEqual(['system', 'user'])
    await s2.close()
    const other = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge, sessions: store.sessions, connectionHash: openAiConnectionHash({ baseURL: 'https://gateway.example/v1', apiKey: 'another-key' }) })
    expect(other.canResume('/proj', id)).toBe(false)
  })

  it('存档里不留图;历史太长就不续接(没有自动压缩,无限续下去会撑爆上下文)', async () => {
    const store = setup()
    const dir = tmp('oai-chat-img-')
    const img = join(dir, 'p.png'); writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const m = scriptedOpenAiModel(() => ({ text: 'ok' }))
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge, ...store })
    const s1 = await provider.spawn({ alias: 'a', path: '/proj' }, spawnCtx())
    const id = ((await drain(s1.dispatch(`看图 [image:${img}]`))).find(e => e.kind === 'init') as { sessionId: string }).sessionId
    await s1.close()
    const row = store.sessions.get(id)!
    expect(JSON.stringify(row.messages)).not.toContain('data:image')
    expect(JSON.stringify(row.messages)).toContain('存档里不留')
    expect(provider.canResume('/proj', id)).toBe(true)
    const s2 = await provider.spawn({ alias: 'a', path: '/proj' }, spawnCtx({ resumeSessionId: id }))
    await drain(s2.dispatch('x'.repeat(CHAT_RESUME_MAX_BYTES)))
    await s2.close()
    expect(provider.canResume('/proj', id)).toBe(false)
  })

  it('每轮做完就记成 ready:daemon 在两轮之间被杀掉也续得上;一轮当中被杀掉的(active)不续', async () => {
    const store = setup()
    const m = scriptedOpenAiModel([{ text: 'ok' }, { hang: true }])
    const provider = createOpenAiAgentProvider({ makeChatModel: () => m.model, makeMcpBridge: async () => replyBridge().bridge, ...store })
    const s1 = await provider.spawn({ alias: 'a', path: '/proj' }, spawnCtx())
    const id = ((await drain(s1.dispatch('first'))).find(e => e.kind === 'init') as { sessionId: string }).sessionId
    expect(store.sessions.get(id)!.state).toBe('ready')
    expect(provider.canResume('/proj', id)).toBe(true)
    const work = drain(s1.dispatch('second'))
    await expect.poll(() => m.signals.length).toBe(2)
    expect(store.sessions.get(id)!.state).toBe('active')
    expect(provider.canResume('/proj', id)).toBe(false)
    await s1.close()
    await work
  })
})

describe('trimDanglingToolCalls', () => {
  it('drops a trailing assistant tool call whose results never came back; keeps complete history', () => {
    const call = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 't', input: {} }, { type: 'tool-call', toolCallId: 'b', toolName: 't', input: {} }] } as any
    const result = (id: string) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 't', output: { type: 'text', value: '' } }] }) as any
    const user = { role: 'user', content: 'hi' } as any
    expect(trimDanglingToolCalls([user, call, result('a')])).toEqual([user])
    expect(trimDanglingToolCalls([user, call, result('a'), result('b')])).toHaveLength(4)
    expect(trimDanglingToolCalls([user])).toEqual([user])
  })
})
