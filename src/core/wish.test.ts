import { describe, it, expect } from 'vitest'
import {
  WISH_TTL_MS, MAX_OPEN_WISHES, WISH_TEXT_MAX, newWishId, draftWish, sendWish, cancelWish, acceptPostcard,
  resolveWishRef, recentWishes, effectiveStatus, isExpired, openCount,
  wishEnvelope, forwardedWishEnvelope, parseWishPayload, postcardEnvelope, parsePostcardPayload, seenKey,
  recordPostcardRef, findPostcardRef, attachMyIntro, clearMyIntro, type WishRecord, type PostcardRef,
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
  it('closed 也受 7 天答复窗口约束:窗口内收,窗口外 expired', () => {
    const closed = mk({ status: 'closed', sentAt: T0, expiresAt: '2026-09-11T10:00:00.000Z' })
    expect(acceptPostcard([closed], 'abcd1234', ms('2026-09-05T00:00:00.000Z')).ok).toBe(true)
    expect(acceptPostcard([closed], 'abcd1234', ms('2026-09-12T00:00:00.000Z'))).toEqual({ ok: false, reason: 'expired' })
  })
  it('resolveWishRef:前缀匹配,限定状态;多条 → ambiguous', () => {
    const list = [mk({ id: 'abcd1234' }), mk({ id: 'abcd9999', status: 'open' }), mk({ id: 'ffff0000' })]
    expect(resolveWishRef(list, 'abcd', ['draft'])).toEqual({ ok: true, id: 'abcd1234' })
    expect(resolveWishRef(list, 'abcd', ['draft', 'open'])).toEqual({ ok: false, reason: 'ambiguous' })
    expect(resolveWishRef(list, 'ff', ['open'])).toEqual({ ok: false, reason: 'not_found' })
    expect(resolveWishRef(list, '  ', ['draft'])).toEqual({ ok: false, reason: 'not_found' })
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
    expect(parseWishPayload(env)).toEqual({ id: 'abcd1234', text: '找周末爬山搭子', expiresAt: '2026-09-11T10:00:00.000Z', hop: 1 })
    expect(parseWishPayload({ kind: 'letter', payload: {} })).toBe(null)
    expect(parseWishPayload({ kind: 'wish', payload: { id: 'x' } })).toBe(null)
    expect(parseWishPayload({ kind: 'wish', payload: { id: 'x', text: '  hello  ', expiresAt: '2026-09-11T10:00:00.000Z' } })!.text).toBe('hello')
  })
  it('wishEnvelope 发的是 redacted,不是原文', () => {
    const w = mk({ text: '找爬山搭子,我住XX路', redacted: '找爬山搭子', status: 'open', sentAt: T0, expiresAt: T0 })
    expect(parseWishPayload(wishEnvelope(w))!.text).toBe('找爬山搭子')
  })
  it('postcardEnvelope ↔ parsePostcardPayload;空 text → null', () => {
    expect(parsePostcardPayload(postcardEnvelope('abcd1234', '我朋友周末常去'))).toEqual({ wishId: 'abcd1234', text: '我朋友周末常去', hop: 1 })
    expect(parsePostcardPayload({ kind: 'postcard', payload: { wishId: 'a', text: '  ' } })).toBe(null)
  })
  it('正文超过 WISH_TEXT_MAX 的心愿 / 明信片一律读不懂 —— 网络输入不能没有上限', () => {
    const long = 'x'.repeat(WISH_TEXT_MAX + 1)
    const ok = 'x'.repeat(WISH_TEXT_MAX)
    expect(parseWishPayload({ kind: 'wish', payload: { id: 'a', text: long, expiresAt: '2026-09-11T10:00:00.000Z' } })).toBe(null)
    expect(parseWishPayload({ kind: 'wish', payload: { id: 'a', text: ok, expiresAt: '2026-09-11T10:00:00.000Z' } })!.text).toHaveLength(WISH_TEXT_MAX)
    expect(parsePostcardPayload({ kind: 'postcard', payload: { wishId: 'a', text: long } })).toBe(null)
    expect(parsePostcardPayload({ kind: 'postcard', payload: { wishId: 'a', text: ok } })!.text).toHaveLength(WISH_TEXT_MAX)
    // 前后空白不算数:trim 完不超就收
    expect(parsePostcardPayload({ kind: 'postcard', payload: { wishId: 'a', text: `  ${ok}  ` } })!.text).toHaveLength(WISH_TEXT_MAX)
  })
  it('seenKey', () => { expect(seenKey('w1', 'ch1')).toBe('w1:ch1') })
})

describe('hop / replyId / 明信片引用(介绍)', () => {
  const open = (): WishRecord => mk({ status: 'open', sentAt: T0, expiresAt: '2026-09-11T10:00:00.000Z' })
  it('wishEnvelope 默认 hop 1;forwardedWishEnvelope 原样带 id/text/expiresAt 且 hop 2', () => {
    const w = open()
    expect(parseWishPayload(wishEnvelope(w))).toEqual({ id: 'abcd1234', text: '找周末爬山搭子', expiresAt: '2026-09-11T10:00:00.000Z', hop: 1 })
    const p1 = parseWishPayload(wishEnvelope(w))!
    expect(parseWishPayload(forwardedWishEnvelope(p1))).toEqual({ ...p1, hop: 2 })
  })
  it('parseWishPayload:hop 缺省 1;3 / "2" / -1 → null', () => {
    const base = { id: 'a', text: 't', expiresAt: T0 }
    expect(parseWishPayload({ kind: 'wish', payload: base })!.hop).toBe(1)
    expect(parseWishPayload({ kind: 'wish', payload: { ...base, hop: 2 } })!.hop).toBe(2)
    for (const hop of [3, '2', -1, 0]) expect(parseWishPayload({ kind: 'wish', payload: { ...base, hop } })).toBe(null)
  })
  it('postcardEnvelope 可带 hop 2 + replyId;hop 2 缺 replyId → null', () => {
    expect(parsePostcardPayload(postcardEnvelope('w1', 'hi'))).toEqual({ wishId: 'w1', text: 'hi', hop: 1 })
    expect(parsePostcardPayload(postcardEnvelope('w1', 'hi', { hop: 2, replyId: 'r1' }))).toEqual({ wishId: 'w1', text: 'hi', hop: 2, replyId: 'r1' })
    expect(parsePostcardPayload({ kind: 'postcard', payload: { wishId: 'w1', text: 'hi', hop: 2 } })).toBe(null)
    expect(parsePostcardPayload({ kind: 'postcard', payload: { wishId: 'w1', text: 'hi', hop: 2, replyId: '' } })).toBe(null)
  })
  it('recordPostcardRef 幂等;findPostcardRef 前缀匹配、限定有 via 的;attach/clearMyIntro', () => {
    const ref = { replyId: 'r1r1r1r1', via: 'chA', at: T0, preview: '我朋友常去' }
    let list = recordPostcardRef([open()], 'abcd1234', ref)
    list = recordPostcardRef(list, 'abcd1234', ref)
    expect(list[0]!.postcards).toEqual([ref])
    expect(findPostcardRef(list, 'r1r1')).toEqual({ ok: true, wishId: 'abcd1234', ref })
    expect(findPostcardRef(list, 'zz')).toEqual({ ok: false, reason: 'not_found' })
    expect(findPostcardRef(list, '')).toEqual({ ok: false, reason: 'not_found' })
    list = recordPostcardRef(list, 'abcd1234', { ...ref, replyId: 'r1r1zzzz' })
    expect(findPostcardRef(list, 'r1r1')).toEqual({ ok: false, reason: 'ambiguous' })
    const mine = { channelId: 'c', pubkey: 'P', privkey: 'K', bearer: 'B', at: T0 }
    list = attachMyIntro(list, 'r1r1r1r1', mine)
    expect(findPostcardRef(list, 'r1r1r1r1')).toMatchObject({ ok: true, ref: { myIntro: mine } })
    list = clearMyIntro(list, 'r1r1r1r1')
    expect(findPostcardRef(list, 'r1r1r1r1')).toMatchObject({ ok: true, ref: { replyId: 'r1r1r1r1' } })
    expect((findPostcardRef(list, 'r1r1r1r1') as { ref: PostcardRef }).ref.myIntro).toBeUndefined()
  })
})
