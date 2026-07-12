import { describe, expect, it } from 'vitest'
import { makeBroker } from './social-broker'

const cheapEval = async () => JSON.stringify({ violation: false, redacted: '找摄影搭子' })
const peerB = { id: 'ccb', name: 'CC-B' } as any

describe('makeBroker.seek', () => {
  it('AC1 happy path: yes receipt + both confirms → lit', async () => {
    const broker = makeBroker({
      policy: 'p', cheapEval,
      discover: async () => [peerB],
      send: async () => ({ intent_id: 'x', match: 'yes', blurb: '也爱摄影' }),
      confirmWithOwner: async () => true,
      confirmPeer: async () => true,
    })
    const out = await broker.seek('找摄影搭子')
    expect(out.matched.map(m => m.hand)).toEqual(['ccb'])
    expect(out.lit).toEqual(['ccb'])
  })
  it('AC5 no reveal if either side declines', async () => {
    const broker = makeBroker({
      policy: 'p', cheapEval,
      discover: async () => [peerB],
      send: async () => ({ intent_id: 'x', match: 'yes', blurb: '也爱摄影' }),
      confirmWithOwner: async () => true,
      confirmPeer: async () => false,          // peer's owner declines
    })
    const out = await broker.seek('找摄影搭子')
    expect(out.lit).toEqual([])                // matched but NOT lit
  })
  it('AC2 non-match → nothing matched, nobody asked to confirm', async () => {
    let askedOwner = 0
    const broker = makeBroker({
      policy: 'p', cheapEval,
      discover: async () => [peerB],
      send: async () => ({ intent_id: 'x', match: 'no' }),
      confirmWithOwner: async () => { askedOwner++; return true },
      confirmPeer: async () => true,
    })
    const out = await broker.seek('找打篮球的')
    expect(out.matched).toEqual([])
    expect(askedOwner).toBe(0)
  })
  it('aborts (sends nothing) if the gate blocks the intent topic', async () => {
    let sent = 0
    const broker = makeBroker({
      policy: 'p',
      cheapEval: async () => JSON.stringify({ violation: true, redacted: '', reasons: ['leak'] }),
      discover: async () => [peerB],
      send: async () => { sent++; return { intent_id: 'x', match: 'yes' } },
      confirmWithOwner: async () => true, confirmPeer: async () => true,
    })
    const out = await broker.seek('涉密意图')
    expect(sent).toBe(0)
    expect(out.matched).toEqual([])
  })
  it('city gated through: cheapEval redacts city, card carries redacted value', async () => {
    let sentCard: any
    let callCount = 0
    const broker = makeBroker({
      policy: 'p',
      cheapEval: async (prompt) => {
        callCount++
        // First call is topic, second call is city
        if (callCount === 1) {
          return JSON.stringify({ violation: false, redacted: '找摄影搭子' })
        } else {
          return JSON.stringify({ violation: false, redacted: '<REDACTED-CITY>' })
        }
      },
      discover: async () => [peerB],
      send: async (_hand, card) => { sentCard = card; return { intent_id: 'x', match: 'yes' } },
      confirmWithOwner: async () => true,
      confirmPeer: async () => true,
    })
    const out = await broker.seek('找摄影搭子', { city: 'Beijing' })
    expect(sentCard.city).toBe('<REDACTED-CITY>')
    expect(out.matched.map(m => m.hand)).toEqual(['ccb'])
  })
  it('city blocked by gate: omit from card, seek proceeds', async () => {
    let sentCard: any
    let callCount = 0
    const broker = makeBroker({
      policy: 'p',
      cheapEval: async (prompt) => {
        callCount++
        // First call is topic (passes), second call is city (blocked)
        if (callCount === 1) {
          return JSON.stringify({ violation: false, redacted: '找摄影搭子' })
        } else {
          return JSON.stringify({ violation: true, redacted: '', reasons: ['leak'] })
        }
      },
      discover: async () => [peerB],
      send: async (_hand, card) => { sentCard = card; return { intent_id: 'x', match: 'yes' } },
      confirmWithOwner: async () => true,
      confirmPeer: async () => true,
    })
    const out = await broker.seek('找摄影搭子', { city: 'Beijing' })
    expect(sentCard.city).toBeUndefined()
    expect(out.matched.map(m => m.hand)).toEqual(['ccb'])
  })
  it('redacted topic actually sent: card carries redacted value not raw input', async () => {
    let sentCard: any
    const broker = makeBroker({
      policy: 'p',
      cheapEval: async () => JSON.stringify({ violation: false, redacted: '寻找摄影伙伴【已清理】' }),
      discover: async () => [peerB],
      send: async (_hand, card) => { sentCard = card; return { intent_id: 'x', match: 'yes' } },
      confirmWithOwner: async () => true,
      confirmPeer: async () => true,
    })
    const out = await broker.seek('找摄影搭子+电话')
    expect(sentCard.topic).toBe('寻找摄影伙伴【已清理】')
    expect(sentCard.topic).not.toBe('找摄影搭子+电话')
    expect(out.matched.map(m => m.hand)).toEqual(['ccb'])
  })
})
