import { describe, it, expect, vi } from 'vitest'
import { makeForwarder } from './social-forwarder'
import type { IntentEvent } from './a2a-server'
import type { IntentCard, MatchReceipt } from './a2a-intent'

function card(over: Partial<IntentCard> = {}): IntentCard {
  return { intent_id: 'i1', kind: 'seek', topic: 't', hop: 1, expires_at: '2026-07-15T01:00:00.000Z', ...over }
}
function event(agentId: string, over: Partial<IntentCard> = {}): IntentEvent {
  return { agent: { id: agentId } as any, card: card(over) }
}

describe('makeForwarder', () => {
  it('judges locally AND forwards hop+1 to peers minus sender, aggregating degree-2 echoes', async () => {
    const answerLocally = vi.fn(async (): Promise<MatchReceipt> => ({ intent_id: 'i1', match: 'no' }))
    const forwardSend = vi.fn(async (_t: { id: string }, _c: IntentCard): Promise<MatchReceipt | null> => ({ intent_id: 'i1', match: 'yes', blurb: '我认识个摄影师' }))
    const recordRelay = vi.fn((_i: string, _up: string, downstream: string) => `tok-${downstream}`)
    const forwardTargets = vi.fn((exclude: string) => [{ id: 'ccq' }, { id: 'ccr' }].filter(t => t.id !== exclude))
    const fwd = makeForwarder({ answerLocally, forwardTargets, forwardSend, recordRelay, markSeen: vi.fn(), hasSeen: () => false })

    const r = await fwd(event('ccs'))

    expect(r.match).toBe('no')
    expect(forwardTargets).toHaveBeenCalledWith('ccs')
    // hop+1 card forwarded to each of the 2 targets.
    expect(forwardSend).toHaveBeenCalledTimes(2)
    expect(forwardSend.mock.calls[0]![1].hop).toBe(2)
    expect(r.forwarded).toEqual([
      { blurb: '我认识个摄影师', degree: 2, relay_token: 'tok-ccq' },
      { blurb: '我认识个摄影师', degree: 2, relay_token: 'tok-ccr' },
    ])
  })

  it('excludes the sender from forward targets', async () => {
    const forwardTargets = vi.fn((exclude: string) => [{ id: 'ccs' }, { id: 'ccq' }].filter(t => t.id !== exclude))
    const forwardSend = vi.fn(async (): Promise<MatchReceipt | null> => ({ intent_id: 'i1', match: 'no' }))
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets, forwardSend, recordRelay: () => 'tok', markSeen: vi.fn(), hasSeen: () => false })
    await fwd(event('ccs'))
    expect(forwardSend).toHaveBeenCalledTimes(1)   // ccs (sender) excluded, only ccq sent
  })

  it('hop cap: a hop=2 card is terminal — judged locally, never forwarded', async () => {
    const forwardSend = vi.fn(async (): Promise<MatchReceipt | null> => ({ intent_id: 'i1', match: 'yes', blurb: 'x' }))
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'yes', blurb: 'me' }), forwardTargets: () => [{ id: 'ccq' }], forwardSend, recordRelay: () => 'tok', markSeen: vi.fn(), hasSeen: () => false })
    const r = await fwd(event('ccs', { hop: 2 }))
    expect(forwardSend).not.toHaveBeenCalled()
    expect(r.forwarded).toBeUndefined()
    expect(r.match).toBe('yes')
  })

  it('dedup: a seen intent is answered locally but not re-forwarded', async () => {
    const forwardSend = vi.fn(async (): Promise<MatchReceipt | null> => ({ intent_id: 'i1', match: 'yes' }))
    const markSeen = vi.fn()
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets: () => [{ id: 'ccq' }], forwardSend, recordRelay: () => 'tok', markSeen, hasSeen: () => true })
    const r = await fwd(event('ccs'))
    expect(forwardSend).not.toHaveBeenCalled()
    expect(markSeen).not.toHaveBeenCalled()   // already seen → not re-marked
    expect(r.forwarded).toBeUndefined()
  })

  it('marks an unseen intent seen before forwarding', async () => {
    const markSeen = vi.fn()
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets: () => [], forwardSend: async () => null, recordRelay: () => 'tok', markSeen, hasSeen: () => false })
    await fwd(event('ccs'))
    expect(markSeen).toHaveBeenCalledWith('i1', '2026-07-15T01:00:00.000Z')
  })

  it('one bad target is skipped, the rest aggregate (fail-closed)', async () => {
    const forwardSend = vi.fn(async (t: { id: string }): Promise<MatchReceipt | null> => {
      if (t.id === 'bad') throw new Error('boom')
      return { intent_id: 'i1', match: 'yes', blurb: 'ok' }
    })
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets: () => [{ id: 'bad' }, { id: 'ccq' }], forwardSend, recordRelay: (_i, _up, d) => `tok-${d}`, markSeen: vi.fn(), hasSeen: () => false })
    const r = await fwd(event('ccs'))
    expect(r.forwarded).toEqual([{ blurb: 'ok', degree: 2, relay_token: 'tok-ccq' }])
  })

  it('no yes downstream → forwarded omitted (not an empty array)', async () => {
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets: () => [{ id: 'ccq' }], forwardSend: async () => ({ intent_id: 'i1', match: 'no' }), recordRelay: () => 'tok', markSeen: vi.fn(), hasSeen: () => false })
    const r = await fwd(event('ccs'))
    expect(r.forwarded).toBeUndefined()
  })
})
