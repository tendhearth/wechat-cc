import { describe, it, expect } from 'vitest'
import { EchoMessageSchema, MatchReceiptSchema, A2A_PROTO_VERSION } from './a2a-intent'

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
