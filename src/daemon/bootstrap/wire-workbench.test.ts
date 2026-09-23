import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { registerUnattendedExecutors, registerAcpExecutors, makeUnattendedAckStore, wireWorkbench, workbenchClaudeOptions } from './wire-workbench'
import { createProviderRegistry } from '../../core/provider-registry'
import { ACP_CAPABILITIES, UNATTENDED_CAPABILITIES } from '../../core/workbench/executor-capabilities'
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import { defaultCompanionConfig, saveCompanionConfig } from '../companion/config'
import { addProject } from '../../lib/project-registry'
import { removeTempDir } from '../../lib/test-temp'
import { makeFakeSession } from '../../core/test-helpers'
import { openDb } from '../../lib/db'
import { AsyncQueue } from '../../core/async-queue'
import type { AgentEvent, AgentRuntimeSnapshot, AgentSession, AgentWorkbenchRuntime, AgentProvider } from '../../core/agent-provider'
import { makeMatterStore } from '../../core/matters/store'
import { makeReportOutboxStore } from '../reports/outbox'
import { makeJournal } from '../../core/journal-store'
import type { Bootstrap } from './types'

it('does not inherit companion memory, MCP servers or daemon permission bypass into office work', async () => {
  const permit = vi.fn(async () => ({ behavior: 'allow' as const }))
  const base = { cwd:'/project',model:'existing-model',permissionMode:'bypassPermissions' as const,mcpServers:{ private:{ command:'private-memory' } },systemPrompt:'private life memory',canUseTool:permit,settingSources:['project' as const,'local' as const] }
  const options=workbenchClaudeOptions(base,'task-only instructions',permit)
  expect(options.permissionMode).toBe('default')
  expect(options.mcpServers).toEqual({})
  expect(options.settingSources).toEqual(['project','local'])
  expect(options.strictMcpConfig).toBe(true)
  expect(options.allowDangerouslySkipPermissions).toBe(false)
  expect(options.hooks).toEqual({})
  expect(options.systemPrompt).toEqual({ type:'preset',preset:'claude_code',append:'task-only instructions' })
  expect(options.model).toBe('existing-model')
  const decision=await options.canUseTool!('mcp__wechat__reply',{text:'publish'}, { signal:new AbortController().signal,toolUseID:'id' })
  expect(decision.behavior).toBe('deny')
})

it('inherits native tools through exact server asks but never inherits companion execution settings', () => {
  const options = workbenchClaudeOptions({ cwd:'/project', model:'native-model', allowedTools:['*'], agents:{ personal:{ description:'private',prompt:'private memory' } }, env:{ PATH:'/bin', ANTHROPIC_API_KEY:'native-auth', WECHAT_SESSION_TOKEN:'private' }, settings:{ permissions:{ defaultMode:'bypassPermissions' } } }, 'task instructions', vi.fn(), { servers:{ catalog:{ command:'catalog-server' } }, omitted:[] })
  expect(options.mcpServers).toEqual({ catalog:{ command:'catalog-server' } })
  expect(options.settings).toMatchObject({ disableAllHooks:true, disableSkillShellExecution:true, permissions:{ defaultMode:'default',disableBypassPermissionsMode:'disable',ask:expect.arrayContaining(['mcp__catalog__*','Bash']) } })
  expect(options.allowedTools).toEqual([])
  expect(options.agents).toBeUndefined()
  expect(options.env).not.toHaveProperty('WECHAT_SESSION_TOKEN')
  expect(options.env?.ANTHROPIC_API_KEY === 'native-auth').toBe(true)
})

it('neutralizes private disk settings environment names at flag scope without overriding ordinary native auth', () => {
  const options=workbenchClaudeOptions({cwd:'/project',env:{CATALOG_API_KEY:'native-tool-auth'}},'',vi.fn(),{
    servers:{catalog:{command:'catalog-server'}},omitted:[],
    privateEnvironmentKeys:['WECHAT_SETTINGS_PROOF','hearth_settings_proof','WXVAULT_SETTINGS_PROOF','WxGraph_SETTINGS_PROOF'],
  })
  expect(options.settings).toMatchObject({env:{
    WECHAT_SETTINGS_PROOF:'',hearth_settings_proof:'',WXVAULT_SETTINGS_PROOF:'',WxGraph_SETTINGS_PROOF:'',
  }})
  expect(options.env?.CATALOG_API_KEY).toBe('native-tool-auth')
  expect(options.settings).not.toHaveProperty('env.CATALOG_API_KEY')
})

it('passes merged native MCP allow and deny policy at flag scope', () => {
  const nativeMcpPolicy={allowedMcpServers:[{serverName:'catalog'},{serverName:'extra'}],deniedMcpServers:[{serverUrl:'https://blocked.example/*'}]}
  const options=workbenchClaudeOptions({cwd:'/project'},'',vi.fn(),{servers:{catalog:{command:'catalog-server'}},omitted:[],nativeMcpPolicy})
  expect(options.settings).toMatchObject(nativeMcpPolicy)
})

it('retains provider reasoning defaults for a fresh task while excluding unrelated companion options',()=>{
  const options=workbenchClaudeOptions({cwd:'/project',model:'configured-model',effort:'low',thinking:{type:'adaptive'},fallbackModel:'companion-fallback'},'',vi.fn())
  expect(options.effort).toBe('low')
  expect(options.thinking).toEqual({type:'adaptive'})
  expect(options.fallbackModel).toBeUndefined()
})

const fakeProvider = (): AgentProvider => ({
  spawn: async () => makeFakeSession({ events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }] }),
})

it('registers only agy as unattended; cursor is no longer an unattended executor', () => {
  const source = createProviderRegistry(), target = createProviderRegistry()
  const agy = fakeProvider(), cursor = fakeProvider()
  source.register('agy', agy, { displayName: 'Gemini (agy)', canResume: () => true })
  source.register('cursor', cursor, { displayName: 'Cursor', canResume: () => false })
  const registered = registerUnattendedExecutors(target, source)
  expect(registered).toEqual(['agy'])
  expect(target.get('agy')!.provider).toBe(agy)
  expect(target.get('agy')!.opts.workbench).toBe(UNATTENDED_CAPABILITIES)
  expect(target.has('cursor')).toBe(false)
})

it('registers cursor through the ACP provider with ACP capabilities when the binary resolves', () => {
  const source = createProviderRegistry(), target = createProviderRegistry()
  source.register('cursor', fakeProvider(), { displayName: 'Cursor', canResume: () => true })
  const acp = fakeProvider(), create = vi.fn(() => acp), log = vi.fn()
  const registered = registerAcpExecutors(target, source, { cursorAgentBin: '/opt/cursor-agent' }, { create, findOnPath: () => null, log })
  expect(registered).toEqual(['cursor'])
  // log 必须接到 provider 上,否则 sessionId 对不上而丢掉的更新在 daemon 日志里一声不吭。
  expect(create).toHaveBeenCalledWith({ command: '/opt/cursor-agent', args: ['acp'], displayName: 'Cursor', log })
  expect(target.get('cursor')!.provider).toBe(acp)
  expect(target.get('cursor')!.opts.displayName).toBe('Cursor')
  expect(target.get('cursor')!.opts.workbench).toBe(ACP_CAPABILITIES)
})

it('registers nothing for ACP when boot lacks cursor or the binary cannot be resolved', () => {
  const source = createProviderRegistry(), target = createProviderRegistry()
  expect(registerAcpExecutors(target, source, {}, { findOnPath: () => '/usr/bin/cursor-agent', create: vi.fn() })).toEqual([])
  source.register('cursor', fakeProvider(), { displayName: 'Cursor', canResume: () => true })
  const log = vi.fn()
  expect(registerAcpExecutors(target, source, {}, { findOnPath: () => null, create: vi.fn(), log })).toEqual([])
  expect(target.has('cursor')).toBe(false)
  expect(log).toHaveBeenCalledWith('WORKBENCH', expect.stringContaining('cursor'))
})

it('registers nothing when the source registry lacks agy/cursor', () => {
  const source = createProviderRegistry(), target = createProviderRegistry()
  source.register('claude', fakeProvider(), { displayName: 'Claude', canResume: () => true })
  const registered = registerUnattendedExecutors(target, source)
  expect(registered).toEqual([])
  expect(target.has('agy')).toBe(false)
  expect(target.has('cursor')).toBe(false)
  expect(target.list()).toEqual([])
})

const acknowledgeDirs: string[] = []
afterEach(() => { for (const dir of acknowledgeDirs.splice(0)) removeTempDir(dir) })

it('round-trips the unattended-ack timestamp through agent-config.json, preserving other fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unattended-ack-')); acknowledgeDirs.push(dir)
  saveAgentConfig(dir, { provider: 'claude', bot_name: 'kept', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false })
  const store = makeUnattendedAckStore(dir)
  expect(store.get()).toBeNull()
  store.set(123)
  expect(store.get()).toBe(123)
  const after = loadAgentConfig(dir)
  expect(after.bot_name).toBe('kept')
  expect(after.workbench_unattended_ack_at).toBe(123)
})

it('wires boot-discovered agy into the live workbench service with unattended permissions and the persisted ack', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wire-workbench-'))); acknowledgeDirs.push(root)
  const stateDir = join(root, 'state')
  saveAgentConfig(stateDir, { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false, workbench_unattended_ack_at: 999 })
  const db = openDb({ path: join(stateDir, 'state.db') })
  const bootRegistry = createProviderRegistry()
  bootRegistry.register('agy', fakeProvider(), { displayName: 'Gemini (agy)', canResume: () => true })
  const boot = {
    registry: bootRegistry,
    sdkOptionsForProject: (() => ({})) as unknown as Bootstrap['sdkOptionsForProject'],
    defaultProviderId: 'agy',
    holdBusy: (_label: string) => () => {},
  } as unknown as Bootstrap
  try {
    const service = wireWorkbench({
      db, stateDir, boot,
      internalApi: { mintSessionToken: () => 'token', invalidateSession: () => {} },
      askUser: async () => 'allow',
      log: () => {},
    })
    const list = service.list()
    const agy = list.providers.find(p => p.id === 'agy')
    expect(agy).toBeDefined()
    expect(agy!.displayName).toBe('Gemini (agy)')
    expect(agy!.capabilities.permissions).toBe('unattended')
    expect(list.unattendedAcknowledgedAt).toBe(999)
  } finally {
    db.close()
  }
})

/**
 * 端到端接线(task-3,2026-09-23):matters + reportOutbox 一起传给
 * wireWorkbench 时,「一件事」结算那一拍应该真的把回报写进
 * matter_report_outbox(v65),等 sweeper 取件——不只是单元测试里假的
 * ReportSink 被调用。claude/codex 在 wireWorkbench 里会被包成真正走
 * SDK 的 provider(见上面几个 workbenchClaudeOptions 测试),没法在单测
 * 里假造事件流;agy 是 registerUnattendedExecutors 原样透传 boot 注册的
 * provider,所以借它接一个可控的 TurnRuntime。
 */
class TurnRuntime {
  queue = new AsyncQueue<AgentEvent>()
  state: AgentRuntimeSnapshot = { retained: true, foreground: 'running', backgroundCount: 0, input: 'send' }
  subscribed = false
  runtime: AgentWorkbenchRuntime = {
    events: { [Symbol.asyncIterator]: () => { this.subscribed = true; return this.queue.iterable()[Symbol.asyncIterator]() } },
    start: () => { if (!this.subscribed) throw Error('runtime_start_without_consumer'); this.queue.push({ kind: 'init', sessionId: 'native-1' }); this.queue.push({ kind: 'text', itemId: 't0', text: '做。' }) },
    submit: async () => {},
    snapshot: () => this.state,
  }
  session: AgentSession = { workbenchRuntime: this.runtime, async *dispatch() {}, close: async () => { this.queue.end() } }
  finishTurn() { this.state = { ...this.state, foreground: 'idle' }; this.queue.push({ kind: 'result', sessionId: 'native-1', numTurns: 1, durationMs: 1 }) }
}

it('从微信交办的事,答复静下来那一拍真的把回报写进 matter_report_outbox(v65)', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wire-workbench-reports-'))); acknowledgeDirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  saveAgentConfig(stateDir, { provider: 'agy', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false, workbench_unattended_ack_at: 999 })
  await saveCompanionConfig(stateDir, { ...defaultCompanionConfig(), default_chat_id: 'chat-1' })
  addProject(join(stateDir, 'projects.json'), 'project', project)
  const db = openDb({ path: join(stateDir, 'state.db') })
  const matters = makeMatterStore(db), reportOutbox = makeReportOutboxStore(db)
  const bootRegistry = createProviderRegistry()
  const runtime = new TurnRuntime()
  bootRegistry.register('agy', { async spawn() { return runtime.session } }, { displayName: 'Gemini (agy)', canResume: () => true })
  const boot = {
    registry: bootRegistry,
    sdkOptionsForProject: (() => ({})) as unknown as Bootstrap['sdkOptionsForProject'],
    defaultProviderId: 'agy',
    holdBusy: (_label: string) => () => {},
  } as unknown as Bootstrap
  try {
    const service = wireWorkbench({
      db, stateDir, boot, matters, reportOutbox,
      internalApi: { mintSessionToken: () => 'token', invalidateSession: () => {} },
      askUser: async () => 'allow',
      log: () => {},
    })
    const projectView = service.projects().find(p => p.path === project)!
    const receipt = service.createWechat({
      ownerChatId: 'chat-1', accountId: 'acct-1', requestId: randomUUID(),
      commandHash: createHash('sha256').update('改首页').digest('hex'),
      originMessageId: 'msg-7', projectId: projectView.id, providerId: 'agy', text: '改首页',
    })
    await expect.poll(() => matters.sessions(receipt.taskId)).not.toHaveLength(0)
    runtime.finishTurn()
    await expect.poll(() => matters.get(receipt.taskId)?.status).toBe('replied')
    const chat = matters.ensureChat('chat-1')
    await expect.poll(async () => (await reportOutbox.listDue(Date.now() + 1)).length).toBeGreaterThan(0)
    const due = await reportOutbox.listDue(Date.now() + 1)
    expect(due).toEqual([expect.objectContaining({ matterId: receipt.taskId, originMatterId: chat.id, originMessageId: 'msg-7' })])
    await service.shutdown()
  } finally {
    db.close()
  }
})

/**
 * 端到端接线(task-5,fix round 1,2026-09-23,控制器裁决:这一轮必须真的
 * 接上,不许留成死代码):只传 matters(不传 reportOutbox,证明「回忆」这
 * 条不依赖回报那条),来回两轮之后 turnSeq 达到 STORY_SIGNALS.turns(2),
 * 真的通过这个 wireWorkbench 自己建的 `registry.getCheapEval()` 问到便宜
 * 模型(借 agy 那个假 provider 挂一个 cheapEval 字段),写进真实的
 * journal(makeJournal(opts.db) 那份,不是单测里假的 Journal)。
 */
class RecollectTurnRuntime {
  queue = new AsyncQueue<AgentEvent>()
  state: AgentRuntimeSnapshot = { retained: true, foreground: 'running', backgroundCount: 0, input: 'send' }
  subscribed = false
  runtime: AgentWorkbenchRuntime = {
    events: { [Symbol.asyncIterator]: () => { this.subscribed = true; return this.queue.iterable()[Symbol.asyncIterator]() } },
    start: () => { if (!this.subscribed) throw Error('runtime_start_without_consumer'); this.queue.push({ kind: 'init', sessionId: 'native-1' }); this.queue.push({ kind: 'text', itemId: 't0', text: '做。' }) },
    // 每次续接都直接吐一个 result——跟 service-report.test.ts 的 TurnRuntime 同一手法,
    // 让每次 submitInput 都能干净地再落一次 settleQuiet。
    submit: async () => { this.queue.push({ kind: 'result', sessionId: 'native-1', numTurns: 1, durationMs: 1 }) },
    snapshot: () => this.state,
  }
  session: AgentSession = { workbenchRuntime: this.runtime, async *dispatch() {}, close: async () => { this.queue.end() } }
  finishTurn() { this.state = { ...this.state, foreground: 'idle' }; this.queue.push({ kind: 'result', sessionId: 'native-1', numTurns: 1, durationMs: 1 }) }
}

it('从微信交办的事,来回两轮之后真的问了便宜模型、把回忆写进 journal', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wire-workbench-recollect-'))); acknowledgeDirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  saveAgentConfig(stateDir, { provider: 'agy', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false, workbench_unattended_ack_at: 999 })
  await saveCompanionConfig(stateDir, { ...defaultCompanionConfig(), default_chat_id: 'chat-1' })
  addProject(join(stateDir, 'projects.json'), 'project', project)
  const db = openDb({ path: join(stateDir, 'state.db') })
  const matters = makeMatterStore(db)
  const bootRegistry = createProviderRegistry()
  const runtime = new RecollectTurnRuntime()
  const asked: string[] = []
  bootRegistry.register('agy', {
    async spawn() { return runtime.session },
    cheapEval: async (prompt: string) => { asked.push(prompt); return '那天你让我改首页，我改错了两次。' },
  }, { displayName: 'Gemini (agy)', canResume: () => true })
  const boot = {
    registry: bootRegistry,
    sdkOptionsForProject: (() => ({})) as unknown as Bootstrap['sdkOptionsForProject'],
    defaultProviderId: 'agy',
    holdBusy: (_label: string) => () => {},
  } as unknown as Bootstrap
  try {
    const service = wireWorkbench({
      db, stateDir, boot, matters,
      internalApi: { mintSessionToken: () => 'token', invalidateSession: () => {} },
      askUser: async () => 'allow',
      log: () => {},
    })
    const projectView = service.projects().find(p => p.path === project)!
    const receipt = service.createWechat({
      ownerChatId: 'chat-1', accountId: 'acct-1', requestId: randomUUID(),
      commandHash: createHash('sha256').update('改首页').digest('hex'),
      originMessageId: 'msg-7', projectId: projectView.id, providerId: 'agy', text: '改首页',
    })
    await expect.poll(() => matters.sessions(receipt.taskId)).not.toHaveLength(0)
    runtime.finishTurn() // turnSeq 还是 0(还没有续接)——够不上门槛,不该问模型。
    await expect.poll(() => matters.get(receipt.taskId)?.status).toBe('replied')
    expect(asked).toEqual([])
    const journal = makeJournal(db)
    expect(journal.list()).toEqual([])
    let runId = service.detail(receipt.taskId).runId!
    await service.submitInput(receipt.taskId, { runId, requestId: randomUUID(), text: '再改一下' }) // turnSeq → 1,还不够。
    await expect.poll(() => journal.list().length + asked.length).toBe(0) // 稳一拍,确认真的没提前触发
    runId = service.detail(receipt.taskId).runId!
    await service.submitInput(receipt.taskId, { runId, requestId: randomUUID(), text: '再改一下' }) // turnSeq → 2,够了。
    await expect.poll(() => asked.length).toBe(1)
    expect(asked[0]).toContain('改首页')
    await expect.poll(() => journal.list().length).toBe(1)
    expect(journal.list()[0]).toMatchObject({ kind: 'recollection', chat_id: 'chat-1', note: '那天你让我改首页，我改错了两次。' })
    await service.shutdown()
  } finally {
    db.close()
  }
})
