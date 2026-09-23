/**
 * wish.ts — 「心愿」:伙伴替主人去问认识的人,纯函数部分
 * (spec 2026-09-04-wish-postcard-design §1)。
 *
 * 心愿是一种信封(kind='wish'),回来的明信片是另一种(kind='postcard'),
 * 都走已有的 E2E 信道 —— 和串门同一个形状。这里只定义:状态怎么走、载荷长
 * 什么样;不碰传输,不碰存储。
 *
 * 状态:draft ─派─▶ open ─7 天─▶ expired;draft ─取消─▶ cancelled;open ─取消─▶ closed。
 * 「expired」不是存的状态,是 open + 过了 expiresAt 的派生视图。
 */
import { randomBytes } from 'node:crypto'
import type { Envelope } from './envelope'

export type WishStatus = 'draft' | 'open' | 'closed' | 'cancelled'

export interface WishRecord {
  id: string
  /** 主人原话(只留在本机)。 */
  text: string
  /** 过了披露门的版本 —— 发出去的是它。 */
  redacted: string
  status: WishStatus
  createdAt: string
  sentAt: string | null
  expiresAt: string | null
  /** 派给了几条信道(投出去就算,信箱是 store-and-forward)。 */
  sentTo: number
  replies: number
  /** hop 2 的明信片留下的引用(介绍用);hop 1 的不记 —— 那些人本来就认识。 */
  postcards?: PostcardRef[]
}

export const WISH_TTL_MS = 7 * 24 * 60 * 60_000
export const MAX_OPEN_WISHES = 3
/**
 * 一条心愿 / 一张明信片的正文上限。对面递过来的是**网络输入** —— 没有上限的话
 * 一封信就能把 wishes.json 撑爆、把「来打听什么」那句话灌进主人的微信。超了
 * 不截断,直接判读不懂(截断会把半句话当成对方的原话)。
 */
export const WISH_TEXT_MAX = 500

export type Hop = 1 | 2
export interface WishPayload { id: string; text: string; expiresAt: string; hop: Hop }
export interface PostcardPayload { wishId: string; text: string; hop: Hop; replyId?: string }
export interface PostcardRef {
  replyId: string
  via: string
  at: string
  preview: string
  myIntro?: { channelId: string; pubkey: string; privkey: string; bearer: string; at: string }
}

export function newWishId(): string {
  return randomBytes(4).toString('hex')
}

export function isExpired(w: WishRecord, nowMs: number): boolean {
  return w.status === 'open' && w.expiresAt !== null && Date.parse(w.expiresAt) < nowMs
}

export function effectiveStatus(w: WishRecord, nowMs: number): WishStatus | 'expired' {
  return isExpired(w, nowMs) ? 'expired' : w.status
}

export function openCount(list: readonly WishRecord[], nowMs: number): number {
  return list.filter(w => effectiveStatus(w, nowMs) === 'open').length
}

export function draftWish(list: readonly WishRecord[], a: { id: string; text: string; redacted: string; nowIso: string }): WishRecord[] {
  return [...list, { id: a.id, text: a.text, redacted: a.redacted, status: 'draft', createdAt: a.nowIso, sentAt: null, expiresAt: null, sentTo: 0, replies: 0 }]
}

const replace = (list: readonly WishRecord[], w: WishRecord): WishRecord[] => list.map(x => (x.id === w.id ? w : x))

export function sendWish(list: readonly WishRecord[], id: string, nowIso: string, sentTo: number):
  { ok: true; wish: WishRecord; list: WishRecord[] } | { ok: false; reason: 'not_found' | 'not_draft' | 'too_many_open' } {
  const w = list.find(x => x.id === id)
  if (!w) return { ok: false, reason: 'not_found' }
  if (w.status !== 'draft') return { ok: false, reason: 'not_draft' }
  if (openCount(list, Date.parse(nowIso)) >= MAX_OPEN_WISHES) return { ok: false, reason: 'too_many_open' }
  const wish: WishRecord = { ...w, status: 'open', sentAt: nowIso, expiresAt: new Date(Date.parse(nowIso) + WISH_TTL_MS).toISOString(), sentTo }
  return { ok: true, wish, list: replace(list, wish) }
}

export function cancelWish(list: readonly WishRecord[], id: string):
  { ok: true; wish: WishRecord; list: WishRecord[] } | { ok: false; reason: 'not_found' | 'already_done' } {
  const w = list.find(x => x.id === id)
  if (!w) return { ok: false, reason: 'not_found' }
  if (w.status === 'closed' || w.status === 'cancelled') return { ok: false, reason: 'already_done' }
  const wish: WishRecord = { ...w, status: w.status === 'draft' ? 'cancelled' : 'closed' }
  return { ok: true, wish, list: replace(list, wish) }
}

/** 收到一张明信片。closed 也收 —— 人家已经答了;只有过期和不认识的才拒。 */
export function acceptPostcard(list: readonly WishRecord[], wishId: string, nowMs: number):
  { ok: true; wish: WishRecord; list: WishRecord[] } | { ok: false; reason: 'unknown' | 'expired' } {
  const w = list.find(x => x.id === wishId && x.sentAt !== null)
  if (!w) return { ok: false, reason: 'unknown' }
  if (w.expiresAt !== null && Date.parse(w.expiresAt) < nowMs) return { ok: false, reason: 'expired' }
  const wish: WishRecord = { ...w, replies: w.replies + 1 }
  return { ok: true, wish, list: replace(list, wish) }
}

/** 主人只会打编号开头。限定状态,免得「取消」打到草稿、「派」打到已开的。 */
export function resolveWishRef(list: readonly WishRecord[], ref: string, among: readonly WishStatus[]):
  { ok: true; id: string } | { ok: false; reason: 'not_found' | 'ambiguous' } {
  if (ref.trim() === '') return { ok: false, reason: 'not_found' }
  const hits = list.filter(w => among.includes(w.status) && w.id.startsWith(ref.toLowerCase()))
  if (hits.length === 0) return { ok: false, reason: 'not_found' }
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, id: hits[0]!.id }
}

export function recentWishes(list: readonly WishRecord[], nowMs: number, days = 30): WishRecord[] {
  const since = nowMs - days * 24 * 60 * 60_000
  return list.filter(w => Date.parse(w.createdAt) >= since).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

const parseHop = (v: unknown): Hop | null => (v === undefined ? 1 : v === 1 || v === 2 ? v : null)

export function wishEnvelope(w: WishRecord, hop: Hop = 1): Envelope<WishPayload> {
  return { kind: 'wish', payload: { id: w.id, text: w.redacted, expiresAt: w.expiresAt ?? '', hop } }
}

/** 介绍人转问:同一条心愿(id / text / expiresAt 原样),只把 hop 记成 2。 */
export function forwardedWishEnvelope(p: WishPayload): Envelope<WishPayload> {
  return { kind: 'wish', payload: { id: p.id, text: p.text, expiresAt: p.expiresAt, hop: 2 } }
}

export function parseWishPayload(env: Envelope): WishPayload | null {
  if (env.kind !== 'wish') return null
  const p = env.payload as Partial<WishPayload> | null
  if (!p || typeof p.id !== 'string' || typeof p.text !== 'string' || typeof p.expiresAt !== 'string') return null
  if (p.id === '' || p.text.trim() === '' || Number.isNaN(Date.parse(p.expiresAt))) return null
  if (p.text.trim().length > WISH_TEXT_MAX) return null
  const hop = parseHop((p as { hop?: unknown }).hop)
  if (hop === null) return null
  return { id: p.id, text: p.text.trim(), expiresAt: p.expiresAt, hop }
}

export function postcardEnvelope(wishId: string, text: string, opts: { hop?: Hop; replyId?: string } = {}): Envelope<PostcardPayload> {
  const hop = opts.hop ?? 1
  return { kind: 'postcard', payload: { wishId, text: text.trim(), hop, ...(opts.replyId ? { replyId: opts.replyId } : {}) } }
}

export function parsePostcardPayload(env: Envelope): PostcardPayload | null {
  if (env.kind !== 'postcard') return null
  const p = env.payload as Partial<PostcardPayload> | null
  if (!p || typeof p.wishId !== 'string' || typeof p.text !== 'string' || p.wishId === '' || p.text.trim() === '') return null
  if (p.text.trim().length > WISH_TEXT_MAX) return null
  const hop = parseHop((p as { hop?: unknown }).hop)
  if (hop === null) return null
  const replyId = typeof p.replyId === 'string' && p.replyId !== '' ? p.replyId : undefined
  if (hop === 2 && !replyId) return null   // hop 2 一定是介绍人转回来的,没有 replyId 就没法「认识」
  return { wishId: p.wishId, text: p.text.trim(), hop, ...(replyId ? { replyId } : {}) }
}

export function seenKey(wishId: string, channelRowId: string): string {
  return `${wishId}:${channelRowId}`
}

const withRefs = (w: WishRecord, refs: PostcardRef[]): WishRecord => ({ ...w, postcards: refs })

export function recordPostcardRef(list: readonly WishRecord[], wishId: string, ref: PostcardRef): WishRecord[] {
  return list.map(w => {
    if (w.id !== wishId) return w
    const refs = w.postcards ?? []
    return refs.some(r => r.replyId === ref.replyId) ? w : withRefs(w, [...refs, ref])
  })
}

export function findPostcardRef(list: readonly WishRecord[], ref: string):
  { ok: true; wishId: string; ref: PostcardRef } | { ok: false; reason: 'not_found' | 'ambiguous' } {
  const q = ref.trim().toLowerCase()
  if (q === '') return { ok: false, reason: 'not_found' }
  const hits: Array<{ wishId: string; ref: PostcardRef }> = []
  for (const w of list) for (const r of w.postcards ?? []) if (r.replyId.startsWith(q)) hits.push({ wishId: w.id, ref: r })
  if (hits.length === 0) return { ok: false, reason: 'not_found' }
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, ...hits[0]! }
}

export function attachMyIntro(list: readonly WishRecord[], replyId: string, myIntro: NonNullable<PostcardRef['myIntro']>): WishRecord[] {
  return list.map(w => (w.postcards?.some(r => r.replyId === replyId)
    ? withRefs(w, w.postcards!.map(r => (r.replyId === replyId ? { ...r, myIntro } : r)))
    : w))
}

export function clearMyIntro(list: readonly WishRecord[], replyId: string): WishRecord[] {
  return list.map(w => (w.postcards?.some(r => r.replyId === replyId)
    ? withRefs(w, w.postcards!.map(r => { if (r.replyId !== replyId) return r; const { myIntro: _m, ...rest } = r; return rest }))
    : w))
}
