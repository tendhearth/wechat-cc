import { describe, it, expect } from 'vitest'
import { makeForwardBudget } from './forward-budget'

describe('makeForwardBudget', () => {
  it('allows up to perSender then refuses, and refills over injected time', () => {
    let t = 0
    const budget = makeForwardBudget({ perSender: 2, windowMs: 1000, now: () => t })
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)   // bucket empty
    t += 500                                          // half the window → +1 token
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)    // spent the refilled token
  })

  it('per-sender isolation: exhausting one sender does not affect another', () => {
    let t = 0
    const budget = makeForwardBudget({ perSender: 1, windowMs: 1000, now: () => t })
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)
    expect(budget.withinBudget('ccq')).toBe(true)     // independent bucket
  })

  it('a big time jump caps refill at capacity, never over-fills', () => {
    let t = 0
    const budget = makeForwardBudget({ perSender: 3, windowMs: 1000, now: () => t })
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)    // empty
    t += 1_000_000                                     // way past one window
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)    // capped at 3, not unlimited
  })

  it('a backwards clock is a no-op (no extra tokens minted)', () => {
    let t = 1000
    const budget = makeForwardBudget({ perSender: 1, windowMs: 1000, now: () => t })
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)    // empty
    t = 500                                            // clock moves BACKWARDS
    expect(budget.withinBudget('ccs')).toBe(false)    // still empty, no negative refill
  })

  it('defaults the clock to Date.now when now is omitted', () => {
    const budget = makeForwardBudget({ perSender: 1, windowMs: 1000 })
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)
  })
})
