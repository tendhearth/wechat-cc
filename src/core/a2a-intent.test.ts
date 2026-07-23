import { describe, expect, it } from 'vitest'
import { IntentCardSchema, MatchReceiptSchema, newIntentId, EchoMessageSchema, A2A_PROTO_VERSION } from './a2a-intent'

describe('a2a-intent schemas', () => {
  it('accepts a valid seek Intent Card', () => {
    const card = { intent_id: newIntentId(), kind: 'seek', topic: '找周末拍照搭子', city: '南京', expires_at: new Date(0).toISOString() }
    expect(IntentCardSchema.parse(card)).toMatchObject({ kind: 'seek', topic: '找周末拍照搭子' })
  })
  it('rejects an Intent Card with an empty topic', () => {
    const card = { intent_id: newIntentId(), kind: 'seek', topic: '', expires_at: new Date(0).toISOString() }
    expect(() => IntentCardSchema.parse(card)).toThrow()
  })
  it('accepts a yes Match Receipt with a blurb and a no Receipt without', () => {
    const id = newIntentId()
    expect(MatchReceiptSchema.parse({ intent_id: id, match: 'yes', blurb: '我主人也爱摄影' }).match).toBe('yes')
    expect(MatchReceiptSchema.parse({ intent_id: id, match: 'no' }).match).toBe('no')
  })
  it('newIntentId returns a non-empty unique-ish string', () => {
    expect(newIntentId()).not.toBe(newIntentId())
  })
})

describe('EchoMessage (async discovery)', () => {
  it('直连回音与 relay 回音都能 parse;缺 blurb/degree 拒绝', () => {
    expect(EchoMessageSchema.safeParse({ agent_id: 'w', intent_id: 'i1', echo: { blurb: '我认识一位', degree: 1 } }).success).toBe(true)
    expect(EchoMessageSchema.safeParse({ agent_id: 'w', intent_id: 'i1', echo: { blurb: 'x', degree: 2, relay_token: 't1' } }).success).toBe(true)
    expect(EchoMessageSchema.safeParse({ agent_id: 'w', intent_id: 'i1', echo: { degree: 1 } }).success).toBe(false)
    expect(EchoMessageSchema.safeParse({ agent_id: 'w', intent_id: 'i1', echo: { blurb: 'x', degree: 0 } }).success).toBe(false)
  })
  it('fast-ack 形状:MatchReceipt 允许 async:true;proto 已 bump 到 2', () => {
    expect(MatchReceiptSchema.safeParse({ intent_id: 'i1', match: 'no', async: true }).success).toBe(true)
    expect(A2A_PROTO_VERSION).toBe(2)
  })
})
