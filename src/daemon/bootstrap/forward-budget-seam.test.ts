import { describe, it, expect, vi } from 'vitest'
import { buildSharedForwardBudget } from './forward-budget-seam'
import type { AgentConfig } from '../../lib/agent-config'

const baseConfig: AgentConfig = { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false }

describe('buildSharedForwardBudget', () => {
  it('uses the 30/hour default when config.forward_budget is absent', () => {
    let t = 0
    const log = vi.fn()
    const withinBudget = buildSharedForwardBudget(baseConfig, log, { now: () => t })
    for (let i = 0; i < 30; i++) expect(withinBudget('ccs')).toBe(true)
    expect(withinBudget('ccs')).toBe(false)   // 31st this window → over budget
    expect(log).toHaveBeenCalledWith('SOCIAL_REC', '[forward-budget] over budget for ccs, local-only')
  })

  it('honors an explicit config.forward_budget', () => {
    let t = 0
    const log = vi.fn()
    const cfg: AgentConfig = { ...baseConfig, forward_budget: { per_sender: 2, window_ms: 1000 } }
    const withinBudget = buildSharedForwardBudget(cfg, log, { now: () => t })
    expect(withinBudget('ccs')).toBe(true)
    expect(withinBudget('ccs')).toBe(true)
    expect(withinBudget('ccs')).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('SHARED instance: a sender exhausted via one call path is also refused via a second call path (same bucket)', () => {
    let t = 0
    const log = vi.fn()
    const cfg: AgentConfig = { ...baseConfig, forward_budget: { per_sender: 1, window_ms: 1000 } }
    const withinBudget = buildSharedForwardBudget(cfg, log, { now: () => t })
    // Simulate the seek-forwarder consume point spending ccs's only token...
    expect(withinBudget('ccs')).toBe(true)
    // ...then the letter-relay consume point (a DIFFERENT call site, but the
    // SAME returned function reference — exactly how wire-social.ts injects
    // it into both ForwarderDeps.withinBudget and LetterRelayDeps.withinBudget)
    // sees ccs already over budget, proving both consume points share ONE bucket.
    expect(withinBudget('ccs')).toBe(false)
  })

  it('does not log when the sender is within budget', () => {
    let t = 0
    const log = vi.fn()
    const withinBudget = buildSharedForwardBudget(baseConfig, log, { now: () => t })
    withinBudget('ccs')
    expect(log).not.toHaveBeenCalled()
  })
})
