import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClaudeAgentProvider } from './claude-agent-provider'
import type { AgentEvent, AgentSession } from './agent-provider'
import { TIER_PROFILES } from './user-tier'

const native = vi.hoisted(() => ({
  sent: [] as any[], options: undefined as any,
  emit: (_message: any) => {}, end: () => {}, fail: (_error: Error) => {},
  stallClose: false, releaseClose: () => {},
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: any) => {
    native.sent = []; native.options = options; native.stallClose = false; native.releaseClose = () => {}
    const messages: any[] = [], waiting: { resolve: (value: IteratorResult<any>) => void; reject: (error: Error) => void }[] = []
    let done = false, failure: Error | undefined
    native.emit = message => { const waiter = waiting.shift(); if (waiter) waiter.resolve({ value: message, done: false }); else messages.push(message) }
    native.end = () => { done = true; for (const waiter of waiting.splice(0)) waiter.resolve({ value: undefined, done: true }) }
    native.fail = error => { failure = error; for (const waiter of waiting.splice(0)) waiter.reject(error) }
    void (async () => { for await (const message of prompt) native.sent.push(message) })()
    return {
      [Symbol.asyncIterator]() { return this },
      next() {
        if (messages.length) return Promise.resolve({ value: messages.shift(), done: false })
        if (failure) return Promise.reject(failure)
        if (done) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => waiting.push({ resolve, reject }))
      },
      close() { if (native.stallClose) return new Promise<void>(resolve => { native.releaseClose = () => { native.end(); resolve() } }); native.end() },
      interrupt: async () => {},
    }
  },
}))

const sessions: AgentSession[] = []
afterEach(async () => { native.releaseClose(); native.end(); for (const session of sessions.splice(0)) await session.close().catch(() => {}); vi.useRealTimers() })
async function open(extra: Record<string, unknown> = {}) {
  const observations: unknown[] = []
  const session = await createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) }).spawn(
    { alias: 'runtime', path: '/tmp' },
    { tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', chatId: 'runtime', workbenchTimeline: true, workbenchLifecycle: true, reportExecution: value => observations.push(value), ...extra },
  )
  sessions.push(session)
  expect(session.workbenchRuntime, 'opt-in must expose a lifetime runtime').toBeDefined()
  const runtime = session.workbenchRuntime!, events: AgentEvent[] = []
  let ended = false
  const drained = (async () => { for await (const event of runtime.events) events.push(event); ended = true })()
  return { session, runtime, events, drained, ended: () => ended, observations }
}
const init = (version = '2.1.267') => native.emit({ type: 'system', subtype: 'init', session_id: 'native-parent', model: 'parent-model', claude_code_version: version, tools: ['Task', 'Read', 'Bash'], capabilities: ['msg_lifecycle_v1'] })
const result = (text = 'parent answer', origin?: unknown) => native.emit({ type: 'result', subtype: 'success', session_id: 'native-parent', num_turns: 1, duration_ms: 10, result: text, ...(origin ? { origin } : {}) })
const assistant = (text: string, parent: string | null = null, uuid: string = crypto.randomUUID()) => native.emit({ type: 'assistant', uuid, parent_tool_use_id: parent, message: { id: `message-${uuid}`, model: parent ? 'child-model' : 'parent-model', content: [{ type: 'text', text }] } })
const startChild = (id: string, toolId = `launch-${id}`, taskType = 'local_agent') => native.emit({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: toolId, task_type: taskType, is_backgrounded: true, session_id: 'native-parent', description: 'Private native task description', prompt: 'PRIVATE CHILD PROMPT' })
const finishChild = (id: string, status = 'completed') => native.emit({ type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: `launch-${id}`, status, session_id: 'native-parent', output_file: '/private/native-output', summary: 'PRIVATE TOOL OUTPUT' })
const textEvents = (events: AgentEvent[]) => events.filter(event => event.kind === 'text').map(event => event.text)
const activityEvents = (events: AgentEvent[]) => events.flatMap(event => event.kind === 'tool_call' && event.activity ? [event.activity] : [])

describe('Claude workbench retained runtime', () => {
  it('keeps both autonomous answers after the last child notification and the first follow-up result', async () => {
    const run = await open(); run.runtime.start('start'); init()
    startChild('A'); startChild('B'); assistant('first'); result('first')
    finishChild('A'); finishChild('B')
    native.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: 'native-parent' })
    assistant('automatic A'); result('automatic A', { kind: 'task-notification' })
    assistant('automatic B'); result('automatic B', { kind: 'task-notification' })
    await expect.poll(() => textEvents(run.events)).toEqual(['first', 'automatic A', 'automatic B'])
    expect(run.events.filter(event => event.kind === 'result')).toHaveLength(3)
    expect(run.ended()).toBe(false)
    expect(run.runtime.snapshot()).toEqual({ retained: true, foreground: 'idle', backgroundCount: 0, input: 'send' })
    await run.session.close(); await run.drained
  })

  it('keeps child lifecycle distinct from launch acknowledgement and child text out of parent replies', async () => {
    const run = await open(); run.runtime.start('start'); init()
    native.emit({ type: 'assistant', uuid: 'launch-message', parent_tool_use_id: null, message: { model: 'parent-model', content: [{ type: 'tool_use', name: 'Agent', id: 'launch-A', input: { run_in_background: true, prompt: 'PRIVATE PROMPT' } }] } })
    startChild('A')
    native.emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'launch-A', content: 'PRIVATE LAUNCH OUTPUT' }] } })
    assistant('child public reply', 'launch-A', 'child-reply')
    assistant('child public reply', 'launch-A', 'child-reply')
    assistant('parent public reply'); result()
    await expect.poll(() => activityEvents(run.events).some(activity => activity.output === 'child public reply')).toBe(true)
    expect(textEvents(run.events)).toEqual(['parent public reply'])
    const child = activityEvents(run.events).findLast(activity => activity.output !== undefined)!
    expect(child).toMatchObject({ type: 'agent', status: 'running', parentId: 'launch-A', output: 'child public reply' })
    expect(child.id).not.toBe('launch-A')
    expect(activityEvents(run.events).findLast(activity => activity.id === 'launch-A')?.status).toBe('completed')
    finishChild('A', 'failed')
    await expect.poll(() => activityEvents(run.events).findLast(activity => activity.id === child.id)?.status).toBe('failed')
    expect(run.events.some(event => event.kind === 'error')).toBe(false)
    expect(JSON.stringify(run.events)).not.toMatch(/PRIVATE|native-output|child-model/)
    expect(run.observations).toEqual(expect.arrayContaining([{ model: 'parent-model', sessionId: 'native-parent', source: 'native_message' }]))
    expect(JSON.stringify(run.observations)).not.toContain('child-model')
  })

  it('retains background Bash and unknown task types, without reviving a terminal occurrence', async () => {
    const run = await open(); run.runtime.start('start'); init()
    startChild('bash', 'launch-bash', 'local_bash'); startChild('unknown', 'launch-unknown', 'future_task')
    result()
    await expect.poll(() => run.runtime.snapshot().backgroundCount).toBe(2)
    finishChild('bash'); finishChild('bash'); startChild('bash', 'launch-bash', 'local_bash')
    finishChild('unknown', 'stopped'); result()
    await expect.poll(() => run.runtime.snapshot().backgroundCount).toBe(0)
    expect(run.ended()).toBe(false)
    expect(run.runtime.snapshot().retained).toBe(true)
    const snapshot = run.runtime.snapshot(); snapshot.retained = false; snapshot.backgroundCount = 50
    expect(run.runtime.snapshot()).toMatchObject({ retained: true, backgroundCount: 0 })
  })

  it('retains unknown registration support and background launch intent even before task_started', async () => {
    const run = await open(); run.runtime.start('start'); init('unverified-version'); result()
    await expect.poll(() => run.events.some(event => event.kind === 'result')).toBe(true)
    expect(run.ended()).toBe(false)
    expect(run.runtime.snapshot().retained).toBe(true)
  })

  it('retains a background terminal observed without its start, because its parent follow-up may still be queued', async () => {
    const run = await open(); run.runtime.start('start'); init(); finishChild('missed-start'); result()
    await expect.poll(() => run.events.some(event => event.kind === 'result')).toBe(true)
    expect(run.runtime.snapshot()).toMatchObject({ retained: true, backgroundCount: 0 })
    expect(run.ended()).toBe(false)
  })

  it('does not classify an explicitly foreground child as retained background work', async () => {
    const run = await open(); run.runtime.start('start'); init()
    native.emit({ type: 'system', subtype: 'task_started', task_id: 'foreground-child', tool_use_id: 'foreground-launch', task_type: 'local_agent', is_backgrounded: false, session_id: 'native-parent' })
    native.emit({ type: 'system', subtype: 'task_progress', task_id: 'foreground-child', tool_use_id: 'foreground-launch', session_id: 'native-parent', usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 } })
    assistant('child answer', 'foreground-launch')
    native.emit({ type: 'system', subtype: 'task_updated', task_id: 'foreground-child', patch: { status: 'completed' }, session_id: 'native-parent' })
    result()
    await expect.poll(() => run.events.some(event => event.kind === 'result')).toBe(true)
    expect(run.runtime.snapshot()).toMatchObject({ retained: false, backgroundCount: 0 })
    await run.drained
  })

  it('finishes verified ordinary no-background work and rejects reuse of the ended epoch', async () => {
    const run = await open(); run.runtime.start('start'); init(); assistant('done'); result('done')
    await run.drained
    expect(textEvents(run.events)).toEqual(['done'])
    expect(run.runtime.snapshot()).toMatchObject({ retained: false, backgroundCount: 0, input: 'queue' })
    expect(() => run.runtime.start('again')).toThrow()
    await expect(run.runtime.submit('too-late', 'late')).rejects.toThrow()
  })

  it('resolves supplemental sends only for matching native replay and retains a submitted epoch', async () => {
    const run = await open(); run.runtime.start('start'); init()
    await expect.poll(() => native.sent.length).toBe(1)
    let received = false
    const submitted = run.runtime.submit('cc-request', 'supplement').then(() => { received = true })
    await expect.poll(() => native.sent.length).toBe(2)
    const sent = native.sent[1]
    expect(sent.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(sent.priority).toBe('next')
    expect(native.options.extraArgs['replay-user-messages']).toBeNull()
    native.emit({ type: 'command_lifecycle', command_uuid: sent.uuid, state: 'queued' })
    native.emit({ type: 'user', uuid: sent.uuid, parent_tool_use_id: null, message: sent.message })
    native.emit({ type: 'user', uuid: 'other-uuid', isReplay: true, parent_tool_use_id: null, message: sent.message })
    result()
    await expect.poll(() => run.events.some(event => event.kind === 'result')).toBe(true)
    expect(received).toBe(false); expect(run.ended()).toBe(false)
    native.emit({ type: 'user', uuid: sent.uuid, isReplay: true, parent_tool_use_id: null, session_id: 'native-parent', message: sent.message })
    await submitted
    expect(received).toBe(true)
    expect(run.runtime.snapshot().retained).toBe(true)
    await expect(run.runtime.submit('cc-request', 'duplicate')).rejects.toThrow()
    expect(native.sent).toHaveLength(2)
  })

  it('acknowledges every UUID in separate replays even when native merges their human turn', async () => {
    const run = await open(); run.runtime.start('start'); init(); startChild('A'); result()
    const one = run.runtime.submit('one', 'one'), two = run.runtime.submit('two', 'two')
    await expect.poll(() => native.sent.length).toBe(3)
    for (const sent of native.sent.slice(1)) native.emit({ type: 'user', uuid: sent.uuid, isReplay: true, parent_tool_use_id: null, session_id: 'native-parent', message: { role: 'user', content: 'one\ntwo' } })
    await Promise.all([one, two])
    assistant('merged reply'); result('merged reply')
    await expect.poll(() => textEvents(run.events)).toEqual(['merged reply'])
    expect(run.ended()).toBe(false)
  })

  it('bounds pending acknowledgement and rejects it on close without resending', async () => {
    const run = await open(); run.runtime.start('start'); init(); startChild('A')
    const pending = Array.from({ length: 10 }, (_, index) => run.runtime.submit(`request-${index}`, `input-${index}`).then(() => 'received', error => String(error)))
    await expect.poll(() => native.sent.length).toBe(11)
    await expect(run.runtime.submit('overflow', 'overflow')).rejects.toThrow()
    expect(run.runtime.snapshot().input).toBe('queue')
    await run.session.close()
    expect((await Promise.all(pending)).every(value => value.includes('closed'))).toBe(true)
    expect(native.sent).toHaveLength(11)
  })

  it('rejects unacknowledged input and settles active child activities when the SDK stream fails', async () => {
    const run = await open(); run.runtime.start('start'); init(); startChild('A')
    const pending = run.runtime.submit('pending', 'pending').then(() => 'received', error => String(error))
    await expect.poll(() => native.sent.length).toBe(2)
    native.fail(new Error('native process lost'))
    await run.drained
    expect(await pending).toContain('native process lost')
    expect(run.events.some(event => event.kind === 'error' && event.message.includes('native process lost'))).toBe(true)
    expect(activityEvents(run.events).at(-1)?.status).toBe('interrupted')
  })

  it('caps public child output and refuses mixed use of the legacy dispatch API', async () => {
    const run = await open(); run.runtime.start('start'); init(); startChild('A')
    assistant('a'.repeat(40_001), 'launch-A')
    await expect.poll(() => activityEvents(run.events).findLast(activity => activity.output)?.output?.length).toBe(40_000)
    expect(() => run.session.dispatch('wrong entry')).toThrow()
  })

  it('rejects close when SDK cleanup never confirms reader shutdown instead of reporting resource release', async () => {
    const run = await open(); run.runtime.start('start')
    vi.useFakeTimers(); native.stallClose = true
    let outcome = 'pending'
    void run.session.close().then(() => { outcome = 'closed' }, error => { outcome = String(error) })
    try {
      await vi.advanceTimersByTimeAsync(3_000)
      expect(outcome).toContain('not_closed')
    } finally { native.releaseClose(); native.end(); vi.useRealTimers() }
  })
  it('rejects a second event reader without disturbing the lifetime reader', async () => {
    const run = await open(); run.runtime.start('start'); init()
    expect(() => run.runtime.events[Symbol.asyncIterator]()).toThrow('single_consumer')
    assistant('first reader remains'); result()
    await run.drained
    expect(textEvents(run.events)).toEqual(['first reader remains'])
  })

  it('fails closed when retained native task state reaches its finite limit', async () => {
    const run = await open(); run.runtime.start('start'); init()
    for (let index = 0; index < 513; index++) { startChild(`bounded-${index}`); finishChild(`bounded-${index}`) }
    await expect.poll(() => run.events.some(event => event.kind === 'error' && event.message.includes('task_limit'))).toBe(true)
    await run.drained
    expect(run.runtime.snapshot().input).toBe('queue')
  })

  it('fails closed when retained operation state reaches its finite limit', async () => {
    const run = await open(); run.runtime.start('start'); init('unknown')
    for (let index = 0; index < 4097; index++) native.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: `bounded-${index}`, input: {} }] } })
    await expect.poll(() => run.events.some(event => event.kind === 'error' && event.message.includes('operation_limit'))).toBe(true)
    await run.drained
  })

  it('bounds the lifetime request ledger after acknowledged sends', async () => {
    const run = await open(); run.runtime.start('start'); init()
    await expect.poll(() => native.sent.length).toBe(1)
    for (let offset = 0; offset < 1024; offset += 8) {
      const sentBefore = native.sent.length
      const acks = Array.from({ length: 8 }, (_, index) => run.runtime.submit(`lifetime-${offset + index}`, 'input'))
      while (native.sent.length < sentBefore + 8) await Promise.resolve()
      for (const sent of native.sent.slice(sentBefore)) native.emit({ type: 'user', uuid: sent.uuid, isReplay: true, session_id: 'native-parent', message: sent.message })
      await Promise.all(acks)
    }
    await expect(run.runtime.submit('overflow', 'input')).rejects.toThrow('request_limit')
    await run.drained
    expect(run.events.some(event => event.kind === 'error' && event.message.includes('request_limit'))).toBe(true)
  })

  it('marks a new public parent init as running before an automatic response arrives', async () => {
    const run = await open(); run.runtime.start('start'); init(); startChild('A'); result()
    await expect.poll(() => run.runtime.snapshot().foreground).toBe('idle')
    init()
    await expect.poll(() => run.runtime.snapshot().foreground).toBe('running')
  })

  it('retains a previously foreground task when native backgrounds it through a patch', async () => {
    const run = await open(); run.runtime.start('start'); init()
    native.emit({ type: 'system', subtype: 'task_started', task_id: 'converted', tool_use_id: 'launch-converted', task_type: 'local_agent', is_backgrounded: false })
    native.emit({ type: 'system', subtype: 'task_updated', task_id: 'converted', patch: { is_backgrounded: true } })
    result()
    await expect.poll(() => run.events.some(event => event.kind === 'result')).toBe(true)
    expect(run.runtime.snapshot()).toMatchObject({ retained: true, backgroundCount: 1 })
    expect(run.ended()).toBe(false)
  })

  it('opens with includePartialMessages so the SDK emits text deltas', async () => {
    await open()
    expect(native.options.includePartialMessages).toBe(true)
  })

  it('streams text_delta as append events under one itemId, then replaces with the whole block on the assistant message', async () => {
    const run = await open(); run.runtime.start('start'); init()
    native.emit({ type: 'stream_event', uuid: 'u1', session_id: 'native-parent', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } } })
    native.emit({ type: 'stream_event', uuid: 'u2', session_id: 'native-parent', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    native.emit({ type: 'stream_event', uuid: 'u3', session_id: 'native-parent', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } } })
    native.emit({ type: 'stream_event', uuid: 'u4', session_id: 'native-parent', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } } })
    native.emit({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { id: 'msg_1', model: 'parent-model', content: [{ type: 'text', text: '你好' }] } })
    await expect.poll(() => run.events.filter(event => event.kind === 'text')).toEqual([
      { kind: 'text', text: '你', itemId: 'claude:msg_1:text:0', textMode: 'append' },
      { kind: 'text', text: '好', itemId: 'claude:msg_1:text:0', textMode: 'append' },
      { kind: 'text', text: '你好', itemId: 'claude:msg_1:text:0', textMode: 'replace' },
    ])
  })

  it('ignores sub-agent stream_events and deltas missing text, without losing the final assistant replace', async () => {
    const run = await open(); run.runtime.start('start'); init()
    native.emit({ type: 'stream_event', uuid: 'u1', session_id: 'native-parent', parent_tool_use_id: 'tool-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '子' } } })
    native.emit({ type: 'stream_event', uuid: 'u2', session_id: 'native-parent', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta' } } })
    native.emit({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { id: 'msg_2', content: [{ type: 'text', text: '整条' }] } })
    await expect.poll(() => run.events.filter(event => event.kind === 'text')).toEqual([
      { kind: 'text', text: '整条', itemId: 'claude:a1:text:0', textMode: 'replace' },
    ])
  })

})
