import { describe, it, expect } from 'vitest'
import {
  WISH_TTL_MS, MAX_OPEN_WISHES, newWishId, draftWish, sendWish, cancelWish, acceptPostcard,
  resolveWishRef, recentWishes, effectiveStatus, isExpired, openCount,
  wishEnvelope, parseWishPayload, postcardEnvelope, parsePostcardPayload, seenKey, type WishRecord,
} from './wish'

const T0 = '2026-09-04T10:00:00.000Z'
const ms = (iso: string) => Date.parse(iso)
const mk = (over: Partial<WishRecord> = {}): WishRecord => ({
  id: 'abcd1234', text: '找周末爬山搭子', redacted: '找周末爬山搭子', status: 'draft',
  createdAt: T0, sentAt: null, expiresAt: null, sentTo: 0, replies: 0, ...over,
})

describe('wish 状态机', () => {
  it('draft → send → open,expiresAt = sentAt + 7 天,sentTo 记下', () => {
    const list = draftWish([], { id: 'abcd1234', text: 'x', redacted: 'x', nowIso: T0 })
    const r = sendWish(list, 'abcd1234', T0, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.wish.status).toBe('open')
    expect(r.wish.sentTo).toBe(2)
    expect(ms(r.wish.expiresAt!)).toBe(ms(T0) + WISH_TTL_MS)
  })
  it('只有 draft 能 send;不存在 → not_found', () => {
    expect(sendWish([mk({ status: 'open' })], 'abcd1234', T0, 1)).toEqual({ ok: false, reason: 'not_draft' })
    expect(sendWish([], 'nope', T0, 1)).toEqual({ ok: false, reason: 'not_found' })
  })
  it('最多 3 条 open;第 4 条 send 被拒 too_many_open;过期的不占名额', () => {
    const opens = [1, 2, 3].map(i => mk({ id: `open000${i}`, status: 'open', sentAt: T0, expiresAt: '2026-09-11T10:00:00.000Z' }))
    const list = [...opens, mk({ id: 'draft001' })]
    expect(sendWish(list, 'draft001', T0, 1)).toEqual({ ok: false, reason: 'too_many_open' })
    const expired = [...opens.map(w => ({ ...w, expiresAt: '2026-09-04T09:00:00.000Z' })), mk({ id: 'draft001' })]
    expect(sendWish(expired, 'draft001', T0, 1).ok).toBe(true)
    expect(openCount(opens, ms(T0))).toBe(MAX_OPEN_WISHES)
  })
  it('cancel:draft → cancelled,open → closed;closed 再取消 → already_done', () => {
    const a = cancelWish([mk()], 'abcd1234'); expect(a.ok && a.wish.status).toBe('cancelled')
    const b = cancelWish([mk({ status: 'open' })], 'abcd1234'); expect(b.ok && b.wish.status).toBe('closed')
    expect(cancelWish([mk({ status: 'closed' })], 'abcd1234')).toEqual({ ok: false, reason: 'already_done' })
  })
  it('effectiveStatus / isExpired:open 过期 → expired;closed 不算过期', () => {
    const w = mk({ status: 'open', sentAt: T0, expiresAt: '2026-09-11T10:00:00.000Z' })
    expect(effectiveStatus(w, ms('2026-09-10T00:00:00.000Z'))).toBe('open')
    expect(effectiveStatus(w, ms('2026-09-12T00:00:00.000Z'))).toBe('expired')
    expect(isExpired({ ...w, status: 'closed' }, ms('2026-09-12T00:00:00.000Z'))).toBe(false)
  })
  it('acceptPostcard:open 且未过期 → replies+1;closed 也收(人家已经答了);过期 → expired;不认识 → unknown', () => {
    const open = mk({ status: 'open', sentAt: T0, expiresAt: '2026-09-11T10:00:00.000Z' })
    const r = acceptPostcard([open], 'abcd1234', ms('2026-09-05T00:00:00.000Z'))
    expect(r.ok && r.wish.replies).toBe(1)
    const c = acceptPostcard([{ ...open, status: 'closed' }], 'abcd1234', ms('2026-09-05T00:00:00.000Z'))
    expect(c.ok).toBe(true)
    expect(acceptPostcard([open], 'abcd1234', ms('2026-09-12T00:00:00.000Z'))).toEqual({ ok: false, reason: 'expired' })
    expect(acceptPostcard([open], 'zzzz', ms(T0))).toEqual({ ok: false, reason: 'unknown' })
  })
  it('resolveWishRef:前缀匹配,限定状态;多条 → ambiguous', () => {
    const list = [mk({ id: 'abcd1234' }), mk({ id: 'abcd9999', status: 'open' }), mk({ id: 'ffff0000' })]
    expect(resolveWishRef(list, 'abcd', ['draft'])).toEqual({ ok: true, id: 'abcd1234' })
    expect(resolveWishRef(list, 'abcd', ['draft', 'open'])).toEqual({ ok: false, reason: 'ambiguous' })
    expect(resolveWishRef(list, 'ff', ['open'])).toEqual({ ok: false, reason: 'not_found' })
  })
  it('recentWishes:30 天内,按 createdAt 降序', () => {
    const list = [mk({ id: 'old', createdAt: '2026-07-01T00:00:00.000Z' }), mk({ id: 'a', createdAt: '2026-09-01T00:00:00.000Z' }), mk({ id: 'b', createdAt: '2026-09-03T00:00:00.000Z' })]
    expect(recentWishes(list, ms(T0)).map(w => w.id)).toEqual(['b', 'a'])
  })
  it('newWishId:8 位 hex,每次不同', () => {
    const a = newWishId(), b = newWishId()
    expect(a).toMatch(/^[0-9a-f]{8}$/); expect(a).not.toBe(b)
  })
})

describe('信封载荷', () => {
  it('wishEnvelope ↔ parseWishPayload 往返;非 wish / 缺字段 → null', () => {
    const w = mk({ status: 'open', sentAt: T0, expiresAt: '2026-09-11T10:00:00.000Z' })
    const env = wishEnvelope(w)
    expect(env.kind).toBe('wish')
    expect(parseWishPayload(env)).toEqual({ id: 'abcd1234', text: '找周末爬山搭子', expiresAt: '2026-09-11T10:00:00.000Z' })
    expect(parseWishPayload({ kind: 'letter', payload: {} })).toBe(null)
    expect(parseWishPayload({ kind: 'wish', payload: { id: 'x' } })).toBe(null)
  })
  it('wishEnvelope 发的是 redacted,不是原文', () => {
    const w = mk({ text: '找爬山搭子,我住XX路', redacted: '找爬山搭子', status: 'open', sentAt: T0, expiresAt: T0 })
    expect(parseWishPayload(wishEnvelope(w))!.text).toBe('找爬山搭子')
  })
  it('postcardEnvelope ↔ parsePostcardPayload;空 text → null', () => {
    expect(parsePostcardPayload(postcardEnvelope('abcd1234', '我朋友周末常去'))).toEqual({ wishId: 'abcd1234', text: '我朋友周末常去' })
    expect(parsePostcardPayload({ kind: 'postcard', payload: { wishId: 'a', text: '  ' } })).toBe(null)
  })
  it('seenKey', () => { expect(seenKey('w1', 'ch1')).toBe('w1:ch1') })
})
