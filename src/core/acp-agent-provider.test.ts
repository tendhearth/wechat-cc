import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSession, SpawnContext } from './agent-provider'
import { TIER_PROFILES } from './user-tier'
import { createAcpProvider, type AcpProviderOptions } from './acp-agent-provider'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

type Rpc = { id?: string | number; method?: string; params?: any; result?: any; error?: any }
class FakeProcess extends EventEmitter {
  // Overwritten per-instance by the mocks.spawn implementation (a beforeEach-reset counter) —
  // every fake process in a single-pid world would make mocks.kill's `-pid` lookup resolve to
  // whichever child happened to be first, silently mis-targeting every close() but the first.
  pid = 4242
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough()
  exitCode: number | null = null
  // The "did this process actually terminate" flag. Kept separate from exitCode because a real
  // signal-killed process reports exitCode:null (Node convention) — overloading exitCode as a
  // liveness proxy made the fake unable to model that case (see exit() below).
  hasExited = false
  sent: Rpc[] = []
  initializeResult: Record<string, unknown> = { protocolVersion: 1, agentCapabilities: { loadSession: true } }
  newResult: Record<string, unknown> | { error: Rpc['error'] } = { sessionId: 'sess-1' }
  loadResult: Record<string, unknown> | { error: Rpc['error'] } = {}
  // null ⇒ never auto-reply (used to model "the request is still in flight when the process dies").
  configResult: Record<string, unknown> | { error: Rpc['error'] } | null = { configOptions: [] }
  promptAuto = true
  // 死掉 / 哑掉的进程不再往 stdout 写:setup 阶段的测试要让 initialize 一直挂着,
  // 也要保证 exit() 之后那些已排好队的 setTimeout 回复不会往已 end 的流里写(write-after-end 会抛)。
  silent = false
  constructor() {
    super()
    let lines = ''
    this.stdin.on('data', chunk => {
      lines += String(chunk)
      while (lines.includes('\n')) {
        const end = lines.indexOf('\n'), line = lines.slice(0, end); lines = lines.slice(end + 1)
        const message = JSON.parse(line) as Rpc
        this.sent.push(message)
        // setTimeout(0), not queueMicrotask: callers poll for `children.length` and then
        // synchronously mutate initializeResult/newResult/loadResult before the response goes
        // out. expect.poll's own resolution costs a microtask turn, so a queueMicrotask-scheduled
        // response here would race ahead of that mutation and always win with the stale default.
        // A macrotask guarantees it runs after all pending microtasks (poll's continuation, the
        // test's synchronous mutation) have drained.
        if (message.method === 'initialize') setTimeout(() => this.send({ id: message.id, result: this.initializeResult }), 0)
        if (message.method === 'session/new') setTimeout(() => this.send('error' in this.newResult ? { id: message.id, error: this.newResult.error } : { id: message.id, result: this.newResult }), 0)
        if (message.method === 'session/load') setTimeout(() => { this.notify('session/update', { sessionId: message.params.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' } } }); this.notify('session/update', { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } } }); this.send('error' in this.loadResult ? { id: message.id, error: this.loadResult.error } : { id: message.id, result: this.loadResult }) }, 0)
        if (message.method === 'session/set_config_option' && this.configResult !== null) setTimeout(() => this.send('error' in this.configResult! ? { id: message.id, error: this.configResult.error } : { id: message.id, result: this.configResult }), 0)
        if (message.method === 'session/cancel') queueMicrotask(() => { const prompt = this.sent.findLast(m => m.method === 'session/prompt'); if (prompt) this.send({ id: prompt.id, result: { stopReason: 'cancelled' } }) })
      }
    })
  }
  send(message: Rpc) { if (this.hasExited || this.silent) return; this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n') }
  notify(method: string, params: unknown) { this.send({ method, params }) }
  update(update: unknown, sessionId = 'sess-1') { this.notify('session/update', { sessionId, update }) }
  finishPrompt(stopReason = 'end_turn') { const prompt = this.sent.findLast(m => m.method === 'session/prompt')!; this.send({ id: prompt.id, result: { stopReason } }) }
  rejectPrompt(error: Rpc['error']) { const prompt = this.sent.findLast(m => m.method === 'session/prompt')!; this.send({ id: prompt.id, error }) }
  exit(code: number | null = 0, signal: string | null = null) { if (this.hasExited) return; this.hasExited = true; this.exitCode = code; this.stdout.end(); this.emit('exit', code, signal) }
}
let children: FakeProcess[], sessions: AgentSession[], platform: PropertyDescriptor, nextPid: number
const context = (extra: Partial<SpawnContext> = {}): SpawnContext => ({ tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', chatId: 'workbench:task', appendInstructions: 'task instructions', workbenchTimeline: true, ...extra })
async function start(extra: Partial<SpawnContext> = {}, setup?: (child: FakeProcess) => void, providerOptions: Partial<AcpProviderOptions> = {}) {
  const spawnedBefore = children.length
  const spawning = createAcpProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 200, closeTimeoutMs: 250, permissions: 'mode', text: 'messages', ...providerOptions }).spawn({ alias: 'workbench:task', path: '/project' }, context(extra))
  await expect.poll(() => children.length).toBe(spawnedBefore + 1)
  setup?.(children.at(-1)!)
  const session = await spawning
  sessions.push(session)
  return { session, child: children.at(-1)! }
}
function collect(session: AgentSession, text = 'do the thing') {
  const events: AgentEvent[] = []
  const done = (async () => { for await (const event of session.dispatch(text)) events.push(event) })()
  return { events, done }
}
async function prompted(child: FakeProcess, n = 1) { await expect.poll(() => child.sent.filter(m => m.method === 'session/prompt').length).toBe(n) }
function permission(child: FakeProcess, id: string | number = 'perm-1', extra: Record<string, unknown> = {}) {
  child.send({ id, method: 'session/request_permission', params: { sessionId: 'sess-1', toolCall: { toolCallId: 'c1', title: '`uname -a`', kind: 'execute', status: 'pending', rawInput: { command: 'uname -a' } }, options: [{ optionId: 'allow-always', name: 'Always', kind: 'allow_always' }, { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }], ...extra } })
}
beforeEach(() => {
  children = []; sessions = []; nextPid = 4242
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  // Unique pid per fake (reset to 4242 each test, so the single-child tests' `-4242` assertions
  // still hold) — otherwise mocks.kill's `-pid` lookup below always resolves to children[0],
  // and every close() but the first silently signals/probes the wrong process.
  mocks.spawn.mockReset().mockImplementation(() => { const child = new FakeProcess(); child.pid = nextPid++; children.push(child); return child })
  mocks.kill.mockReset().mockImplementation((pid: number, signal?: string | number) => {
    const child = children.find(c => -c.pid === pid || c.pid === pid)
    if (!child || child.hasExited) { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) }
    // code:null mirrors real Node's signal-kill convention; hasExited (not exitCode) is what the
    // ESRCH check above and the provider's own groupAlive() liveness probe key off.
    if (signal === 'SIGTERM' || signal === 'SIGKILL') queueMicrotask(() => child.exit(null, String(signal)))
    return true
  })
  vi.spyOn(process, 'kill').mockImplementation(mocks.kill as never)
})
afterEach(async () => { for (const session of sessions) await session.close().catch(() => {}); Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks() })

describe('ACP provider — chat-side options', () => {
  it('passes mcpServers to session/new and session/load, sets the model only when offered, skips the notice', async () => {
    const reportNotice = vi.fn()
    const servers = [{ name: 'wechat', command: '/cli', args: ['mcp-server', 'wechat'], env: [{ name: 'WECHAT_SESSION_TOKEN', value: 't' }] }]
    const { child } = await start({ reportNotice, model: 'gpt-5' }, c => { c.newResult = { sessionId: 'sess-1', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'auto', options: [{ value: 'auto', name: 'Auto' }, { value: 'gpt-5', name: 'GPT-5' }] }] } }, { mcpServers: () => servers, model: ctx => ctx.model, notice: null })
    expect(child.sent.find(m => m.method === 'session/new')!.params).toEqual({ cwd: '/project', mcpServers: servers })
    await expect.poll(() => child.sent.some(m => m.method === 'session/set_config_option')).toBe(true)
    expect(child.sent.find(m => m.method === 'session/set_config_option')!.params).toEqual({ sessionId: 'sess-1', configId: 'model', value: 'gpt-5' })
    expect(reportNotice).not.toHaveBeenCalled()
    const log = vi.fn()
    const second = await start({ model: 'nope' }, c => { c.newResult = { sessionId: 'sess-2', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'auto', options: [{ value: 'auto', name: 'Auto' }] }] } }, { model: ctx => ctx.model, log })
    await new Promise(r => setTimeout(r, 20))
    expect(second.child.sent.some(m => m.method === 'session/set_config_option')).toBe(false)
    expect(log).toHaveBeenCalledWith('ACP', expect.stringContaining('nope'))
    const resumed = await start({ resumeSessionId: 'sess-old', model: 'gpt-5' }, undefined, { mcpServers: () => servers, model: ctx => ctx.model })
    expect(resumed.child.sent.find(m => m.method === 'session/load')!.params).toEqual({ sessionId: 'sess-old', cwd: '/project', mcpServers: servers })
    expect(resumed.child.sent.some(m => m.method === 'session/set_config_option')).toBe(false)
  })
  it('mode permissions: dangerously ⇒ allow-once, strict ⇒ reject-once, never calls the bridge, unverifiable ⇒ cancelled without stopping', async () => {
    const requestPermission = vi.fn(async () => true)
    const { session, child } = await start({ permissionMode: 'dangerously', requestPermission })
    const { done } = collect(session); await prompted(child)
    permission(child, 'p1')
    await expect.poll(() => child.sent.some(m => m.id === 'p1')).toBe(true)
    expect(child.sent.find(m => m.id === 'p1')!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    permission(child, 'p2', { toolCall: { toolCallId: 'c9', kind: 'execute', rawInput: { command: 'x'.repeat(20_001) } } })
    await expect.poll(() => child.sent.some(m => m.id === 'p2')).toBe(true)
    expect(child.sent.find(m => m.id === 'p2')!.result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(requestPermission).not.toHaveBeenCalled()
    child.finishPrompt(); await done
    expect(session).toBeTruthy()
    const strict = await start({ permissionMode: 'strict' })
    const s = collect(strict.session); await prompted(strict.child)
    permission(strict.child, 'p3')
    await expect.poll(() => strict.child.sent.some(m => m.id === 'p3')).toBe(true)
    expect(strict.child.sent.find(m => m.id === 'p3')!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    strict.child.finishPrompt(); await s.done
    expect(s.events.at(-1)).toMatchObject({ kind: 'result' })
  })
  it('messages text: one text event per assistant message, flushed before tool calls and before the result', async () => {
    const { session, child } = await start()
    const { events, done } = collect(session); await prompted(child)
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先' } })
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '看' } })
    child.update({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'other', status: 'pending', rawInput: { providerIdentifier: 'wechat', toolName: 'reply' } })
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好了' } })
    child.finishPrompt(); await done
    expect(events.map(e => e.kind)).toEqual(['init', 'text', 'tool_call', 'text', 'result'])
    expect(events[1]).toEqual({ kind: 'text', text: '先看' }); expect(events[3]).toEqual({ kind: 'text', text: '好了' })
    expect(events[2]).toMatchObject({ server: 'wechat', tool: 'reply' })
  })
  it('resume fallback: a failed session/load logs once and opens a new session whose id is reported', async () => {
    const log = vi.fn()
    const { session, child } = await start({ resumeSessionId: 'gone' }, c => { c.loadResult = { error: { code: -32602, message: 'unknown session' } }; c.newResult = { sessionId: 'sess-fresh' } }, { resume: 'fallback', log })
    expect(child.sent.some(m => m.method === 'session/load')).toBe(true)
    expect(child.sent.some(m => m.method === 'session/new')).toBe(true)
    expect(log).toHaveBeenCalledWith('ACP', expect.stringContaining('gone'))
    const { events, done } = collect(session); await prompted(child); child.finishPrompt(); await done
    expect(events[0]).toEqual({ kind: 'init', sessionId: 'sess-fresh' })
    expect(events.at(-1)).toMatchObject({ kind: 'result', sessionId: 'sess-fresh' })
    const noLoad = await start({ resumeSessionId: 'x' }, c => { c.initializeResult = { protocolVersion: 1, agentCapabilities: {} }; c.newResult = { sessionId: 'sess-n' } }, { resume: 'fallback' })
    expect(noLoad.child.sent.some(m => m.method === 'session/new')).toBe(true)
  })
  it('strict resume (default) still rejects on load failure', async () => {
    const provider = createAcpProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 200, closeTimeoutMs: 250, permissions: 'bridge', text: 'append' })
    const p = provider.spawn({ alias: 'a', path: '/project' }, context({ resumeSessionId: 'gone' }))
    await expect.poll(() => children.length).toBe(1); children[0]!.loadResult = { error: { code: -32602, message: 'unknown session' } }
    await expect(p).rejects.toThrow('acp_session_failed: unknown session')
  })
})

describe('ACP provider — review fixes', () => {
  it('a connection death while pinning the model is not swallowed: spawn() rejects with the real cause and the process is closed', async () => {
    const provider = createAcpProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 2_000, closeTimeoutMs: 250, permissions: 'mode', text: 'messages', model: () => 'gpt-5' })
    const spawning = provider.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(1)
    const child = children[0]!
    // Never auto-reply to session/set_config_option — models the request being in flight when
    // the process dies, which is exactly the race the fix guards against.
    child.configResult = null
    child.newResult = { sessionId: 'sess-1', configOptions: [{ id: 'model', category: 'model', options: [{ value: 'gpt-5', name: 'GPT-5' }] }] }
    await expect.poll(() => child.sent.some(m => m.method === 'session/set_config_option')).toBe(true)
    child.stderr.write('boom\n')
    child.exit(1)
    // The real cause (the process dying) must survive, not the generic acp_session_closed the
    // dispose() rejection would otherwise be mistaken for by a too-broad .catch.
    await expect(spawning).rejects.toThrow(/^acp_process_exited: 1[\s\S]*boom/)
    expect(child.hasExited).toBe(true)
  })
  it('a session/set_config_option JSON-RPC error still lets spawn() resolve and logs once', async () => {
    const log = vi.fn()
    const { child } = await start({ model: 'gpt-5' }, c => {
      c.newResult = { sessionId: 'sess-1', configOptions: [{ id: 'model', category: 'model', options: [{ value: 'gpt-5', name: 'GPT-5' }] }] }
      c.configResult = { error: { code: -32602, message: 'bad option' } }
    }, { model: ctx => ctx.model, log })
    await expect.poll(() => log.mock.calls.length).toBe(1)
    expect(log).toHaveBeenCalledWith('ACP', expect.stringContaining('bad option'))
    expect(child.hasExited).toBe(false)
  })
  it('model returning "auto" sends no session/set_config_option', async () => {
    const { child } = await start({}, c => { c.newResult = { sessionId: 'sess-1', configOptions: [{ id: 'model', category: 'model', options: [{ value: 'auto', name: 'Auto' }] }] } }, { model: () => 'auto' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(child.sent.some(m => m.method === 'session/set_config_option')).toBe(false)
  })
  it('a matched config option without a usable string id is skipped instead of sending configId:"undefined"', async () => {
    const log = vi.fn()
    const { child } = await start({}, c => { c.newResult = { sessionId: 'sess-1', configOptions: [{ category: 'model', options: [{ value: 'gpt-5', name: 'GPT-5' }] }] } }, { model: () => 'gpt-5', log })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(child.sent.some(m => m.method === 'session/set_config_option')).toBe(false)
    expect(log).toHaveBeenCalledWith('ACP', expect.stringContaining('gpt-5'))
  })
  it('mode permissions: an undisplayable request logs exactly one ACP line and does not stop the task', async () => {
    const log = vi.fn()
    const { session, child } = await start({}, undefined, { log })
    const { done } = collect(session); await prompted(child)
    permission(child, 'p1', { toolCall: { toolCallId: 'c9', kind: 'execute', rawInput: { command: 'x'.repeat(20_001) } } })
    await expect.poll(() => child.sent.some(m => m.id === 'p1')).toBe(true)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('ACP', expect.stringContaining('undisplayable'))
    child.finishPrompt(); await done
  })
  it('a locally cancelled turn never flushes the buffered messages-mode text, even if the reply says end_turn', async () => {
    const { session, child } = await start()
    const { events, done } = collect(session); await prompted(child)
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'half' } })
    void session.cancel!()
    child.finishPrompt('end_turn')
    await done
    expect(events.some(e => e.kind === 'text')).toBe(false)
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'acp_turn_cancelled' })
  })
})
