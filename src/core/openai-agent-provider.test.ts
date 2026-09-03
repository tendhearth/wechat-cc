import { describe, it, expect } from 'vitest'
import { OPENAI_CAPABILITIES, mapDeltaToEvent, createOpenAiAgentProvider } from './openai-agent-provider'
import { collectTurn } from './agent-provider'
import type { AgentEvent } from './agent-provider'
import type { ChatModelClient, ToolSpec } from './openai-chat-model'
import type { McpToolBridge } from './openai-mcp-bridge'
import { TIER_PROFILES } from './user-tier'

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

  it('cancel() at a step boundary stops the loop with a cancelled error + result, no further streamTurn calls', async () => {
    // Two-round-capable model (always asks to call `reply`, same shape as
    // the step_budget fake above) — proves cancel() cuts the loop short at
    // the boundary check after round 1's tool execution, rather than
    // letting it run to maxSteps.
    let streamTurnCalls = 0
    const alwaysToolCall: ChatModelClient = {
      streamTurn(_messages, _tools) {
        streamTurnCalls++
        const id = `c${streamTurnCalls}`
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
    const iterator = session.dispatch('go')[Symbol.asyncIterator]()

    // Consume round 1's events: init (first dispatch on a fresh session),
    // then the tool_call delta event.
    let step = await iterator.next()
    expect(step.value).toMatchObject({ kind: 'init' })
    step = await iterator.next()
    expect(step.value).toMatchObject({ kind: 'tool_call', tool: 'reply' })

    // Cancel here — the generator is paused right after yielding round 1's
    // tool_call delta, before round 1's tool has even executed. Draining
    // continues from here.
    await session.cancel!()

    const events: AgentEvent[] = []
    step = await iterator.next()
    while (!step.done) {
      events.push(step.value)
      step = await iterator.next()
    }

    const errorEvents = events.filter((e) => e.kind === 'error')
    const resultEvents = events.filter((e) => e.kind === 'result')
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0]).toMatchObject({ kind: 'error', code: 'cancelled' })
    expect(resultEvents).toHaveLength(1)
    expect(events.indexOf(errorEvents[0]!)).toBeLessThan(events.indexOf(resultEvents[0]!))
    // Round 1's tool DID execute (the abort check comes after tool exec, not before).
    expect(calls).toEqual(['reply'])
    // No round 2 — the boundary check after round 1's tool exec caught the cancel.
    expect(streamTurnCalls).toBe(1)
    await session.close()
  })

  it('cancel() called between dispatch() returning and the first .next() still reaches the turn (Important 3 regression)', async () => {
    // Regression: the AbortController used to be constructed INSIDE the
    // generator body, which doesn't run until the caller's first .next() —
    // a cancel() landing before that point would be silently lost. Never
    // calling iterator.next() before cancel() proves the controller is now
    // live the instant dispatch() returns.
    let streamTurnCalls = 0
    const alwaysToolCall: ChatModelClient = {
      streamTurn(_messages, _tools) {
        streamTurnCalls++
        const id = `c${streamTurnCalls}`
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
    const provider = createOpenAiAgentProvider({
      makeChatModel: () => alwaysToolCall,
      makeMcpBridge: async () => fakeBridge([]),
    })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)

    const iterable = session.dispatch('go')
    // No iteration at all yet — cancel() immediately.
    await session.cancel!()

    const events: AgentEvent[] = []
    for await (const ev of iterable) events.push(ev)

    // The very first boundary check (top of round 1, before any streamTurn
    // call) must already see the abort.
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'cancelled' }))
    expect(events.some((e) => e.kind === 'result')).toBe(true)
    expect(streamTurnCalls).toBe(0)
    await session.close()
  })

  it('cancel() with no dispatch in flight is a safe no-op', async () => {
    const provider = createOpenAiAgentProvider({
      makeChatModel: () => scriptedModel(),
      makeMcpBridge: async () => fakeBridge([]),
    })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    await expect(session.cancel!()).resolves.toBeUndefined()
    await session.close()
  })

  it('classifies a thrown streamTurn auth error as an error event instead of propagating (D4/B3)', async () => {
    // A ChatModelClient whose streamTurn throws synchronously — previously
    // this would propagate out of the dispatch() async generator uncaught;
    // now the loop's try/catch + TurnEmitter.error() classify it via
    // isAuthFail('sdk-error', …) into a terminal error event.
    const authThrowModel: ChatModelClient = {
      streamTurn() { throw new Error('401 unauthorized') },
      async generate() { return 'ok' },
      userMessage: (t) => ({ role: 'user', content: t } as any),
      systemMessage: (t) => ({ role: 'system', content: t } as any),
      toolResultMessage: (id, name, r) => ({ role: 'tool', content: `${name}:${JSON.stringify(r)}` } as any),
    }
    const provider = createOpenAiAgentProvider({
      makeChatModel: () => authThrowModel,
      makeMcpBridge: async () => fakeBridge([]),
    })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const events: AgentEvent[] = []
    for await (const ev of session.dispatch('hi')) events.push(ev)

    expect(events[events.length - 1]).toMatchObject({ kind: 'error', code: 'auth_failed' })
    // no result event follows an unrecovered throw
    expect(events.some((e) => e.kind === 'result')).toBe(false)
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

  it('cheapEval classifies a thrown 401 (real gateway auth error, no longer masked by NoOutputGeneratedError) as auth_failed', async () => {
    // Post-fix, openai-chat-model's generate() surfaces the real transport
    // error instead of swallowing it — this proves the eval-path caller
    // catches that thrown error and re-wraps it into the same
    // `auth_failed: …` contract assertNotAuthFailed uses for error-shaped
    // TEXT, so downstream consumers (wrapCheapEvalWithAuthFailCheck,
    // gardener.ts) don't need to know which shape the failure took.
    const authThrowModel: ChatModelClient = {
      streamTurn() { throw new Error('not used in this test') },
      async generate() { throw Object.assign(new Error('Authentication Error'), { statusCode: 401 }) },
      userMessage: (t) => ({ role: 'user', content: t } as any),
      systemMessage: (t) => ({ role: 'system', content: t } as any),
      toolResultMessage: (id, name, r) => ({ role: 'tool', content: `${name}:${JSON.stringify(r)}` } as any),
    }
    const provider = createOpenAiAgentProvider({ makeChatModel: () => authThrowModel, makeMcpBridge: async () => fakeBridge([]) })
    await expect(provider.cheapEval!('ping')).rejects.toThrow(/^auth_failed:/)
  })

  it('strongEval classifies a thrown 401 as auth_failed', async () => {
    const authThrowModel: ChatModelClient = {
      streamTurn() { throw new Error('not used in this test') },
      async generate() { throw Object.assign(new Error('Authentication Error'), { statusCode: 401 }) },
      userMessage: (t) => ({ role: 'user', content: t } as any),
      systemMessage: (t) => ({ role: 'system', content: t } as any),
      toolResultMessage: (id, name, r) => ({ role: 'tool', content: `${name}:${JSON.stringify(r)}` } as any),
    }
    const provider = createOpenAiAgentProvider({ makeChatModel: () => authThrowModel, makeMcpBridge: async () => fakeBridge([]) })
    await expect(provider.strongEval!('ping')).rejects.toThrow(/^auth_failed:/)
  })

  it('cheapEval passes through a non-auth thrown error unchanged (no false auth_failed classification)', async () => {
    const networkFailModel: ChatModelClient = {
      streamTurn() { throw new Error('not used in this test') },
      async generate() { throw new Error('ECONNRESET: socket hang up') },
      userMessage: (t) => ({ role: 'user', content: t } as any),
      systemMessage: (t) => ({ role: 'system', content: t } as any),
      toolResultMessage: (id, name, r) => ({ role: 'tool', content: `${name}:${JSON.stringify(r)}` } as any),
    }
    const provider = createOpenAiAgentProvider({ makeChatModel: () => networkFailModel, makeMcpBridge: async () => fakeBridge([]) })
    await expect(provider.cheapEval!('ping')).rejects.toThrow('ECONNRESET: socket hang up')
    await expect(provider.cheapEval!('ping')).rejects.not.toThrow(/auth_failed/)
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

// 2026-09-02 真机。owner 在微信里派活给那台跑 Kimi 的手,拿回来的是碎的:
//
//   已 读取  `C:\ Users\030103 49\wcc \ package.json`， 内容如下 ：
//
// 根因:**`assistantText: string[]` 的含义因 provider 而异**。claude/codex
// 一条完整消息一个 text 事件;agy 的解析器按 step 聚合;cursor 按 block 聚合;
// **只有这个 provider 把原始流式 delta 逐个当事件抛出来**。而每个消费者都
// 按「一条消息一项」用 `join('\n')` 拼 —— 于是每个 token 之间多一个换行。
//
// 之前没人发现,是因为正常聊天里 agent 走 reply 工具,assistantText 根本不用。
// 只有**回落路径**才拼:chatroom 的每一拍、parallel、以及派活的 exec 返回 ——
// 而这三条今天刚好全都变成了主路径。
describe('openai provider —— 流式 delta 必须聚合成完整消息再发', () => {
  function modelEmitting(chunks: string[], withTool = false) {
    let first = true
    return {
      streamTurn(_m: unknown, _t: unknown) {
        const isFirst = first; first = false
        async function* deltas() {
          if (isFirst && withTool) {
            yield { kind: 'text' as const, text: '先说一句' }
            yield { kind: 'tool_call' as const, id: 'c1', name: 'Read', input: {} }
            return
          }
          for (const c of chunks) yield { kind: 'text' as const, text: c }
        }
        return {
          deltas: deltas(),
          finished: Promise.resolve({
            messages: [{ role: 'assistant', content: '' }] as never,
            toolCalls: isFirst && withTool ? [{ id: 'c1', name: 'Read', input: {} }] : [],
          }),
        }
      },
      async generate() { return 'ok' },
      userMessage: (t: string) => ({ role: 'user', content: t } as never),
      systemMessage: (t: string) => ({ role: 'system', content: t } as never),
      toolResultMessage: (id: string, r: string) => ({ role: 'tool', tool_call_id: id, content: r } as never),
    }
  }

  it('一步里的所有 delta 聚合成 ONE text 事件(此前是每个 token 一个)', async () => {
    const provider = createOpenAiAgentProvider({
      makeChatModel: () => modelEmitting(['claude-', 'channel-', 'wechat', ' 0.6.4']) as never,
      makeMcpBridge: async () => ({ tools: [], serverOf: () => undefined, call: async () => '' }) as never,
    })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, { chatId: 'c', tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict' })
    const texts: string[] = []
    for await (const ev of session.dispatch('x')) if (ev.kind === 'text') texts.push(ev.text)
    expect(texts).toEqual(['claude-channel-wechat 0.6.4'])
    // 这才是关键:消费者按「一条消息一项」拼,拼出来必须干净
    expect(texts.join('\n').trim()).toBe('claude-channel-wechat 0.6.4')
  })

  it('工具调用之前先把已攒的文本吐出来,保持事件顺序', async () => {
    const provider = createOpenAiAgentProvider({
      makeChatModel: () => modelEmitting(['后', '半', '段'], true) as never,
      makeMcpBridge: async () => ({ tools: [], serverOf: () => undefined, call: async () => 'r' }) as never,
    })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, { chatId: 'c', tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict' })
    const kinds: string[] = []
    const texts: string[] = []
    for await (const ev of session.dispatch('x')) {
      if (ev.kind === 'text') { kinds.push('text'); texts.push(ev.text) }
      else if (ev.kind === 'tool_call') kinds.push('tool')
    }
    expect(kinds.slice(0, 2)).toEqual(['text', 'tool'])   // 文本先于工具
    expect(texts[0]).toBe('先说一句')
    expect(texts[1]).toBe('后半段')                        // 第二步也聚合
  })
})
