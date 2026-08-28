import { describe, expect, it, vi } from 'vitest'
import { runSettlementBackfill, SETTLE_ACTIVITY_WINDOW_S } from './sweep-obligation-settled'
import { SWEEP_FEED_OVERSCAN } from './sweep-conflicts'
import type { FactsApi } from '../../../core/knowledge/facts'

const NOW = 1_756_000_000

function fact(id: number, predicate: string, value: string) {
  return { id, contact: 'u1', kind: 'obligation', predicate, value, related_contact: null, time_ref: null,
           confidence: 'med', source_msg_keys: [], status: 'active', created_at: 1, updated_at: 1,
           valid_from: 1, invalidated_at: null, superseded_by: null }
}

function api(over: Partial<FactsApi> = {}): FactsApi {
  const judgeState = new Map<string, string>()
  return {
    nextBatch: vi.fn(), record: vi.fn(), findFacts: vi.fn(), setFactStatus: vi.fn(),
    extractionStatus: vi.fn(), conflictedGroups: vi.fn(() => []), supersede: vi.fn(),
    obligationHeavyContacts: vi.fn(() => [{ contact: 'u1', n: 1 }]),
    contactFacts: vi.fn(() => ({ by_kind: { obligation: [fact(7, '还书', '答应还《三体》')] } })),
    recentMessages: vi.fn(() => [{ sender: 'u1', time: NOW - 3600, text: '书收到啦，谢谢！' }]),
    mergeObligations: vi.fn(() => ({ merged: 0 })),
    settleObligations: vi.fn(() => ({ settled: 1 })),
    judgeFingerprint: vi.fn((key: string) => judgeState.get(key) ?? null),
    setJudgeFingerprint: vi.fn((key: string, fp: string) => { judgeState.set(key, fp) }),
    ...over,
  } as unknown as FactsApi
}

describe('runSettlementBackfill', () => {
  it('judges heavy contacts (minCount=1) against recent chat and settles confirmed ids', async () => {
    const facts = api()
    const cheapEval = vi.fn(async (p: string) => {
      expect(p).toContain('书收到啦')
      expect(p).toContain('#7「还书」答应还《三体》')
      return '[7]'
    })
    const r = await runSettlementBackfill({ facts, cheapEval, contactCap: 2, now: () => NOW })
    // Feed is overscanned so gate-skipped contacts can't starve the backlog.
    expect(facts.obligationHeavyContacts).toHaveBeenCalledWith(2 * SWEEP_FEED_OVERSCAN, 1)
    expect(facts.settleObligations).toHaveBeenCalledWith('u1', [7], NOW)
    expect(r).toEqual({ contacts: 1, settled: 1 })
  })

  it('skips contacts with no recent activity inside the window', async () => {
    const stale = NOW - SETTLE_ACTIVITY_WINDOW_S - 10
    const facts = api({ recentMessages: vi.fn(() => [{ sender: 'u1', time: stale, text: '老消息' }]) } as never)
    const cheapEval = vi.fn()
    const r = await runSettlementBackfill({ facts, cheapEval, contactCap: 2, now: () => NOW })
    expect(cheapEval).not.toHaveBeenCalled()
    expect(r).toEqual({ contacts: 0, settled: 0 })
  })

  it('judge refusal or [] → nothing settled, no throw', async () => {
    const facts = api()
    const r = await runSettlementBackfill({ facts, cheapEval: async () => '我不能', contactCap: 2, now: () => NOW })
    expect(facts.settleObligations).not.toHaveBeenCalled()
    expect(r).toEqual({ contacts: 1, settled: 0 })
  })

  it('judge throw on one contact → others still processed', async () => {
    const facts = api({
      obligationHeavyContacts: vi.fn(() => [{ contact: 'u1', n: 1 }, { contact: 'u2', n: 1 }]),
    } as never)
    let call = 0
    const cheapEval = vi.fn(async () => {
      call++
      if (call === 1) throw new Error('model down')
      return '[7]'
    })
    const r = await runSettlementBackfill({ facts, cheapEval, contactCap: 3, now: () => NOW })
    expect(r).toEqual({ contacts: 2, settled: 1 })
  })

  it('no heavy contacts → zero work', async () => {
    const facts = api({ obligationHeavyContacts: vi.fn(() => []) } as never)
    const cheapEval = vi.fn()
    const r = await runSettlementBackfill({ facts, cheapEval, contactCap: 2, now: () => NOW })
    expect(cheapEval).not.toHaveBeenCalled()
    expect(r).toEqual({ contacts: 0, settled: 0 })
  })

  it('no new message since the last verdict → NOT re-judged next cycle', async () => {
    const facts = api()
    const cheapEval = vi.fn(async () => '[]')
    await runSettlementBackfill({ facts, cheapEval, contactCap: 2, now: () => NOW })
    expect(cheapEval).toHaveBeenCalledTimes(1)
    const r2 = await runSettlementBackfill({ facts, cheapEval, contactCap: 2, now: () => NOW })
    expect(cheapEval).toHaveBeenCalledTimes(1)                  // same evidence — zero calls
    expect(r2).toEqual({ contacts: 0, settled: 0 })
  })

  it('a new message after the verdict re-opens the contact', async () => {
    const msgs = [{ sender: 'u1', time: NOW - 3600, text: '书收到啦，谢谢！' }]
    const facts = api({ recentMessages: vi.fn(() => msgs) } as never)
    const cheapEval = vi.fn(async () => '[]')
    await runSettlementBackfill({ facts, cheapEval, contactCap: 2, now: () => NOW })
    msgs.push({ sender: 'u1', time: NOW - 60, text: 'VPS 也弄好了' })
    await runSettlementBackfill({ facts, cheapEval, contactCap: 2, now: () => NOW })
    expect(cheapEval).toHaveBeenCalledTimes(2)
  })

  it('gate-skipped contacts make room for the backlog beyond the cap', async () => {
    const facts = api({
      obligationHeavyContacts: vi.fn(() => [{ contact: 'u1', n: 2 }, { contact: 'u2', n: 1 }]),
    } as never)
    const cheapEval = vi.fn(async () => '[]')
    const r1 = await runSettlementBackfill({ facts, cheapEval, contactCap: 1, now: () => NOW })
    expect(r1.contacts).toBe(1)                                 // cap respected: only u1 judged
    const r2 = await runSettlementBackfill({ facts, cheapEval, contactCap: 1, now: () => NOW })
    expect(r2.contacts).toBe(1)                                 // u1 gated, u2 gets its turn
    expect(cheapEval).toHaveBeenCalledTimes(2)
  })

  it('judge throw records no fingerprint — the contact is retried next cycle', async () => {
    const facts = api()
    await runSettlementBackfill({ facts, cheapEval: async () => { throw new Error('down') }, contactCap: 2, now: () => NOW })
    const cheapEval = vi.fn(async () => '[]')
    await runSettlementBackfill({ facts, cheapEval, contactCap: 2, now: () => NOW })
    expect(cheapEval).toHaveBeenCalledTimes(1)                  // retried, not skipped
  })
})
