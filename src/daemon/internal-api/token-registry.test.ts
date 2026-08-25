import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeTokenRegistry } from './token-registry'

describe('token-registry', () => {
  it('resolves a registered file token as trusted/file', () => {
    const r = makeTokenRegistry()
    r.registerFileToken('aa'.repeat(32))
    expect(r.resolve('aa'.repeat(32))).toEqual({ tier: 'trusted', origin: 'file' })
  })

  it('mint returns a token that resolves to its tier/session and is unique', () => {
    let n = 0
    const r = makeTokenRegistry(() => `${n++}`.padStart(64, '0'))
    const t1 = r.mint('admin', 'claude/a/chat-1')
    const t2 = r.mint('guest', 'codex/a/chat-2')
    expect(t1).not.toBe(t2)
    expect(r.resolve(t1)).toEqual({ tier: 'admin', origin: 'session', sessionKey: 'claude/a/chat-1' })
    expect(r.resolve(t2)).toEqual({ tier: 'guest', origin: 'session', sessionKey: 'codex/a/chat-2' })
  })

  it('resolve returns null for an unknown token', () => {
    expect(makeTokenRegistry().resolve('ff'.repeat(32))).toBeNull()
  })

  it('resolves an operator token as admin, scoped to explicit desktop owner surfaces', () => {
    const r = makeTokenRegistry()
    r.registerFileToken('cc'.repeat(32))
    r.registerOperatorToken('dd'.repeat(32))
    const opInfo = r.resolve('dd'.repeat(32))
    expect(opInfo?.tier).toBe('admin')
    expect(opInfo?.origin).toBe('operator')
    expect(opInfo?.routeAllow).toEqual(new Set([
      'POST /v1/companion/converse',
      'POST /v1/companion/speak',
      'POST /v1/companion/transcribe',
      'GET /v1/customer-review/contacts',
      'POST /v1/customer-review',
      'POST /v1/customer-review/run',
      'GET /v1/customer-review',
      'GET /v1/customer-review/evidence',
      'GET /v1/customer-review/recent',
      'GET /v1/customer-review/history',
      'POST /v1/customer-review/item',
      'POST /v1/knowledge/facts/find_facts',
      'POST /v1/llm/keys',
      'POST /v1/knowledge/facts/set_fact_status',
      'POST /v1/knowledge/graph/top_contacts',
      'POST /v1/reminders/schedule',
      'POST /v1/federation/mint',
    ]))
    expect(opInfo?.routeAllow).not.toContain('POST /v1/daemon/restart')
    expect(r.resolve('cc'.repeat(32))).toEqual({ tier: 'trusted', origin: 'file' })
  })

  it('file and session tokens carry no routeAllow (unrestricted by route, tier gate only)', () => {
    const r = makeTokenRegistry()
    r.registerFileToken('ee'.repeat(32))
    const sessionTok = r.mint('admin', 'claude/a/chat-1')
    expect(r.resolve('ee'.repeat(32))?.routeAllow).toBeUndefined()
    expect(r.resolve(sessionTok)?.routeAllow).toBeUndefined()
  })

  it('invalidateSession drops every token for that sessionKey but keeps others', () => {
    const r = makeTokenRegistry()
    r.registerFileToken('bb'.repeat(32))
    const t = r.mint('admin', 'claude/a/chat-1')
    const other = r.mint('trusted', 'codex/a/chat-9')
    r.invalidateSession('claude/a/chat-1')
    expect(r.resolve(t)).toBeNull()
    expect(r.resolve(other)?.tier).toBe('trusted')
    expect(r.resolve('bb'.repeat(32))?.origin).toBe('file')
  })

  // ─── mint(opts) — security review fix round 1 (federation mint's
  //     credential must be scoped + short-lived, not just gated) ─────────
  describe('mint(tier, sessionKey, opts) — routeAllow + ttlMs scoping', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('mint without opts is unchanged: no routeAllow, no expiry (back-compat for every existing caller)', () => {
      const r = makeTokenRegistry()
      const t = r.mint('admin', 'claude/a/chat-1')
      expect(r.resolve(t)).toEqual({ tier: 'admin', origin: 'session', sessionKey: 'claude/a/chat-1' })
    })

    it('mint with opts.routeAllow scopes the resolved TokenInfo to that route set', () => {
      const r = makeTokenRegistry()
      const t = r.mint('admin', 'hearth-federated', { routeAllow: new Set(['POST /v1/knowledge/search']) })
      const info = r.resolve(t)
      expect(info?.routeAllow).toEqual(new Set(['POST /v1/knowledge/search']))
      expect(info?.routeAllow?.has('POST /v1/companion/converse')).toBe(false)
    })

    it('mint with opts.ttlMs: resolves normally before expiry, then null (and evicted) after', () => {
      vi.useFakeTimers()
      const r = makeTokenRegistry()
      const t = r.mint('admin', 'hearth-federated', { ttlMs: 1000 })
      expect(r.resolve(t)?.tier).toBe('admin')
      vi.advanceTimersByTime(999)
      expect(r.resolve(t)?.tier).toBe('admin')
      vi.advanceTimersByTime(1)
      expect(r.resolve(t)).toBeNull()
      // Eviction, not just an expiry check that re-passes on re-resolve —
      // a second resolve must still be null (the map entry is gone).
      expect(r.resolve(t)).toBeNull()
    })

    it('a token minted without ttlMs never expires, even much later (existing behavior preserved)', () => {
      vi.useFakeTimers()
      const r = makeTokenRegistry()
      const t = r.mint('admin', 'claude/a/chat-1')
      vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000) // a year
      expect(r.resolve(t)?.tier).toBe('admin')
    })
  })
})
