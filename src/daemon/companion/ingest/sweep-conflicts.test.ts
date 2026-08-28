import { describe, expect, it, vi } from 'vitest'
import { runConflictSweep, SWEEP_FEED_OVERSCAN } from './sweep-conflicts'
import type { FactsApi } from '../../../core/knowledge/facts'

function fact(id: number, contact: string, predicate: string, value: string, updated: number) {
  return { id, contact, kind: 'attribute', predicate, value, related_contact: null, time_ref: null,
           confidence: 'med', source_msg_keys: [], status: 'active', created_at: updated, updated_at: updated,
           valid_from: updated, invalidated_at: null, superseded_by: null }
}

function api(groups: unknown[], superseded: unknown[] = []): FactsApi {
  const judgeState = new Map<string, string>()
  return {
    nextBatch: vi.fn(), record: vi.fn(), contactFacts: vi.fn(), findFacts: vi.fn(),
    setFactStatus: vi.fn(), extractionStatus: vi.fn(),
    conflictedGroups: vi.fn(() => groups),
    supersede: vi.fn((pairs: unknown[]) => { superseded.push(...pairs); return { superseded: pairs.length } }),
    judgeFingerprint: vi.fn((key: string) => judgeState.get(key) ?? null),
    setJudgeFingerprint: vi.fn((key: string, fp: string) => { judgeState.set(key, fp) }),
  } as unknown as FactsApi
}

const GROUP = {
  contact: 'u1', predicate: '住在',
  facts: [fact(22, 'u1', '住在', '上海', 2000), fact(11, 'u1', '住在', '北京', 1000)],
}

describe('runConflictSweep', () => {
  it('no conflicted groups → no judge call, zero report', async () => {
    const cheapEval = vi.fn()
    const r = await runConflictSweep({ facts: api([]), cheapEval, cap: 5 })
    expect(r).toEqual({ groups: 0, superseded: 0 })
    expect(cheapEval).not.toHaveBeenCalled()
  })

  it('one judge call covers all capped groups; approved pairs are superseded', async () => {
    const applied: unknown[] = []
    const facts = api([GROUP], applied)
    const cheapEval = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('#22')
      expect(prompt).toContain('#11')
      return '[{"supersede":11,"by":22}]'
    })
    const r = await runConflictSweep({ facts, cheapEval, cap: 5 })
    expect(cheapEval).toHaveBeenCalledTimes(1)
    expect(applied).toEqual([{ supersede: 11, by: 22 }])
    expect(r).toEqual({ groups: 1, superseded: 1 })
    // Feed is overscanned so fingerprint-skipped stock can't starve the backlog.
    expect((facts.conflictedGroups as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(5 * SWEEP_FEED_OVERSCAN)
  })

  it('judge refusal/garbage → nothing superseded, no throw', async () => {
    const applied: unknown[] = []
    const r = await runConflictSweep({ facts: api([GROUP], applied), cheapEval: async () => '我不能', cap: 5 })
    expect(applied).toEqual([])
    expect(r).toEqual({ groups: 1, superseded: 0 })
  })

  it('judge throw → swallowed, zero superseded', async () => {
    const r = await runConflictSweep({
      facts: api([GROUP]),
      cheapEval: async () => { throw new Error('model down') },
      cap: 5,
    })
    expect(r).toEqual({ groups: 1, superseded: 0 })
  })

  it('unchanged stock judged once with no action is NOT re-judged next cycle', async () => {
    const facts = api([GROUP])
    const cheapEval = vi.fn(async () => '[]')                   // coexist verdict — nothing superseded
    await runConflictSweep({ facts, cheapEval, cap: 5 })
    expect(cheapEval).toHaveBeenCalledTimes(1)
    const r2 = await runConflictSweep({ facts, cheapEval, cap: 5 })
    expect(cheapEval).toHaveBeenCalledTimes(1)                  // second cycle: zero calls
    expect(r2).toEqual({ groups: 0, superseded: 0 })
  })

  it('a group whose facts changed since the last verdict IS re-judged', async () => {
    const groups = [structuredClone(GROUP)]
    const facts = api(groups)
    const cheapEval = vi.fn(async () => '[]')
    await runConflictSweep({ facts, cheapEval, cap: 5 })
    groups[0]!.facts.push(fact(33, 'u1', '住在', '广州', 3000)) // new evidence lands in the group
    await runConflictSweep({ facts, cheapEval, cap: 5 })
    expect(cheapEval).toHaveBeenCalledTimes(2)
  })

  it('skipped unchanged groups make room for backlog beyond the cap', async () => {
    const mk = (i: number) => ({
      contact: `u${i}`, predicate: 'p',
      facts: [fact(i * 10, `u${i}`, 'p', 'a', 2000), fact(i * 10 + 1, `u${i}`, 'p', 'b', 1000)],
    })
    const six = [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)]
    const facts = api(six)
    const seen: string[] = []
    const cheapEval = vi.fn(async (prompt: string) => { seen.push(prompt); return '[]' })
    await runConflictSweep({ facts, cheapEval, cap: 5 })        // judges u1..u5
    await runConflictSweep({ facts, cheapEval, cap: 5 })        // u1..u5 unchanged → u6 gets its turn
    expect(cheapEval).toHaveBeenCalledTimes(2)
    expect(seen[1]).toContain('#60')                            // u6's facts got their turn
    expect(seen[1]).not.toContain('#10')                        // u1's unchanged stock skipped
  })

  it('judge throw records no fingerprint — the same stock is retried next cycle', async () => {
    const facts = api([GROUP])
    await runConflictSweep({ facts, cheapEval: async () => { throw new Error('down') }, cap: 5 })
    const cheapEval = vi.fn(async () => '[]')
    await runConflictSweep({ facts, cheapEval, cap: 5 })
    expect(cheapEval).toHaveBeenCalledTimes(1)                  // retried, not skipped
  })
})
