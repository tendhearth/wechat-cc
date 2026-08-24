import { describe, it, expect, vi } from 'vitest'
import { makeInProcFactsCall } from './facts-inproc'
import type { FactsApi } from '../../../core/knowledge/facts'

function fakeFacts(over: Partial<FactsApi> = {}): FactsApi {
  return {
    nextBatch: vi.fn(() => ({ done: true })),
    record: vi.fn(() => ({ recorded: 0, merged: 0, advanced_to: 0 })),
    contactFacts: vi.fn(() => ({})),
    findFacts: vi.fn(() => ({ results: [] })),
    setFactStatus: vi.fn(() => ({ ok: true })),
    extractionStatus: vi.fn(() => ({})),
    supersede: vi.fn(() => ({ superseded: 0 })),
    conflictedGroups: vi.fn(() => []),
    obligationHeavyContacts: vi.fn(() => []),
    mergeObligations: vi.fn(() => ({ merged: 0 })),
    settleObligations: vi.fn(() => ({ settled: 0 })),
    recentMessages: vi.fn(() => []),
    ...over,
  }
}

describe('makeInProcFactsCall', () => {
  it('extraction_batch delegates to facts.nextBatch(contact, limit) and stringifies the result', async () => {
    const sentinel = { batch_id: 'x', contact: 'c', messages: [] }
    const facts = fakeFacts({ nextBatch: vi.fn(() => sentinel) })
    const call = makeInProcFactsCall(facts)
    const out = await call('extraction_batch', { limit: 5 })
    expect(facts.nextBatch).toHaveBeenCalledWith(null, 5)
    expect(out).toBe(JSON.stringify(sentinel))
  })

  it('extraction_batch defaults contact to null and limit to 40 when omitted', async () => {
    const facts = fakeFacts()
    const call = makeInProcFactsCall(facts)
    await call('extraction_batch')
    expect(facts.nextBatch).toHaveBeenCalledWith(null, 40)
  })

  it('extraction_batch passes through an explicit contact', async () => {
    const facts = fakeFacts()
    const call = makeInProcFactsCall(facts)
    await call('extraction_batch', { contact: 'alice' })
    expect(facts.nextBatch).toHaveBeenCalledWith('alice', 40)
  })

  it('record_facts delegates to facts.record(batch_id, facts, injected now) and stringifies the result', async () => {
    const sentinel = { recorded: 2, merged: 1, advanced_to: 99 }
    const facts = fakeFacts({ record: vi.fn(() => sentinel) })
    const call = makeInProcFactsCall(facts, () => 12345)
    const inputFacts = [{ kind: 'entity', predicate: '是', value: 'x' }]
    const out = await call('record_facts', { batch_id: 'b', facts: inputFacts })
    expect(facts.record).toHaveBeenCalledWith('b', inputFacts, 12345)
    expect(out).toBe(JSON.stringify(sentinel))
  })

  it('record_facts defaults facts to [] when omitted', async () => {
    const facts = fakeFacts()
    const call = makeInProcFactsCall(facts, () => 1)
    await call('record_facts', { batch_id: 'b' })
    expect(facts.record).toHaveBeenCalledWith('b', [], 1)
  })

  it('rejects any other tool name', async () => {
    const facts = fakeFacts()
    const call = makeInProcFactsCall(facts)
    await expect(call('some_other_tool', {})).rejects.toThrow(/extraction_batch\/record_facts/)
  })

  it('uses the default nowFn (wall clock seconds) when none is injected', async () => {
    const facts = fakeFacts()
    const call = makeInProcFactsCall(facts)
    const before = Math.floor(Date.now() / 1000)
    await call('record_facts', { batch_id: 'b', facts: [] })
    const after = Math.floor(Date.now() / 1000)
    const now = (facts.record as ReturnType<typeof vi.fn>).mock.calls[0]![2]
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(after)
  })
})

it('active_obligations returns the contact\'s active obligation rows from contactFacts', async () => {
  const rows = [{ id: 7, kind: 'obligation', predicate: 'p', value: 'v' }]
  const facts = fakeFacts({ contactFacts: vi.fn(() => ({ by_kind: { obligation: rows } })) })
  const call = makeInProcFactsCall(facts)
  const out = JSON.parse(await call('active_obligations', { contact: 'alice' }))
  expect(facts.contactFacts).toHaveBeenCalledWith('alice')
  expect(out).toEqual({ obligations: rows })
})

it('active_obligations returns [] when the contact has no obligation kind', async () => {
  const facts = fakeFacts({ contactFacts: vi.fn(() => ({ by_kind: {} })) })
  const call = makeInProcFactsCall(facts)
  expect(JSON.parse(await call('active_obligations', { contact: 'alice' }))).toEqual({ obligations: [] })
})

it('settle_obligations routes to FactsApi.settleObligations with contact + ids', async () => {
  const facts = fakeFacts({ settleObligations: vi.fn(() => ({ settled: 2 })) })
  const call = makeInProcFactsCall(facts, () => 42)
  const out = JSON.parse(await call('settle_obligations', { contact: 'alice', ids: [7, 9] }))
  expect(out).toEqual({ settled: 2 })
  expect(facts.settleObligations).toHaveBeenCalledWith('alice', [7, 9], 42)
})

it('supersede_facts routes to FactsApi.supersede with the pairs', async () => {
  const facts = fakeFacts({ supersede: vi.fn((pairs: Array<{ supersede: number; by: number }>) => ({ superseded: pairs.length })) })
  const call = makeInProcFactsCall(facts, () => 42)
  const out = JSON.parse(await call('supersede_facts', { pairs: [{ supersede: 1, by: 2 }] }))
  expect(out).toEqual({ superseded: 1 })
  expect(facts.supersede).toHaveBeenCalledWith([{ supersede: 1, by: 2 }], 42)
})
