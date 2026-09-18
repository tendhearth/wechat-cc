import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerUnattendedExecutors, registerAcpExecutors, makeUnattendedAckStore, wireWorkbench, workbenchClaudeOptions } from './wire-workbench'
import { createProviderRegistry } from '../../core/provider-registry'
import { ACP_CAPABILITIES, UNATTENDED_CAPABILITIES } from '../../core/workbench/executor-capabilities'
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import { removeTempDir } from '../../lib/test-temp'
import { makeFakeSession } from '../../core/test-helpers'
import { openDb } from '../../lib/db'
import type { AgentProvider } from '../../core/agent-provider'
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
  const acp = fakeProvider(), create = vi.fn(() => acp)
  const registered = registerAcpExecutors(target, source, { cursorAgentBin: '/opt/cursor-agent' }, { create, findOnPath: () => null })
  expect(registered).toEqual(['cursor'])
  expect(create).toHaveBeenCalledWith({ command: '/opt/cursor-agent', args: ['acp'], displayName: 'Cursor' })
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
