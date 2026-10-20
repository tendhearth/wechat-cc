import { describe, expect, it } from 'vitest'
import { usageDelta, claudeResultUsage, codexBreakdown, sumUsage } from './turn-usage'

describe('turn usage', () => {
  it('claude result.usage ⇒ tokens only (cost never guessed)', () => {
    expect(claudeResultUsage({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, total_cost_usd: 0.4 })).toEqual({ input: 10, output: 20, cacheRead: 5, cacheWrite: 2 })
    expect(claudeResultUsage(undefined)).toBeUndefined()
    expect(claudeResultUsage({ input_tokens: 'x' })).toBeUndefined()
  })
  it('codex breakdown ⇒ usage', () => {
    expect(codexBreakdown({ totalTokens: 40, inputTokens: 30, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 8, reasoningOutputTokens: 2 })).toEqual({ input: 30, output: 8, cacheRead: 10, cacheWrite: 0, reasoning: 2 })
    expect(codexBreakdown(null)).toBeUndefined()
  })
  it('delta of cumulative totals; a negative field (restart) ⇒ the new total is a new segment', () => {
    expect(usageDelta({ input: 100, output: 50 }, { input: 160, output: 70 })).toEqual({ input: 60, output: 20 })
    expect(usageDelta(undefined, { input: 10, output: 5 })).toEqual({ input: 10, output: 5 })
    expect(usageDelta({ input: 100, output: 50 }, { input: 30, output: 10 })).toEqual({ input: 30, output: 10 })
  })
  it('sumUsage: unknown fields stay unknown (null), never 0', () => {
    expect(sumUsage([{ input: 1, output: 2 }, { input: 3 }])).toEqual({ turns: 2, input: 4, output: 2, cacheRead: null, cacheWrite: null, reasoning: null, costUsd: null })
    expect(sumUsage([])).toEqual({ turns: 0, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, costUsd: null })
  })
})
