import { describe, expect, it } from 'vitest'
import { buildCheckupPlan, gradeMemory, scoreMemory, estimateCheckup } from './butler-checkup'

describe('synthetic butler checkup', () => {
  it('reproduces only fabricated conversations from a fixed seed at each depth', () => {
    const a = buildCheckupPlan({ seed: 769, windowTokens: 8192, full: false })
    expect(a).toEqual(buildCheckupPlan({ seed: 769, windowTokens: 8192, full: false }))
    expect(a.memory.map(s => s.fillRatio)).toEqual([.1, .25, .4, .6, .8])
    for (const sample of a.memory) {
      expect(sample.answers).toHaveLength(3)
      expect(sample.prompt).toContain('虚构')
      for (const answer of sample.answers) expect(sample.prompt).toContain(answer)
    }
    expect(a).not.toEqual(buildCheckupPlan({ seed: 770, windowTokens: 8192, full: false }))
  })
  it('locates the last reliable stage and grades all-correct / all-wrong honestly', () => {
    const stages = [.1, .25, .4, .6, .8].map(fillRatio => ({ fillRatio, accuracy: fillRatio < .6 ? 1 : 0 }))
    expect(gradeMemory(stages)).toEqual({ reliableFillRatio: .4, memory: 'fair' })
    expect(gradeMemory(stages.map(s => ({ ...s, accuracy: 1 })))).toEqual({ reliableFillRatio: .8, memory: 'good' })
    expect(gradeMemory(stages.map(s => ({ ...s, accuracy: 0 })))).toEqual({ reliableFillRatio: 0, memory: 'weak' })
    expect(scoreMemory('["a","b","x"]', ['a', 'b', 'c'])).toBeCloseTo(2 / 3)
  })
  it('estimates requests and bounded retries before creating a model session', () => {
    const short = estimateCheckup({ windowTokens: 8192, full: false })
    const full = estimateCheckup({ windowTokens: 8192, full: true })
    expect(short.requests).toBe(11)
    expect(short.maxRequests).toBe(54)
    expect(short.outputTokens).toBe(27 * (4096 + 8192))
    expect(full.requests).toBeGreaterThan(short.requests)
    expect(full.inputTokens).toBeGreaterThan(short.inputTokens)
  })
})
