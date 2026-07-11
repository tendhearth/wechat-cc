import { describe, it, expect } from 'vitest'
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

  it('resolves a registered operator token as admin/operator, route-scoped to converse + speak only', () => {
    const r = makeTokenRegistry()
    r.registerFileToken('cc'.repeat(32))
    r.registerOperatorToken('dd'.repeat(32))
    const opInfo = r.resolve('dd'.repeat(32))
    expect(opInfo?.tier).toBe('admin')
    expect(opInfo?.origin).toBe('operator')
    expect(opInfo?.routeAllow).toEqual(new Set(['POST /v1/companion/converse', 'POST /v1/companion/speak']))
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
})
