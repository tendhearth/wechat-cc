import { describe, expect, it } from 'vitest'
import { addAcpAgent, detectGeminiAuthMethod, formatAcpAgents, removeAcpAgent } from './acp-agents'

const onPath = (cmd: string) => (cmd === 'gemini' ? '/usr/local/bin/gemini' : null)

describe('cli acp (2026-10-07)', () => {
  it('adds a preset by id when its binary is installed; refuses a missing one', () => {
    const r = addAcpAgent([], { id: 'gemini-cli' }, onPath)
    expect(r).toMatchObject({ ok: true, agent: { id: 'gemini-cli', name: 'Gemini CLI', command: 'gemini', args: ['--acp'] }, replaced: false })
    expect(addAcpAgent([], { id: 'opencode' }, onPath)).toMatchObject({ ok: false, error: expect.stringContaining('没找到 opencode') })
  })
  it('custom command, replacement by id, and validation', () => {
    const first = addAcpAgent([], { id: 'my-agent', name: '我的', command: '/opt/a/bin', args: ['serve', '--acp'] }, onPath)
    expect(first.ok).toBe(true)
    const again = addAcpAgent(first.ok ? first.agents : [], { id: 'my-agent', command: '/opt/b' }, onPath)
    expect(again).toMatchObject({ ok: true, replaced: true })
    expect(again.ok && again.agents).toHaveLength(1)
    expect(addAcpAgent([], { id: 'unknown-thing' }, onPath)).toMatchObject({ ok: false, error: expect.stringContaining('--command') })
    expect(addAcpAgent([], { id: 'claude', command: '/x' }, onPath)).toMatchObject({ ok: false, error: expect.stringContaining('内置') })
    expect(addAcpAgent([], { id: 'Bad Id', command: '/x' }, onPath)).toMatchObject({ ok: false })
  })
  it('removes and lists (marks missing commands and installed presets)', () => {
    const agents = [{ id: 'gemini-cli', name: 'Gemini CLI', command: 'gemini', args: ['--acp'] }, { id: 'ghost', name: 'Ghost', command: 'ghost-cli' }]
    expect(removeAcpAgent(agents, 'ghost')).toEqual({ ok: true, agents: [agents[0]] })
    expect(removeAcpAgent(agents, 'nope')).toMatchObject({ ok: false })
    const text = formatAcpAgents(agents, onPath)
    expect(text).toContain('ghost-cli  (找不到命令,不会登记)')
    expect(text).toContain('gemini-cli  Gemini CLI  gemini --acp  (已装)')
  })
  it('presets read the local login method; explicit --auth-method wins; bad settings are ignored', () => {
    expect(addAcpAgent([], { id: 'gemini-cli' }, onPath, () => 'oauth-personal')).toMatchObject({ ok: true, agent: { auth_method: 'oauth-personal' } })
    expect(addAcpAgent([], { id: 'gemini-cli', authMethod: 'gemini-api-key' }, onPath, () => 'oauth-personal')).toMatchObject({ ok: true, agent: { auth_method: 'gemini-api-key' } })
    expect(detectGeminiAuthMethod(() => JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }))).toBe('oauth-personal')
    expect(detectGeminiAuthMethod(() => JSON.stringify({ selectedAuthType: 'vertex-ai' }))).toBe('vertex-ai')
    expect(detectGeminiAuthMethod(() => '{oops')).toBeNull()
    expect(detectGeminiAuthMethod(() => null)).toBeNull()
  })
})
