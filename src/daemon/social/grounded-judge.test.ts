import { describe, it, expect } from 'vitest'
import { makeGroundedJudgeRunTurn } from './grounded-judge'
import { buildClaudeJudgeOptions } from '../../core/claude-agent-provider'
import { SOCIAL_JUDGE_PROFILE } from '../../core/user-tier'

const baseDeps = {
  pluginMcp: { wxsearch: { command: '/x', args: [], env: {} } },
  stateDir: '/tmp/x',
  log: () => {},
}

describe('makeGroundedJudgeRunTurn — provider dispatch', () => {
  it('returns a runTurn for openai when openai config is present', () => {
    const rt = makeGroundedJudgeRunTurn({
      ...baseDeps, providerId: 'openai',
      openai: { apiKey: 'k', baseUrl: 'http://x', model: 'm' },
    })
    expect(typeof rt).toBe('function')
  })

  it('returns null for openai when openai config is absent', () => {
    expect(makeGroundedJudgeRunTurn({ ...baseDeps, providerId: 'openai' })).toBeNull()
  })

  it('returns null for a provider with no adapter yet (gemini)', () => {
    expect(makeGroundedJudgeRunTurn({ ...baseDeps, providerId: 'gemini' })).toBeNull()
  })
})

describe('buildClaudeJudgeOptions — isolation', () => {
  const opts = buildClaudeJudgeOptions({
    pluginMcpForClaude: { wxsearch: { type: 'stdio', command: '/x', args: [], env: {} } },
    model: 'claude-x',
  })('a', '/tmp', SOCIAL_JUDGE_PROFILE, '_social_judge')

  it('mcpServers are plugins-only — no wechat, no delegate', () => {
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(['wxsearch'])
  })

  it('canUseTool allows a plugin MCP tool', async () => {
    const d = await opts.canUseTool!('mcp__wxsearch__find_facts', {}, {} as never)
    expect(d.behavior).toBe('allow')
  })

  it('canUseTool denies a non-plugin tool (Bash) — never prompts', async () => {
    const d = await opts.canUseTool!('Bash', { command: 'rm -rf /' }, {} as never)
    expect(d.behavior).toBe('deny')
  })
})

describe('makeGroundedJudgeRunTurn — claude', () => {
  it('returns a runTurn for claude', () => {
    const rt = makeGroundedJudgeRunTurn({
      ...baseDeps, providerId: 'claude', claude: { model: () => 'claude-x' },
    })
    expect(typeof rt).toBe('function')
  })
})
