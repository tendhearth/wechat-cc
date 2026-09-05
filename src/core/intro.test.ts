import { describe, it, expect } from 'vitest'
import {
  introEnvelope, parseIntroPayload, newReplyId, emptyIntroIndex, pruneIntroIndex, resolveIntroRef,
  INTRO_INDEX_TTL_MS, INTRO_PENDING_TTL_MS, HINT_MAX, type IntroIndex,
} from './intro'

const T0 = '2026-09-04T10:00:00.000Z'
const card = { v: 2 as const, role: 'initiator' as const, nonce: 'n', self_id: 'cc-bbbb0001', name: 'B', mailbox_addr: 'MB', mailbox_enc_pub: 'EB', relays: ['https://r/mailbox'], bearer: 'k'.repeat(16), channel_id: 'cid', channel_pub: 'PUB' }

describe('intro 载荷', () => {
  it('五个 stage 往返;request/accept/card 必须带合法名片;forward 必须带 hint;decline 都不带', () => {
    const rq = parseIntroPayload(introEnvelope({ stage: 'request', replyId: 'r1', wishId: 'w1', card }))
    expect(rq).toMatchObject({ stage: 'request', replyId: 'r1', wishId: 'w1', card: { self_id: 'cc-bbbb0001' } })
    expect(parseIntroPayload({ kind: 'intro', payload: { stage: 'request', replyId: 'r1', wishId: 'w1' } })).toBe(null)
    expect(parseIntroPayload({ kind: 'intro', payload: { stage: 'accept', replyId: 'r1', wishId: 'w1', card: { ...card, mailbox_addr: '' } } })).toBe(null)
    expect(parseIntroPayload(introEnvelope({ stage: 'forward', replyId: 'r1', wishId: 'w1', hint: '找爬山搭子' }))).toMatchObject({ stage: 'forward', hint: '找爬山搭子' })
    expect(parseIntroPayload({ kind: 'intro', payload: { stage: 'forward', replyId: 'r1', wishId: 'w1' } })).toBe(null)
    expect(parseIntroPayload({ kind: 'intro', payload: { stage: 'forward', replyId: 'r1', wishId: 'w1', hint: 'x'.repeat(HINT_MAX * 2 + 1) } })).toBe(null)
    expect(parseIntroPayload(introEnvelope({ stage: 'decline', replyId: 'r1', wishId: 'w1' }))).toEqual({ stage: 'decline', replyId: 'r1', wishId: 'w1' })
    expect(parseIntroPayload({ kind: 'intro', payload: { stage: 'nope', replyId: 'r1', wishId: 'w1' } })).toBe(null)
    expect(parseIntroPayload({ kind: 'wish', payload: {} })).toBe(null)
  })
  it('newReplyId 8 位 hex', () => { expect(newReplyId()).toMatch(/^[0-9a-f]{8}$/) })
})

describe('intro 索引', () => {
  const at = (msAgo: number) => new Date(Date.parse(T0) - msAgo).toISOString()
  it('pruneIntroIndex:forwards/replies 14 天,pending/offers 7 天;过期的 pending 报出来给介绍人发 decline', () => {
    const idx: IntroIndex = {
      forwards: { w1: { from: 'c0', to: ['c1'], preview: 'p', at: at(INTRO_INDEX_TTL_MS + 1) }, w2: { from: 'c0', to: ['c1'], preview: 'p', at: at(1000) } },
      replies: { r1: { wishId: 'w1', fromChannel: 'c1', at: at(INTRO_INDEX_TTL_MS + 1) }, r2: { wishId: 'w2', fromChannel: 'c1', at: at(1000) } },
      pending: { r1: { wishId: 'w1', requesterChannel: 'c0', requesterCard: card, targetChannel: 'c1', at: at(INTRO_PENDING_TTL_MS + 1) }, r2: { wishId: 'w2', requesterChannel: 'c0', requesterCard: card, targetChannel: 'c1', at: at(1000) } },
      offers: { o1: { wishId: 'w1', viaChannel: 'c9', hint: 'h', at: at(INTRO_PENDING_TTL_MS + 1) }, o2: { wishId: 'w2', viaChannel: 'c9', hint: 'h', at: at(1000) } },
    }
    const r = pruneIntroIndex(idx, Date.parse(T0))
    expect(Object.keys(r.index.forwards)).toEqual(['w2'])
    expect(Object.keys(r.index.replies)).toEqual(['r2'])
    expect(Object.keys(r.index.pending)).toEqual(['r2'])
    expect(Object.keys(r.index.offers)).toEqual(['o2'])
    expect(r.expiredPending).toEqual([{ replyId: 'r1', requesterChannel: 'c0' }])
  })
  it('emptyIntroIndex 四张空表;resolveIntroRef 前缀匹配', () => {
    expect(emptyIntroIndex()).toEqual({ forwards: {}, replies: {}, pending: {}, offers: {} })
    expect(resolveIntroRef(['abcd1111', 'abcd2222', 'ffff0000'], 'ff')).toEqual({ ok: true, id: 'ffff0000' })
    expect(resolveIntroRef(['abcd1111', 'abcd2222'], 'abcd')).toEqual({ ok: false, reason: 'ambiguous' })
    expect(resolveIntroRef(['abcd1111'], '')).toEqual({ ok: false, reason: 'not_found' })
  })
})
