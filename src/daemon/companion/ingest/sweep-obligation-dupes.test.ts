import { describe, expect, it, vi } from 'vitest'
import { runObligationDedup, buildObligationDedupPrompt } from './sweep-obligation-dupes'
import type { FactsApi } from '../../../core/knowledge/facts'

function fact(id: number, predicate: string, value: string, time_ref: string | null = null) {
  return { id, contact: 'u1', kind: 'obligation', predicate, value, related_contact: null, time_ref,
           confidence: 'med', source_msg_keys: [], status: 'active', created_at: 1, updated_at: 1,
           valid_from: 1, invalidated_at: null, superseded_by: null }
}

function api(heavy: Array<{ contact: string; n: number }>, rows: unknown[], mergedLog: unknown[] = []): FactsApi {
  return {
    nextBatch: vi.fn(), record: vi.fn(), findFacts: vi.fn(), setFactStatus: vi.fn(),
    extractionStatus: vi.fn(), conflictedGroups: vi.fn(() => []), supersede: vi.fn(),
    obligationHeavyContacts: vi.fn(() => heavy),
    contactFacts: vi.fn(() => ({ by_kind: { obligation: rows } })),
    mergeObligations: vi.fn((pairs: unknown[]) => { mergedLog.push(...pairs); return { merged: pairs.length } }),
  } as unknown as FactsApi
}

describe('buildObligationDedupPrompt', () => {
  it('lists id/predicate/value/time_ref and demands JSON-only conservative output', () => {
    const p = buildObligationDedupPrompt('u1', [fact(11, 'help_vps', '帮配 VPS', '今晚'), fact(22, 'setup_ts', '帮配 Tailscale')] as never)
    expect(p).toContain('#11「help_vps」帮配 VPS（今晚）')
    expect(p).toContain('#22「setup_ts」帮配 Tailscale')
    expect(p).toContain('只输出 JSON 数组')
    expect(p).toContain('不确定就不输出')
  })
})

describe('runObligationDedup', () => {
  it('one judge call per heavy contact; approved pairs merged', async () => {
    const mergedLog: unknown[] = []
    const facts = api([{ contact: 'u1', n: 2 }], [fact(11, 'a', 'x'), fact(22, 'b', 'x的另一种说法')], mergedLog)
    const cheapEval = vi.fn(async () => '[{"supersede":11,"by":22}]')
    const r = await runObligationDedup({ facts, cheapEval, contactCap: 3 })
    expect(cheapEval).toHaveBeenCalledTimes(1)
    expect(mergedLog).toEqual([{ supersede: 11, by: 22 }])
    expect(r).toEqual({ contacts: 1, merged: 1 })
  })

  it('judge refusal → nothing merged, no throw', async () => {
    const facts = api([{ contact: 'u1', n: 2 }], [fact(11, 'a', 'x'), fact(22, 'b', 'y')])
    const r = await runObligationDedup({ facts, cheapEval: async () => '我不能', contactCap: 3 })
    expect(r).toEqual({ contacts: 1, merged: 0 })
  })

  it('judge throw → swallowed, other contacts still processed', async () => {
    const mergedLog: unknown[] = []
    let call = 0
    const facts = api([{ contact: 'u1', n: 2 }, { contact: 'u2', n: 2 }], [fact(11, 'a', 'x'), fact(22, 'b', 'y')], mergedLog)
    const cheapEval = vi.fn(async () => {
      call++
      if (call === 1) throw new Error('model down')
      return '[{"supersede":11,"by":22}]'
    })
    const r = await runObligationDedup({ facts, cheapEval, contactCap: 3 })
    expect(r).toEqual({ contacts: 2, merged: 1 })
  })

  it('no heavy contacts → zero work, no judge calls', async () => {
    const cheapEval = vi.fn()
    const r = await runObligationDedup({ facts: api([], []), cheapEval, contactCap: 3 })
    expect(r).toEqual({ contacts: 0, merged: 0 })
    expect(cheapEval).not.toHaveBeenCalled()
  })
})
