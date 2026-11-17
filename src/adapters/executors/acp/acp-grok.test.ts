import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grokHome, grokSubprocessEnv } from '../../../lib/grok-home'
import { removeTempDir } from '../../../lib/test-temp'
import { createAcpGrokProvider } from './acp-grok'
import { createAcpProvider } from './acp-agent-provider'
import { createScriptedAcpAgent } from '../../../test-support/executors/acp-scripted-agent'
import { ONEOFF_PROFILE, TIER_PROFILES } from '../../../domain/user-tier'
import { ONEOFF_INSTRUCTIONS } from '../../../domain/answer-target'
import { createProviderRegistry } from '../../../app/provider-registry'
import { executionFailureMessage } from '../../store/workbench/execution-settings'

const context = { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' as const, chatId: 'test' }
const initialized = { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } }, _meta: { modelState: { currentModelId: 'grok-4.7', availableModels: [{ id: 'grok-4.7' }] } } }
const dirs: string[] = []
function loggedIn() {
  const dir = mkdtempSync(join(tmpdir(), 'grok-acp-home-')); dirs.push(dir)
  grokSubprocessEnv(dir, {})
  writeFileSync(join(grokHome(dir), '.grok/auth.json'), 'existence only, not real auth')
  return dir
}
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) removeTempDir(dir) })

describe('Grok ACP integration boundary', () => {
  it('explains unsupported MCP transport without suggesting Cursor login', () => {
    expect(executionFailureMessage('acp_mcp_stdio_unsupported')).toContain('stdio MCP')
    expect(executionFailureMessage('acp_mcp_stdio_unsupported')).not.toContain('Cursor')
    expect(executionFailureMessage('grok_auth_required')).toContain('CC 的专属 HOME')
    expect(executionFailureMessage('grok_auth_required')).not.toContain('Cursor')
  })
  it('cannot consume account quota through automatic or explicitly pinned background evaluation', () => {
    for (const cheapEvalProvider of [undefined, 'grok']) {
      const registry = createProviderRegistry({ cheapEvalProvider })
      registry.register('grok', createAcpGrokProvider({ networkPreflight: async () => true, bin: '/fake/grok', log: () => {} }), { canResume: () => false })
      expect(registry.getCheapEval()).toBeNull()
      expect(registry.getStrongEval('grok')).toBeNull()
    }
  })
  it.runIf(process.platform !== 'win32')('refuses any CLI without its dedicated HOME, even dangerously/workbench', async () => {
    const spawn = vi.fn() as unknown as typeof import('node:child_process').spawn
    for (const workbench of [false, true]) for (const permissionMode of ['strict', 'dangerously'] as const) {
      const provider = createAcpGrokProvider({ networkPreflight: async () => true, bin: '/fake/grok', log: () => {}, spawn, workbench })
      expect(provider.cheapEval).toBeUndefined()
      expect(provider.strongEval).toBeUndefined()
      await expect(provider.spawn({ alias: 'test', path: '/test' }, { ...context, permissionMode, mcpEnv: { WECHAT_SESSION_TOKEN: 'never-forward' } })).rejects.toThrow('专属 HOME')
    }
    expect(spawn).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')('requires a separate login and checks it again before every session', async () => {
    const stateDir = loggedIn(), spawn = vi.fn() as unknown as typeof import('node:child_process').spawn
    unlinkSync(join(grokHome(stateDir), '.grok/auth.json'))
    for (const workbench of [false, true]) {
      const provider = createAcpGrokProvider({ networkPreflight: async () => true, bin: '/fake/grok', stateDir, log: () => {}, spawn, workbench })
      await expect(provider.spawn({ alias: 'test', path: '/test' }, context)).rejects.toThrow(`HOME='${grokHome(stateDir)}' grok login`)
    }
    expect(spawn).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')('uses the dedicated HOME for chat and workbench, stripping daemon/config credentials', async () => {
    const stateDir = loggedIn(), owner = '/owner-home-sentinel'
    vi.stubEnv('HOME', owner); vi.stubEnv('GROK_AUTH_PATH', owner + '/.grok/auth.json'); vi.stubEnv('WECHAT_SESSION_TOKEN', 'never-forward')
    for (const workbench of [false, true]) {
      const fake = createScriptedAcpAgent({ initializeResult: initialized, turns: [] })
      const spawn = vi.fn(fake.spawn)
      const provider = createAcpGrokProvider({ networkPreflight: async () => true, bin: '/fake/grok', stateDir, log: () => {}, spawn: spawn as unknown as typeof fake.spawn, workbench })
      const session = await provider.spawn({ alias: 'test', path: '/test' }, context)
      try {
        const env = (spawn.mock.calls[0]![2] as import('node:child_process').SpawnOptions).env!
        expect(env.HOME).toBe(grokHome(stateDir))
        expect(Object.values(env).some(v => v?.includes(owner))).toBe(false)
        expect(env.WECHAT_SESSION_TOKEN).toBeUndefined()
        expect(env.GROK_AUTH_PATH).toBeUndefined()
        expect(provider.modelCatalog).toBeUndefined() // no unisolated `grok models` subprocess
        expect(fake.children[0]!.sent.find(r => r.method === 'session/new')?.params.mcpServers).toEqual([])
      } finally { await session.close() }
    }
  })

  it.runIf(process.platform !== 'win32')('delivers a final-text oneoff without MCP and rejects requested native commands', async () => {
    const fake = createScriptedAcpAgent({ initializeResult: initialized, turns: [{ steps: [{ native: 'execute', title: 'do not execute', command: 'echo forbidden' }, { say: '纯文字最终回复' }] }] })
    const provider = createAcpGrokProvider({ networkPreflight: async () => true, bin: '/fake/grok', stateDir: loggedIn(), log: () => {}, spawn: fake.spawn })
    const reportMatterTools = vi.fn()
    const session = await provider.spawn({ alias: '__oneoff__:test', path: '/empty-oneoff' }, { ...context, tierProfile: ONEOFF_PROFILE, oneoff: true, ephemeral: true, appendInstructions: ONEOFF_INSTRUCTIONS, reportMatterTools })
    try {
      const events = []
      for await (const e of session.dispatch('只回答这一句')) events.push(e)
      expect(events).toContainEqual({ kind: 'text', text: '纯文字最终回复' })
      expect(fake.children[0]!.sent.find(r => r.method === 'session/new')?.params.mcpServers).toEqual([])
      expect(fake.children[0]!.sent.some(r => r.result?.outcome?.outcome === 'selected' && r.result.outcome.optionId === 'reject-once')).toBe(true)
      expect(fake.children[0]!.prompts[0]).toContain('未接入 wechat、记忆、记录本或委派工具')
      expect(reportMatterTools).toHaveBeenCalledWith(false)
    } finally { await session.close() }
  })

  it.runIf(process.platform !== 'win32')('the ACP client understands the measured Grok model-state shape using only a fake process', async () => {
    const fake = createScriptedAcpAgent({ initializeResult: initialized, turns: [{ steps: [{ say: '假 Grok 回复' }] }] })
    const provider = createAcpProvider({ command: '/fake/grok', grokStateDir: loggedIn(), args: ['agent', '--no-leader', 'stdio'], displayName: 'Grok', targetProvider: 'grok', permissions: 'mode', text: 'messages', notice: null, spawn: fake.spawn })
    const session = await provider.spawn({ alias: 'test', path: '/test' }, context)
    try {
      expect(session.callTarget?.()).toEqual({ provider: 'grok', model: 'grok-4.7' })
      const events = []
      for await (const e of session.dispatch('问题')) events.push(e)
      expect(events).toContainEqual({ kind: 'text', text: '假 Grok 回复' })
      expect(fake.children[0]!.sent.find(r => r.method === 'session/new')?.params.mcpServers).toEqual([])
    } finally { await session.close() }
  })

  it.runIf(process.platform !== 'win32')('rejects stdio MCP before session/new when Grok only advertises http/sse', async () => {
    const fake = createScriptedAcpAgent({ initializeResult: initialized, turns: [] })
    const provider = createAcpProvider({ command: '/fake/grok', grokStateDir: loggedIn(), args: [], displayName: 'Grok', permissions: 'mode', text: 'messages', spawn: fake.spawn, requireMcpCapabilities: true, mcpServers: () => [{ name: 'wechat', command: '/cc', args: [], env: [] }] })
    await expect(provider.spawn({ alias: 'test', path: '/test' }, context)).rejects.toThrow('acp_mcp_stdio_unsupported')
    expect(fake.children[0]!.sent.some(r => r.method === 'session/new')).toBe(false)
  })
})
