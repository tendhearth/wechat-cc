// src/daemon/internal-api/routes-social.test.ts
//
// 心愿 (spec 2026-09-04-wish-postcard §4) — POST /v1/social/wish(/send|/cancel)
// + GET /v1/social/wishes replace the old propose/confirm/cancel/seeks/echoes/
// pledges/reveal routes (deleted in this pass). Mirrors routes-pair.test.ts's
// deps-stub shape: a bare `{ social }` object cast through, no real broker.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { socialRoutes } from './routes-social'
import { minTierFor } from './route-tiers'
import type { InternalApiDeps } from './types'
import { INTRO_PENDING_TTL_MS } from '../../core/intro'

const qs = () => new URLSearchParams()

describe('/v1/social/wish*', () => {
  const wish = {
    propose: vi.fn(async (t: string) => (t === 'bad' ? { ok: false as const, error: 'gate_failed' as const, violations: ['住址'] } : { ok: true as const, id: 'abcd1234', preview: t })),
    send: vi.fn(async (id: string) => (id === 'abcd1234' ? { ok: true as const, sentTo: 2 } : { ok: false as const, reason: 'not_found' as const })),
    cancel: vi.fn((id: string) => (id === 'abcd1234' ? { ok: true as const, status: 'closed' as const } : { ok: false as const, reason: 'not_found' as const })),
    list: vi.fn(() => [{ id: 'abcd1234', text: '原文', redacted: '脱敏', status: 'open' as const, effective: 'open' as const, createdAt: 'c', sentAt: 's', expiresAt: 'e', sentTo: 2, replies: 1 }]),
    resolveRef: vi.fn(),
  }
  const deps = { social: { wish } } as unknown as InternalApiDeps
  const r = socialRoutes(deps)
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
  it('social 没接 → 503;四条 tier 是 trusted;旧路由不存在', () => {
    expect(socialRoutes({} as InternalApiDeps)['POST /v1/social/wish']).toBeDefined()
    for (const k of ['POST /v1/social/wish', 'POST /v1/social/wish/send', 'POST /v1/social/wish/cancel', 'GET /v1/social/wishes']) expect(minTierFor(k)).toBe('trusted')
    for (const k of ['POST /v1/social/seek/propose', 'GET /v1/social/seeks', 'GET /v1/social/echoes', 'POST /v1/social/echoes/reveal', 'GET /v1/social/pledges']) expect(r[k]).toBeUndefined()
  })
})

// 2026-08-31 —— 社交总开关的 HTTP 面。此前桌面端三处入口在社交未启用时
// 只会说「先在命令行运行 wechat-cc social enable」:一个桌面产品把人踢回
// 终端,被朋友拉来试的人基本必然卡死在这一步(找朋友测试的头号障碍)。
//
// 这条路由【不能】依赖 deps.social —— 社交没开时那个字段根本不存在,而
// "没开"恰恰是唯一需要它的时候。它只读写 stateDir 上的 agent-config.json。
describe('POST /v1/social/enable —— 桌面端的社交总开关', () => {
  function stateDeps(stateDir: string): InternalApiDeps {
    return { stateDir } as unknown as InternalApiDeps
  }

  it('社交未接线时依然可用(这正是它存在的意义)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'routes-social-enable-'))
    try {
      const routes = socialRoutes(stateDeps(dir))   // 注意:没有 social 字段
      const r = await routes['POST /v1/social/enable']!({} as any, { enabled: true })
      expect(r.status).toBe(200)
      expect((r.body as any).enabled).toBe(true)
      expect((r.body as any).restart_required).toBe(true)   // 配对引擎在 boot 时接线
      const raw = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf8'))
      expect(raw.social_enabled).toBe(true)
      expect(raw.mailbox_relays.length).toBeGreaterThan(0)  // 默认中继已填好
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('能关回去(总开关必须双向,否则用户被单向门锁住)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'routes-social-disable-'))
    try {
      const routes = socialRoutes(stateDeps(dir))
      await routes['POST /v1/social/enable']!({} as any, { enabled: true })
      const r = await routes['POST /v1/social/enable']!({} as any, { enabled: false })
      expect((r.body as any).enabled).toBe(false)
      const raw = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf8'))
      expect(raw.social_enabled).toBe(false)
      expect(raw.social_disclosure_policy).toBeTruthy()   // 关闭不清空,再开不用重填
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('空 body 读作关闭,不 500(与同族 POST 路由一致的防御)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'routes-social-nobody-'))
    try {
      const routes = socialRoutes(stateDeps(dir))
      const r = await routes['POST /v1/social/enable']!({} as any, null)
      expect(r.status).toBe(200)
      expect((r.body as any).enabled).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
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
  const r = socialRoutes({ social: { wish, intro } } as unknown as InternalApiDeps)
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
    const rs = socialRoutes({ social: { wish: wishStale, intro } } as unknown as InternalApiDeps)
    const w = (await rs['GET /v1/social/wishes']!(qs(), undefined)).body as { wishes: Array<{ postcards: Array<{ requested: boolean }> }> }
    expect(w.wishes[0]!.postcards[0]!.requested).toBe(false)
  })
  it('没接 → 503;四条 tier trusted', async () => {
    expect((await socialRoutes({ social: { wish } } as unknown as InternalApiDeps)['POST /v1/social/intro/request']!(qs(), { reply_id: 'ab' })).status).toBe(503)
    for (const k of ['POST /v1/social/intro/request', 'POST /v1/social/intro/accept', 'POST /v1/social/intro/decline', 'GET /v1/social/intro/offers']) expect(minTierFor(k)).toBe('trusted')
  })
})
