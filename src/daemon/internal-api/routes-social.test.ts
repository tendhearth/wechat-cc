// src/daemon/internal-api/routes-social.test.ts
//
// P4 派心愿 — the propose/confirm/cancel routes replacing the old one-shot
// POST /v1/social/seek (deleted in this pass). Mirrors routes-pair.test.ts's
// deps-stub shape: a bare `{ social }` object cast through, no real broker.
import { describe, it, expect, vi } from 'vitest'
import { socialRoutes } from './routes-social'
import type { InternalApiDeps } from './types'

function deps(social?: any): InternalApiDeps {
  return { social } as unknown as InternalApiDeps
}

describe('socialRoutes — propose/confirm/cancel', () => {
  it('the old one-shot route is gone', () => {
    const routes = socialRoutes(deps())
    expect(routes['POST /v1/social/seek']).toBeUndefined()
  })

  describe('POST /v1/social/seek/propose', () => {
    it('calls broker.propose(topic, { city }) and returns 200 with the result verbatim', async () => {
      const propose = vi.fn(async () => ({ ok: true, intent_id: 'i1', redacted: '找摄影搭子' }))
      const routes = socialRoutes(deps({ broker: { propose } }))
      const r = await routes['POST /v1/social/seek/propose']!({} as any, { topic: '找摄影搭子', city: '深圳' })
      expect(propose).toHaveBeenCalledWith('找摄影搭子', { city: '深圳' })
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ ok: true, intent_id: 'i1', redacted: '找摄影搭子' })
    })

    it('omits opts when no city given', async () => {
      const propose = vi.fn(async () => ({ ok: true, intent_id: 'i1', redacted: 'x' }))
      const routes = socialRoutes(deps({ broker: { propose } }))
      await routes['POST /v1/social/seek/propose']!({} as any, { topic: 'x' })
      expect(propose).toHaveBeenCalledWith('x', undefined)
    })

    it('503 when deps.social is undefined', async () => {
      const routes = socialRoutes(deps(undefined))
      const r = await routes['POST /v1/social/seek/propose']!({} as any, { topic: 'x' })
      expect(r.status).toBe(503)
      expect(r.body).toEqual({ error: 'social_not_wired' })
    })
  })

  describe('POST /v1/social/seek/confirm', () => {
    it('calls broker.confirmSeek(id) and returns 200 with the result verbatim', async () => {
      const confirmSeek = vi.fn(async () => ({ ok: true, intent_id: 'i1' }))
      const routes = socialRoutes(deps({ broker: { confirmSeek } }))
      const r = await routes['POST /v1/social/seek/confirm']!({} as any, { id: 'i1' })
      expect(confirmSeek).toHaveBeenCalledWith('i1')
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ ok: true, intent_id: 'i1' })
    })

    it('400 missing_id on a missing/empty id', async () => {
      const confirmSeek = vi.fn()
      const routes = socialRoutes(deps({ broker: { confirmSeek } }))
      const missing = await routes['POST /v1/social/seek/confirm']!({} as any, {})
      expect(missing.status).toBe(400)
      expect(missing.body).toEqual({ error: 'missing_id' })
      const empty = await routes['POST /v1/social/seek/confirm']!({} as any, { id: '' })
      expect(empty.status).toBe(400)
      expect(confirmSeek).not.toHaveBeenCalled()
    })

    it('503 when deps.social is undefined', async () => {
      const routes = socialRoutes(deps(undefined))
      const r = await routes['POST /v1/social/seek/confirm']!({} as any, { id: 'i1' })
      expect(r.status).toBe(503)
      expect(r.body).toEqual({ error: 'social_not_wired' })
    })
  })

  describe('POST /v1/social/seek/cancel', () => {
    it('calls broker.cancelSeek(id) and returns 200 with the result verbatim', async () => {
      const cancelSeek = vi.fn(async () => ({ ok: true }))
      const routes = socialRoutes(deps({ broker: { cancelSeek } }))
      const r = await routes['POST /v1/social/seek/cancel']!({} as any, { id: 'i1' })
      expect(cancelSeek).toHaveBeenCalledWith('i1')
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ ok: true })
    })

    it('400 missing_id on a missing id', async () => {
      const cancelSeek = vi.fn()
      const routes = socialRoutes(deps({ broker: { cancelSeek } }))
      const r = await routes['POST /v1/social/seek/cancel']!({} as any, {})
      expect(r.status).toBe(400)
      expect(r.body).toEqual({ error: 'missing_id' })
      expect(cancelSeek).not.toHaveBeenCalled()
    })

    it('503 when deps.social is undefined', async () => {
      const routes = socialRoutes(deps(undefined))
      const r = await routes['POST /v1/social/seek/cancel']!({} as any, { id: 'i1' })
      expect(r.status).toBe(503)
      expect(r.body).toEqual({ error: 'social_not_wired' })
    })
  })
})
