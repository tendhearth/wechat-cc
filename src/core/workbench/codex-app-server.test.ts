import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAttachment, AgentEvent, AgentSession, SpawnContext } from '../agent-provider'
import { TIER_PROFILES } from '../user-tier'
import { createWorkbenchCodexProvider } from './codex-app-server'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

type Rpc = { id?: string | number; method?: string; params?: any; result?: any; error?: any }
class FakeProcess extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough()
  exitCode: number | null = null; signalCode: string | null = null
  sent: Rpc[] = []; autoExit = true; autoTurnStart = true; autoInterrupt = true
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
        if (message.method === 'initialize') queueMicrotask(() => this.send({ id: message.id, result: initializeResponse }))
        if (message.method === 'config/read') queueMicrotask(() => this.send({ id: message.id, result: { config: nativeConfig } }))
        if (message.method === 'model/list') queueMicrotask(() => this.send({ id: message.id, result: { data: [{id:modelPresetId,model:'native-model',displayName:'Native model',description:'Native',isDefault:true,defaultReasoningEffort:'deep-native',supportedReasoningEfforts:[{reasoningEffort:'deep-native',description:'Native'}],inputModalities:modelModalities}],nextCursor:null } }))
        if (message.method === 'thread/start' || message.method === 'thread/resume') queueMicrotask(() => this.send({ id: message.id, result: { thread: { id: message.params.threadId ?? 'thread-1' }, cwd: '/project', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, ...threadResponse } }))
        if (message.method === 'turn/start' && this.autoTurnStart) queueMicrotask(() => this.send({ id: message.id, result: { turn: { id: `turn-${this.sent.filter(m => m.method === 'turn/start').length}` } } }))
        if (message.method === 'thread/read') queueMicrotask(() => this.send({ id: message.id, result: { thread: nativeThreads[message.params.threadId] } }))
        if (message.method === 'thread/backgroundTerminals/clean') queueMicrotask(() => this.send(terminalCleanup === 'unavailable' ? {id:message.id,error:{message:'unsupported terminal API'}} : {id:message.id,result:{}}))
        if (message.method === 'thread/backgroundTerminals/list') queueMicrotask(() => this.send({id:message.id,result:{data:terminalCleanup === 'running' ? [{processId:'owned-running'}] : [],nextCursor:null}}))
        if (message.method === 'turn/interrupt' && this.autoInterrupt) queueMicrotask(() => this.send({ id: message.id, result: {} }))
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
let nativeConfig: Record<string, unknown>, initializeResponse: Record<string, unknown>
let modelModalities: string[]
let modelPresetId: string
let nativeThreads: Record<string, any>
let terminalCleanup: 'normal' | 'unavailable' | 'running'
const context = (extra = {}): SpawnContext => ({ tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', chatId: 'workbench:task', appendInstructions: 'task instructions', ...extra })
async function start(extra = {}, options = {}) {
  const session = await createWorkbenchCodexProvider({ codexPathOverride: '/codex', rpcTimeoutMs: 200, closeTimeoutMs: 250, ...options }).spawn({ alias: 'workbench:task', path: '/project' }, context(extra))
  sessions.push(session)
  return { session, child: children.at(-1)! }
}
function collect(session: AgentSession, text = 'original user text', attachments?: readonly AgentAttachment[]) {
  const events: AgentEvent[] = []
  const done = (async () => { for await (const event of session.dispatch(text, attachments)) events.push(event) })()
  return { events, done }
}
async function begun(child: FakeProcess, n = 1) { await expect.poll(() => child.sent.filter(m => m.method === 'turn/start').length).toBe(n); await Promise.resolve() }
function completed(child: FakeProcess, status = 'completed', turn = 'turn-1') { child.notify('turn/completed', { threadId: 'thread-1', turn: { id: turn, status, error: status === 'failed' ? { message: 'execution failed' } : null, durationMs: 4 } }) }
function approval(child: FakeProcess, id: string | number = 'approve-1', method = 'item/commandExecution/requestApproval', extra = {}) {
  child.send({ id, method, params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', kind: 'command', command: 'rm report.txt', cwd: '/project', reason: 'replace file', ...extra } })
}
function question(child: FakeProcess, id: string | number = 'question-1', extra = {}) {
  child.send({ id, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'question-item', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'format', header: 'Format', question: 'Which format?', isOther: true, isSecret: false, options: [{ label: 'PDF', description: 'Fixed layout' }, { label: 'Word', description: 'Editable' }] }], ...extra } })
}
function mcpRequest(child: FakeProcess, id: string | number = 0, extra = {}) {
  child.send({ id, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-1', turnId: 'turn-1', serverName: 'external', mode: 'form', message: 'Run external tool?', _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { note: 'review me', api_key: 'credential-value' } }, requestedSchema: { type: 'object', properties: {} }, ...extra } })
}
function mcpItem(child: FakeProcess, extra = {}) {
  child.notify('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'mcpToolCall', id: 'mcp-1', server: 'external', tool: 'create_note', status: 'inProgress', arguments: { note: 'review me', api_key: 'credential-value' }, ...extra } })
}
function enableExternal() {
  discovery = '[{"name":"external","enabled":true}]'
  nativeConfig = { mcp_servers: { external: { command: '/tools/external', tools: { create_note: { approval_mode: 'approve' } } } } }
}
beforeEach(() => {
  terminalCleanup = 'normal'
  nativeThreads = {}
  modelModalities=['text','image']
  modelPresetId='native-model'
  children = []; sessions = []; discovery = '[{"name":"personal","env":{"SECRET":"private"}}]'; discoveryExit = 0; threadResponse = {}
  nativeConfig = { mcp_servers: { personal: { command: '/tools/personal' } } }
  initializeResponse = { userAgent: 'cc_workbench/0.153.4 (Mac OS; arm64)' }
  mocks.spawn.mockReset().mockImplementation((_binary: string, args: string[]) => {
    const child = new FakeProcess(args.includes('mcp')); children.push(child)
    if (child.probe) queueMicrotask(() => { child.stdout.write(discovery); child.exit(discoveryExit) })
    return child
  })
})
afterEach(async () => { for (const session of sessions) await session.close().catch(() => {}); vi.restoreAllMocks() })

describe('workbench Codex app-server', () => {
  it('rejects images on a known text-only selected model before dispatch or steer',async()=>{
    modelModalities=['text']
    const {session,child}=await start({execution:{defaults:'native',model:'native-model',reasoningEffort:null}})
    const attachments=[{name:'owned.png',mime:'image/png',path:'/owned.png',sha256:'a'.repeat(64),data:'UE5H'}]
    expect(()=>session.dispatch('inspect',attachments)).toThrow(/execution_image_unsupported/)
    expect(child.sent.some(message=>message.method==='turn/start')).toBe(false)
    const run=collect(session);await begun(child)
    await expect(session.steer!('inspect',attachments)).rejects.toThrow(/execution_image_unsupported/)
    expect(child.sent.some(message=>message.method==='turn/steer')).toBe(false)
    completed(child);await run.done
  })
  it('discovers models without starting a thread or admitting MCPs',async()=>{
    const provider=createWorkbenchCodexProvider({codexPathOverride:'/codex',rpcTimeoutMs:200,closeTimeoutMs:250})
    expect(typeof provider.modelCatalog).toBe('function')
    const catalog=await provider.modelCatalog!({alias:'test',path:'/project'})
    expect(catalog.models[0]?.reasoningEfforts).toEqual(['deep-native'])
    const child=children.at(-1)!
    expect(child.sent.some(m=>m.method?.startsWith('thread/')||m.method?.startsWith('turn/'))).toBe(false)
    expect(child.kill).toHaveBeenCalled()
  })
  it('applies explicit native model and effort and reports only native acknowledgement',async()=>{
    threadResponse={model:'native-model',reasoningEffort:'deep-native'}
    const reportExecution=vi.fn()
    const {child}=await start({execution:{defaults:'provider',model:'native-model',reasoningEffort:'deep-native'},reportExecution},{model:'cc-fallback'})
    expect(child.sent.find(m=>m.method==='thread/start')?.params).toMatchObject({model:'native-model',config:{model_reasoning_effort:'deep-native'}})
    expect(reportExecution).toHaveBeenCalledWith({model:'native-model',reasoningEffort:'deep-native',sessionId:'thread-1',source:'native_response'})
  })
  it.each([undefined,'existing'])('dispatches the advertised execution slug when a Codex preset id differs (resume=%s)',async(resumeSessionId)=>{
    modelPresetId='picker-only-preset'
    threadResponse={model:'native-model',reasoningEffort:'deep-native'}
    const provider=createWorkbenchCodexProvider({codexPathOverride:'/codex',rpcTimeoutMs:200,closeTimeoutMs:250})
    const catalog=await provider.modelCatalog!({alias:'test',path:'/project'})
    const model=catalog.models[0]!.id
    expect(model).toBe('native-model')
    const {session,child}=await start({resumeSessionId,execution:{defaults:'native',model,reasoningEffort:'deep-native'}})
    expect(child.sent.find(message=>message.method===(resumeSessionId?'thread/resume':'thread/start'))?.params.model).toBe('native-model')
    const run=collect(session);await begun(child)
    child.notify('turn/completed',{threadId:resumeSessionId??'thread-1',turn:{id:'turn-1',status:'completed',error:null,durationMs:4}})
    await run.done
  })
  it.each(['provider','native'])('omits CC fallback during opted-in automatic %s resume',async(defaults)=>{
    const {child}=await start({resumeSessionId:'existing',execution:{defaults,model:null,reasoningEffort:null}},{model:'cc-fallback'})
    const params=child.sent.find(m=>m.method==='thread/resume')!.params
    expect(params).not.toHaveProperty('model')
    expect(params.config).not.toHaveProperty('model_reasoning_effort')
  })
  it('rejects an unadvertised model or effort before any native model turn',async()=>{
    for(const [model,reasoningEffort] of [['unknown',null],['native-model','unsupported']]) {
      await expect(start({execution:{defaults:'native',model,reasoningEffort}})).rejects.toThrow(/execution_(model|effort)_unsupported/)
    }
    expect(children.flatMap(child=>child.sent).some(m=>m.method==='turn/start')).toBe(false)
  })
  it('reports rerouting only for the active originating turn',async()=>{
    const reportExecution=vi.fn(); const {session,child}=await start({reportExecution}); const run=collect(session); await begun(child)
    for(const turnId of ['stale','turn-1'])child.notify('model/rerouted',{threadId:'thread-1',turnId,fromModel:'native-model',toModel:'rerouted-native',reason:'highRiskCyberActivity'})
    await expect.poll(()=>reportExecution.mock.calls.length).toBe(1)
    expect(reportExecution).toHaveBeenCalledWith({model:'rerouted-native',sessionId:'thread-1',source:'native_reroute'})
    completed(child); await run.done
    child.notify('model/rerouted',{threadId:'thread-1',turnId:'turn-1',toModel:'stale'}); await Promise.resolve()
    expect(reportExecution).toHaveBeenCalledTimes(1)
  })
  it('sends immutable image bytes and explicit file references on initial and subsequent turns', async () => {
    const image = { name: 'image.png', mime: 'image/png', path: '/not-read/image.png', sha256: 'a'.repeat(64), data: 'UE5H' }
    const file = { name: 'report\n"quoted".pdf', mime: 'application/pdf', path: '/project/report.pdf', sha256: 'b'.repeat(64), data: 'UERG' }
    const { session, child } = await start()
    for (let turn = 1; turn <= 2; turn++) {
      const run = collect(session, 'inspect', [image, file]); await begun(child, turn)
      const input = child.sent.filter(m => m.method === 'turn/start').at(-1)!.params.input
      expect(input[0]).toEqual({ type: 'text', text: 'inspect', text_elements: [] })
      expect(input[1]).toEqual({ type: 'image', url: 'data:image/png;base64,UE5H', detail: 'high' })
      expect(input[2].type).toBe('text')
      expect(input[2].text).toContain(JSON.stringify({ name: file.name, mime: file.mime, path: file.path, sha256: file.sha256 }))
      expect(input[2].text).not.toContain(file.data)
      expect(input.some((item: any) => item.type === 'localImage' || item.type === 'document')).toBe(false)
      completed(child, 'completed', `turn-${turn}`); await run.done
    }
  })
  it('accepts image-only steering through the same active turn acknowledgement', async () => {
    const { session, child } = await start(); const run = collect(session); await begun(child)
    const pending = session.steer!('', [{ name: 'new.webp', mime: 'image/webp', path: '/not-read.webp', sha256: 'a'.repeat(64), data: 'V0VCUA==' }]).then(() => null, error => error)
    await expect.poll(() => child.sent.some(m => m.method === 'turn/steer')).toBe(true)
    const rpc = child.sent.find(m => m.method === 'turn/steer')!
    expect(rpc.params.expectedTurnId).toBe('turn-1')
    expect(rpc.params.input).toEqual([{ type: 'image', url: 'data:image/webp;base64,V0VCUA==', detail: 'high' }])
    child.send({ id: rpc.id, result: { turnId: 'turn-1' } }); expect(await pending).toBeNull()
    completed(child); await run.done
  })
  it('rejects missing image bytes before reserving a native turn rather than degrading to a pathname', async () => {
    const { session, child } = await start()
    expect(() => session.dispatch('inspect', [{ name: 'missing.png', mime: 'image/png', path: '/missing.png', sha256: 'a'.repeat(64) }])).toThrow('attachment_data_missing')
    expect(child.sent.some(m => m.method === 'turn/start')).toBe(false)
    const run = collect(session); await begun(child); completed(child); await run.done
  })
  it('reads native overrides while tools are disabled and applies review policy again on resume', async () => {
    enableExternal(); nativeConfig.web_search = 'live'
    initializeResponse.userAgent = 'Codex Desktop/0.153.4 (Mac OS; arm64) dumb (cc_workbench; 1)'
    const { child } = await start({ resumeSessionId: 'existing' })
    expect(mocks.spawn.mock.calls[1]![1]).toContain('mcp_servers.external.enabled=false')
    expect(mocks.spawn.mock.calls[1]![1]).not.toContain('web_search="disabled"')
    expect(child.sent.find(m => m.method === 'thread/resume')?.params.config).toMatchObject({ web_search: 'live', features: { tool_call_mcp_elicitation: true }, mcp_servers: { external: { enabled: true, default_tools_approval_mode: 'prompt', tools: { create_note: { approval_mode: 'prompt' } } } } })
  })

  it.each([true, false])('relays MCP invocation approval once and returns a one-shot decision: %s', async allowed => {
    enableExternal(); let decide!: (value: boolean) => void
    const permit = vi.fn((_request: { tool: string; description: string }) => new Promise<boolean>(resolve => { decide = resolve }))
    const { session, child } = await start({ requestPermission: permit }); const run = collect(session); await begun(child)
    mcpItem(child); mcpRequest(child); mcpRequest(child)
    await expect.poll(() => permit.mock.calls.length).toBe(1)
    expect(child.sent.some(m => m.id === 0)).toBe(false)
    const request = permit.mock.calls[0]![0]
    expect(request).toEqual({ tool: 'mcp__external__create_note', description: expect.stringContaining('review me') })
    expect(JSON.stringify(request)).not.toContain('credential-value')
    decide(allowed)
    await expect.poll(() => child.sent.find(m => m.id === 0)?.result).toEqual({ action: allowed ? 'accept' : 'decline', content: null, _meta: null })
    mcpRequest(child); await Promise.resolve()
    expect(child.sent.filter(m => m.id === 0)).toHaveLength(1)
    expect(run.events).toContainEqual(expect.objectContaining({ kind: 'tool_call', activity: expect.objectContaining({ id: 'mcp-1', status: 'running' }) }))
    completed(child); await run.done
  })

  it.each(['cancel', 'resolved', 'completed', 'exit'])('never accepts a late MCP approval after %s', async action => {
    enableExternal(); let decide!: (value: boolean) => void, signal!: AbortSignal
    const { session, child } = await start({ requestPermission: (_request: unknown, s: AbortSignal) => { signal = s; return new Promise<boolean>(resolve => { decide = resolve }) } })
    const run = collect(session); await begun(child); mcpItem(child); mcpRequest(child)
    await expect.poll(() => !!decide).toBe(true)
    if (action === 'cancel') await session.cancel!()
    if (action === 'resolved') child.notify('serverRequest/resolved', { threadId: 'thread-1', requestId: 0 })
    if (action === 'completed') completed(child)
    if (action === 'exit') child.exit(7)
    expect(signal.aborted).toBe(true)
    decide(true); await Promise.resolve(); await Promise.resolve()
    expect(child.sent.some(m => m.id === 0 && m.result?.action === 'accept')).toBe(false)
    if (action === 'cancel' || action === 'completed') expect(child.sent.find(m => m.id === 0)?.result).toEqual({ action: 'decline', content: null, _meta: null })
    if (action === 'cancel' || action === 'resolved') completed(child, action === 'cancel' ? 'interrupted' : 'completed')
    await run.done
  })

  it('declines foreign, stale, uncorrelated and unsupported MCP forms without stopping a valid turn', async () => {
    enableExternal(); const permit = vi.fn(async () => true)
    const { session, child } = await start({ requestPermission: permit }); const run = collect(session); await begun(child); mcpItem(child)
    for (const [id, extra] of Object.entries({ foreign: { threadId: 'other' }, stale: { turnId: 'old' }, unrelated: { turnId: null }, missingItem: { serverName: 'other' }, form: { _meta: null, requestedSchema: { type: 'object', properties: { secret: { type: 'string' } } } }, url: { mode: 'url', url: 'https://example.test/auth' } })) mcpRequest(child, id, extra)
    await expect.poll(() => child.sent.filter(m => m.result?.action === 'decline').length).toBe(6)
    expect(permit).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled()
    expect(run.events.some(e => e.kind === 'tool_call' && e.activity?.status === 'failed')).toBe(true)
    completed(child); await run.done
  })

  it('declines an ambiguous tool binding without exposing raw arguments', async () => {
    enableExternal(); const permit = vi.fn(async () => true)
    const { session, child } = await start({ requestPermission: permit }); const run = collect(session); await begun(child)
    mcpItem(child); mcpItem(child, { id: 'mcp-2', tool: 'another_tool' }); mcpRequest(child)
    await expect.poll(() => child.sent.find(m => m.id === 0)?.result.action).toBe('decline')
    expect(permit).not.toHaveBeenCalled(); expect(JSON.stringify(run.events)).not.toContain('credential-value')
    completed(child); await run.done
  })

  it('refuses to enable external tools on an unverified older native protocol', async () => {
    enableExternal(); initializeResponse.userAgent = 'cc_workbench/0.144.4 (Mac OS; arm64)'
    await expect(start()).rejects.toThrow('0.153.4')
    expect(children.at(-1)!.sent.some(m => m.method === 'thread/start')).toBe(false)
  })

  it('steers the active native turn with exact text and waits for its matching acknowledgement', async () => {
    const { session, child } = await start(); const run = collect(session); await begun(child)
    expect(session.steer).toBeTypeOf('function')
    let accepted = false
    const pending = session.steer!('  Keep the appendix.\n').then(() => { accepted = true })
    const rpc = child.sent.find(m => m.method === 'turn/steer')!
    expect(rpc.params).toEqual({ threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: '  Keep the appendix.\n', text_elements: [] }] })
    await Promise.resolve(); expect(accepted).toBe(false)
    child.send({ id: rpc.id, result: { turnId: 'turn-1' } }); await pending
    expect(accepted).toBe(true); completed(child); await run.done
  })

  it.each(['wrong-turn', 'rpc-error', 'completed', 'cancelled'])('does not acknowledge rejected or stale steering: %s', async failure => {
    const { session, child } = await start(); const run = collect(session); await begun(child)
    expect(session.steer).toBeTypeOf('function')
    const pending = session.steer!('extra').then(() => 'accepted', () => 'rejected')
    const rpc = child.sent.find(m => m.method === 'turn/steer')!
    if (failure === 'completed') completed(child)
    if (failure === 'cancelled') await session.cancel!()
    child.send(failure === 'rpc-error' ? { id: rpc.id, error: { code: -32601, message: 'unsupported' } } : { id: rpc.id, result: { turnId: failure === 'wrong-turn' ? 'other-turn' : 'turn-1' } })
    expect(await pending).toBe('rejected')
    if (failure !== 'completed') completed(child, failure === 'cancelled' ? 'interrupted' : 'completed')
    await run.done
  })

  it('refuses steering before a turn id exists or after it ended', async () => {
    const { session, child } = await start(); child.autoTurnStart = false
    expect(session.steer).toBeTypeOf('function')
    await expect(session.steer!('before')).rejects.toThrow()
    const run = collect(session); await begun(child)
    await expect(session.steer!('starting')).rejects.toThrow()
    child.send({ id: child.sent.find(m => m.method === 'turn/start')!.id, result: { turn: { id: 'turn-1' } } })
    await Promise.resolve(); completed(child); await run.done
    await expect(session.steer!('ended')).rejects.toThrow()
    expect(child.sent.some(m => m.method === 'turn/steer')).toBe(false)
  })

  it('maps native structured questions and replies only to the exact RPC id including zero', async () => {
    const requestUserInput = vi.fn(async () => ({ format: ['Word'] }))
    const { session, child } = await start({ requestUserInput }); const run = collect(session); await begun(child)
    question(child, 0)
    await expect.poll(() => child.sent.find(m => m.id === 0)?.result).toEqual({ answers: { format: { answers: ['Word'] } } })
    expect(requestUserInput).toHaveBeenCalledWith({ questions: [{ id: 'format', header: 'Format', question: 'Which format?', options: [{ label: 'PDF', description: 'Fixed layout' }, { label: 'Word', description: 'Editable' }], multiSelect: false, allowOther: true }] }, expect.any(AbortSignal))
    completed(child); await run.done
  })

  it.each(['cancel', 'resolved', 'completed', 'exit'])('aborts a pending question and ignores a late answer on %s', async action => {
    let answer!: (value: Record<string, string[]>) => void, signal!: AbortSignal
    const { session, child } = await start({ requestUserInput: (_request: unknown, s: AbortSignal) => { signal = s; return new Promise(resolve => { answer = resolve }) } })
    const run = collect(session); await begun(child); question(child)
    await expect.poll(() => !!answer).toBe(true)
    if (action === 'cancel') await session.cancel!()
    if (action === 'resolved') child.notify('serverRequest/resolved', { threadId: 'thread-1', requestId: 'question-1' })
    if (action === 'completed') completed(child)
    if (action === 'exit') child.exit(7)
    expect(signal.aborted).toBe(true)
    answer({ format: ['Word'] }); await Promise.resolve(); await Promise.resolve()
    expect(child.sent.some(m => m.id === 'question-1' && m.result?.answers?.format)).toBe(false)
    if (action === 'cancel' || action === 'resolved') completed(child, action === 'cancel' ? 'interrupted' : 'completed')
    await run.done
  })

  it('does not resurrect a question resolved before the turn-start response', async () => {
    const requestUserInput = vi.fn(async () => ({ format: ['PDF'] }))
    const { session, child } = await start({ requestUserInput }); child.autoTurnStart = false
    const run = collect(session); await begun(child); question(child)
    child.notify('serverRequest/resolved', { threadId: 'thread-1', requestId: 'question-1' })
    child.send({ id: child.sent.find(m => m.method === 'turn/start')!.id, result: { turn: { id: 'turn-1' } } })
    await Promise.resolve(); await Promise.resolve(); completed(child); await run.done
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('answers duplicate native question delivery once and ignores a resolution for another thread', async () => {
    let answer!: (value: Record<string, string[]>) => void, signal!: AbortSignal
    const requestUserInput = vi.fn((_request: unknown, s: AbortSignal) => { signal = s; return new Promise(resolve => { answer = resolve }) })
    const { session, child } = await start({ requestUserInput }); const run = collect(session); await begun(child)
    question(child); question(child)
    await expect.poll(() => !!answer).toBe(true)
    child.notify('serverRequest/resolved', { threadId: 'different-thread', requestId: 'question-1' })
    expect(signal.aborted).toBe(false)
    answer({ format: ['PDF'] })
    await expect.poll(() => child.sent.filter(m => m.id === 'question-1').length).toBe(1)
    question(child); await Promise.resolve(); await Promise.resolve()
    expect(child.sent.filter(m => m.id === 'question-1')).toHaveLength(1)
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    completed(child); await run.done
  })

  it('declines a duplicated early question once when cancelled before turn-start acknowledgement', async () => {
    const requestUserInput = vi.fn(async () => ({ format: ['PDF'] }))
    const { session, child } = await start({ requestUserInput }); child.autoTurnStart = false
    const run = collect(session); await begun(child); question(child); question(child)
    await session.cancel!()
    expect(child.sent.filter(m => m.id === 'question-1')).toEqual([{ id: 'question-1', result: { answers: {} } }])
    question(child); await Promise.resolve()
    expect(child.sent.filter(m => m.id === 'question-1')).toHaveLength(1)
    expect(requestUserInput).not.toHaveBeenCalled()
    await session.close(); await run.done
  })

  it('supports native free text questions without selectable options', async () => {
    const requestUserInput = vi.fn(async () => ({ note: ['Keep all tables.'] }))
    const { session, child } = await start({ requestUserInput }); const run = collect(session); await begun(child)
    question(child, 'free', { questions: [{ id: 'note', header: 'Note', question: 'Any other requirements?', isOther: false, isSecret: false, options: null }], isBlocking: false, autoResolutionMs: 60000 })
    await expect.poll(() => child.sent.find(m => m.id === 'free')?.result).toEqual({ answers: { note: { answers: ['Keep all tables.'] } } })
    expect(requestUserInput).toHaveBeenCalledWith({ questions: [{ id: 'note', header: 'Note', question: 'Any other requirements?', options: [], multiSelect: false, allowOther: true }] }, expect.any(AbortSignal))
    completed(child); await run.done
  })

  it.each(['missing', 'declined', 'failed'])('returns no answer when the question callback is %s', async mode => {
    const requestUserInput = mode === 'missing' ? undefined : async () => { if (mode === 'failed') throw new Error('UI gone'); return null }
    const { session, child } = await start({ requestUserInput }); const run = collect(session); await begun(child); question(child)
    await expect.poll(() => child.sent.find(m => m.id === 'question-1')?.result).toEqual({ answers: {} })
    completed(child); await run.done
  })

  it('rejects malformed native questions without opening a truncated or ambiguous prompt', async () => {
    const requestUserInput = vi.fn(async () => ({ format: ['PDF'] }))
    const { session, child } = await start({ requestUserInput }); const run = collect(session); await begun(child)
    question(child, 'malformed', { questions: [{ id: 'format', header: 'Format', question: 'Which format?', isOther: false, isSecret: false, options: [{ label: 'PDF', description: 'a'.repeat(21000) }] }] })
    await run.done
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(child.sent.find(m => m.id === 'malformed')?.result).toEqual({ answers: {} })
    expect(run.events.some(event => event.kind === 'error')).toBe(true)
  })

  it('rejects secret questions without forwarding their contents to task storage', async () => {
    const requestUserInput = vi.fn(async () => ({ password: ['secret'] }))
    const { session, child } = await start({ requestUserInput }); const run = collect(session); await begun(child)
    question(child, 'secret', { questions: [{ id: 'password', header: 'Password', question: 'Sensitive question detail', isOther: true, isSecret: true, options: null }] })
    await run.done
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(child.sent.find(m => m.id === 'secret')?.result).toEqual({ answers: {} })
    expect(run.events).toContainEqual({ kind: 'error', message: expect.stringContaining('敏感') })
    expect(JSON.stringify(run.events)).not.toContain('Sensitive question detail')
  })

  it('declines unavailable, invalid and foreign question answers without granting permissions', async () => {
    const requestUserInput = vi.fn(async () => ({ unknown: ['bad'] }))
    const { session, child } = await start({ requestUserInput }); const run = collect(session); await begun(child)
    question(child, 'invalid-answer'); question(child, 'other-thread', { threadId: 'elsewhere' }); question(child, 'old-turn', { turnId: 'turn-old' })
    await expect.poll(() => child.sent.find(m => m.id === 'invalid-answer')?.result).toEqual({ answers: {} })
    expect(child.sent.find(m => m.id === 'other-thread')?.result).toEqual({ answers: {} })
    expect(child.sent.find(m => m.id === 'old-turn')?.result).toEqual({ answers: {} })
    expect(requestUserInput).toHaveBeenCalledTimes(1); completed(child); await run.done
  })
  it('probes selected cwd, initializes and starts a strictly isolated native thread', async () => {
    const { child } = await start({ mcpEnv: { WECHAT_SESSION_TOKEN: 'do-not-forward' } })
    expect(mocks.spawn.mock.calls[0]![2]).toMatchObject({ cwd: '/project' })
    expect(mocks.spawn.mock.calls[1]![1]).toEqual(expect.arrayContaining(['app-server', '--listen', 'stdio://', 'mcp_servers.personal.enabled=false']))
    expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain('do-not-forward')
    expect(child.sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'config/read', 'thread/start'])
    expect(child.sent[0]!.params.capabilities.experimentalApi).toBe(false)
    expect(child.sent[2]!.params).toEqual({ cwd: '/project', includeLayers: false })
    expect(child.sent[3]!.params).toMatchObject({ cwd: '/project', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', developerInstructions: 'task instructions', config: { web_search: 'cached', mcp_servers: { personal: { enabled: false } } } })
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
    expect(first.events).toEqual([{ kind: 'init', sessionId: 'thread-1' }, { kind: 'tool_call', tool: 'commandExecution', activity: { id: 'item-1', type: 'command', status: 'running', label: '运行命令' } }, { kind: 'text', text: 'Real answer', itemId: 'answer', textMode: 'replace' }, { kind: 'result', sessionId: 'thread-1', numTurns: 1, durationMs: 4 }])
    const second = collect(session, 'follow-up'); await begun(child, 2)
    child.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'stale' } })
    completed(child, 'completed', 'turn-2'); await second.done
    expect(second.events.some(e => e.kind === 'text')).toBe(false)
    expect(child.sent.filter(m => m.method === 'thread/start')).toHaveLength(1)
  })

  it('streams ordered text deltas and replaces the same message with its authoritative completion', async () => {
    const { session, child } = await start(); const run = collect(session); await begun(child)
    const scope = { threadId: 'thread-1', turnId: 'turn-1' }
    child.notify('item/agentMessage/delta', { ...scope, itemId: 'progress', delta: 'Inspecting ' })
    child.notify('item/agentMessage/delta', { ...scope, itemId: 'progress', delta: 'files' })
    child.notify('item/started', { ...scope, item: { type: 'commandExecution', id: 'read', status: 'inProgress', command: 'cat private.txt', cwd: '/project', commandActions: [{ type: 'read', command: 'cat private.txt', name: 'private.txt', path: '/project/private.txt' }] } })
    child.notify('item/completed', { ...scope, item: { type: 'agentMessage', id: 'progress', text: 'Inspecting files.' } })
    child.notify('item/agentMessage/delta', { ...scope, itemId: 'progress', delta: 'late duplicate' })
    child.notify('item/agentMessage/delta', { ...scope, threadId: 'other-thread', itemId: 'wrong', delta: 'wrong thread' })
    child.notify('item/agentMessage/delta', { ...scope, turnId: 'old-turn', itemId: 'wrong', delta: 'wrong turn' })
    child.notify('item/completed', { ...scope, item: { type: 'agentMessage', id: 'answer', text: 'Done.' } })
    completed(child); await run.done
    expect(run.events.slice(1, -1)).toEqual([
      { kind: 'text', itemId: 'progress', textMode: 'append', text: 'Inspecting ' },
      { kind: 'text', itemId: 'progress', textMode: 'append', text: 'files' },
      { kind: 'tool_call', tool: 'commandExecution', activity: { id: 'read', type: 'read', status: 'running', label: '读取文件', detail: '/project/private.txt' } },
      { kind: 'text', itemId: 'progress', textMode: 'replace', text: 'Inspecting files.' },
      { kind: 'text', itemId: 'answer', textMode: 'replace', text: 'Done.' },
    ])
  })

  it('updates command and file activities by native item identity without exposing command output or patches', async () => {
    const { session, child } = await start(); const run = collect(session); await begun(child)
    const scope = { threadId: 'thread-1', turnId: 'turn-1' }
    const item = { type: 'commandExecution', id: 'read', status: 'inProgress', command: 'SECRET_COMMAND', cwd: '/project', commandActions: [{ type: 'read', command: 'SECRET_COMMAND', name: 'a.txt', path: '/project/a.txt' }] }
    child.notify('item/started', { ...scope, item })
    child.notify('item/completed', { ...scope, item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'SECRET_OUTPUT' } })
    child.notify('item/started', { ...scope, item: { type: 'fileChange', id: 'edit', status: 'inProgress', changes: [{ path: '/project/a.txt', kind: { type: 'update' }, diff: 'SECRET_DIFF' }] } })
    child.notify('item/fileChange/patchUpdated', { ...scope, itemId: 'edit', changes: [{ path: '/project/b.txt', kind: { type: 'update' }, diff: 'SECRET_NEW_DIFF' }] })
    child.notify('item/completed', { ...scope, item: { type: 'fileChange', id: 'edit', status: 'completed' } })
    completed(child); await run.done
    const activities = run.events.flatMap(event => event.kind === 'tool_call' ? [event.activity] : [])
    expect(activities).toEqual([
      { id: 'read', type: 'read', status: 'running', label: '读取文件', detail: '/project/a.txt' },
      { id: 'read', type: 'read', status: 'completed', label: '读取文件', detail: '/project/a.txt' },
      { id: 'edit', type: 'edit', status: 'running', label: '修改文件', detail: '/project/a.txt' },
      { id: 'edit', type: 'edit', status: 'running', label: '修改文件', detail: '/project/b.txt' },
      { id: 'edit', type: 'edit', status: 'completed', label: '修改文件', detail: '/project/b.txt' },
    ])
    expect(JSON.stringify(run.events)).not.toContain('SECRET_')
  })

  it.each([
    ['failed', 1, 'failed'], ['declined', null, 'cancelled'], ['completed', 2, 'failed'], ['interrupted', null, 'interrupted'],
  ])('preserves command outcome %s rather than assuming success at item completion', async (status, exitCode, expected) => {
    const { session, child } = await start(); const run = collect(session); await begun(child)
    child.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd', status, exitCode, command: 'SECRET', commandActions: [], cwd: '/project' } })
    completed(child); await run.done
    expect(run.events.find(event => event.kind === 'tool_call')).toMatchObject({ activity: { id: 'cmd', type: 'command', status: expected } })
  })

  it.each(['collabAgentToolCall', 'collabToolCall'])('keeps %s relationships and reported child states without leaking prompts', async type => {
    const { session, child } = await start(); const run = collect(session); await begun(child)
    const scope = { threadId: 'thread-1', turnId: 'turn-1' }
    const targets = type === 'collabAgentToolCall' ? { receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'pendingInit', message: 'SECRET_MESSAGE' } } } : { newThreadId: 'child-1', agentStatus: 'pendingInit' }
    const runningState = type === 'collabAgentToolCall' ? { agentsStates: { 'child-1': { status: 'running', message: 'SECRET_MESSAGE' } } } : { agentStatus: 'running' }
    const item = { type, id: 'spawn', tool: 'spawnAgent', senderThreadId: 'thread-1', status: 'inProgress', prompt: 'SECRET_PROMPT', ...targets }
    child.notify('item/started', { ...scope, item })
    child.notify('item/completed', { ...scope, item: { ...item, status: 'completed', ...runningState } })
    child.notify('item/completed', { ...scope, item: { ...item, id: 'send', tool: 'sendMessage', status: 'completed' } })
    completed(child); await run.done
    const activities = run.events.flatMap(event => event.kind === 'tool_call' ? [event.activity] : [])
    expect(activities).toMatchObject([
      { id: 'spawn', type: 'agent', status: 'running', parentId: 'thread-1', agentIds: ['child-1'] },
      { id: 'spawn', type: 'agent', status: 'completed', parentId: 'thread-1', agentIds: ['child-1'], detail: '子助手 1：正在处理' },
      { id: 'send', type: 'agent', status: 'completed', label: '给子助手发送消息' },
    ])
    expect(JSON.stringify(run.events)).not.toContain('SECRET_')
  })

  it('does not expose raw MCP or dynamic tool payloads and bounds activity details', async () => {
    const { session, child } = await start(); const run = collect(session); await begun(child)
    const scope = { threadId: 'thread-1', turnId: 'turn-1' }
    child.notify('item/completed', { ...scope, item: { type: 'mcpToolCall', id: 'mcp', server: 'files', tool: 'read', status: 'failed', arguments: { secret: 'SECRET_ARG' }, error: { message: 'SECRET_ERROR' }, result: { content: 'SECRET_RESULT' } } })
    child.notify('item/completed', { ...scope, item: { type: 'dynamicToolCall', id: 'dynamic', tool: 'inspect', status: 'completed', success: false, arguments: 'SECRET_ARG', contentItems: ['SECRET_RESULT'] } })
    child.notify('item/completed', { ...scope, item: { type: 'fileChange', id: 'large', status: 'completed', changes: Array.from({ length: 100 }, (_, i) => ({ path: `/project/${i}-${'x'.repeat(1000)}\u0000.txt`, diff: 'SECRET_DIFF' })) } })
    completed(child); await run.done
    const activities = run.events.flatMap(event => event.kind === 'tool_call' && event.activity ? [event.activity] : [])
    expect(activities).toMatchObject([{ id: 'mcp', type: 'tool', status: 'failed' }, { id: 'dynamic', type: 'tool', status: 'failed' }, { id: 'large', type: 'edit', status: 'completed' }])
    expect(activities[2]!.detail!.length).toBeLessThanOrEqual(2000)
    expect(activities[2]!.detail).not.toContain('\u0000')
    expect(JSON.stringify(run.events)).not.toContain('SECRET_')
  })

  it('uses native search actions and ignores stale or private activity notifications', async () => {
    const { session, child } = await start(); const run = collect(session); await begun(child)
    const scope = { threadId: 'thread-1', turnId: 'turn-1' }
    const web = { type: 'webSearch', id: 'web', query: 'SECRET_QUERY', results: ['SECRET_RESULTS'] }
    child.notify('item/started', { ...scope, item: web })
    child.notify('item/completed', { ...scope, item: web })
    child.notify('item/started', { ...scope, item: web })
    child.notify('item/completed', { ...scope, item: web })
    child.notify('item/completed', { ...scope, item: { type: 'commandExecution', id: 'search', status: 'completed', command: 'SECRET_COMMAND', commandActions: [{ type: 'search', command: 'SECRET_COMMAND', path: '/project/src', query: 'SECRET_QUERY' }] } })
    child.notify('item/completed', { ...scope, threadId: 'child-1', item: { type: 'commandExecution', id: 'other', status: 'completed' } })
    child.notify('item/completed', { ...scope, turnId: 'old-turn', item: { type: 'fileChange', id: 'old', status: 'completed', changes: [] } })
    child.notify('item/completed', { ...scope, item: { type: 'reasoning', id: 'private', text: 'SECRET_REASONING' } })
    completed(child); await run.done
    const activities = run.events.flatMap(event => event.kind === 'tool_call' ? [event.activity] : [])
    expect(activities).toEqual([
      { id: 'web', type: 'search', status: 'running', label: '搜索网页' },
      { id: 'web', type: 'search', status: 'completed', label: '搜索网页' },
      { id: 'search', type: 'search', status: 'completed', label: '检索文件', detail: '/project/src' },
    ])
    expect(JSON.stringify(run.events)).not.toContain('SECRET_')
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


describe('Codex retained workbench runtime', () => {
  async function runtime(extra = {}) {
    const started = await start({ workbenchLifecycle: true, ...extra })
    expect(started.session.workbenchRuntime).toBeDefined()
    const events: AgentEvent[] = []; let ended = false
    const api = started.session.workbenchRuntime!
    const done = (async () => { for await (const event of api.events) events.push(event); ended = true })()
    api.start('parent'); await begun(started.child)
    return { ...started, api, events, done, ended: () => ended }
  }
  function launch(child: FakeProcess, mode = 'v1', id = 'child-1', parent = 'thread-1', turn = 'turn-1') {
    nativeThreads[id] = { id, source: { subAgent: { thread_spawn: { parent_thread_id: parent } } }, cwd: '/project', turns: [] }
    child.notify('item/started', { threadId: parent, turnId: turn, item: mode === 'v1'
      ? { type: 'collabAgentToolCall', id: `spawn-${id}`, tool: 'spawnAgent', status: 'inProgress', senderThreadId: parent, receiverThreadIds: [id] }
      : { type: 'subAgentActivity', id: `spawn-${id}`, kind: 'started', agentThreadId: id, agentPath: '/root/child' } })
    child.notify('turn/started', { threadId: id, turn: { id: 'child-turn-1', status: 'inProgress' } })
  }
  function childEnd(child: FakeProcess, status = 'completed', turn = 'child-turn-1') {
    child.notify('turn/completed', { threadId: 'child-1', turn: { id: turn, status, items: [{ id: 'public', type: 'agentMessage', text: 'child public reply' }] } })
  }
  it('is opt-in and ordinary no-background completion ends the lifetime', async () => {
    expect((await start()).session.workbenchRuntime).toBeUndefined()
    const run = await runtime(); completed(run.child); await run.done
    expect(run.api.snapshot()).toMatchObject({ retained: false, foreground: 'idle', backgroundCount: 0 })
    expect(() => run.api.start('again')).toThrow()
    await expect(run.api.submit('later', 'again')).rejects.toThrow()
  })
  it.each(['v1', 'v2'])('retains %s children, scopes late output, and deduplicates occurrence lifecycle', async mode => {
    const reportExecution = vi.fn(); const run = await runtime({ reportExecution })
    launch(run.child, mode); await expect.poll(() => run.api.snapshot().backgroundCount).toBe(1)
    completed(run.child); await expect.poll(() => run.events.filter(e => e.kind === 'result').length).toBe(1)
    expect(run.ended()).toBe(false); expect(run.api.snapshot()).toEqual({ retained: true, foreground: 'idle', backgroundCount: 1, input: 'send' })
    run.child.notify('item/completed', { threadId: 'child-1', turnId: 'child-turn-1', item: { id: 'public', type: 'agentMessage', text: 'x'.repeat(41000) } })
    childEnd(run.child); childEnd(run.child)
    run.child.notify('turn/started', { threadId: 'child-1', turn: { id: 'child-turn-1' } })
    await expect.poll(() => run.api.snapshot().backgroundCount).toBe(0)
    expect(run.events.filter(e => e.kind === 'text')).toEqual([])
    expect(run.events.filter(e => e.kind === 'tool_call' && e.activity?.output).every(e => e.kind === 'tool_call' && e.activity!.output!.length <= 40000)).toBe(true)
    const finished = run.events.findLast(e => e.kind === 'tool_call' && e.activity?.output)
    expect(finished).toMatchObject({ activity: { status: 'completed', output: 'child public reply' } })
    run.child.notify('model/rerouted', { threadId: 'child-1', turnId: 'child-turn-1', toModel: 'wrong-child-model' })
    expect(reportExecution).not.toHaveBeenCalled()
    run.child.notify('turn/started', { threadId: 'child-1', turn: { id: 'child-turn-2' } })
    await expect.poll(() => run.api.snapshot().backgroundCount).toBe(1)
    childEnd(run.child, 'failed', 'child-turn-2')
    await expect.poll(() => run.api.snapshot().backgroundCount).toBe(0)
    expect(run.events.filter(e => e.kind === 'error')).toEqual([])
    const ids = new Set(run.events.flatMap(e => e.kind === 'tool_call' && e.activity?.output ? [e.activity.id] : []))
    expect(ids.size).toBe(2)
    const snapshot = run.api.snapshot(); snapshot.retained = false; expect(run.api.snapshot().retained).toBe(true)
    await run.session.close(); await run.done
  })
  it('accepts child permission after parent result but rejects foreign, stale, or closed authority', async () => {
    let decide!: (value: boolean) => void
    const permit = vi.fn(() => new Promise<boolean>(resolve => { decide = resolve }))
    const run = await runtime({ requestPermission: permit }); launch(run.child)
    await expect.poll(() => run.api.snapshot().backgroundCount).toBe(1); completed(run.child)
    approval(run.child, 'foreign', undefined, { threadId: 'not-owned', turnId: 'child-turn-1' })
    approval(run.child, 'stale', undefined, { threadId: 'child-1', turnId: 'old' })
    approval(run.child, 'owned', undefined, { threadId: 'child-1', turnId: 'child-turn-1' })
    await expect.poll(() => permit.mock.calls.length).toBe(1)
    expect(run.child.sent.find(m => m.id === 'foreign')?.result.decision).toBe('decline')
    expect(run.child.sent.find(m => m.id === 'stale')?.result.decision).toBe('decline')
    run.child.notify('serverRequest/resolved', { threadId: 'not-owned', requestId: 'owned' })
    decide(true); await expect.poll(() => run.child.sent.find(m => m.id === 'owned')?.result.decision).toBe('accept')
    approval(run.child, 'late', undefined, { threadId: 'child-1', turnId: 'child-turn-1' })
    await expect.poll(() => permit.mock.calls.length).toBe(2)
    await run.session.cancel!(); decide(true); await run.session.close(); await run.done
    expect(run.child.sent.find(m => m.id === 'late')?.result.decision).toBe('decline')
    expect(run.child.sent.some(m => m.method === 'turn/interrupt' && m.params.threadId === 'child-1')).toBe(true)
  })
  it('requires native acknowledgements for steer and same-parent followup; submitted input retains epoch', async () => {
    const run = await runtime(); const accepted = run.api.submit('input-1', 'followup')
    await expect.poll(() => run.child.sent.some(m => m.method === 'turn/steer')).toBe(true)
    const steer = run.child.sent.find(m => m.method === 'turn/steer')!
    run.child.send({ id: steer.id, result: { turnId: 'turn-1' } }); await accepted
    completed(run.child); await expect.poll(() => run.api.snapshot().foreground).toBe('idle')
    expect(run.api.snapshot().retained).toBe(true); expect(run.ended()).toBe(false)
    run.child.autoTurnStart = false; let acknowledged = false
    const followup = run.api.submit('input-2', 'after result').then(() => { acknowledged = true })
    await begun(run.child, 2); expect(acknowledged).toBe(false)
    const request = run.child.sent.filter(m => m.method === 'turn/start').at(-1)!
    expect(request.params.threadId).toBe('thread-1')
    run.child.send({ id: request.id, result: { turn: { id: 'turn-2' } } }); await followup
    await run.api.submit('input-2', 'after result')
    expect(run.child.sent.filter(m => m.method === 'turn/start')).toHaveLength(2)
    await expect(run.api.submit('input-2', 'different')).rejects.toThrow()
    await run.session.close(); await run.done
  })
  it('has exactly one lifetime reader and verifies descendant lineage before granting child authority', async () => {
    const run = await runtime({ requestPermission: vi.fn(async () => true) })
    const other = run.api.events[Symbol.asyncIterator]()
    await expect(other.next()).rejects.toThrow('codex_events_already_consumed')
    nativeThreads['foreign-child'] = { id: 'foreign-child', cwd: '/project', source: { subAgent: { thread_spawn: { parent_thread_id: 'foreign-parent' } } } }
    run.child.notify('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'subAgentActivity', id: 'spawn', agentThreadId: 'foreign-child', kind: 'started' } })
    run.child.notify('turn/started', { threadId: 'foreign-child', turn: { id: 'foreign-turn' } })
    approval(run.child, 'no-authority', undefined, { threadId: 'foreign-child', turnId: 'foreign-turn' })
    await expect.poll(() => run.child.sent.find(m => m.id === 'no-authority')?.result.decision).toBe('decline')
    await run.session.close(); await run.done
  })
  it('aborts child questions only when their exact native owner resolves or stops', async () => {
    let answer!: (value: any) => void
    const requestUserInput = vi.fn(() => new Promise<any>(resolve => { answer = resolve }))
    const run = await runtime({ requestUserInput }); launch(run.child)
    await expect.poll(() => run.api.snapshot().backgroundCount).toBe(1); completed(run.child)
    question(run.child, 'child-question', { threadId: 'child-1', turnId: 'child-turn-1' })
    await expect.poll(() => requestUserInput.mock.calls.length).toBe(1)
    run.child.notify('serverRequest/resolved', { threadId: 'thread-1', requestId: 'child-question' })
    answer({ format: ['PDF'] })
    await expect.poll(() => run.child.sent.find(m => m.id === 'child-question')?.result.answers).toEqual({ format: { answers: ['PDF'] } })
    await run.session.close(); await run.done
  })
  it('buffers child registration and requests that precede the parent start acknowledgement', async () => {
    const permit = vi.fn(async () => true), { session, child } = await start({ workbenchLifecycle: true, requestPermission: permit })
    child.autoTurnStart = false; const api = session.workbenchRuntime!, events: AgentEvent[] = []
    const done = (async () => { for await (const event of api.events) events.push(event) })()
    api.start('parent'); await begun(child)
    launch(child)
    approval(child, 'early-child', undefined, { threadId: 'child-1', turnId: 'child-turn-1' })
    expect(permit).not.toHaveBeenCalled()
    const request = child.sent.find(m => m.method === 'turn/start')!
    child.send({ id: request.id, result: { turn: { id: 'turn-1' } } })
    await expect.poll(() => permit.mock.calls.length).toBe(1)
    completed(child); await expect.poll(() => api.snapshot().backgroundCount).toBe(1)
    await session.close(); await done
  })
  it('freezes submitted image bytes while waiting on the initial native start acknowledgement', async () => {
    const {session, child} = await start({workbenchLifecycle:true}); child.autoTurnStart = false
    const api = session.workbenchRuntime!, done = (async () => { for await (const _event of api.events) {} })()
    api.start('parent'); await begun(child)
    const attachments = [{name:'owned.png',mime:'image/png',path:'/owned.png',sha256:'a'.repeat(64),data:'T1JJR0lOQUw='}]
    const accepted = api.submit('frozen', 'inspect', attachments)
    attachments[0]!.data = 'UkVQTEFDRUQ='
    const initial = child.sent.find(m => m.method === 'turn/start')!
    child.send({id:initial.id,result:{turn:{id:'turn-1'}}})
    await expect.poll(() => child.sent.some(m => m.method === 'turn/steer')).toBe(true)
    const steer = child.sent.find(m => m.method === 'turn/steer')!
    expect(steer.params.input[1].url).toBe('data:image/png;base64,T1JJR0lOQUw=')
    child.send({id:steer.id,result:{turnId:'turn-1'}}); await accepted
    await session.close(); await done
  })
  it('projects late command completion from its original root turn without restoring old authority', async () => {
    const permit = vi.fn(async () => true), run = await runtime({requestPermission:permit})
    const item = {type:'commandExecution',id:'background-command',command:'owned task',processId:'123',status:'inProgress'}
    run.child.notify('item/started',{threadId:'thread-1',turnId:'turn-1',item})
    completed(run.child); await expect.poll(() => run.api.snapshot().foreground).toBe('idle')
    await run.api.submit('next','followup'); await begun(run.child,2)
    run.child.notify('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{...item,status:'completed',exitCode:0}})
    approval(run.child,'old-permission',undefined,{turnId:'turn-1'})
    await expect.poll(() => run.events.some(event => event.kind==='tool_call'&&event.activity?.id==='background-command'&&event.activity.status==='completed')).toBe(true)
    expect(run.api.snapshot()).toMatchObject({backgroundCount:0,foreground:'running'})
    expect(permit).not.toHaveBeenCalled()
    expect(run.child.sent.find(m=>m.id==='old-permission')?.result.decision).toBe('decline')
    await run.session.close(); await run.done
  })
  it('retains unknown native versions rather than asserting a no-background registration barrier', async () => {
    initializeResponse.userAgent='future-native/9.0.0 (owned fixture)'
    const run = await runtime(); completed(run.child)
    await expect.poll(() => run.api.snapshot().foreground).toBe('idle')
    expect(run.api.snapshot().retained).toBe(true); expect(run.ended()).toBe(false)
    await run.session.close(); await run.done
  })
  it('cleans each owned native terminal registry before returning from close', async () => {
    const run=await runtime();launch(run.child);await expect.poll(()=>run.api.snapshot().backgroundCount).toBe(1)
    completed(run.child); await run.session.close(); await run.done
    expect(run.child.sent.find(m=>m.method==='initialize')?.params.capabilities.experimentalApi).toBe(true)
    expect(run.child.sent.filter(m=>m.method==='thread/backgroundTerminals/clean').map(m=>m.params.threadId).sort()).toEqual(['child-1','thread-1'])
    expect(run.child.sent.filter(m=>m.method==='thread/backgroundTerminals/list').map(m=>m.params.threadId).sort()).toEqual(['child-1','thread-1'])
  })
  it.each(['unavailable','running'] as const)('refuses to confirm close when native terminal cleanup is %s', async state => {
    const run=await runtime();terminalCleanup=state
    const closing=run.session.close()
    await expect(run.api.submit('late','must not send')).rejects.toThrow('codex_session_closed')
    await expect(closing).rejects.toThrow('codex_terminal_cleanup_unverified')
    await run.done;expect(run.child.kill).toHaveBeenCalled()
  })
  it('never repeats an already requested native interrupt while closing the same epoch', async () => {
    const run=await runtime();launch(run.child);await expect.poll(()=>run.api.snapshot().backgroundCount).toBe(1)
    completed(run.child);await run.session.cancel!();await run.session.cancel!();await run.session.close();await run.done
    expect(run.child.sent.filter(m=>m.method==='turn/interrupt'&&m.params.threadId==='child-1')).toHaveLength(1)
  })
  it('does not treat unloaded metadata as proof that native background terminals were cleaned', async () => {
    const run=await runtime();terminalCleanup='unavailable'
    nativeThreads['thread-1']={id:'thread-1',status:{type:'notLoaded'}}
    await expect(run.session.close()).rejects.toThrow('codex_terminal_cleanup_unverified');await run.done
  })
  it('bounds unread lifetime output and fails closed instead of accumulating an unbounded stream', async () => {
    const {session,child}=await start({workbenchLifecycle:true});const api=session.workbenchRuntime!
    api.start('parent');await begun(child)
    for(let index=0;index<12;index++)child.notify('item/agentMessage/delta',{threadId:'thread-1',turnId:'turn-1',itemId:'huge-reply',delta:'x'.repeat(1_000_000)})
    const events:AgentEvent[]=[];for await(const event of api.events)events.push(event)
    expect(events.some(event=>event.kind==='error'&&event.message==='codex_runtime_output_limit')).toBe(true)
    await session.close()
  })
  it('keeps late child registrations for teardown after authority has closed', async () => {
    const run=await runtime();await run.session.cancel!()
    launch(run.child)
    await expect.poll(()=>run.api.snapshot().backgroundCount).toBe(1)
    await run.session.close();await run.done
    expect(run.child.sent.some(m=>m.method==='turn/interrupt'&&m.params.threadId==='child-1')).toBe(true)
    expect(run.child.sent.some(m=>m.method==='thread/backgroundTerminals/clean'&&m.params.threadId==='child-1')).toBe(true)
  })
  it('waits a previously requested interrupt fence when cancel and close overlap', async () => {
    const run=await runtime();run.child.autoInterrupt=false
    const cancelled=run.session.cancel!(),closing=run.session.close()
    await expect.poll(()=>run.child.sent.filter(m=>m.method==='turn/interrupt').length).toBe(1)
    expect(run.child.sent.some(m=>m.method==='thread/backgroundTerminals/clean')).toBe(false)
    const request=run.child.sent.find(m=>m.method==='turn/interrupt')!
    run.child.send({id:request.id,result:{}})
    await cancelled;await closing;await run.done
    expect(run.child.sent.filter(m=>m.method==='turn/interrupt')).toHaveLength(1)
  })
  it.each([true,false])('closes a pending start only with its exact observed native ID (identified=%s)', async identified => {
    const {session,child}=await start({workbenchLifecycle:true});child.autoTurnStart=false
    const api=session.workbenchRuntime!,done=(async()=>{for await(const _event of api.events){}})()
    api.start('parent');await begun(child)
    const closing=session.close()
    if(identified){
      child.notify('turn/started',{threadId:'thread-1',turn:{id:'actual-pending-turn'}})
      await closing
      expect(child.sent.some(m=>m.method==='turn/interrupt'&&m.params.turnId==='actual-pending-turn')).toBe(true)
    }else await expect(closing).rejects.toThrow('codex_terminal_cleanup_unverified')
    await done
  })
  it('keeps isolation after native process loss when unknown background ownership was retained', async () => {
    const run=await runtime()
    run.child.notify('item/started',{threadId:'thread-1',turnId:'turn-1',item:{type:'collabToolCall',id:'unknown-launch',tool:'futureBackground'}})
    completed(run.child);await expect.poll(()=>run.api.snapshot().foreground).toBe('idle')
    run.child.exit(7)
    await expect(run.session.close()).rejects.toThrow('codex_terminal_cleanup_unverified');await run.done
  })
  it('quarantines a newly observed unverified child outside the initial close cohort', async () => {
    const run=await runtime();run.child.autoInterrupt=false
    const closing=run.session.close()
    await expect.poll(()=>run.child.sent.some(m=>m.method==='turn/interrupt')).toBe(true)
    nativeThreads['late-unverified']={id:'late-unverified',cwd:'/other-worktree',source:{subAgent:{thread_spawn:{parent_thread_id:'thread-1'}}}}
    run.child.notify('item/started',{threadId:'thread-1',turnId:'turn-1',item:{type:'subAgentActivity',id:'late-launch',kind:'started',agentThreadId:'late-unverified'}})
    await expect.poll(()=>run.child.sent.some(m=>m.method==='thread/read'&&m.params.threadId==='late-unverified')).toBe(true)
    const interrupt=run.child.sent.find(m=>m.method==='turn/interrupt')!
    run.child.send({id:interrupt.id,result:{}})
    await expect(closing).rejects.toThrow('codex_terminal_cleanup_unverified');await run.done
    expect(run.child.kill).toHaveBeenCalled()
  })
  it('retains unknown launches and still-running command work at a parent milestone', async () => {
    for (const item of [{ type: 'collabToolCall', id: 'future', tool: 'futureBackground' }, { type: 'commandExecution', id: 'cmd', processId: '123', status: 'inProgress', command: 'owned task' }]) {
      const run = await runtime(); run.child.notify('item/started', { threadId: 'thread-1', turnId: 'turn-1', item })
      completed(run.child); await expect.poll(() => run.api.snapshot().foreground).toBe('idle')
      expect(run.api.snapshot().retained).toBe(true); expect(run.ended()).toBe(false)
      await run.session.close(); await run.done
    }
  })
})
