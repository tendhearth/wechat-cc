import { describe, expect, it } from 'vitest'
import { PROVIDER_IDS } from './provider-ids'
import { EXECUTOR_FACTS } from './executor-facts'
import { executorBinary } from './executor-detect'
import { activeModel, loadAgentConfig, saveAgentConfig, modelForProvider, withModelForProvider } from './agent-config'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from './test-temp'
import { classifyCall } from './call-classifier'
import { capabilitiesFor } from '../domain/capability-matrix'
import { compilePolicy } from '../domain/policy'
import { TIER_PROFILES } from '../domain/user-tier'
import { providerDenialFor, describeProviderDenial } from '../domain/provider-policy'
import { supportsOneoffAnswer } from '../domain/answer-target'
import { acpAgentProblem, resolveAcpAgent } from '../adapters/executors/acp/agents'

describe('Grok account ACP executor', () => {
  it('has its own identity, official account setup and measured endpoint, without an API credential', () => {
    expect(PROVIDER_IDS).toContain('grok')
    expect(EXECUTOR_FACTS.grok).toMatchObject({ id: 'grok', names: { name: 'Grok', short: 'Grok' }, slash: 'grok', modelField: 'grokModel', endpoint: { host: 'cli-chat-proxy.grok.com', source: '整合者实测 2026-11-16 grok 1.0.77 -p 一轮' } })
    expect(EXECUTOR_FACTS.grok.setupHint).toContain('curl -fsSL https://x.ai/cli/install.sh | bash')
    expect(EXECUTOR_FACTS.grok.setupHint).toContain('grok login')
    expect(EXECUTOR_FACTS.grok.credentialEnv).toBeUndefined()
  })

  it('detects one binary centrally and reserves the built-in id', () => {
    expect(executorBinary('grok', { grokBin: '/opt/grok' }, () => null)).toBe('/opt/grok')
    expect(executorBinary('grok', { grokBin: '  ' }, cmd => cmd === 'grok' ? '/local/grok' : null)).toBe('/local/grok')
    expect(resolveAcpAgent('grok', { grokBin: '/opt/grok' }, () => null)).toMatchObject({ id: 'grok', command: '/opt/grok', args: ['agent', '--no-leader', 'stdio'] })
    expect(acpAgentProblem({ id: 'grok', name: 'Other', command: 'other' })).toContain('内置执行者')
  })

  it('keeps Grok model configuration separate from the unchanged CC default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-config-'))
    try {
      saveAgentConfig(dir, { provider: 'claude', model: 'claude-model', grokModel: 'grok-4.7', grokBin: '/opt/grok', autoStart: false, closeStopsDaemon: false, dangerouslySkipPermissions: false })
      const config = loadAgentConfig(dir)
      expect(config.grokBin).toBe('/opt/grok')
      expect(modelForProvider(config, 'grok')).toBe('grok-4.7')
      expect(activeModel(withModelForProvider(config, 'grok', 'another-grok'))).toBe('claude-model')
    } finally { removeTempDir(dir) }
  })

  it('protects Grok and xAI official hosts, including setup traffic', () => {
    for (const target of [{ provider: 'grok' }, { provider: 'grok', purpose: 'setup' as const }, { provider: 'openai', baseUrl: 'https://api.x.ai/v1' }, { provider: 'openai', baseUrl: 'https://cli-chat-proxy.grok.com' }]) {
      expect(classifyCall(target)).toMatchObject({ protected: true, kind: 'official' })
    }
    expect(classifyCall({ provider: 'grok' })).toMatchObject({ host: 'cli-chat-proxy.grok.com', label: 'Grok' })
    expect(classifyCall({ provider: 'openai', baseUrl: 'https://not-grok.com' }).kind).toBe('custom_gateway')
  })

  it('supports text-only oneoff while keeping MCP, guest confinement, resume and delegation unavailable', () => {
    expect(capabilitiesFor('grok')).toMatchObject({ adminMcpTools: false, mcpTools: 'none', perToolCallback: false, supportsResume: false, supportsDelegation: false })
    expect(capabilitiesFor('grok').unavailableReason).toBeUndefined()
    expect(supportsOneoffAnswer('grok')).toBe(true)
    expect(supportsOneoffAnswer('agy')).toBe(false)
    expect(providerDenialFor('grok', 'guest', undefined)).toEqual({ kind: 'unconfined_guest' })
    expect(describeProviderDenial(providerDenialFor('grok', 'guest', undefined)!, 'grok')).toContain('访客')
    for (const tier of ['trusted', 'admin'] as const) {
      expect(providerDenialFor('grok', tier, undefined)).toBeNull()
      expect(compilePolicy('grok-acp', TIER_PROFILES[tier], 'strict')).toEqual({ answer: 'reject' })
      expect(compilePolicy('grok-acp', TIER_PROFILES[tier], 'dangerously')).toEqual({ answer: 'allow' })
    }
  })
})
