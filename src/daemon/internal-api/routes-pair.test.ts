import { describe, it, expect, vi } from 'vitest'
import { pairRoutes } from './routes-pair'

const deps = (pairing?: any) => ({ pairing } as any)

describe('pairRoutes', () => {
  it('503 when pairing not wired', async () => {
    const r = await pairRoutes(deps())['POST /v1/pair/start']!({} as any, null)
    expect(r.status).toBe(503)
  })
  it('start returns the code', async () => {
    const start = vi.fn(() => ({ code: '483921', expiresAt: 123 }))
    const r = await pairRoutes(deps({ start, accept: vi.fn() }))['POST /v1/pair/start']!({} as any, null)
    expect(r.status).toBe(200); expect((r.body as any).code).toBe('483921')
  })
  it('accept validates the code and returns the result', async () => {
    const accept = vi.fn(async () => ({ ok: true, peer: { self_id: 'cc-x', name: 'Bob' } }))
    const r = await pairRoutes(deps({ start: vi.fn(), accept }))['POST /v1/pair/accept']!({} as any, { code: '483921' })
    expect(accept).toHaveBeenCalledWith('483921'); expect(r.status).toBe(200)
  })
  it('accept 400 on a missing/invalid code', async () => {
    const r = await pairRoutes(deps({ start: vi.fn(), accept: vi.fn() }))['POST /v1/pair/accept']!({} as any, { code: 'nope' })
    expect(r.status).toBe(400)
  })
})
