import { describe, it, expect, vi } from 'vitest'
import { createClaudeAgentProvider, makeWorkbenchClaudeCanUseTool, tierProfileToClaudeSdkOpts } from './claude-agent-provider'
import type { AgentEvent } from './agent-provider'
import { TIER_PROFILES } from './user-tier'

// Helper: drain an async iterable into an array for assertion.
async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

// We monkeypatch @anthropic-ai/claude-agent-sdk's `query` so the test
// doesn't actually spawn `claude`. The harness controls the message
// stream the provider sees and asserts that dispatch() yields events
// in the correct sequence.

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const sentMessages: unknown[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let yieldFn: ((msg: any) => void) | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let endFn: (() => void) | null = null
  let interruptCount = 0
  let interruptFailureMode: 'none' | 'throw' | 'reject' = 'none'

  function makeStream() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer: any[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolvers: ((v: IteratorResult<any>) => void)[] = []
    let closed = false
    yieldFn = (msg) => {
      const r = resolvers.shift()
      if (r) r({ value: msg, done: false })
      else buffer.push(msg)
    }
    endFn = () => {
      closed = true
      const r = resolvers.shift()
      if (r) r({ value: undefined, done: true })
    }
    // Return an object that both implements AsyncIterable AND carries an
    // `interrupt` method — mirrors the shape of @anthropic-ai/claude-agent-sdk's
    // `query()` return value (Query is a Promise + AsyncIterable with helpers).
    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (buffer.length > 0) return Promise.resolve({ value: buffer.shift(), done: false })
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise<IteratorResult<unknown>>(res => resolvers.push(res))
          },
        }
      },
      interrupt() {
        interruptCount++
        if (interruptFailureMode === 'throw') {
          throw new Error('ProcessTransport is not ready for writing')
        }
        if (interruptFailureMode === 'reject') {
          return Promise.reject(new Error('ProcessTransport is not ready for writing'))
        }
      },
    }
  }

  let lastQueryOptions: unknown = undefined
  return {
    query: ({ prompt, options }: { prompt: AsyncIterable<unknown> | string; options?: unknown }) => {
      lastQueryOptions = options
      // cheapEval passes prompt as a string, not an iterable; only iterate
      // when it actually has Symbol.asyncIterator.
      if (typeof prompt !== 'string' && (prompt as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]) {
        ;(async () => {
          for await (const m of prompt as AsyncIterable<unknown>) sentMessages.push(m)
        })()
      }
      return makeStream()
    },
    __test_yield: (msg: unknown) => yieldFn?.(msg),
    __test_end: () => endFn?.(),
    __test_last_options: () => lastQueryOptions,
    __test_sent: () => sentMessages,
    __test_interrupt_count: () => interruptCount,
    __test_reset_interrupt: () => { interruptCount = 0; interruptFailureMode = 'none' },
    __test_set_interrupt_failure: (mode: 'none' | 'throw' | 'reject') => { interruptFailureMode = mode },
  }
})

import * as sdk from '@anthropic-ai/claude-agent-sdk'

const emitSdk = (message: unknown) => (sdk as unknown as { __test_yield: (message: unknown) => void }).__test_yield(message)
const finishSdkTurn = () => emitSdk({ type: 'result', subtype: 'success', session_id: 'timeline-session', num_turns: 1, duration_ms: 1 })

describe('claude-agent-provider', () => {
  it('preserves workbench text-tool-text order and native tool identity without exposing tool input', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test', workbenchTimeline: true })
    const eventsPromise = drain(session.dispatch('inspect'))
    emitSdk({ type: 'assistant', uuid: 'message-1', parent_tool_use_id: null, message: { content: [
      { type: 'text', text: 'Before' },
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/private/SECRET_INPUT', token: 'SECRET_TOKEN' } },
      { type: 'thinking', thinking: 'PRIVATE_REASONING' },
      { type: 'text', text: 'After' },
    ] } })
    emitSdk({ type: 'user', parent_tool_use_id: null, message: { content: [
      { type: 'tool_result', tool_use_id: 'read-1', content: 'SECRET_RESULT' },
    ] } })
    finishSdkTurn()
    const events = await eventsPromise
    expect(events.map(event => event.kind)).toEqual(['text', 'tool_call', 'text', 'tool_call', 'result'])
    expect(events[0]).toMatchObject({ kind: 'text', text: 'Before', itemId: expect.any(String) })
    expect(events[2]).toMatchObject({ kind: 'text', text: 'After', itemId: expect.any(String) })
    expect((events[0] as { itemId: string }).itemId).not.toEqual((events[2] as { itemId: string }).itemId)
    expect(events[1]).toMatchObject({ kind: 'tool_call', tool: 'Read', activity: { id: 'read-1', type: 'read', status: 'running', label: expect.any(String) } })
    expect(events[3]).toMatchObject({ kind: 'tool_call', tool: 'Read', activity: { id: 'read-1', type: 'read', status: 'completed' } })
    expect(JSON.stringify(events)).not.toMatch(/SECRET_|PRIVATE_REASONING/)
    await session.close()
  })

  it('correlates failed tool results and native subagent activities without inventing completions', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test', workbenchTimeline: true })
    const eventsPromise = drain(session.dispatch('inspect'))
    emitSdk({ type: 'assistant', uuid: 'message-agent', parent_tool_use_id: null, message: { content: [
      { type: 'tool_use', id: 'agent-1', name: 'Agent', input: { prompt: 'SECRET_PROMPT' } },
      { type: 'tool_use', id: 'task-1', name: 'Task', input: { prompt: 'SECRET_PROMPT' } },
    ] } })
    emitSdk({ type: 'assistant', uuid: 'message-child', parent_tool_use_id: 'agent-1', message: { content: [
      { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'TOKEN=SECRET_COMMAND curl somewhere' } },
    ] } })
    emitSdk({ type: 'user', parent_tool_use_id: 'agent-1', message: { content: [
      { type: 'tool_result', tool_use_id: 'unknown-id', is_error: true, content: 'SECRET_UNKNOWN' },
      { type: 'tool_result', tool_use_id: 'bash-1', is_error: true, content: 'SECRET_FAILURE' },
      { type: 'tool_result', tool_use_id: 'bash-1', content: 'Duplicate stale success' },
    ] } })
    emitSdk({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'done' }] } })
    finishSdkTurn()
    const events = await eventsPromise
    const activities = events.flatMap(event => event.kind === 'tool_call' && event.activity ? [event.activity] : [])
    expect(activities).toMatchObject([
      { id: 'agent-1', type: 'agent', status: 'running' },
      { id: 'task-1', type: 'agent', status: 'running' },
      { id: 'bash-1', type: 'command', status: 'running', parentId: 'agent-1' },
      { id: 'bash-1', type: 'command', status: 'failed', parentId: 'agent-1' },
      { id: 'agent-1', type: 'agent', status: 'completed' },
    ])
    expect(JSON.stringify(events)).not.toContain('SECRET_')
    await session.close()
  })

  it('keeps normal chat tool-first combined text and ignores tool-result lifecycle', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })
    const eventsPromise = drain(session.dispatch('inspect'))
    emitSdk({ type: 'assistant', uuid: 'message-chat', message: { content: [
      { type: 'text', text: 'Before' }, { type: 'tool_use', id: 'read-1', name: 'Read', input: {} }, { type: 'text', text: 'After' },
    ] } })
    emitSdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'done' }] } })
    finishSdkTurn()
    expect((await eventsPromise).slice(0, -1)).toEqual([{ kind: 'tool_call', tool: 'Read' }, { kind: 'text', text: 'BeforeAfter' }])
    await session.close()
  })

  it('identifies generic workbench tools with bounded sanitized names without copying their payload', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test', workbenchTimeline: true })
    const eventsPromise = drain(session.dispatch('inspect'))
    emitSdk({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'local-tool', name: 'InspectWidget', input: { key: 'SECRET_INPUT' } },
      { type: 'tool_use', id: 'mcp-tool', name: 'mcp__inventory__find_widget', input: { token: 'SECRET_TOKEN' } },
      { type: 'tool_use', id: 'messy-tool', name: 'odd\n<tool>' + 'x'.repeat(300), input: {} },
    ] } })
    emitSdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'mcp-tool', content: 'SECRET_OUTPUT' }] } })
    finishSdkTurn()
    const events = await eventsPromise
    const activities = events.flatMap(event => event.kind === 'tool_call' && event.activity ? [event.activity] : [])
    expect(activities[0]).toMatchObject({ id: 'local-tool', type: 'tool', detail: 'InspectWidget' })
    expect(activities[1]).toMatchObject({ id: 'mcp-tool', type: 'tool', detail: 'inventory/find_widget' })
    expect(activities[2]?.detail).toMatch(/^odd_tool_x+$/)
    expect(activities[2]?.detail?.length).toBeLessThanOrEqual(160)
    expect(activities[3]).toMatchObject({ id: 'mcp-tool', status: 'completed', detail: 'inventory/find_widget' })
    expect(JSON.stringify(events)).not.toContain('SECRET_')
    await session.close()
  })

  it('keeps replayed text identity and does not regress completed tools or accept a different parent result', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test', workbenchTimeline: true })
    const eventsPromise = drain(session.dispatch('inspect'))
    const message = { type: 'assistant', uuid: 'message-replayed', parent_tool_use_id: 'parent-1', message: { content: [
      { type: 'text', text: 'Checking' }, { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { new_string: 'SECRET_CONTENT' } },
    ] } }
    emitSdk(message)
    emitSdk({ type: 'user', parent_tool_use_id: 'other-parent', message: { content: [{ type: 'tool_result', tool_use_id: 'edit-1', is_error: true }] } })
    emitSdk({ type: 'user', parent_tool_use_id: 'parent-1', message: { content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } })
    emitSdk(message)
    finishSdkTurn()
    const events = await eventsPromise
    const texts = events.filter(event => event.kind === 'text')
    expect(texts).toHaveLength(2)
    expect(texts[0]).toEqual(texts[1])
    expect(texts[0]).toMatchObject({ textMode: 'replace' })
    expect(events.flatMap(event => event.kind === 'tool_call' ? [event.activity] : [])).toMatchObject([
      { id: 'edit-1', type: 'edit', status: 'running', parentId: 'parent-1' },
      { id: 'edit-1', type: 'edit', status: 'completed', parentId: 'parent-1' },
    ])
    await session.close()
  })

  it('retains authentication sentinel protection across workbench text blocks', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test', workbenchTimeline: true })
    const eventsPromise = drain(session.dispatch('inspect'))
    emitSdk({ type: 'assistant', uuid: 'message-auth', message: { content: [
      { type: 'text', text: 'Not logged ' }, { type: 'text', text: 'in · Please run /login' },
    ] } })
    finishSdkTurn()
    const events = await eventsPromise
    expect(events.filter(event => event.kind === 'text')).toEqual([])
    expect(events.filter(event => event.kind === 'error')).toMatchObject([{ code: 'auth_failed' }])
    await session.close()
  })

  it('does not carry workbench tool identities or late results into the next dispatch', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test', workbenchTimeline: true })
    const first = drain(session.dispatch('first'))
    emitSdk({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'old-tool', name: 'Read', input: {} }] } })
    finishSdkTurn()
    await first
    const second = drain(session.dispatch('second'))
    emitSdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'late' }] } })
    finishSdkTurn()
    expect((await second).filter(event => event.kind === 'tool_call')).toEqual([])
    await session.close()
  })

  it('routes AskUserQuestion through structured input before permission classification', async () => {
    const requestPermission = vi.fn(async () => true)
    const requestUserInput = vi.fn(async () => ({ 'question-tool:0': ['PDF', 'Word'], 'question-tool:1': ['Custom note'] }))
    const signal = new AbortController().signal
    const input = { questions: [
      { header: 'Formats', question: 'Which formats?', options: [{ label: 'PDF', description: 'Fixed' }, { label: 'Word', description: 'Editable' }], multiSelect: true },
      { header: 'Note', question: 'Which note?', options: [{ label: 'Brief', description: 'Short' }, { label: 'Full', description: 'Long' }], multiSelect: false },
    ], metadata: { source: 'review' } }
    const gate = makeWorkbenchClaudeCanUseTool(requestPermission, requestUserInput)
    await expect(gate('AskUserQuestion', input, { signal, toolUseID: 'question-tool' })).resolves.toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which formats?': 'PDF, Word', 'Which note?': 'Custom note' } } })
    expect(requestUserInput).toHaveBeenCalledWith({ questions: [
      { id: 'question-tool:0', header: 'Formats', question: 'Which formats?', options: input.questions[0]!.options, multiSelect: true, allowOther: true },
      { id: 'question-tool:1', header: 'Note', question: 'Which note?', options: input.questions[1]!.options, multiSelect: false, allowOther: true },
    ] }, signal)
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it.each(['missing', 'declined', 'failed', 'invalid-answer', 'aborted'])('denies unanswered Claude questions on %s', async reason => {
    const controller = new AbortController()
    const input = { questions: [{ header: 'Format', question: 'Which format?', options: [{ label: 'PDF', description: 'Fixed' }, { label: 'Word', description: 'Editable' }], multiSelect: false }] }
    const requestUserInput = reason === 'missing' ? undefined : async (): Promise<Record<string, string[]> | null> => {
      if (reason === 'failed') throw new Error('UI gone')
      if (reason === 'aborted') controller.abort()
      if (reason === 'invalid-answer') return { unknown: ['PDF'] }
      return reason === 'declined' ? null : { 'question-tool:0': ['PDF'] }
    }
    const gate = makeWorkbenchClaudeCanUseTool(undefined, requestUserInput)
    await expect(gate('AskUserQuestion', input, { signal: controller.signal, toolUseID: 'question-tool' })).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('rejects duplicate Claude question text because native answers are keyed by question text', async () => {
    const requestUserInput = vi.fn(async () => ({ 'question-tool:0': ['PDF'], 'question-tool:1': ['Word'] }))
    const q = { header: 'Format', question: 'Which format?', options: [{ label: 'PDF', description: 'Fixed' }, { label: 'Word', description: 'Editable' }], multiSelect: false }
    const gate = makeWorkbenchClaudeCanUseTool(undefined, requestUserInput)
    await expect(gate('AskUserQuestion', { questions: [q, q] }, { signal: new AbortController().signal, toolUseID: 'question-tool' })).resolves.toMatchObject({ behavior: 'deny' })
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('forwards spawnOpts.appendInstructions to sdkOptionsForProject (unified prompt seam)', async () => {
    const seen: unknown[] = []
    const provider = createClaudeAgentProvider({
      sdkOptionsForProject: (...args: unknown[]) => { seen.push(args); return {} },
    })
    await provider.spawn({ alias: 'foo', path: '/tmp' }, {
      tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test',
      mcpEnv: { WECHAT_SESSION_TIER: 'admin' },
      appendInstructions: 'SELF-HEAL-PROMPT',
    })
    // The final context lets a task-only options builder consume its local
    // permission callback without changing ordinary chat builders.
    expect(seen[0]).toEqual([
      'foo', '/tmp', TIER_PROFILES.admin, '_test',
      { WECHAT_SESSION_TIER: 'admin' }, 'SELF-HEAL-PROMPT',
      expect.objectContaining({ chatId: '_test', appendInstructions: 'SELF-HEAL-PROMPT' }),
    ])
  })

  it('builds a task-only gate that preserves trusted solo strict policy and SDK abort', async () => {
    const signal = new AbortController().signal
    const requestPermission = vi.fn(async () => true)
    const gate = makeWorkbenchClaudeCanUseTool(requestPermission)

    await expect(gate('Read', { file_path: '/tmp/report.md' }, { signal } as never)).resolves.toEqual({ behavior: 'allow' })
    await expect(gate('Bash', { command: 'rm -rf build' }, { signal, title: 'Remove build output' } as never)).resolves.toEqual({ behavior: 'allow' })
    expect(requestPermission).toHaveBeenCalledWith({ tool: 'Bash', description: 'Remove build output\ncommand=rm -rf build' }, signal)
  })

  it('denies task MCP tools and relay requests without an active callback', async () => {
    const signal = new AbortController().signal
    const gate = makeWorkbenchClaudeCanUseTool()
    await expect(gate('mcp__wechat__reply', {}, { signal } as never)).resolves.toMatchObject({ behavior: 'deny' })
    await expect(gate('Bash', { command: 'git reset --hard HEAD' }, { signal } as never)).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('asks the owning task before using an admitted native MCP and redacts credential fields', async () => {
    const permission = vi.fn(async (_request: {tool:string;description:string}, _signal?: AbortSignal) => true), signal = new AbortController().signal
    const gate = makeWorkbenchClaudeCanUseTool(permission, undefined, ['my_catalog'])
    await expect(gate('mcp__my_catalog__lookup', { query:'item', api_key:'never-store', url:'https://user:url-secret@example.test/?token=query-secret', headers:[{name:'Authorization',value:'Bearer header-secret'}] }, { signal } as never)).resolves.toMatchObject({ behavior:'allow' })
    expect(permission).toHaveBeenCalledOnce()
    expect(permission.mock.calls[0]?.[0]).toMatchObject({ tool:'mcp__my_catalog__lookup', description:expect.stringContaining('item') })
    expect(JSON.stringify(permission.mock.calls)).not.toContain('never-store')
    for (const value of ['url-secret','query-secret','header-secret']) expect(JSON.stringify(permission.mock.calls)).not.toContain(value)
    for (const tool of ['mcp__my_catalog_other__lookup','mcp__wechat__reply','mcp__delegate__run']) {
      await expect(gate(tool, {}, { signal } as never)).resolves.toMatchObject({ behavior:'deny' })
    }
    expect(permission).toHaveBeenCalledOnce()
  })

  it('denies admitted MCP when approval is missing, refused, failed or cancelled', async () => {
    for (const result of ['missing','refused','failed','cancelled']) {
      const controller = new AbortController()
      const permission = result === 'missing' ? undefined : async () => {
        if (result === 'failed') throw Error('closed')
        if (result === 'cancelled') controller.abort()
        return result !== 'refused'
      }
      const gate = makeWorkbenchClaudeCanUseTool(permission, undefined, ['catalog'])
      await expect(gate('mcp__catalog__lookup', { query:'item' }, { signal:controller.signal } as never)).resolves.toMatchObject({ behavior:'deny' })
    }
  })

  it('fails closed when the full destructive input cannot fit in the bounded permission detail', async () => {
    const signal = new AbortController().signal
    const requestPermission = vi.fn(async () => false)
    const gate = makeWorkbenchClaudeCanUseTool(requestPermission)
    await expect(gate('Bash', { command: `rm -rf ${'secret'.repeat(4000)}`, ignored: 'x'.repeat(1000) }, { signal } as never)).resolves.toMatchObject({ behavior: 'deny' })
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('denies an already-aborted tool call before any policy branch can allow it', async () => {
    const controller=new AbortController(); controller.abort()
    const requestPermission=vi.fn(async()=>true)
    const gate=makeWorkbenchClaudeCanUseTool(requestPermission)
    await expect(gate('Read',{file_path:'/tmp/report.md'},{signal:controller.signal} as never)).resolves.toMatchObject({behavior:'deny'})
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('denies an allow-policy tool when the SDK aborts while policy modules load', async () => {
    const controller = new AbortController()
    const gate = makeWorkbenchClaudeCanUseTool(vi.fn(async () => true))
    const decision = gate('Read', { file_path: '/tmp/report.md' }, { signal: controller.signal } as never)
    controller.abort()
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('denies an approved relay when the SDK aborts before the approval continuation', async () => {
    const controller = new AbortController()
    let approve!: (allowed: boolean) => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const requestPermission = vi.fn(() => {
      markStarted()
      return new Promise<boolean>(resolve => { approve = resolve })
    })
    const gate = makeWorkbenchClaudeCanUseTool(requestPermission)
    const decision = gate('Bash', { command: 'rm -rf build' }, { signal: controller.signal } as never)
    await started
    approve(true)
    controller.abort()
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('yields init then text then result for a simple turn', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })

    const eventsPromise = drain(session.dispatch('hi'))

    // Give the background task a tick to start consuming
    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'system', subtype: 'init', session_id: 's1',
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's1', num_turns: 1, duration_ms: 100,
    })

    const events = await eventsPromise
    expect(events).toEqual([
      { kind: 'init', sessionId: 's1' },
      { kind: 'text', text: 'hello' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 100 },
    ])
    await session.close()
  })

  it('yields tool_call for `mcp__wechat__reply` with `{server:"wechat", tool:"reply"}`', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })

    const eventsPromise = drain(session.dispatch('reply please'))

    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'thinking aloud' },
        { type: 'tool_use', name: 'mcp__wechat__reply', input: { chat_id: 'c', text: 'hi back' } },
      ] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's2', num_turns: 1, duration_ms: 50,
    })

    const events = await eventsPromise
    const toolCall = events.find(e => e.kind === 'tool_call')
    expect(toolCall).toBeDefined()
    expect(toolCall).toEqual({ kind: 'tool_call', server: 'wechat', tool: 'reply' })
    await session.close()
  })

  it('yields tool_call for built-in tools without server prefix', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })

    const eventsPromise = drain(session.dispatch('read a file'))

    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/img.jpg' } },
      ] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's3', num_turns: 1, duration_ms: 0,
    })

    const events = await eventsPromise
    const toolCall = events.find(e => e.kind === 'tool_call')
    expect(toolCall).toBeDefined()
    expect((toolCall as { server?: string }).server).toBeUndefined()
    expect((toolCall as { tool: string }).tool).toBe('Read')
    await session.close()
  })

  it('yields error event for non-success result subtype', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })

    const eventsPromise = drain(session.dispatch('hi'))

    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'error', result: 'tool execution failed', session_id: 's4', num_turns: 1, duration_ms: 0,
    })

    const events = await eventsPromise
    expect(events.some(e => e.kind === 'error')).toBe(true)
    const errorEvent = events.find(e => e.kind === 'error')
    expect((errorEvent as { message: string }).message).toContain('error')
    // result event should still come after error event
    expect(events.some(e => e.kind === 'result')).toBe(true)
    await session.close()
  })

  it('translates "Please run /login" assistant text into an auth_failed error event (not a normal text reply)', async () => {
    // When claude is unauthenticated, its binary streams the literal text
    // "Not logged in · Please run /login" as an assistant message. Without
    // interception that string leaks to the user as if it were a real reply.
    // The provider must intercept it and surface a structured error so the
    // coordinator can suppress the fallback path.
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })

    const eventsPromise = drain(session.dispatch('hi'))

    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's-auth', num_turns: 1, duration_ms: 0,
    })

    const events = await eventsPromise
    // The auth-fail text MUST NOT pass through as a normal text event.
    expect(events.find(e => e.kind === 'text')).toBeUndefined()
    // It must be surfaced as a structured error with a specific code.
    const errorEvent = events.find(e => e.kind === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as { code?: string }).code).toBe('auth_failed')
    // Result event still arrives last so the iterator closes cleanly.
    expect(events[events.length - 1]?.kind).toBe('result')
    await session.close()
  })

  it('routes a "Not logged in" assistant chunk to auth_failed even when "/login" arrives separately', async () => {
    // The SDK is free to split the auth-fail sentinel across multiple
    // assistant messages — observed shape from the claude binary's string
    // table is two distinct strings, "Not logged in" and "Please run /login".
    // The provider must catch the first chunk; otherwise that chunk flows to
    // the user as a normal reply before the second one trips the error path.
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })

    const eventsPromise = drain(session.dispatch('hi'))
    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Not logged in' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's-auth-split', num_turns: 1, duration_ms: 0,
    })

    const events = await eventsPromise
    expect(events.find(e => e.kind === 'text')).toBeUndefined()
    const errorEvent = events.find(e => e.kind === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as { code?: string }).code).toBe('auth_failed')
    await session.close()
  })

  it('returns an empty iterable after close()', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })
    await session.close()
    const events = await drain(session.dispatch('after close'))
    expect(events).toEqual([])
  })

  it('throws if dispatch is called while a previous dispatch is in flight', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })

    // Start first dispatch — do NOT drain it yet (keep it in-flight)
    const first = session.dispatch('a')
    // Start consuming the iterator to set the active queue
    const firstIterator = first[Symbol.asyncIterator]()
    // Kick off the iterator — don't await so it's in-flight
    const firstNextPromise = firstIterator.next()

    await new Promise(r => setTimeout(r, 0))

    // Second dispatch while first is in flight should throw
    expect(() => session.dispatch('b')).toThrow(/in flight/)

    // Finish first dispatch cleanly
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's5', num_turns: 1, duration_ms: 0,
    })

    await firstNextPromise
    // Drain the rest
    for await (const _ of { [Symbol.asyncIterator]: () => firstIterator }) { /* drain */ }
    await session.close()
  })

  it('cancel() calls SDK interrupt without closing the session', async () => {
    ;(sdk as unknown as { __test_reset_interrupt: () => void }).__test_reset_interrupt()
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })

    // Start a dispatch and leave it in-flight.
    const eventsPromise = drain(session.dispatch('first'))
    await new Promise(r => setTimeout(r, 0))

    // Cancel mid-stream — should hit SDK.interrupt exactly once.
    await session.cancel?.()
    expect((sdk as unknown as { __test_interrupt_count: () => number }).__test_interrupt_count()).toBe(1)

    // The dispatch iterator stays open until the SDK emits a final event;
    // in production the SDK responds to interrupt with a result message.
    // Simulate that here so the iterator winds down.
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's-cancel', num_turns: 1, duration_ms: 5,
    })
    await eventsPromise

    // Session is NOT closed — a second dispatch still works.
    const eventsPromise2 = drain(session.dispatch('second'))
    await new Promise(r => setTimeout(r, 0))
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'still alive' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's-cancel', num_turns: 2, duration_ms: 5,
    })
    const events2 = await eventsPromise2
    expect(events2.some(e => e.kind === 'text' && e.text === 'still alive')).toBe(true)

    await session.close()
  })

  it('close() survives a dead SDK ProcessTransport (sync throw)', async () => {
    // Regression: 2026-05-28 PDT — daemon crashed twice with exit 1.
    // sweepIdle → release → close → SDK.interrupt() threw "ProcessTransport
    // is not ready for writing" because the claude subprocess had already
    // exited. The throw was inside a fire-and-forget call, so Bun killed
    // the daemon on unhandled rejection. close() must absorb this.
    ;(sdk as unknown as { __test_reset_interrupt: () => void }).__test_reset_interrupt()
    ;(sdk as unknown as { __test_set_interrupt_failure: (m: 'throw') => void }).__test_set_interrupt_failure('throw')

    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })

    await expect(session.close()).resolves.toBeUndefined()
  })

  it('close() survives a dead SDK ProcessTransport (async rejection)', async () => {
    // Same regression — but SDK returns a rejected promise instead of
    // throwing synchronously. Bun's default unhandled-rejection behaviour
    // is fatal, so the fire-and-forget invoker must attach a .catch.
    ;(sdk as unknown as { __test_reset_interrupt: () => void }).__test_reset_interrupt()
    ;(sdk as unknown as { __test_set_interrupt_failure: (m: 'reject') => void }).__test_set_interrupt_failure('reject')

    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })

    await expect(session.close()).resolves.toBeUndefined()
    // Wait a tick so any unhandled rejection would surface before the
    // test exits.
    await new Promise(r => setTimeout(r, 10))
  })

  it('cancel() survives a dead SDK ProcessTransport', async () => {
    ;(sdk as unknown as { __test_reset_interrupt: () => void }).__test_reset_interrupt()
    ;(sdk as unknown as { __test_set_interrupt_failure: (m: 'reject') => void }).__test_set_interrupt_failure('reject')

    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })

    await expect(session.cancel?.()).resolves.toBeUndefined()
    await new Promise(r => setTimeout(r, 10))

    // Tidy up — close() also must not crash.
    await session.close()
  })

  it('passes an AbortController into query() and aborts it on close() (clean subprocess teardown)', async () => {
    // Problem 5 (zombie subprocesses): the best-effort interrupt()/close()
    // calls no-op against a dead/wedged ProcessTransport, leaving the claude
    // child running. The SDK's abortController is the documented "stop and
    // clean up resources" path — close() must trip it so the watchdog's
    // release→close actually tears the subprocess down.
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })
    const opts = (sdk as unknown as { __test_last_options: () => unknown }).__test_last_options() as { abortController?: AbortController }
    expect(opts.abortController).toBeInstanceOf(AbortController)
    expect(opts.abortController!.signal.aborted).toBe(false)
    await session.close()
    expect(opts.abortController!.signal.aborted).toBe(true)
  })

  it('cheapEval returns concatenated assistant text (PR F)', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const cheapPromise = provider.cheapEval?.('what is 9-1?')
    await new Promise(r => setTimeout(r, 0))
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: '8' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 'c1', num_turns: 1, duration_ms: 50,
    })
    // Mock's stream doesn't auto-close after `result` — manually end so
    // the for-await loop inside cheapEval can return.
    ;(sdk as unknown as { __test_end: () => void }).__test_end()
    const text = await cheapPromise
    expect(text).toBe('8')
  })

  it('cheapEval falls back to result text when no assistant event is emitted', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const cheapPromise = provider.cheapEval?.('return JSON')
    await new Promise(r => setTimeout(r, 0))
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', result: '{"shouldPaint":false}',
      session_id: 'c-result-only', num_turns: 1, duration_ms: 50,
    })
    ;(sdk as unknown as { __test_end: () => void }).__test_end()
    await expect(cheapPromise).resolves.toBe('{"shouldPaint":false}')
    const options = (sdk as unknown as { __test_last_options: () => unknown }).__test_last_options() as {
      settingSources?: string[]; tools?: string[]; persistSession?: boolean
    }
    expect(options.settingSources).toEqual([])
    expect(options.tools).toEqual([])
    expect(options.persistSession).toBe(false)
  })

  it('cheapEval respects WECHAT_CLAUDE_CHEAP_MODEL env override (PR F)', async () => {
    const prior = process.env['WECHAT_CLAUDE_CHEAP_MODEL']
    process.env['WECHAT_CLAUDE_CHEAP_MODEL'] = 'claude-haiku-99-experimental'
    try {
      const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
      expect(provider.cheapEval).toBeDefined()
      const cheapPromise = provider.cheapEval?.('hi')
      await new Promise(r => setTimeout(r, 0))
      ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
        type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] },
      })
      ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
        type: 'result', subtype: 'success', session_id: 'c2', num_turns: 1, duration_ms: 50,
      })
      ;(sdk as unknown as { __test_end: () => void }).__test_end()
      expect(await cheapPromise).toBe('ok')
      // Verify the env value actually reached query() — otherwise a
      // regression that drops the env read would still pass.
      const lastOpts = (sdk as unknown as { __test_last_options: () => unknown }).__test_last_options()
      expect((lastOpts as { model?: string })?.model).toBe('claude-haiku-99-experimental')
    } finally {
      if (prior === undefined) delete process.env['WECHAT_CLAUDE_CHEAP_MODEL']
      else process.env['WECHAT_CLAUDE_CHEAP_MODEL'] = prior
    }
  })

  it('cheapEval defaults to claude-haiku-4-5 when no env override (PR F)', async () => {
    const prior = process.env['WECHAT_CLAUDE_CHEAP_MODEL']
    delete process.env['WECHAT_CLAUDE_CHEAP_MODEL']
    try {
      const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
      const cheapPromise = provider.cheapEval?.('hi')
      await new Promise(r => setTimeout(r, 0))
      ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
        type: 'result', subtype: 'success', session_id: 'c3', num_turns: 1, duration_ms: 0,
      })
      ;(sdk as unknown as { __test_end: () => void }).__test_end()
      await cheapPromise
      const lastOpts = (sdk as unknown as { __test_last_options: () => unknown }).__test_last_options()
      expect((lastOpts as { model?: string })?.model).toBe('claude-haiku-4-5')
    } finally {
      if (prior !== undefined) process.env['WECHAT_CLAUDE_CHEAP_MODEL'] = prior
    }
  })

  it('cancel() is a no-op after close()', async () => {
    ;(sdk as unknown as { __test_reset_interrupt: () => void }).__test_reset_interrupt()
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })
    await session.close()
    // close() itself calls interrupt — record that baseline, then verify
    // cancel() does NOT add another call.
    const baseline = (sdk as unknown as { __test_interrupt_count: () => number }).__test_interrupt_count()
    await session.cancel?.()
    expect((sdk as unknown as { __test_interrupt_count: () => number }).__test_interrupt_count()).toBe(baseline)
  })

  describe('tierProfileToClaudeSdkOpts', () => {
    it('dangerously mode → permissionMode=bypassPermissions regardless of tier', () => {
      // Operator override: --dangerously short-circuits all tiers.
      expect(tierProfileToClaudeSdkOpts(TIER_PROFILES.admin, 'dangerously').permissionMode).toBe('bypassPermissions')
      expect(tierProfileToClaudeSdkOpts(TIER_PROFILES.trusted, 'dangerously').permissionMode).toBe('bypassPermissions')
      expect(tierProfileToClaudeSdkOpts(TIER_PROFILES.guest, 'dangerously').permissionMode).toBe('bypassPermissions')
    })

    it('strict + admin → permissionMode=default + canUseTool (admin tier relay set fires for destructive)', () => {
      // Post-RFC-05: admin in strict no longer auto-bypasses. canUseTool
      // fires for every tool; admin's tier policy auto-allows safe tools
      // and relays destructive Bash / memory_delete via permission-relay.
      const out = tierProfileToClaudeSdkOpts(TIER_PROFILES.admin, 'strict')
      expect(out.permissionMode).toBe('default')
      expect(out.disallowedTools).toBeUndefined()
    })

    it('strict + trusted → permissionMode=default, no disallowedTools (canUseTool relays destructive)', () => {
      const out = tierProfileToClaudeSdkOpts(TIER_PROFILES.trusted, 'strict')
      expect(out.permissionMode).toBe('default')
      // shell_destructive is relayed via canUseTool, not via disallowedTools —
      // because disallowedTools blocks at the tool name level and we'd lose
      // the ability to allow non-destructive Bash.
      expect(out.disallowedTools).toBeUndefined()
    })

    it('strict + guest → permissionMode=default + disallowedTools blocks non-allowed built-ins', () => {
      const out = tierProfileToClaudeSdkOpts(TIER_PROFILES.guest, 'strict')
      expect(out.permissionMode).toBe('default')
      expect(out.disallowedTools).toBeDefined()
      expect(out.disallowedTools).toContain('Bash')
      expect(out.disallowedTools).toContain('Write')
    })

    it('guest disallowedTools is exactly the built-in tools mapped to non-allow ToolKinds', () => {
      const out = tierProfileToClaudeSdkOpts(TIER_PROFILES.guest, 'strict')
      const set = new Set(out.disallowedTools ?? [])
      expect(set.has('Bash')).toBe(true)
      expect(set.has('KillShell')).toBe(true)
      expect(set.has('Write')).toBe(true)
      expect(set.has('Edit')).toBe(true)
      expect(set.has('NotebookEdit')).toBe(true)
      expect(set.has('Read')).toBe(true)
      expect(set.has('Glob')).toBe(true)
      expect(set.has('Grep')).toBe(true)
      expect(set.has('LS')).toBe(true)
      expect(set.has('WebFetch')).toBe(true)
      expect(set.has('WebSearch')).toBe(true)
      expect(set.has('Task')).toBe(true)
      // MCP tools are NOT included in disallowedTools — they're filtered by
      // canUseTool instead (because the wechat MCP server exposes them
      // dynamically; we can't pre-enumerate the names here without
      // double-maintaining a list).
    })
  })

  it('assistant text arriving with no active queue is dropped with [STREAM_DROP] warn', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_test' })

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    // Emit assistant text before any dispatch is in flight
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'orphan' }] },
    })
    // Give the iterator loop a tick to consume the yielded message
    await new Promise(r => setTimeout(r, 10))
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('STREAM_DROP'))

    // Now dispatch — the result must contain ONLY this turn's text, not the orphan
    const eventsPromise = drain(session.dispatch('hello'))

    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'fresh' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 'sid-1', num_turns: 1, duration_ms: 100,
    })

    const events = await eventsPromise
    const textEvents = events.filter(e => e.kind === 'text')
    expect(textEvents).toEqual([{ kind: 'text', text: 'fresh' }])
    stderrSpy.mockRestore()
    await session.close()
  })
})
