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
