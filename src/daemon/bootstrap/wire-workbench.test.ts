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
 * 接上,不许留成死代码;fix round 2,复审「小的」②:第一版这里的假 agy
 * 带着 `workbenchRuntime` 且 `retained:true`——那是 claude/codex 的形状,
 * **真 agy 永远没有** `workbenchRuntime`(agy-agent-provider.ts 的
 * `spawn()` 只返回 `dispatch`/`cancel`/`close`,没有 `workbenchRuntime`
 * 字段;`registerUnattendedExecutors` 原样透传同一个 provider 对象,不做
 * 任何适配)。带着假形状的 'agy' 会让这条 e2e 走 `settleQuiet` 那条路
 * (claude/codex 专属),而真 agy 只走终态提交那条路径(fix round 2 第 1
 * 项新补的那处)——e2e 绿了,却正好没测到真正要测的那条路,比没有 e2e 更
 * 危险(这个仓库 09-16 刚因为 stale fixture 瞎了四天)。
 *
 * 改法:`spawn()` 直接返回 `dispatch`/`cancel`/`close`(照 service-unattended.test.ts
 * 的 `fakeProvider()` 写法,那是这个仓库给"非 retained、无
 * workbenchRuntime"执行者的既有惯用 fixture),一次 dispatch 就终态收尾,
 * 不经过 settleQuiet。真 agy 的会话也没有"续接"这个动作能推进 turnSeq
 * (`submitInput` 的 runtime 分支要求 `workbenchRuntime` 存在,agy 没有;
 * `steer` 它也没实现)——所以 turns 对这类执行者结构性地恒为 0,这条 e2e
 * 改成用 `overnight` 信号过门槛(matters store 注入一个"48 小时前"的固
 * 定时钟,让 matter.createdAt 与真实的 `Date.now()` 隔着至少一个 UTC 日
 * 历日),这比继续假装 turns 能到 2 更贴近这类执行者的真实处境。
 */
it('从微信交办的事(真 agy 形状:非 retained、无 workbenchRuntime),终态收尾时真的问了便宜模型、把回忆写进 journal', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wire-workbench-recollect-'))); acknowledgeDirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  saveAgentConfig(stateDir, { provider: 'agy', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false, workbench_unattended_ack_at: 999 })
  await saveCompanionConfig(stateDir, { ...defaultCompanionConfig(), default_chat_id: 'chat-1' })
  addProject(join(stateDir, 'projects.json'), 'project', project)
  const db = openDb({ path: join(stateDir, 'state.db') })
  // matter 的创建时刻钉在"48 小时前"——保证跟真实 Date.now() 隔着至少一个 UTC
  // 日历日,不依赖 turns(agy 结构性地推不动 turnSeq)也能过 overnight 门槛。
  const matters = makeMatterStore(db, () => Date.now() - 48 * 60 * 60 * 1000)
  const bootRegistry = createProviderRegistry()
  const asked: string[] = []
  bootRegistry.register('agy', {
    // 真 agy 的 spawn() 形状(agy-agent-provider.ts):没有 workbenchRuntime,
    // 一次 dispatch 吐完 text + result 就算这一轮完事——跟
    // service-unattended.test.ts 的 fakeProvider() 同一手法。
    async spawn() { return { async *dispatch() { yield { kind: 'text' as const, itemId: 't0', text: '做完了。' }; yield { kind: 'result' as const, sessionId: 'agy-1', numTurns: 1, durationMs: 1 } }, async cancel() {}, async close() {} } },
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
    // 非 retained:永不经过 settleQuiet,直接终态 done(跟 service-report.test.ts
    // 的「非 retained 执行者」用例、service-recollect.test.ts 的同类用例一致)。
    await expect.poll(() => matters.get(receipt.taskId)?.status).toBe('done')
    await expect.poll(() => asked.length).toBe(1)
    expect(asked[0]).toContain('改首页')
    const journal = makeJournal(db)
    await expect.poll(() => journal.list().length).toBe(1)
    expect(journal.list()[0]).toMatchObject({ kind: 'recollection', chat_id: 'chat-1', note: '那天你让我改首页，我改错了两次。' })
    await service.shutdown()
  } finally {
    db.close()
  }
})

/**
 * fix round 2(2026-09-23,复审新 Important ③):回忆的便宜模型来源必须是
 * `opts.boot.registry`(带 `/set cheap` 的 `cheapEvalProvider` 钉死、
 * `cheapEvalPreflight` 网络预检、`onProviderFailure`/`log` 诊断的那一
 * 个),不能是 `wireWorkbench` 自己另建的、`createProviderRegistry()`
 * **不带任何 opts** 的本地 registry——那个本地 registry 没有钉死机制,
 * `/set cheap` 对回忆完全无效。
 *
 * 判定方式:给 `bootRegistry` 钉死 `cheapEvalProvider` 到一个**只注册在
 * boot registry、从不会被 wireWorkbench 复制进本地 registry**的 id
 * (`registerUnattendedExecutors` 只复制 'agy';managed 的 claude/codex
 * 是本地重新构造的、跟 boot 这份是两个不同的 cheapEval 实现)。如果接线
 * 真的用 `opts.boot.registry.getCheapEval()`,钉死会生效,问到的是这个
 * "pinned" provider;如果不小心接回本地 registry(没有这份 opts,钉不
 * 住),就会落到本地注册的 agy(它有自己的 cheapEval),两者的回答内容
 * 从设计上就不同,断言能抓住这个差异。
 */
it('回忆的便宜模型来源是 opts.boot.registry(带 cheapEvalProvider 钉死),不是 wireWorkbench 自己那个没有 opts 的本地 registry', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wire-workbench-recollect-cheap-src-'))); acknowledgeDirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  saveAgentConfig(stateDir, { provider: 'agy', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false, workbench_unattended_ack_at: 999 })
  await saveCompanionConfig(stateDir, { ...defaultCompanionConfig(), default_chat_id: 'chat-1' })
  addProject(join(stateDir, 'projects.json'), 'project', project)
  const db = openDb({ path: join(stateDir, 'state.db') })
  const matters = makeMatterStore(db, () => Date.now() - 48 * 60 * 60 * 1000)
  const bootRegistry = createProviderRegistry({ cheapEvalProvider: () => 'pinned-cheap', log: () => {} })
  // 驱动任务的是 agy(真实形状,非 retained、无 workbenchRuntime),它自己也带
  // cheapEval——如果钉死没生效、接线退回本地那份 registry,问到的就会是它。
  bootRegistry.register('agy', {
    async spawn() { return { async *dispatch() { yield { kind: 'text' as const, itemId: 't0', text: '做完了。' }; yield { kind: 'result' as const, sessionId: 'agy-1', numTurns: 1, durationMs: 1 } }, async cancel() {}, async close() {} } },
    cheapEval: async () => '来自 agy 自己的便宜模型(不该被问到)',
  }, { displayName: 'Gemini (agy)', canResume: () => true })
  // 'pinned-cheap' 只注册在 boot registry——wireWorkbench 的 registerUnattendedExecutors
  // 只认 'agy' 这一个 id,不会把它复制进本地 registry;它也不是 claude/codex/cursor,
  // 不会被本地 registry 的其它构造路径间接建出来。
  bootRegistry.register('pinned-cheap', {
    async spawn() { throw new Error('pinned-cheap 不该被用来驱动任何工作台任务') },
    cheapEval: async (prompt: string) => { return `钉死答的:${prompt.includes('改首页') ? '改首页' : '?'}` },
  }, { displayName: 'Pinned', canResume: () => true })
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
    await expect.poll(() => matters.get(receipt.taskId)?.status).toBe('done')
    const journal = makeJournal(db)
    await expect.poll(() => journal.list().length).toBe(1)
    expect(journal.list()[0]!.note).toBe('钉死答的:改首页') // 不是 agy 自己那句
    await service.shutdown()
  } finally {
    db.close()
  }
})
