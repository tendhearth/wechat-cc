import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { federationRoutes } from './routes-federation'
import { writeGrant } from './federation-grant'
import { makeTokenRegistry } from './token-registry'
import type { InternalApiDeps } from './types'

function depsWith(stateDir: string, mint = vi.fn(() => 'minted-admin-token')): InternalApiDeps {
  // Only the fields the route touches; cast through unknown like sibling tests do.
  return { stateDir, mintSessionToken: mint, log: vi.fn() } as unknown as InternalApiDeps
}

const FEDERATION_ROUTE_ALLOW = new Set(['POST /v1/knowledge/search'])
const FEDERATION_TTL_MS = 5 * 60_000

describe('POST /v1/federation/mint', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('mints an admin token when the grant exists, scoped to knowledge/search only + a 5-minute TTL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-mint-'))
    writeGrant(dir, 1)
    const mint = vi.fn(() => 'minted-admin-token')
    const routes = federationRoutes(depsWith(dir, mint))
    const out = await routes['POST /v1/federation/mint']!(new URLSearchParams(), {})
    expect(out.status).toBe(200)
    expect((out.body as { token: string }).token).toBe('minted-admin-token')
    expect(mint).toHaveBeenCalledWith('admin', 'hearth-federated', {
      routeAllow: FEDERATION_ROUTE_ALLOW,
      ttlMs: FEDERATION_TTL_MS,
    })
  })

  it('refuses with 403 federation_not_authorized when no grant, and does NOT mint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-mint-nogrant-'))
    const mint = vi.fn(() => 'should-not-happen')
    const routes = federationRoutes(depsWith(dir, mint))
    const out = await routes['POST /v1/federation/mint']!(new URLSearchParams(), {})
    expect(out.status).toBe(403)
    expect((out.body as { error: string }).error).toBe('federation_not_authorized')
    expect(mint).not.toHaveBeenCalled()
  })

  it('503s federation_mint_not_wired when deps.mintSessionToken is absent (defensive guard)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-mint-notwired-'))
    writeGrant(dir, 1)
    const deps = { stateDir: dir, log: vi.fn() } as unknown as InternalApiDeps
    const out = await federationRoutes(deps)['POST /v1/federation/mint']!(new URLSearchParams(), {})
    expect(out).toEqual({ status: 503, body: { error: 'federation_mint_not_wired' } })
  })

  it('never puts the token into the log payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-mint-log-'))
    writeGrant(dir, 1)
    const log = vi.fn()
    const deps = { stateDir: dir, mintSessionToken: () => 'SECRET-TOKEN', log } as unknown as InternalApiDeps
    await federationRoutes(deps)['POST /v1/federation/mint']!(new URLSearchParams(), {})
    for (const call of log.mock.calls) expect(JSON.stringify(call)).not.toContain('SECRET-TOKEN')
  })

  // ─── security review fix round 1: the CREDENTIAL itself, not just the
  //     three gates guarding who can mint it ────────────────────────────
  describe('credential scoping (HIGH: unscoped full-admin) + lifetime (MEDIUM: unbounded)', () => {
    it('the minted token resolves to routeAllow containing ONLY POST /v1/knowledge/search — not full admin', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fed-mint-scope-'))
      writeGrant(dir, 1)
      const registry = makeTokenRegistry(() => 'scopetesttoken')
      const deps = { stateDir: dir, mintSessionToken: registry.mint, log: vi.fn() } as unknown as InternalApiDeps
      const out = await federationRoutes(deps)['POST /v1/federation/mint']!(new URLSearchParams(), {})
      const token = (out.body as { token: string }).token
      const info = registry.resolve(token)
      expect(info?.tier).toBe('admin')
      // Reaches the one route federated_query actually calls...
      expect(info?.routeAllow?.has('POST /v1/knowledge/search')).toBe(true)
      // ...and NOTHING else — in particular not the owner-impersonation route.
      expect(info?.routeAllow?.has('POST /v1/companion/converse')).toBe(false)
      expect(info?.routeAllow?.size).toBe(1)
    })

    it('a resolved caller with this routeAllow is rejected by the route-allow gate for a sensitive admin route', async () => {
      // Drives the same gate index.ts's dispatcher applies (routeAllow &&
      // !routeAllow.has(routeKey) ⇒ route_not_allowed), without spinning up
      // the HTTP server — proves the scoping is enforced, not just present.
      const dir = mkdtempSync(join(tmpdir(), 'fed-mint-gate-'))
      writeGrant(dir, 1)
      const registry = makeTokenRegistry(() => 'gatetesttoken')
      const deps = { stateDir: dir, mintSessionToken: registry.mint, log: vi.fn() } as unknown as InternalApiDeps
      const out = await federationRoutes(deps)['POST /v1/federation/mint']!(new URLSearchParams(), {})
      const token = (out.body as { token: string }).token
      const info = registry.resolve(token)!
      const routeAllowGate = (routeKey: string) => !info.routeAllow || info.routeAllow.has(routeKey)
      expect(routeAllowGate('POST /v1/knowledge/search')).toBe(true)
      expect(routeAllowGate('POST /v1/companion/converse')).toBe(false)
      expect(routeAllowGate('POST /v1/daemon/restart')).toBe(false)
    })

    it('the minted token is valid immediately, and expired + evicted after 5 minutes', async () => {
      vi.useFakeTimers()
      const dir = mkdtempSync(join(tmpdir(), 'fed-mint-ttl-'))
      writeGrant(dir, 1)
      const registry = makeTokenRegistry(() => 'ttltesttoken')
      const deps = { stateDir: dir, mintSessionToken: registry.mint, log: vi.fn() } as unknown as InternalApiDeps
      const out = await federationRoutes(deps)['POST /v1/federation/mint']!(new URLSearchParams(), {})
      const token = (out.body as { token: string }).token

      expect(registry.resolve(token)).not.toBeNull()

      vi.advanceTimersByTime(FEDERATION_TTL_MS - 1)
      expect(registry.resolve(token)).not.toBeNull() // still inside the window

      vi.advanceTimersByTime(2) // now past ttlMs
      expect(registry.resolve(token)).toBeNull() // expired AND evicted
      expect(registry.resolve(token)).toBeNull() // still gone, not re-appearing
    })
  })
})
