import { describe, expect, it, vi } from 'vitest'
import { runConflictSweep } from './sweep-conflicts'
import type { FactsApi } from '../../../core/knowledge/facts'

function fact(id: number, contact: string, predicate: string, value: string, updated: number) {
  return { id, contact, kind: 'attribute', predicate, value, related_contact: null, time_ref: null,
           confidence: 'med', source_msg_keys: [], status: 'active', created_at: updated, updated_at: updated,
           valid_from: updated, invalidated_at: null, superseded_by: null }
}

function api(groups: unknown[], superseded: unknown[] = []): FactsApi {
  return {
    nextBatch: vi.fn(), record: vi.fn(), contactFacts: vi.fn(), findFacts: vi.fn(),
    setFactStatus: vi.fn(), extractionStatus: vi.fn(),
    conflictedGroups: vi.fn(() => groups),
    supersede: vi.fn((pairs: unknown[]) => { superseded.push(...pairs); return { superseded: pairs.length } }),
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
    expect((facts.conflictedGroups as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(5)
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
})
