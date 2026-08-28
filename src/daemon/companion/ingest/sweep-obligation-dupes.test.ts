import { describe, expect, it, vi } from 'vitest'
import { runObligationDedup, buildObligationDedupPrompt } from './sweep-obligation-dupes'
import type { FactsApi } from '../../../core/knowledge/facts'

function fact(id: number, predicate: string, value: string, time_ref: string | null = null) {
  return { id, contact: 'u1', kind: 'obligation', predicate, value, related_contact: null, time_ref,
           confidence: 'med', source_msg_keys: [], status: 'active', created_at: 1, updated_at: 1,
           valid_from: 1, invalidated_at: null, superseded_by: null }
}

function api(heavy: Array<{ contact: string; n: number }>, rows: unknown[], mergedLog: unknown[] = []): FactsApi {
  const judgeState = new Map<string, string>()
  return {
    nextBatch: vi.fn(), record: vi.fn(), findFacts: vi.fn(), setFactStatus: vi.fn(),
    extractionStatus: vi.fn(), conflictedGroups: vi.fn(() => []), supersede: vi.fn(),
    obligationHeavyContacts: vi.fn(() => heavy),
    contactFacts: vi.fn(() => ({ by_kind: { obligation: rows } })),
    mergeObligations: vi.fn((pairs: unknown[]) => { mergedLog.push(...pairs); return { merged: pairs.length } }),
    judgeFingerprint: vi.fn((key: string) => judgeState.get(key) ?? null),
    setJudgeFingerprint: vi.fn((key: string, fp: string) => { judgeState.set(key, fp) }),
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

  it('unchanged contact stock judged once with [] is NOT re-judged next cycle', async () => {
    const facts = api([{ contact: 'u1', n: 2 }], [fact(11, 'a', 'x'), fact(22, 'b', 'y')])
    const cheapEval = vi.fn(async () => '[]')
    await runObligationDedup({ facts, cheapEval, contactCap: 3 })
    expect(cheapEval).toHaveBeenCalledTimes(1)
    const r2 = await runObligationDedup({ facts, cheapEval, contactCap: 3 })
    expect(cheapEval).toHaveBeenCalledTimes(1)                  // second cycle: zero calls
    expect(r2).toEqual({ contacts: 0, merged: 0 })
  })

  it('a contact whose obligations changed since the verdict IS re-judged', async () => {
    const rows: unknown[] = [fact(11, 'a', 'x'), fact(22, 'b', 'y')]
    const facts = api([{ contact: 'u1', n: 2 }], rows)
    const cheapEval = vi.fn(async () => '[]')
    await runObligationDedup({ facts, cheapEval, contactCap: 3 })
    rows.push(fact(33, 'c', 'z'))                               // new obligation extracted
    await runObligationDedup({ facts, cheapEval, contactCap: 3 })
    expect(cheapEval).toHaveBeenCalledTimes(2)
  })

  it('skipped unchanged contacts make room for the backlog beyond the cap', async () => {
    const facts = api([{ contact: 'u1', n: 3 }, { contact: 'u2', n: 2 }],
                      [fact(11, 'a', 'x'), fact(22, 'b', 'y')])
    const cheapEval = vi.fn(async () => '[]')
    const r1 = await runObligationDedup({ facts, cheapEval, contactCap: 1 })
    expect(r1.contacts).toBe(1)                                 // cap respected: only u1 judged
    const r2 = await runObligationDedup({ facts, cheapEval, contactCap: 1 })
    expect(r2.contacts).toBe(1)                                 // u1 skipped, u2 gets its turn
    expect(cheapEval).toHaveBeenCalledTimes(2)
    const r3 = await runObligationDedup({ facts, cheapEval, contactCap: 1 })
    expect(r3.contacts).toBe(0)                                 // both settled into fingerprints
  })

  it('judge throw records no fingerprint — the contact is retried next cycle', async () => {
    const facts = api([{ contact: 'u1', n: 2 }], [fact(11, 'a', 'x'), fact(22, 'b', 'y')])
    await runObligationDedup({ facts, cheapEval: async () => { throw new Error('down') }, contactCap: 3 })
    const cheapEval = vi.fn(async () => '[]')
    await runObligationDedup({ facts, cheapEval, contactCap: 3 })
    expect(cheapEval).toHaveBeenCalledTimes(1)                  // retried, not skipped
  })
})
