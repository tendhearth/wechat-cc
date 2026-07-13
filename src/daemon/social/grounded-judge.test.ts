import { describe, it, expect } from 'vitest'
import { makeGroundedJudgeRunTurn } from './grounded-judge'

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
