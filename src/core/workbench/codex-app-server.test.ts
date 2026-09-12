import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSession, SpawnContext } from '../agent-provider'
import { TIER_PROFILES } from '../user-tier'
import { createWorkbenchCodexProvider } from './codex-app-server'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

type Rpc = { id?: string | number; method?: string; params?: any; result?: any; error?: any }
class FakeProcess extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough()
  exitCode: number | null = null; signalCode: string | null = null
  sent: Rpc[] = []; autoExit = true; autoTurnStart = true
  kill = vi.fn((signal = 'SIGTERM') => { if (this.autoExit) queueMicrotask(() => this.exit(null, signal)); return true })
  constructor(readonly probe: boolean) {
    super()
    let lines = ''
    this.stdin.on('data', chunk => {
      lines += String(chunk)
      while (lines.includes('\n')) {
        const end = lines.indexOf('\n'), line = lines.slice(0, end); lines = lines.slice(end + 1)
        const message = JSON.parse(line) as Rpc
        this.sent.push(message)
        if (message.method === 'initialize') queueMicrotask(() => this.send({ id: message.id, result: {} }))
        if (message.method === 'thread/start' || message.method === 'thread/resume') queueMicrotask(() => this.send({ id: message.id, result: { thread: { id: message.params.threadId ?? 'thread-1' }, cwd: '/project', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, ...threadResponse } }))
        if (message.method === 'turn/start' && this.autoTurnStart) queueMicrotask(() => this.send({ id: message.id, result: { turn: { id: `turn-${this.sent.filter(m => m.method === 'turn/start').length}` } } }))
        if (message.method === 'turn/interrupt') queueMicrotask(() => this.send({ id: message.id, result: {} }))
      }
    })
  }
  send(message: Rpc) { this.stdout.write(JSON.stringify(message) + '\n') }
  notify(method: string, params: unknown) { this.send({ method, params }) }
  exit(code: number | null = 0, signal: string | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code; this.signalCode = signal
    this.stdout.end(); this.stderr.end(); this.emit('exit', code, signal); this.emit('close', code, signal)
  }
}
let children: FakeProcess[], sessions: AgentSession[], discovery: string, discoveryExit: number, threadResponse: Record<string, unknown>
const context = (extra = {}): SpawnContext => ({ tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', chatId: 'workbench:task', appendInstructions: 'task instructions', ...extra })
async function start(extra = {}, options = {}) {
  const session = await createWorkbenchCodexProvider({ codexPathOverride: '/codex', rpcTimeoutMs: 200, closeTimeoutMs: 250, ...options }).spawn({ alias: 'workbench:task', path: '/project' }, context(extra))
  sessions.push(session)
  return { session, child: children.at(-1)! }
}
function collect(session: AgentSession, text = 'original user text') {
  const events: AgentEvent[] = []
  const done = (async () => { for await (const event of session.dispatch(text)) events.push(event) })()
  return { events, done }
}
async function begun(child: FakeProcess, n = 1) { await expect.poll(() => child.sent.filter(m => m.method === 'turn/start').length).toBe(n); await Promise.resolve() }
function completed(child: FakeProcess, status = 'completed', turn = 'turn-1') { child.notify('turn/completed', { threadId: 'thread-1', turn: { id: turn, status, error: status === 'failed' ? { message: 'execution failed' } : null, durationMs: 4 } }) }
function approval(child: FakeProcess, id: string | number = 'approve-1', method = 'item/commandExecution/requestApproval', extra = {}) {
  child.send({ id, method, params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', kind: 'command', command: 'rm report.txt', cwd: '/project', reason: 'replace file', ...extra } })
}
beforeEach(() => {
  children = []; sessions = []; discovery = '[{"name":"personal","env":{"SECRET":"private"}}]'; discoveryExit = 0; threadResponse = {}
  mocks.spawn.mockReset().mockImplementation((_binary: string, args: string[]) => {
    const child = new FakeProcess(args.includes('mcp')); children.push(child)
    if (child.probe) queueMicrotask(() => { child.stdout.write(discovery); child.exit(discoveryExit) })
    return child
  })
})
afterEach(async () => { for (const session of sessions) await session.close().catch(() => {}); vi.restoreAllMocks() })

describe('workbench Codex app-server', () => {
  it('probes selected cwd, initializes and starts a strictly isolated native thread', async () => {
    const { child } = await start({ mcpEnv: { WECHAT_SESSION_TOKEN: 'do-not-forward' } })
    expect(mocks.spawn.mock.calls[0]![2]).toMatchObject({ cwd: '/project' })
    expect(mocks.spawn.mock.calls[1]![1]).toEqual(expect.arrayContaining(['app-server', '--listen', 'stdio://', 'mcp_servers.personal.enabled=false']))
    expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain('do-not-forward')
    expect(child.sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'thread/start'])
    expect(child.sent[0]!.params.capabilities.experimentalApi).toBe(false)
    expect(child.sent[2]!.params).toMatchObject({ cwd: '/project', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', developerInstructions: 'task instructions', config: { mcp_servers: { personal: { enabled: false } } } })
  })

  it('resumes exactly the supplied native thread without a new thread', async () => {
    const { child } = await start({ resumeSessionId: 'old-thread' })
    expect(child.sent.at(-1)).toMatchObject({ method: 'thread/resume', params: { threadId: 'old-thread' } })
  })

  it('rejects a resume response for a different native thread', async () => {
    threadResponse = { thread: { id: 'unexpected-thread' } }
    await expect(start({ resumeSessionId: 'old-thread' })).rejects.toThrow('codex_resume_thread_mismatch')
  })

  it.each([{}, { resumeSessionId: 'old-thread' }])('refuses a different returned cwd on start or resume: %j', async extra => {
    threadResponse = { cwd: '/another-project' }
    await expect(start(extra)).rejects.toThrow('codex_unverified_thread_cwd')
    expect(children.at(-1)!.kill).toHaveBeenCalled()
  })

  it('refuses Windows before spawning until owned process-tree cleanup is supported', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await expect(start()).rejects.toThrow('Codex 工作台暂不支持 Windows')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('preserves input and emits text/tools; only confirmed completion yields result across two turns', async () => {
    const { session, child } = await start()
    const first = collect(session); await begun(child)
    expect(child.sent.find(m => m.method === 'turn/start')!.params.input).toEqual([{ type: 'text', text: 'original user text', text_elements: [] }])
    child.notify('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'item-1', command: 'pwd' } })
    child.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'answer', text: 'Real answer' } })
    completed(child); await first.done
    expect(first.events).toEqual([{ kind: 'init', sessionId: 'thread-1' }, { kind: 'tool_call', tool: 'commandExecution' }, { kind: 'text', text: 'Real answer' }, { kind: 'result', sessionId: 'thread-1', numTurns: 1, durationMs: 4 }])
    const second = collect(session, 'follow-up'); await begun(child, 2)
    child.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'stale' } })
    completed(child, 'completed', 'turn-2'); await second.done
    expect(second.events.some(e => e.kind === 'text')).toBe(false)
    expect(child.sent.filter(m => m.method === 'thread/start')).toHaveLength(1)
  })

  it.each([true, false])('replies to the exact approval RPC id with one-shot decision %s', async allow => {
    const requestPermission = vi.fn(async () => allow)
    const { session, child } = await start({ requestPermission })
    const run = collect(session); await begun(child); approval(child, 42)
    await expect.poll(() => child.sent.find(m => m.id === 42)?.result).toEqual({ decision: allow ? 'accept' : 'decline' })
    expect(requestPermission).toHaveBeenCalledWith({ tool: 'commandExecution', description: expect.stringContaining('rm report.txt') }, expect.any(AbortSignal))
    completed(child); await run.done
  })

  it.each([true, false])('routes captured native local approval id zero using an offered one-shot decision: %s', async allow => {
    const requestPermission = vi.fn(async (_request: { tool: string; description: string }) => allow)
    const { session, child } = await start({ requestPermission }); const run = collect(session); await begun(child)
    const command = 'curl --max-time 10 http://127.0.0.1:4191/cc-live-check'
    const amendment = ['curl', '--max-time', '10', 'http://127.0.0.1:4191/cc-live-check']
    approval(child, 0, undefined, { environmentId: 'local', startedAtMs: 1, command, commandActions: [{ type: 'unknown', command }], proposedExecpolicyAmendment: amendment, availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } }, 'cancel'] })
    await expect.poll(() => child.sent.find(m => m.id === 0)?.result).toEqual({ decision: allow ? 'accept' : 'cancel' })
    expect(requestPermission.mock.calls[0]![0].description).toContain('Execution environment: local')
    expect(requestPermission.mock.calls[0]![0].description).toContain(command)
    completed(child); await run.done
  })

  it('explains native interruption after a denied operation without carrying that cause into the next turn', async () => {
    const { session, child } = await start({ requestPermission: async () => false })
    const first = collect(session); await begun(child)
    approval(child, 0, undefined, { environmentId: 'local', availableDecisions: ['accept', 'cancel'] })
    await expect.poll(() => child.sent.find(m => m.id === 0)?.result).toEqual({ decision: 'cancel' })
    completed(child, 'interrupted'); await first.done
    expect(first.events).toContainEqual({ kind: 'error', message: '这次操作已被拒绝，Codex 已结束本轮。可以补充要求后继续。' })
    expect(first.events.some(event => event.kind === 'result')).toBe(false)
    const second = collect(session, 'a different request'); await begun(child, 2)
    completed(child, 'interrupted', 'turn-2'); await second.done
    expect(second.events).toContainEqual({ kind: 'error', message: 'Codex 本轮已中断，未能确认完成。可以补充要求后继续。' })
    expect(second.events.some(event => event.kind === 'result')).toBe(false)
  })

  it('shows every recognized requested per-command permission with its command before one-shot approval', async () => {
    const requestPermission = vi.fn(async (_request: { tool: string; description: string }) => true)
    const { session, child } = await start({ requestPermission }); const run = collect(session); await begun(child)
    const extra = {
      additionalPermissions: { network: { enabled: true }, fileSystem: { read: ['/private/reference'], write: ['/outside/report'] } },
      networkApprovalContext: { host: 'uploads.example', protocol: 'https' }, availableDecisions: ['accept', 'decline'],
      proposedExecpolicyAmendment: ['rm'], proposedNetworkPolicyAmendments: [{ host: 'uploads.example', action: 'allow' }],
    }
    approval(child, 'scope', undefined, extra)
    await expect.poll(() => child.sent.find(m => m.id === 'scope')?.result).toEqual({ decision: 'accept' })
    const description = requestPermission.mock.calls[0]![0].description
    for (const visible of ['rm report.txt', '/private/reference', '/outside/report', 'uploads.example', 'https', '"enabled": true']) expect(description).toContain(visible)
    expect(description).toContain('not applied')
    completed(child); await run.done
  })

  it.each([
    { environmentId: 'remote-worker' },
    { command: null, itemId: 'unknown' },
    { command: 'x'.repeat(20_001) },
    { availableDecisions: ['acceptForSession', 'decline'] },
    { availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm'] } }, 'decline'] },
    { proposedExecpolicyAmendment: { unknown: true } },
    { proposedNetworkPolicyAmendments: [{ host: '*', action: 'unknown' }] },
    { additionalPermissions: { network: { enabled: true, unknownGrant: true }, fileSystem: null } },
    { additionalPermissions: { network: null, fileSystem: { read: null, write: null, entries: [{ path: { type: 'special', value: 'root' }, access: 'write' }] } } },
    { networkApprovalContext: { host: 'host', protocol: 'unknown' } },
    { additionalPermissions: { network: null, fileSystem: { read: ['x'.repeat(20_001)], write: null } } },
  ])('refuses unsupported or undisplayable authority case %#', async extra => {
    const requestPermission = vi.fn(async () => true)
    const { session, child } = await start({ requestPermission }); const run = collect(session); await begun(child)
    approval(child, 'unsupported', undefined, extra)
    await expect.poll(() => child.sent.find(m => m.id === 'unsupported')?.result).toEqual({ decision: 'decline' })
    expect(requestPermission).not.toHaveBeenCalled()
    await expect.poll(() => run.events.some(event => event.kind === 'error' && event.message.includes('无法核实')), { timeout: 200 }).toBe(true)
    await run.done
    expect(run.events.some(event => event.kind === 'result')).toBe(false)
  })

  it('refuses file-change session-root grants even when the single patch is visible', async () => {
    const requestPermission = vi.fn(async () => true)
    const { session, child } = await start({ requestPermission }); const run = collect(session); await begun(child)
    child.notify('item/fileChange/patchUpdated', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', changes: [{ path: '/outside/file', kind: { type: 'add' }, diff: '+new' }] })
    approval(child, 'root-grant', 'item/fileChange/requestApproval', { grantRoot: '/outside' })
    await expect.poll(() => child.sent.find(m => m.id === 'root-grant')?.result).toEqual({ decision: 'decline' })
    expect(requestPermission).not.toHaveBeenCalled()
    await expect.poll(() => run.events.some(event => event.kind === 'error' && event.message.includes('无法核实')), { timeout: 200 }).toBe(true)
    await run.done
  })

  it('includes cached file changes in approval, denies missing callbacks and unsupported permission kinds', async () => {
    const { session, child } = await start()
    const run = collect(session); await begun(child)
    approval(child)
    await expect.poll(() => child.sent.find(m => m.id === 'approve-1')?.result).toEqual({ decision: 'decline' })
    approval(child, 'permission', 'item/permissions/requestApproval')
    await expect.poll(() => child.sent.find(m => m.id === 'permission')?.result).toEqual({ permissions: {}, scope: 'turn' })
    completed(child); await run.done
    const requestPermission = vi.fn(async (_request: { tool: string; description: string }, _signal?: AbortSignal) => true)
    const next = await start({ requestPermission }); const run2 = collect(next.session); await begun(next.child)
    next.child.notify('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'fileChange', id: 'item-1', changes: [{ path: '/project/report.txt', kind: { type: 'update' }, diff: '-old\n+new' }] } })
    approval(next.child, 'patch', 'item/fileChange/requestApproval')
    await expect.poll(() => requestPermission.mock.calls.length).toBe(1)
    expect(requestPermission.mock.calls[0]![0]).toMatchObject({ tool: 'fileChange', description: expect.stringContaining('-old\n+new') })
    completed(next.child); await run2.done
  })

  it('uses the latest file patch notification in the actionable preview', async () => {
    const requestPermission = vi.fn(async (_request: { tool: string; description: string }, _signal?: AbortSignal) => true)
    const { session, child } = await start({ requestPermission }); const run = collect(session); await begun(child)
    child.notify('item/fileChange/patchUpdated', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', changes: [{ path: '/project/file', kind: { type: 'add' }, diff: '+actual patch' }] })
    approval(child, 'patch', 'item/fileChange/requestApproval')
    await expect.poll(() => child.sent.find(m => m.id === 'patch')?.result).toEqual({ decision: 'accept' })
    expect(requestPermission.mock.calls[0]![0].description).toContain('+actual patch')
    expect(requestPermission).toHaveBeenCalledTimes(1)
    completed(child); await run.done
  })

  it.each([{ approvalPolicy: 'never' }, { approvalsReviewer: 'guardian_subagent' }, { sandbox: { type: 'dangerFullAccess' } }])('refuses a server that did not apply requested isolation: %j', async returned => {
    threadResponse = returned
    await expect(start()).rejects.toThrow('codex_unverified_thread_policy')
    expect(children.at(-1)!.kill).toHaveBeenCalled()
  })

  it.each(['cancel', 'resolved', 'completed', 'exit'])('aborts pending approvals on %s and cannot apply a late allow', async action => {
    let approve!: (value: boolean) => void, signal!: AbortSignal
    const { session, child } = await start({ requestPermission: (_request: unknown, s: AbortSignal) => { signal = s; return new Promise<boolean>(resolve => { approve = resolve }) } })
    const run = collect(session); await begun(child); approval(child, undefined, undefined, { environmentId: 'local', availableDecisions: ['accept', 'cancel'] })
    await expect.poll(() => !!approve).toBe(true)
    if (action === 'cancel') await session.cancel!()
    if (action === 'resolved') child.notify('serverRequest/resolved', { threadId: 'thread-1', requestId: 'approve-1' })
    if (action === 'completed') completed(child)
    if (action === 'exit') child.exit(7)
    expect(signal.aborted).toBe(true)
    if (action === 'cancel' || action === 'completed') expect(child.sent.find(m => m.id === 'approve-1')?.result).toEqual({ decision: 'cancel' })
    approve(true); await Promise.resolve(); await Promise.resolve()
    expect(child.sent.some(m => m.id === 'approve-1' && m.result?.decision === 'accept')).toBe(false)
    if (action === 'cancel' || action === 'resolved') completed(child, action === 'cancel' ? 'interrupted' : 'completed')
    await run.done
  })

  it('treats interrupt acknowledgement as a request and waits for owned process exit when closing', async () => {
    const { session, child } = await start(); const run = collect(session); await begun(child)
    await session.cancel!()
    expect(run.events.some(e => e.kind === 'result')).toBe(false)
    child.autoExit = false
    let closed = false
    const closing = session.close().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false)
    child.exit(null, 'SIGTERM'); await closing; await run.done
    expect(closed).toBe(true)
  })

  it('does not turn retrying errors, failed or interrupted turns into success', async () => {
    const { session, child } = await start(); const run = collect(session); await begun(child)
    child.notify('error', { threadId: 'thread-1', turnId: 'turn-1', willRetry: true, error: { message: 'retrying' } })
    expect(run.events.some(e => e.kind === 'error')).toBe(false)
    completed(child, 'failed'); await run.done
    expect(run.events).toContainEqual({ kind: 'error', message: 'execution failed' })
    expect(run.events.some(e => e.kind === 'result')).toBe(false)
  })

  it.each(['malformed', 'exit', 'unknown-request'])('fails and shuts down on %s without inventing a result', async failure => {
    const { session, child } = await start(); const run = collect(session); await begun(child)
    if (failure === 'malformed') child.stdout.write('invalid json\n')
    if (failure === 'exit') child.exit(9)
    if (failure === 'unknown-request') child.send({ id: 'unsupported', method: 'item/newUnknownRequest', params: {} })
    await run.done
    expect(run.events.some(e => e.kind === 'error')).toBe(true)
    expect(run.events.some(e => e.kind === 'result')).toBe(false)
    if (failure === 'unknown-request') expect(child.sent.find(m => m.id === 'unsupported')?.error.code).toBe(-32601)
  })

  it('does not start an app-server after MCP discovery failure', async () => {
    discovery = '{}'
    await expect(start()).rejects.toThrow()
    expect(children).toHaveLength(1)
    discovery = '[]'; discoveryExit = 1
    await expect(start()).rejects.toThrow()
    expect(children).toHaveLength(2)
  })

  it('does not resurrect an approval resolved before the turn-start response', async () => {
    const requestPermission = vi.fn(async () => true)
    const { session, child } = await start({ requestPermission }); child.autoTurnStart = false
    const run = collect(session); await begun(child)
    approval(child)
    child.notify('serverRequest/resolved', { threadId: 'thread-1', requestId: 'approve-1' })
    child.send({ id: child.sent.find(m => m.method === 'turn/start')!.id, result: { turn: { id: 'turn-1' } } })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(requestPermission).not.toHaveBeenCalled()
    completed(child); await run.done
  })

  it('denies callback failure and refuses replies for another turn or thread', async () => {
    const requestPermission = vi.fn(async () => { throw new Error('UI gone') })
    const { session, child } = await start({ requestPermission }); const run = collect(session); await begun(child)
    approval(child, 'failed')
    approval(child, 'other-thread', undefined, { threadId: 'another-thread' })
    approval(child, 'other-turn', undefined, { turnId: 'old-turn' })
    await expect.poll(() => child.sent.find(m => m.id === 'failed')?.result).toEqual({ decision: 'decline' })
    expect(child.sent.find(m => m.id === 'other-thread')?.result).toEqual({ decision: 'decline' })
    expect(child.sent.find(m => m.id === 'other-turn')?.result).toEqual({ decision: 'decline' })
    expect(requestPermission).toHaveBeenCalledTimes(1)
    completed(child); await run.done
  })

  it('fails a turn-start RPC error without a success event', async () => {
    const { session, child } = await start(); child.autoTurnStart = false
    const run = collect(session); await begun(child)
    child.send({ id: child.sent.find(m => m.method === 'turn/start')!.id, error: { code: -32000, message: 'turn rejected' } })
    await run.done
    expect(run.events).toContainEqual({ kind: 'error', message: 'turn rejected' })
    expect(run.events.some(e => e.kind === 'result')).toBe(false)
  })

  it('times out an unresponsive turn RPC and terminates its process', async () => {
    const { session, child } = await start({}, { rpcTimeoutMs: 40 }); child.autoTurnStart = false
    const run = collect(session); await run.done
    expect(run.events).toContainEqual({ kind: 'error', message: 'codex_rpc_timeout: turn/start' })
    await expect.poll(() => child.kill.mock.calls.length).toBeGreaterThan(0)
  })

  it('reports failure to confirm process exit instead of resolving close', async () => {
    const { session, child } = await start({}, { closeTimeoutMs: 60 }); child.autoExit = false
    await expect(session.close()).rejects.toThrow('codex_process_not_exited')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.exit(null, 'SIGKILL')
  })

  it.each(['destroyed', 'write-throws', 'write-callback-error'])('fails immediately and aborts approval on stdin %s', async failure => {
    let resolveApproval!: (allow: boolean) => void, signal!: AbortSignal
    const { session, child } = await start({ requestPermission: (_request: unknown, requestSignal: AbortSignal) => { signal = requestSignal; return new Promise<boolean>(resolve => { resolveApproval = resolve }) } })
    const run = collect(session); await begun(child); approval(child)
    await expect.poll(() => !!resolveApproval).toBe(true)
    if (failure === 'destroyed') child.stdin.destroy()
    if (failure === 'write-throws') vi.spyOn(child.stdin, 'write').mockImplementation(() => { throw new Error('closed') })
    if (failure === 'write-callback-error') vi.spyOn(child.stdin, 'write').mockImplementation((...args: any[]) => { queueMicrotask(() => args.at(-1)(new Error('closed'))); return false })
    resolveApproval(true)
    await expect.poll(() => run.events.some(e => e.kind === 'error' && e.message === 'codex_protocol_write_failed'), { timeout: 500 }).toBe(true)
    await run.done
    expect(signal.aborted).toBe(true)
    expect(run.events.some(e => e.kind === 'result')).toBe(false)
    await expect.poll(() => child.kill.mock.calls.length).toBeGreaterThan(0)
  })
})
