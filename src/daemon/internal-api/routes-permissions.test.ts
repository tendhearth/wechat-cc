import { describe, it, expect, vi } from 'vitest'
import { permissionRoutes } from './routes-permissions'
import { minTierFor } from './route-tiers'
import type { InternalApiDeps } from './types'

const qs = () => new URLSearchParams()

const items = [{ hash: 'abcde', chatId: 'owner', prompt: 'Bash: ls', since: 's', expires_at: 'e' }]

describe('/v1/permissions/*', () => {
  it('pending:没接线 503;接了 → { items }', async () => {
    const off = permissionRoutes({} as InternalApiDeps)['GET /v1/permissions/pending']!
    expect(await off(qs(), undefined)).toEqual({ status: 503, body: { error: 'permissions_not_wired' } })
    const deps = { permissions: { list: () => items, resolve: vi.fn(() => true) } } as unknown as InternalApiDeps
    expect(await permissionRoutes(deps)['GET /v1/permissions/pending']!(qs(), undefined)).toEqual({ status: 200, body: { items } })
  })

  it('resolve:没接线 503', async () => {
    const off = permissionRoutes({} as InternalApiDeps)['POST /v1/permissions/resolve']!
    expect(await off(qs(), { hash: 'abcde', decision: 'allow' })).toEqual({ status: 503, body: { error: 'permissions_not_wired' } })
  })

  it('resolve:body 校验(hash 非空串、decision ∈ allow|deny)→ 400;成功 → { ok }', async () => {
    const resolve = vi.fn((h: string) => h === 'abcde')
    const deps = { permissions: { list: () => items, resolve } } as unknown as InternalApiDeps
    const route = permissionRoutes(deps)['POST /v1/permissions/resolve']!
    expect((await route(qs(), undefined)).status).toBe(400)
    expect((await route(qs(), { hash: '', decision: 'allow' })).status).toBe(400)
    expect((await route(qs(), { hash: 'abcde', decision: 'maybe' })).status).toBe(400)
    expect(await route(qs(), { hash: 'abcde', decision: 'deny' })).toEqual({ status: 200, body: { ok: true } })
    expect(await route(qs(), { hash: 'zzzzz', decision: 'allow' })).toEqual({ status: 200, body: { ok: false } })
    expect(resolve).toHaveBeenCalledWith('abcde', 'deny')
  })

  it('两条都是 admin(拍板权限就是主人本人的事)', () => {
    expect(minTierFor('GET /v1/permissions/pending')).toBe('admin')
    expect(minTierFor('POST /v1/permissions/resolve')).toBe('admin')
  })
})
