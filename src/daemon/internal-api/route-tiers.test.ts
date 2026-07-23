import { describe, it, expect } from 'vitest'
import { tierMeets, minTierFor, ROUTE_MIN_TIER } from './route-tiers'
import { makeRoutes } from './routes'
import type { InternalApiDeps } from './types'

describe('route-tiers', () => {
  it('tierMeets ranks admin > trusted > guest', () => {
    expect(tierMeets('admin', 'trusted')).toBe(true)
    expect(tierMeets('trusted', 'admin')).toBe(false)
    expect(tierMeets('guest', 'guest')).toBe(true)
    expect(tierMeets('trusted', 'guest')).toBe(true)
  })

  it('daemon-control routes require admin', () => {
    expect(minTierFor('POST /v1/daemon/restart')).toBe('admin')
    expect(minTierFor('POST /v1/sessions/release')).toBe('admin')
    expect(minTierFor('POST /v1/model')).toBe('admin')
    expect(minTierFor('GET /v1/turns')).toBe('admin')
    expect(minTierFor('GET /v1/sessions')).toBe('admin')
    expect(minTierFor('GET /v1/model')).toBe('admin')
  })

  it('reply/health/memory-read are guest; broadcast/a2a are trusted', () => {
    expect(minTierFor('GET /v1/health')).toBe('guest')
    expect(minTierFor('POST /v1/wechat/reply')).toBe('guest')
    expect(minTierFor('POST /v1/memory/read')).toBe('guest')
    expect(minTierFor('POST /v1/wechat/broadcast')).toBe('trusted')
    expect(minTierFor('GET /v1/a2a/list')).toBe('trusted')
    expect(minTierFor('POST /v1/companion/import-local')).toBe('trusted')
  })

  it('an unlisted route defaults to admin (fail-closed)', () => {
    expect(minTierFor('POST /v1/some/new/route')).toBe('admin')
  })

  it('pair routes require trusted', () => {
    expect(minTierFor('POST /v1/pair/start')).toBe('trusted')
    expect(minTierFor('POST /v1/pair/accept')).toBe('trusted')
  })

  it('P4 seek propose/confirm/cancel require trusted (CLI-reachable, flagged for release review)', () => {
    expect(minTierFor('POST /v1/social/seek/propose')).toBe('trusted')
    expect(minTierFor('POST /v1/social/seek/confirm')).toBe('trusted')
    expect(minTierFor('POST /v1/social/seek/cancel')).toBe('trusted')
  })

  it('the deleted one-shot POST /v1/social/seek has no explicit tier (falls to the admin default)', () => {
    expect(ROUTE_MIN_TIER['POST /v1/social/seek']).toBeUndefined()
  })

  it('penpal 信箱路由全部 trusted(桌面凭据是 trusted 文件 token — 真机验收 2026-07-22 发现 admin 定级把桌面读挡成 403)', () => {
    expect(minTierFor('GET /v1/penpal/channels')).toBe('trusted')
    expect(minTierFor('GET /v1/penpal/letters')).toBe('trusted')
    expect(minTierFor('POST /v1/penpal/letters')).toBe('trusted')
    expect(minTierFor('POST /v1/penpal/letters/read')).toBe('trusted')
    expect(minTierFor('POST /v1/penpal/letters/resend')).toBe('trusted')
  })

  it('觅食台读面 + inbound toggle 是 trusted(同上:桌面/CLI 的唯一凭据是文件 token)', () => {
    expect(minTierFor('GET /v1/social/seeks')).toBe('trusted')
    expect(minTierFor('GET /v1/social/echoes')).toBe('trusted')
    expect(minTierFor('GET /v1/social/pledges')).toBe('trusted')
    expect(minTierFor('GET /v1/social/inbound')).toBe('trusted')
    expect(minTierFor('POST /v1/social/inbound')).toBe('trusted')
  })

  it('every registered route has an explicit min tier (no accidental default-deny)', () => {
    const deps = { stateDir: '/tmp', daemonPid: 1 } as unknown as InternalApiDeps
    const routes = makeRoutes({ deps, getDelegate: () => null, maybePrefix: (_c, t) => t })
    const missing = Object.keys(routes).filter(k => ROUTE_MIN_TIER[k] === undefined)
    expect(missing, `routes missing from ROUTE_MIN_TIER: ${missing.join(', ')}`).toEqual([])
  })
})
