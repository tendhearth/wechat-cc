import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  entitlementFromCache, getEntitlement, isPro, needsRevalidation,
  activate, validate, readCache, clearLicense, type LicenseCache,
} from './license'
import { licensePath } from './paths'

const T0 = new Date('2026-07-01T00:00:00Z')
const cache = (over: Partial<LicenseCache> = {}): LicenseCache => ({
  key: 'K', instanceId: 'i', status: 'active', expiresAt: null, lastValidatedAt: T0.toISOString(), ...over,
})

describe('license entitlement (pure gate)', () => {
  it('no license → free', () => {
    expect(entitlementFromCache(null, T0).pro).toBe(false)
  })
  it('active + no expiry → pro', () => {
    expect(entitlementFromCache(cache(), T0).pro).toBe(true)
  })
  it('active but past expiry → not pro', () => {
    const c = cache({ expiresAt: '2026-06-01T00:00:00Z' })
    expect(entitlementFromCache(c, T0)).toMatchObject({ pro: false, reason: 'license expired' })
  })
  it('active and before expiry → pro (offline grace until expiry)', () => {
    expect(entitlementFromCache(cache({ expiresAt: '2026-12-01T00:00:00Z' }), T0).pro).toBe(true)
  })
  it('non-active status → not pro', () => {
    for (const s of ['inactive', 'expired', 'disabled']) {
      expect(entitlementFromCache(cache({ status: s }), T0).pro).toBe(false)
    }
  })
  it('needsRevalidation: fresh no, >24h yes, DEV never', () => {
    const now = new Date('2026-07-01T12:00:00Z')
    expect(needsRevalidation(cache({ lastValidatedAt: '2026-07-01T06:00:00Z' }), now)).toBe(false)
    expect(needsRevalidation(cache({ lastValidatedAt: '2026-06-29T00:00:00Z' }), now)).toBe(true)
    expect(needsRevalidation(cache({ key: 'DEV-x' }), now)).toBe(false)
  })
})

describe('license activation + cache', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'lic-')) })
  afterEach(() => { try { rmSync(stateDir, { recursive: true, force: true }) } catch { /**/ } })

  it('DEV- key unlocks Pro locally (no network) and persists', async () => {
    const r = await activate(stateDir, 'DEV-PRO', 'my-mac')
    expect(r.ok).toBe(true)
    expect(isPro(stateDir)).toBe(true)
    expect(existsSync(licensePath(stateDir))).toBe(true)
    expect(readCache(stateDir)?.status).toBe('active')
  })

  it('activate parses a Lemon Squeezy response via injected fetch', async () => {
    const mockFetch = (async () => ({
      status: 200,
      json: async () => ({ activated: true, instance: { id: 'inst_42' }, license_key: { status: 'active', expires_at: '2027-07-01T00:00:00Z' } }),
    })) as unknown as typeof fetch
    const r = await activate(stateDir, 'REAL-KEY', 'my-mac', mockFetch)
    expect(r.ok).toBe(true)
    const c = readCache(stateDir)!
    expect(c).toMatchObject({ instanceId: 'inst_42', status: 'active', expiresAt: '2027-07-01T00:00:00Z' })
    expect(isPro(stateDir)).toBe(true)
  })

  it('activate surfaces LS failure and writes no cache', async () => {
    const mockFetch = (async () => ({ status: 400, json: async () => ({ activated: false, error: 'license_key not found' }) })) as unknown as typeof fetch
    const r = await activate(stateDir, 'BAD', 'my-mac', mockFetch)
    expect(r).toMatchObject({ ok: false, error: 'license_key not found' })
    expect(existsSync(licensePath(stateDir))).toBe(false)
  })

  it('validate keeps last-known-good cache when offline (grace)', async () => {
    await activate(stateDir, 'DEV-PRO', 'my-mac')      // seed an active cache
    // DEV key path returns from cache without network; force a real key + throwing fetch
    const throwing = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    // manually seed a non-DEV cache
    const { activate: act } = await import('./license')
    const mockOk = (async () => ({ status: 200, json: async () => ({ activated: true, instance: { id: 'x' }, license_key: { status: 'active', expires_at: null } }) })) as unknown as typeof fetch
    await act(stateDir, 'REAL', 'my-mac', mockOk)
    const ent = await validate(stateDir, throwing)     // network dies → grace
    expect(ent.pro).toBe(true)
  })

  it('WECHAT_CC_DEV_PRO=1 forces Pro regardless of cache', () => {
    clearLicense(stateDir)
    process.env.WECHAT_CC_DEV_PRO = '1'
    try { expect(getEntitlement(stateDir).pro).toBe(true) }
    finally { delete process.env.WECHAT_CC_DEV_PRO }
  })
})
