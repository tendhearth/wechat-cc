import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { federationRoutes } from './routes-federation'
import { writeGrant } from './federation-grant'
import type { InternalApiDeps } from './types'

function depsWith(stateDir: string, mint = vi.fn(() => 'minted-admin-token')): InternalApiDeps {
  // Only the fields the route touches; cast through unknown like sibling tests do.
  return { stateDir, mintSessionToken: mint, log: vi.fn() } as unknown as InternalApiDeps
}

describe('POST /v1/federation/mint', () => {
  it('mints an admin token when the grant exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-mint-'))
    writeGrant(dir, 1)
    const mint = vi.fn(() => 'minted-admin-token')
    const routes = federationRoutes(depsWith(dir, mint))
    const out = await routes['POST /v1/federation/mint']!(new URLSearchParams(), {})
    expect(out.status).toBe(200)
    expect((out.body as { token: string }).token).toBe('minted-admin-token')
    expect(mint).toHaveBeenCalledWith('admin', 'hearth-federated')
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
  it('never puts the token into the log payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-mint-log-'))
    writeGrant(dir, 1)
    const log = vi.fn()
    const deps = { stateDir: dir, mintSessionToken: () => 'SECRET-TOKEN', log } as unknown as InternalApiDeps
    await federationRoutes(deps)['POST /v1/federation/mint']!(new URLSearchParams(), {})
    for (const call of log.mock.calls) expect(JSON.stringify(call)).not.toContain('SECRET-TOKEN')
  })
})
