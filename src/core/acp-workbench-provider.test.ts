import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSession, SpawnContext } from './agent-provider'
import { TIER_PROFILES } from './user-tier'
import { acpNotice, createAcpWorkbenchProvider, type AcpWorkbenchProviderOptions } from './acp-workbench-provider'

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
async function start(extra: Partial<SpawnContext> = {}, setup?: (child: FakeProcess) => void, providerExtra: Partial<AcpWorkbenchProviderOptions> = {}) {
  const spawnedBefore = children.length
  const spawning = createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 200, closeTimeoutMs: 250, ...providerExtra }).spawn({ alias: 'workbench:task', path: '/project' }, context(extra))
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

describe('ACP workbench provider', () => {
  it('initializes without fs/terminal capabilities, opens a session and reports the edit-unattended notice', async () => {
    const reportNotice = vi.fn()
    const { child } = await start({ reportNotice })
    expect(mocks.spawn).toHaveBeenCalledWith('/cursor-agent', ['acp'], expect.objectContaining({ cwd: '/project', detached: true, stdio: ['pipe', 'pipe', 'pipe'] }))
    const init = child.sent.find(m => m.method === 'initialize')!
    expect(init.params).toEqual({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'cc_workbench', title: 'CC Workbench', version: '0.6.4' } })
    expect(child.sent.find(m => m.method === 'session/new')!.params).toEqual({ cwd: '/project', mcpServers: [] })
    expect(reportNotice).toHaveBeenCalledWith(acpNotice('Cursor'))
    // 三句对外文案都由 displayName 拼出来,换一个 ACP 执行者不用再改一遍字。
    expect(acpNotice('Gemini')).toContain('Gemini 通过 ACP 执行')
  })
  it('does not hand daemon credentials to the ACP subprocess', async () => {
    const previous = process.env.WECHAT_INTERNAL_TOKEN_FILE
    process.env.WECHAT_INTERNAL_TOKEN_FILE = '/state/internal-token'
    try {
      await start()
      const env = mocks.spawn.mock.calls.at(-1)![2].env as NodeJS.ProcessEnv
      expect(Object.keys(env).some(name => /^WECHAT_/i.test(name))).toBe(false)
      expect(env.PATH).toBe(process.env.PATH)
    } finally {
      if (previous === undefined) delete process.env.WECHAT_INTERNAL_TOKEN_FILE
      else process.env.WECHAT_INTERNAL_TOKEN_FILE = previous
    }
  })
  it('surfaces the real cause and the stderr tail when the process dies during initialize', async () => {
    const provider = createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 2_000, closeTimeoutMs: 250 })
    const spawning = provider.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(1)
    const child = children[0]!
    child.silent = true
    child.stderr.write("error: unrecognized subcommand 'acp'\n")
    await new Promise(resolve => setImmediate(resolve))
    child.exit(1)
    // 老版本 cursor-agent 没有 acp 子命令:真因必须活下来(以前被 dispose 的 acp_session_closed 盖掉)。
    await expect(spawning).rejects.toThrow(/^acp_process_exited: 1[\s\S]*unrecognized subcommand/)
  })
  it('maps a failed spawn (ENOENT) to acp_process_start_failed', async () => {
    const provider = createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 2_000, closeTimeoutMs: 250 })
    const spawning = provider.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(1)
    children[0]!.silent = true
    children[0]!.emit('error', Object.assign(new Error('spawn /cursor-agent ENOENT'), { code: 'ENOENT' }))
    await expect(spawning).rejects.toThrow('acp_process_start_failed')
  })
  it('rejects unsupported protocol versions and missing session ids, closing the process', async () => {
    const bad = createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 200, closeTimeoutMs: 250 })
    const p1 = bad.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(1); children[0]!.initializeResult = { protocolVersion: 2 }
    await expect(p1).rejects.toThrow('acp_protocol_version_unsupported')
    await expect.poll(() => children[0]!.hasExited).toBe(true)
    const p2 = bad.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(2); children[1]!.newResult = { sessionId: 'bad\nid' }
    await expect(p2).rejects.toThrow('acp_missing_session_id')
    // Second child's cleanup must target ITS OWN pid, not silently re-signal children[0].
    await expect.poll(() => children[1]!.hasExited).toBe(true)
  })
  it('maps -32000 on session setup to acp_auth_required and other errors to acp_session_failed', async () => {
    const provider = createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 200, closeTimeoutMs: 250 })
    const p1 = provider.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(1); children[0]!.newResult = { error: { code: -32000, message: 'Authentication required' } }
    await expect(p1).rejects.toThrow('acp_auth_required')
    await expect.poll(() => children[0]!.hasExited).toBe(true)
    const p2 = provider.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(2); children[1]!.newResult = { error: { code: -32602, message: 'bad cwd' } }
    await expect(p2).rejects.toThrow('acp_session_failed: bad cwd')
    // Second child's cleanup must target ITS OWN pid, not silently re-signal children[0].
    await expect.poll(() => children[1]!.hasExited).toBe(true)
  })
  it('resumes through session/load, discards the replayed history, and refuses when loadSession is absent', async () => {
    const { session, child } = await start({ resumeSessionId: 'sess-old' })
    expect(child.sent.find(m => m.method === 'session/load')!.params).toEqual({ sessionId: 'sess-old', cwd: '/project', mcpServers: [] })
    expect(child.sent.some(m => m.method === 'session/new')).toBe(false)
    const { events, done } = collect(session)
    await prompted(child)
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live' } }, 'sess-old'); child.finishPrompt()
    await done
    expect(events.filter(e => e.kind === 'text').map(e => (e as any).text)).toEqual(['live'])
    expect(events[0]).toEqual({ kind: 'init', sessionId: 'sess-old' })
    const provider = createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 200, closeTimeoutMs: 250 })
    const p = provider.spawn({ alias: 'a', path: '/project' }, context({ resumeSessionId: 'sess-old' }))
    await expect.poll(() => children.length).toBe(2); children[1]!.initializeResult = { protocolVersion: 1, agentCapabilities: {} }
    await expect(p).rejects.toThrow('acp_resume_unsupported')
    // Second child's cleanup must target ITS OWN pid, not silently re-signal children[0] (which
    // is still alive and owned by `session` above).
    await expect.poll(() => children[1]!.hasExited).toBe(true)
  })
  it('prefixes instructions on the first prompt only and streams init, text, activities and result', async () => {
    const { session, child } = await start()
    const first = collect(session, 'first ask')
    await prompted(child)
    expect(child.sent.findLast(m => m.method === 'session/prompt')!.params).toEqual({ sessionId: 'sess-1', prompt: [{ type: 'text', text: 'task instructions\n\n---\n\nfirst ask' }] })
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '这' } })
    child.update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Edit File', kind: 'edit', status: 'pending', locations: [{ path: '/project/a.ts' }] })
    child.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } })
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ignored' } }, 'other-session')
    child.finishPrompt()
    await first.done
    expect(first.events).toEqual([
      { kind: 'init', sessionId: 'sess-1' },
      { kind: 'text', text: '这', itemId: 'acp:turn:1:0', textMode: 'append' },
      { kind: 'tool_call', tool: 'edit', activity: { id: 'c1', type: 'edit', status: 'running', label: '修改文件', detail: '/project/a.ts' } },
      { kind: 'tool_call', tool: 'edit', activity: { id: 'c1', type: 'edit', status: 'completed', label: '修改文件', detail: '/project/a.ts' } },
      { kind: 'text', text: '好', itemId: 'acp:turn:1:1', textMode: 'append' },
      expect.objectContaining({ kind: 'result', sessionId: 'sess-1', numTurns: 1 }),
    ])
    const second = collect(session, 'second ask')
    await prompted(child, 2)
    expect(child.sent.findLast(m => m.method === 'session/prompt')!.params.prompt).toEqual([{ type: 'text', text: 'second ask' }])
    child.finishPrompt(); await second.done
  })
  it('turns permission requests into the task bridge and answers only with once options', async () => {
    const requestPermission = vi.fn(async (request: { tool: string; description: string }) => request.description.includes('rm') ? false : true)
    const { session, child } = await start({ requestPermission })
    const { done } = collect(session)
    await prompted(child)
    permission(child, 'perm-1')
    await expect.poll(() => child.sent.some(m => m.id === 'perm-1')).toBe(true)
    expect(requestPermission).toHaveBeenCalledWith({ tool: 'execute', description: 'uname -a' }, expect.any(AbortSignal))
    expect(child.sent.find(m => m.id === 'perm-1')).toEqual({ jsonrpc: '2.0', id: 'perm-1', result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
    permission(child, 'perm-2', { toolCall: { toolCallId: 'c2', title: '`rm x`', kind: 'execute', status: 'pending', rawInput: { command: 'rm x' } } })
    await expect.poll(() => child.sent.some(m => m.id === 'perm-2')).toBe(true)
    expect(child.sent.find(m => m.id === 'perm-2')!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    permission(child, 'perm-3', { options: [{ optionId: 'a', kind: 'allow_always' }] })
    await expect.poll(() => child.sent.some(m => m.id === 'perm-3')).toBe(true)
    expect(child.sent.find(m => m.id === 'perm-3')!.result).toEqual({ outcome: { outcome: 'cancelled' } })
    child.finishPrompt(); await done
  })
  it('rejects when no bridge is bound, cancels unverifiable requests and stops the task, and answers unknown methods with -32601', async () => {
    const { session, child } = await start()
    const { events, done } = collect(session)
    await prompted(child)
    permission(child, 'perm-1')
    await expect.poll(() => child.sent.some(m => m.id === 'perm-1')).toBe(true)
    expect(child.sent.find(m => m.id === 'perm-1')!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    child.send({ id: 'fs-1', method: 'fs/read_text_file', params: { path: '/etc/passwd' } })
    await expect.poll(() => child.sent.some(m => m.id === 'fs-1')).toBe(true)
    expect(child.sent.find(m => m.id === 'fs-1')!.error).toEqual({ code: -32601, message: 'client capability not declared: fs/read_text_file' })
    permission(child, 'perm-2', { toolCall: { toolCallId: 'c9', kind: 'execute', rawInput: { command: 'x'.repeat(20_001) } } })
    await expect.poll(() => child.sent.some(m => m.id === 'perm-2')).toBe(true)
    expect(child.sent.find(m => m.id === 'perm-2')!.result).toEqual({ outcome: { outcome: 'cancelled' } })
    await done
    expect(events.at(-1)).toEqual({ kind: 'error', message: '无法核实或完整显示本次 Cursor 权限请求，工作台已停止任务。' })
    await expect(async () => { for await (const _ of session.dispatch('again')) { /* noop */ } }).rejects.toThrow('acp_session_closed')
  })
  it('stops the task when the agent reuses a pending permission request id', async () => {
    const requestPermission = vi.fn(() => new Promise<boolean>(() => { /* never answered */ }))
    const { session, child } = await start({ requestPermission })
    const { events, done } = collect(session)
    await prompted(child)
    permission(child, 'perm-dup')
    await expect.poll(() => requestPermission.mock.calls.length).toBe(1)
    permission(child, 'perm-dup')
    await done
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'acp_duplicate_permission_request' })
    expect(child.sent.filter(m => m.id === 'perm-dup').every(m => m.result?.outcome?.outcome === 'cancelled')).toBe(true)
  })
  it('stops the task when pending permission requests pile past the limit', async () => {
    const requestPermission = vi.fn(() => new Promise<boolean>(() => { /* never answered */ }))
    const { session, child } = await start({ requestPermission }, undefined, { permissionLimit: 3 })
    const { events, done } = collect(session)
    await prompted(child)
    for (let index = 0; index < 4; index++) permission(child, `perm-${index}`)
    await done
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'acp_request_limit' })
    expect(requestPermission).toHaveBeenCalledTimes(3)
  })
  it('logs a foreign-session update once per session instead of dropping it in silence', async () => {
    const log = vi.fn()
    const { session, child } = await start({}, undefined, { log })
    const { done } = collect(session)
    await prompted(child)
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }, 'other-session')
    await expect.poll(() => log.mock.calls.length).toBe(1)
    expect(log.mock.calls[0]).toEqual(['ACP', expect.stringContaining('sessionId')])
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'y' } }, 'another-session')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(log).toHaveBeenCalledTimes(1)
    child.finishPrompt(); await done
  })
  it('cancel sends session/cancel, aborts pending permissions and ends the turn with an error event', async () => {
    const requestPermission = vi.fn((_request: unknown, signal?: AbortSignal) => new Promise<boolean>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))))
    const { session, child } = await start({ requestPermission })
    const { events, done } = collect(session)
    await prompted(child)
    permission(child, 'perm-1')
    await expect.poll(() => requestPermission.mock.calls.length).toBe(1)
    await session.cancel!()
    expect(child.sent.some(m => m.method === 'session/cancel' && m.params.sessionId === 'sess-1')).toBe(true)
    await done
    expect(child.sent.find(m => m.id === 'perm-1')!.result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'acp_turn_cancelled' })
  })
  it('maps stop reasons: agent-side cancelled counts as end, max_tokens and refusal are errors', async () => {
    const { session, child } = await start()
    const a = collect(session); await prompted(child, 1); child.finishPrompt('cancelled'); await a.done
    expect(a.events.at(-1)).toMatchObject({ kind: 'result' })
    const b = collect(session); await prompted(child, 2); child.finishPrompt('max_tokens'); await b.done
    expect(b.events.at(-1)).toEqual({ kind: 'error', message: 'acp_stop_max_tokens' })
    const c = collect(session); await prompted(child, 3); child.finishPrompt('refusal'); await c.done
    expect(c.events.at(-1)).toEqual({ kind: 'error', message: 'acp_stop_refusal' })
  })
  it('surfaces a session/prompt JSON-RPC error as a turn error event', async () => {
    const { session, child } = await start()
    const { events, done } = collect(session)
    await prompted(child)
    child.rejectPrompt({ code: -32603, message: 'model unavailable' })
    await done
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'model unavailable' })
  })
  it('appends a captured stderr tail to acp_session_failed, but leaves acp_auth_required a bare code', async () => {
    const provider = createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 200, closeTimeoutMs: 250 })
    const p1 = provider.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(1)
    children[0]!.newResult = { error: { code: -32000, message: 'Authentication required' } }
    children[0]!.stderr.write('please run: cursor-agent login\n')
    await expect(p1).rejects.toThrow(/^acp_auth_required$/)
    const p2 = provider.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(2)
    children[1]!.newResult = { error: { code: -32602, message: 'bad cwd' } }
    children[1]!.stderr.write('fatal: workspace is locked by another process\n')
    await expect(p2).rejects.toThrow(/acp_session_failed: bad cwd[\s\S]*fatal: workspace is locked by another process/)
  })
  it('surfaces an unexpected process exit as an error event and refuses further dispatch', async () => {
    const { session, child } = await start()
    const { events, done } = collect(session)
    await prompted(child)
    child.exit(1)
    await done
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'acp_process_exited: 1' })
    await expect(async () => { for await (const _ of session.dispatch('again')) { /* noop */ } }).rejects.toThrow('acp_session_closed')
  })
  it('close ends stdin, signals the process group and waits for exit; a stubborn group fails with acp_process_not_exited', async () => {
    const { session, child } = await start()
    await session.close()
    expect(child.stdin.writableEnded).toBe(true)
    expect(mocks.kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(child.hasExited).toBe(true)
    const stubborn = await start()
    mocks.kill.mockImplementation((pid: number, signal?: string | number) => { if (signal === 0) return true; return true })
    await expect(stubborn.session.close()).rejects.toThrow('acp_process_not_exited')
    expect(mocks.kill).toHaveBeenCalledWith(-stubborn.child.pid, 'SIGKILL')
    stubborn.child.exit(0)
  })
  it('refuses attachments, overlapping turns and win32', async () => {
    const { session, child } = await start()
    await expect(async () => { for await (const _ of session.dispatch('x', [{ name: 'a', mime: 'text/plain', path: '/a', sha256: 'f' }])) { /* noop */ } }).rejects.toThrow('acp_attachments_unsupported')
    const first = collect(session); await prompted(child)
    await expect(async () => { for await (const _ of session.dispatch('overlap')) { /* noop */ } }).rejects.toThrow('acp_turn_already_running')
    child.finishPrompt(); await first.done
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    await expect(createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor' }).spawn({ alias: 'a', path: '/project' }, context())).rejects.toThrow('Cursor 工作台暂不支持 Windows')
  })
})
