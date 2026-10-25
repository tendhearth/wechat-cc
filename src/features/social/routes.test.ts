// src/features/social/routes.test.ts
//
// 心愿 (spec 2026-09-04-wish-postcard §4) — POST /v1/social/wish(/send|/cancel)
// + GET /v1/social/wishes replace the old propose/confirm/cancel/seeks/echoes/
// pledges/reveal routes (deleted in this pass). 社交模块自己挂这几条(架构终态 A5):
// 处理器拿到的 `social` 一定接上了 —— 「没接 ⇒ 503」归路由层的模块门(daemon/internal-api/module-gate.test.ts)。
import { describe, it, expect, vi } from 'vitest'
import { socialRoutes as routes, type SocialRoutesDeps } from './routes'
import { minTierFor } from '../../daemon/internal-api/route-tiers'
import { INTRO_PENDING_TTL_MS } from './intro'

const qs = () => new URLSearchParams()
const socialRoutes = (social: unknown) => routes({ social, peerName: () => undefined } as unknown as SocialRoutesDeps)

describe('/v1/social/wish*', () => {
  const wish = {
    propose: vi.fn(async (t: string) => (t === 'bad' ? { ok: false as const, error: 'gate_failed' as const, violations: ['住址'] } : { ok: true as const, id: 'abcd1234', preview: t })),
    send: vi.fn(async (id: string) => (id === 'abcd1234' ? { ok: true as const, sentTo: 2 } : { ok: false as const, reason: 'not_found' as const })),
    cancel: vi.fn((id: string) => (id === 'abcd1234' ? { ok: true as const, status: 'closed' as const } : { ok: false as const, reason: 'not_found' as const })),
    list: vi.fn(() => [{ id: 'abcd1234', text: '原文', redacted: '脱敏', status: 'open' as const, effective: 'open' as const, createdAt: 'c', sentAt: 's', expiresAt: 'e', sentTo: 2, replies: 1 }]),
    resolveRef: vi.fn(),
  }
  const r = socialRoutes({ wish })
  it('propose 过门 → id + preview;不过门 → ok:false + violations;缺 text → 400', async () => {
    expect((await r['POST /v1/social/wish']!(qs(), { text: '找搭子' })).body).toEqual({ ok: true, id: 'abcd1234', preview: '找搭子' })
    expect((await r['POST /v1/social/wish']!(qs(), { text: 'bad' })).body).toMatchObject({ ok: false, error: 'gate_failed', violations: ['住址'] })
    expect((await r['POST /v1/social/wish']!(qs(), {})).status).toBe(400)
  })
  it('send / cancel', async () => {
    expect((await r['POST /v1/social/wish/send']!(qs(), { id: 'abcd1234' })).body).toEqual({ ok: true, sent_to: 2 })
    expect((await r['POST /v1/social/wish/cancel']!(qs(), { id: 'abcd1234' })).body).toEqual({ ok: true, status: 'closed' })
    expect((await r['POST /v1/social/wish/send']!(qs(), {})).status).toBe(400)
  })
  it('list 给脱敏文本和 effective 状态,字段 snake_case', async () => {
    expect((await r['GET /v1/social/wishes']!(qs(), undefined)).body).toEqual({ wishes: [{ id: 'abcd1234', text: '脱敏', status: 'open', created_at: 'c', expires_at: 'e', sent_to: 2, replies: 1 }] })
  })
  it('四条 tier 是 trusted;旧路由不存在', () => {
    for (const k of ['POST /v1/social/wish', 'POST /v1/social/wish/send', 'POST /v1/social/wish/cancel', 'GET /v1/social/wishes']) expect(minTierFor(k)).toBe('trusted')
    for (const k of ['POST /v1/social/seek/propose', 'GET /v1/social/seeks', 'GET /v1/social/echoes', 'POST /v1/social/echoes/reveal', 'GET /v1/social/pledges']) expect(r[k]).toBeUndefined()
  })
})

describe('/v1/social/intro/*', () => {
  const intro = {
    request: vi.fn(async (r: string) => (r === 'ab' ? { ok: true as const, replyId: 'ab12cd34' } : { ok: false as const, reason: 'not_found' as const })),
    accept: vi.fn(async () => ({ ok: true as const, replyId: 'ab12cd34' })),
    decline: vi.fn(async () => ({ ok: true as const, replyId: 'ab12cd34' })),
    offers: vi.fn(() => [{ replyId: 'ab12cd34', hint: '找搭子', viaLabel: '阿A', at: 't' }]),
  }
  const wish = { list: vi.fn(() => [{ id: 'w1', text: 'x', redacted: 'x', status: 'open' as const, effective: 'open' as const, createdAt: 'c', sentAt: 's', expiresAt: 'e', sentTo: 1, replies: 1,
    postcards: [{ replyId: 'ab12cd34', via: 'me>A', viaLabel: '阿A', at: 't', preview: 'p', myIntro: { channelId: 'c', pubkey: 'P', privkey: 'K', bearer: 'B', at: 't' } }] }]), propose: vi.fn(), send: vi.fn(), cancel: vi.fn(), resolveRef: vi.fn() }
  const r = socialRoutes({ wish, intro })
  it('request / accept / decline:body reply_id → snake_case 结果;缺 → 400', async () => {
    expect((await r['POST /v1/social/intro/request']!(qs(), { reply_id: 'ab' })).body).toEqual({ ok: true, reply_id: 'ab12cd34' })
    expect((await r['POST /v1/social/intro/request']!(qs(), { reply_id: 'zz' })).body).toEqual({ ok: false, reason: 'not_found' })
    expect((await r['POST /v1/social/intro/accept']!(qs(), { reply_id: 'ab' })).body).toEqual({ ok: true, reply_id: 'ab12cd34' })
    expect((await r['POST /v1/social/intro/decline']!(qs(), { reply_id: 'ab' })).body).toEqual({ ok: true, reply_id: 'ab12cd34' })
    expect((await r['POST /v1/social/intro/request']!(qs(), {})).status).toBe(400)
  })
  it('offers 与 wishes 的 postcards 都是 snake_case;requested = 有 myIntro,且 myIntro 不外泄', async () => {
    expect((await r['GET /v1/social/intro/offers']!(qs(), undefined)).body).toEqual({ offers: [{ reply_id: 'ab12cd34', hint: '找搭子', via_label: '阿A', at: 't' }] })
    const w = (await r['GET /v1/social/wishes']!(qs(), undefined)).body as { wishes: Array<{ postcards: unknown[] }> }
    expect(w.wishes[0]!.postcards).toEqual([{ reply_id: 'ab12cd34', via_label: '阿A', preview: 'p', at: 't', requested: true }])
  })
  it('claim 过了 7 天(card 丢了)→ requested 翻回 false,桌面重新露出「想认识 TA」', async () => {
    const stale = new Date(Date.now() - INTRO_PENDING_TTL_MS - 1000).toISOString()
    const wishStale = { ...wish, list: vi.fn(() => [{ ...wish.list()[0]!, postcards: [{ ...wish.list()[0]!.postcards[0]!, myIntro: { channelId: 'c', pubkey: 'P', privkey: 'K', bearer: 'B', at: stale } }] }]) }
    const rs = socialRoutes({ wish: wishStale, intro })
    const w = (await rs['GET /v1/social/wishes']!(qs(), undefined)).body as { wishes: Array<{ postcards: Array<{ requested: boolean }> }> }
    expect(w.wishes[0]!.postcards[0]!.requested).toBe(false)
  })
  it('四条 tier trusted', async () => {
    for (const k of ['POST /v1/social/intro/request', 'POST /v1/social/intro/accept', 'POST /v1/social/intro/decline', 'GET /v1/social/intro/offers']) expect(minTierFor(k)).toBe('trusted')
  })
})

describe('POST /v1/social/visit', () => {
  it('POST /v1/social/visit 起跑就回,不等两三分钟', async () => {
    let called: string | undefined = 'unset'
    const r0 = socialRoutes({ penpal: { startVisit: async (t?: string) => { called = t; await new Promise(r => setTimeout(r, 50)); return { ok: true, id: 'v', channel: 'c' } } } })
    const t0 = Date.now()
    const r = await r0['POST /v1/social/visit']!(qs(), { target: '阿柚' })
    expect(Date.now() - t0).toBeLessThan(40)
    expect(r.body).toEqual({ ok: true, started: true })
    expect(called).toBe('阿柚')
    expect((await r0['POST /v1/social/visit']!(qs(), { target: 42 })).status).toBe(400)
  })
})
