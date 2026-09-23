/**
 * intro.ts — 「介绍」的纯函数部分(spec 2026-09-04-introduction-design)。
 *
 * 介绍 = 心愿的转问 + 配对的名片交换,中间隔着一个人点头。这里只定义:
 * intro 信封长什么样、介绍人 / 被介绍方各自记什么、什么时候过期。传输和
 * 存储都不在这里。
 *
 * 五个 stage 走向:
 *   request(我 → A,带我的名片)→ forward(A → B,只带一句 hint)
 *   → accept(B → A,带 B 的名片)/ decline(B → A)
 *   → card(A → 我 / A → B,交叉转发对方名片)
 */
import { randomBytes } from 'node:crypto'
import type { Envelope } from './envelope'
import { isValidPairCard, type PairCard } from './pairing'

export type IntroStage = 'request' | 'forward' | 'accept' | 'decline' | 'card'
export interface IntroPayload { stage: IntroStage; replyId: string; wishId: string; card?: PairCard; hint?: string }

export const FORWARD_PER_SENDER = 3
export const FORWARD_WINDOW_MS = 24 * 60 * 60_000
/** 判「不能」才转问。改成 false 就是「一律转」(热心朋友模式)。 */
export const FORWARD_ONLY_WHEN_UNABLE = true
export const INTRO_INDEX_TTL_MS = 14 * 24 * 60 * 60_000
export const INTRO_PENDING_TTL_MS = 7 * 24 * 60 * 60_000
export const HINT_MAX = 40

const STAGES: ReadonlySet<string> = new Set<IntroStage>(['request', 'forward', 'accept', 'decline', 'card'])
const NEEDS_CARD: ReadonlySet<IntroStage> = new Set(['request', 'accept', 'card'])

export function newReplyId(): string { return randomBytes(4).toString('hex') }

export function introEnvelope(p: IntroPayload): Envelope<IntroPayload> {
  return { kind: 'intro', payload: { stage: p.stage, replyId: p.replyId, wishId: p.wishId, ...(p.card ? { card: p.card } : {}), ...(p.hint ? { hint: p.hint.slice(0, HINT_MAX) } : {}) } }
}

export function parseIntroPayload(env: Envelope): IntroPayload | null {
  if (env.kind !== 'intro') return null
  const p = env.payload as Partial<IntroPayload> | null
  if (!p || typeof p.stage !== 'string' || !STAGES.has(p.stage)) return null
  if (typeof p.replyId !== 'string' || p.replyId === '' || typeof p.wishId !== 'string' || p.wishId === '') return null
  const stage = p.stage as IntroStage
  if (NEEDS_CARD.has(stage)) {
    if (!p.card || !isValidPairCard(p.card)) return null
    return { stage, replyId: p.replyId, wishId: p.wishId, card: p.card }
  }
  if (stage === 'forward') {
    if (typeof p.hint !== 'string' || p.hint.trim() === '' || p.hint.length > HINT_MAX * 2) return null
    return { stage, replyId: p.replyId, wishId: p.wishId, hint: p.hint.trim().slice(0, HINT_MAX) }
  }
  return { stage, replyId: p.replyId, wishId: p.wishId }
}

export interface IntroIndex {
  forwards: Record<string, { from: string; to: string[]; preview: string; at: string }>
  replies: Record<string, { wishId: string; fromChannel: string; at: string }>
  pending: Record<string, { wishId: string; requesterChannel: string; requesterCard: PairCard; targetChannel: string; at: string }>
  offers: Record<string, { wishId: string; viaChannel: string; hint: string; at: string; myIntro?: { channelId: string; pubkey: string; privkey: string; bearer: string; at: string } }>
}

export function emptyIntroIndex(): IntroIndex { return { forwards: {}, replies: {}, pending: {}, offers: {} } }

function keep<T extends { at: string }>(rec: Record<string, T>, nowMs: number, ttl: number): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(rec)) { const t = Date.parse(v.at); if (!Number.isNaN(t) && nowMs - t <= ttl) out[k] = v }
  return out
}

export function pruneIntroIndex(idx: IntroIndex, nowMs: number): { index: IntroIndex; expiredPending: Array<{ replyId: string; requesterChannel: string }> } {
  const pending = keep(idx.pending, nowMs, INTRO_PENDING_TTL_MS)
  const expiredPending = Object.entries(idx.pending).filter(([k]) => !(k in pending)).map(([replyId, v]) => ({ replyId, requesterChannel: v.requesterChannel }))
  return {
    index: { forwards: keep(idx.forwards, nowMs, INTRO_INDEX_TTL_MS), replies: keep(idx.replies, nowMs, INTRO_INDEX_TTL_MS), pending, offers: keep(idx.offers, nowMs, INTRO_PENDING_TTL_MS) },
    expiredPending,
  }
}

/**
 * 请求方手里那笔「我已经在问了」(`PostcardRef['myIntro']` / `offers[].myIntro`)
 * 还算数吗 —— 和介绍人的 `pending`、被介绍方的 `offers` 同一把 7 天尺子。
 *
 * WHY:claim 是**本机单方面**记的一句「等对方点头」,没有它过期,一封没送到的
 * `card` 就把这张明信片永远钉死在「已在问」上:桌面按钮消失、微信答「已经在问
 * 了」,主人除了手改 wishes.json 没有别的出路。而对面那条 pending 早在同一个
 * 时刻过期了,重问一次本来就该重新起一笔。
 *
 * `at` 缺失或读不懂(升级前落盘的老数据)一律**当新鲜**:宁可少放一次「再问」,
 * 也不能因为没有时间戳就把所有老 claim 一次性判死。
 */
export function isIntroClaimLive(claim: { at?: string } | undefined | null, nowMs: number): boolean {
  if (!claim) return false
  const t = Date.parse(claim.at ?? '')
  if (Number.isNaN(t)) return true
  return nowMs - t <= INTRO_PENDING_TTL_MS
}

export function resolveIntroRef(keys: readonly string[], ref: string): { ok: true; id: string } | { ok: false; reason: 'not_found' | 'ambiguous' } {
  const q = ref.trim().toLowerCase()
  if (q === '') return { ok: false, reason: 'not_found' }
  const hits = keys.filter(k => k.startsWith(q))
  if (hits.length === 0) return { ok: false, reason: 'not_found' }
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, id: hits[0]! }
}
