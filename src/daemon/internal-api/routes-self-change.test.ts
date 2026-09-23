import { describe, it, expect, vi } from 'vitest'
import { selfChangeRoutes } from './routes-self-change'
import { minTierFor } from './route-tiers'
import type { InternalApiDeps } from './types'

const qs = (s = '') => new URLSearchParams(s)

function depsWith(over: Partial<NonNullable<InternalApiDeps['selfChange']>> = {}) {
  const selfChange = {
    notice: vi.fn(async () => ({ ok: true as const })),
    ask: vi.fn(async () => ({ ok: true as const, hash: 'abc123', code: '07', delivered: true })),
    decision: vi.fn(() => 'pending' as const),
    ...over,
  }
  return { deps: { selfChange } as unknown as InternalApiDeps, selfChange }
}

describe('/v1/self-change/*', () => {
  it('三条都没接线 ⇒ 503 self_change_not_wired', async () => {
    const r = selfChangeRoutes({} as InternalApiDeps)
    expect(await r['POST /v1/self-change/notice']!(qs(), { text: 'hi' })).toEqual({ status: 503, body: { error: 'self_change_not_wired' } })
    expect(await r['POST /v1/self-change/ask']!(qs(), { prompt: 'hi', timeoutMs: 60_000 })).toEqual({ status: 503, body: { error: 'self_change_not_wired' } })
    expect(await r['GET /v1/self-change/decision']!(qs('hash=abc'), undefined)).toEqual({ status: 503, body: { error: 'self_change_not_wired' } })
  })

  it('notice:text 非空 ≤ 4000,否则 400', async () => {
    const { deps, selfChange } = depsWith()
    const route = selfChangeRoutes(deps)['POST /v1/self-change/notice']!
    expect((await route(qs(), undefined)).status).toBe(400)
    expect((await route(qs(), { text: '' })).status).toBe(400)
    expect((await route(qs(), { text: '   ' })).status).toBe(400)
    expect((await route(qs(), { text: 42 })).status).toBe(400)
    expect((await route(qs(), { text: 'x'.repeat(4001) })).status).toBe(400)
    expect(selfChange.notice).not.toHaveBeenCalled()
    expect(await route(qs(), { text: 'x'.repeat(4000) })).toEqual({ status: 200, body: { ok: true } })
  })

  it('notice:没有主人 chat ⇒ 409;送不出去 ⇒ 502(CLI 据此别装作通知过了)', async () => {
    const unknown = depsWith({ notice: vi.fn(async () => ({ ok: false as const, error: 'owner_chat_unknown' as const })) })
    expect(await selfChangeRoutes(unknown.deps)['POST /v1/self-change/notice']!(qs(), { text: 'hi' }))
      .toEqual({ status: 409, body: { error: 'owner_chat_unknown' } })
    const failed = depsWith({ notice: vi.fn(async () => ({ ok: false as const, error: 'send_failed' as const })) })
    expect(await selfChangeRoutes(failed.deps)['POST /v1/self-change/notice']!(qs(), { text: 'hi' }))
      .toEqual({ status: 502, body: { error: 'send_failed' } })
  })

  it('ask:prompt 非空 ≤ 4000、timeoutMs 是 60_000..172_800_000 的整数,否则 400', async () => {
    const { deps, selfChange } = depsWith()
    const route = selfChangeRoutes(deps)['POST /v1/self-change/ask']!
    expect((await route(qs(), undefined)).status).toBe(400)
    expect((await route(qs(), { prompt: '', timeoutMs: 60_000 })).status).toBe(400)
    expect((await route(qs(), { prompt: 'x'.repeat(4001), timeoutMs: 60_000 })).status).toBe(400)
    expect((await route(qs(), { prompt: 'p' })).status).toBe(400)
    expect((await route(qs(), { prompt: 'p', timeoutMs: 59_999 })).status).toBe(400)
    expect((await route(qs(), { prompt: 'p', timeoutMs: 172_800_001 })).status).toBe(400)
    expect((await route(qs(), { prompt: 'p', timeoutMs: 60_000.5 })).status).toBe(400)
    expect((await route(qs(), { prompt: 'p', timeoutMs: '60000' })).status).toBe(400)
    expect(selfChange.ask).not.toHaveBeenCalled()
    expect(await route(qs(), { prompt: '合进 dev?', timeoutMs: 172_800_000 })).toEqual({ status: 200, body: { hash: 'abc123', code: '07', delivered: true } })
    expect(selfChange.ask).toHaveBeenCalledWith('合进 dev?', 172_800_000)
  })

  // 卡片没进微信不是 502:条目还在登记处,桌面权限卡 / `self change --approve`
  // 照样能拍(2026-09-18 真机 errcode=-2)。CLI 要拿 delivered 去提醒人换个面拍。
  it('ask:卡片没送到 ⇒ 仍是 200,只是 delivered:false', async () => {
    const { deps } = depsWith({ ask: vi.fn(async () => ({ ok: true as const, hash: 'abc123', code: '07', delivered: false })) })
    expect(await selfChangeRoutes(deps)['POST /v1/self-change/ask']!(qs(), { prompt: 'p', timeoutMs: 60_000 }))
      .toEqual({ status: 200, body: { hash: 'abc123', code: '07', delivered: false } })
  })

  it('ask:没有主人 chat ⇒ 409', async () => {
    const { deps } = depsWith({ ask: vi.fn(async () => ({ ok: false as const, error: 'owner_chat_unknown' as const })) })
    expect(await selfChangeRoutes(deps)['POST /v1/self-change/ask']!(qs(), { prompt: 'p', timeoutMs: 60_000 }))
      .toEqual({ status: 409, body: { error: 'owner_chat_unknown' } })
  })

  it('decision:hash 必填;有就回 { decision }', async () => {
    const { deps, selfChange } = depsWith({ decision: vi.fn(() => 'allow' as const) })
    const route = selfChangeRoutes(deps)['GET /v1/self-change/decision']!
    expect((await route(qs(), undefined)).status).toBe(400)
    expect((await route(qs('hash='), undefined)).status).toBe(400)
    expect(await route(qs('hash=abc123'), undefined)).toEqual({ status: 200, body: { decision: 'allow' } })
    expect(selfChange.decision).toHaveBeenCalledWith('abc123')
  })

  it('三条都是 admin(替主人拿主意、往主人微信里发东西)', () => {
    expect(minTierFor('POST /v1/self-change/notice')).toBe('admin')
    expect(minTierFor('POST /v1/self-change/ask')).toBe('admin')
    expect(minTierFor('GET /v1/self-change/decision')).toBe('admin')
  })
})
