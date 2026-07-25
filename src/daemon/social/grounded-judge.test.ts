import { describe, it, expect } from 'vitest'
import { makeGroundedJudgeRunTurn } from './grounded-judge'
import { buildClaudeJudgeOptions } from '../../core/claude-agent-provider'
import { buildOpenaiMcpSpecs } from '../bootstrap/mcp-specs'
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

  it('returns null when pluginMcp is EMPTY even for a fitting adapter — a plugins-only judge with 0 plugin tools is structurally blind (ws-bench stall root cause 2026-07-22)', () => {
    // claude adapter fits, but no wx* servers are mounted (fresh/dev/bench box
    // without wxvault-decrypted facts). Grounding is impossible → the caller
    // must fall back to cheapEval, NOT spawn a pointless 26s blind judge.
    expect(makeGroundedJudgeRunTurn({ ...baseDeps, pluginMcp: {}, providerId: 'claude', claude: { model: () => 'claude-x' } })).toBeNull()
    expect(makeGroundedJudgeRunTurn({ ...baseDeps, pluginMcp: {}, providerId: 'openai', openai: { apiKey: 'k', baseUrl: 'http://x', model: 'm' } })).toBeNull()
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

  it('strictMcpConfig is set — ignores stray .mcp.json/settings MCP servers at cwd', () => {
    expect(opts.strictMcpConfig).toBe(true)
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

describe('buildOpenaiMcpSpecs — isolation (openai judge adapter)', () => {
  it('mcpServers are plugins-only — no wechat, no delegate', () => {
    const specs = buildOpenaiMcpSpecs(
      { wechat: null, delegate: null, pluginMcp: { wxsearch: { command: '/x', args: [], env: {} } } },
      {},
    )
    expect(Object.keys(specs)).toEqual(['wxsearch'])
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
