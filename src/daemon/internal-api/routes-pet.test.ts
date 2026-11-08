import { describe, it, expect } from 'vitest'
import { petRoutes } from './routes-pet'
import { minTierFor } from './route-tiers'
import type { InternalApiDeps, PetTurnDep } from './types'

const qs = () => new URLSearchParams()

const payload = {
  owner_last_contact_at: '2026-09-05T10:00:00.000Z',
  turn: { phase: 'thinking' as const, since: '2026-09-05T10:00:01.000Z' },
  last_done_at: null,
  pending_permissions: [],
}

const deps = (petTurn?: PetTurnDep): InternalApiDeps => ({ petTurn } as unknown as InternalApiDeps)

describe('GET /v1/companion/pet', () => {
  it('没接线 → 503 pet_not_wired;接了 → 原样返回推导结果', async () => {
    const off = petRoutes(deps())['GET /v1/companion/pet']!
    expect(await off(qs(), undefined)).toEqual({ status: 503, body: { error: 'pet_not_wired' } })
    const on = petRoutes(deps(async () => payload))['GET /v1/companion/pet']!
    expect(await on(qs(), undefined)).toEqual({ status: 200, body: payload })
  })

  it('推导抛错 → 500,不掀翻', async () => {
    const r = petRoutes(deps(async () => { throw new Error('boom') }))['GET /v1/companion/pet']!
    const res = await r(qs(), undefined)
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'boom' })
  })

  it('tier 是 trusted(桌面拿的是 FILE token)', () => {
    expect(minTierFor('GET /v1/companion/pet')).toBe('trusted')
  })
})

describe('GET /v1/subscribe/presence(S5:桌宠订的 presence 主题)', () => {
  it('没给 since ⇒ 马上回 { cursor, presence, pet };没接线的那一半是 null(桌面画成联系不上 / 端点没接)', async () => {
    const r = await petRoutes(deps())['GET /v1/subscribe/presence']!(qs(), undefined)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ cursor: expect.any(Number), presence: null, pet: null })
    const on = await petRoutes(deps(async () => payload))['GET /v1/subscribe/presence']!(qs(), undefined)
    expect((on.body as { pet: unknown }).pet).toEqual(payload)
  })

  it('写口一戳,挂着的长轮询马上带回新内容', async () => {
    let current: unknown = payload
    let poke: (() => void) | null = null
    const d = { petTurn: async () => current, presenceChanged: (cb: () => void) => { poke = cb; return () => {} } } as unknown as InternalApiDeps
    const route = petRoutes(d)['GET /v1/subscribe/presence']!
    const first = (await route(qs(), undefined)).body as { cursor: number }
    const waiting = route(new URLSearchParams({ since: String(first.cursor), wait_ms: '20000' }), undefined)
    current = { ...payload, turn: { phase: 'idle', since: null } }
    poke!()
    const got = (await waiting).body as { cursor: number; pet: { turn: { phase: string } } }
    expect(got.cursor).toBe(first.cursor + 1)
    expect(got.pet.turn.phase).toBe('idle')
  })

  it('since 不是数 ⇒ 400', async () => {
    const r = await petRoutes(deps())['GET /v1/subscribe/presence']!(new URLSearchParams({ since: 'abc' }), undefined)
    expect(r.status).toBe(400)
  })

  it('tier 是 trusted(和 presence / pet 两条同一类)', () => {
    expect(minTierFor('GET /v1/subscribe/presence')).toBe('trusted')
  })
})
