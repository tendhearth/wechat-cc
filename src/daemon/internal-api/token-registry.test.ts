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
      'GET /v1/companion/thoughts',
      'POST /v1/knowledge/facts/set_fact_status',
      'POST /v1/knowledge/graph/top_contacts',
      'POST /v1/reminders/schedule',
      'POST /v1/permissions/resolve',
      'POST /v1/federation/mint',
      'GET /v1/workbench/entry-options',
      'POST /v1/workbench/create-entry',
      'GET /v1/workbench/entry-receipt',
      'POST /v1/workbench/attachment',
      'GET /v1/workbench/attachment',
      'POST /v1/workbench/discard-attachment',
      'GET /v1/workbench',
      'GET /v1/matters','GET /v1/matter','GET /v1/matter/owner-chat','GET /v1/matter/owner-chat/search','POST /v1/matter/say',
      'GET /v1/connections',
      'POST /v1/phone/link',
      'GET /v1/phone/devices',
      'GET /v1/workbench/models',
      'GET /v1/workbench/sessions',
      'GET /v1/workbench/session',
      'GET /v1/workbench/task',
      'POST /v1/workbench/project',
      'POST /v1/workbench/create',
      'POST /v1/workbench/continue',
      'POST /v1/workbench/cancel',
      'GET /v1/workbench/artifact',
      'POST /v1/workbench/approve',
      'POST /v1/workbench/permission',
      'POST /v1/workbench/archive',
      'POST /v1/workbench/writer-exited',
      'POST /v1/workbench/unattended-ack',
      'GET /v1/workbench/review',
      'POST /v1/workbench/review-mark',
      'POST /v1/workbench/review-return',
      'POST /v1/workbench/review-revert',
      'POST /v1/workbench/worktree',
      'POST /v1/workbench/import',
      'POST /v1/workbench/prepare-resume',
      'POST /v1/workbench/prepare-continuation',
      'POST /v1/workbench/quota-handoff',
      'POST /v1/workbench/handoff-preview',
      'POST /v1/workbench/handoff',
      'GET /v1/workbench/handoff',
      'GET /v1/workbench/attention',
      'POST /v1/workbench/input',
      'POST /v1/workbench/answer',
      'POST /v1/workbench/withdraw-input',
      'POST /v1/selftest/converse',
      'POST /v1/self-change/notice',
      'POST /v1/self-change/ask',
      'GET /v1/self-change/decision',
      'GET /v1/settings/link',
      'POST /v1/cli/upgrade',
      'POST /v1/cli/rollback',
    ]))
    expect(opInfo?.routeAllow).not.toContain('POST /v1/daemon/restart')
    expect(r.resolve('cc'.repeat(32))).toEqual({ tier: 'trusted', origin: 'file' })
  })

  it('operator token grants exactly the supported Workbench routes without widening agent tokens', () => {
    const r = makeTokenRegistry(() => 'ee'.repeat(32))
    r.registerOperatorToken('dd'.repeat(32))
    r.registerFileToken('cc'.repeat(32))
    const session = r.mint('trusted', 'codex/default/contact')
    const workbenchRoutes = [...(r.resolve('dd'.repeat(32))?.routeAllow ?? [])].filter(route => route.includes('/v1/workbench'))
    expect(workbenchRoutes).toEqual([
      'GET /v1/workbench/entry-options',
      'POST /v1/workbench/create-entry',
      'GET /v1/workbench/entry-receipt',
      'POST /v1/workbench/attachment',
      'GET /v1/workbench/attachment',
      'POST /v1/workbench/discard-attachment',
      'GET /v1/workbench',
      'GET /v1/workbench/models',
      'GET /v1/workbench/sessions',
      'GET /v1/workbench/session',
      'GET /v1/workbench/task',
      'POST /v1/workbench/project',
      'POST /v1/workbench/create',
      'POST /v1/workbench/continue',
      'POST /v1/workbench/cancel',
      'GET /v1/workbench/artifact',
      'POST /v1/workbench/approve',
      'POST /v1/workbench/permission',
      'POST /v1/workbench/archive',
      'POST /v1/workbench/writer-exited',
      'POST /v1/workbench/unattended-ack',
      'GET /v1/workbench/review',
      'POST /v1/workbench/review-mark',
      'POST /v1/workbench/review-return',
      'POST /v1/workbench/review-revert',
      'POST /v1/workbench/worktree',
      'POST /v1/workbench/import',
      'POST /v1/workbench/prepare-resume',
      'POST /v1/workbench/prepare-continuation',
      'POST /v1/workbench/quota-handoff',
      'POST /v1/workbench/handoff-preview',
      'POST /v1/workbench/handoff',
      'GET /v1/workbench/handoff',
      'GET /v1/workbench/attention',
      'POST /v1/workbench/input',
      'POST /v1/workbench/answer',
      'POST /v1/workbench/withdraw-input',
    ])
    expect(r.resolve('cc'.repeat(32))?.routeAllow).toBeUndefined()
    expect(r.resolve(session)?.routeAllow).toBeUndefined()
    expect(r.resolve(session)?.tier).toBe('trusted')
    for(const route of ['POST /v1/workbench/entry-options','GET /v1/workbench/create-entry','POST /v1/workbench/entry-receipt','GET /v1/workbench/entry-options/extra','POST /v1/workbench/create-entry-extra','GET /v1/workbench/entry-receipt/'])expect(r.resolve('dd'.repeat(32))?.routeAllow?.has(route)).toBe(false)
    expect(r.resolve('dd'.repeat(32))?.routeAllow?.has('POST /v1/workbench/models')).toBe(false)
    expect(r.resolve('dd'.repeat(32))?.routeAllow?.has('GET /v1/workbench/models/extra')).toBe(false)
    expect(r.resolve('dd'.repeat(32))?.routeAllow?.has('GET /v1/workbench/prepare-continuation')).toBe(false)
    expect(r.resolve('dd'.repeat(32))?.routeAllow?.has('POST /v1/workbench/prepare-continuation/extra')).toBe(false)
  })

  // 桌宠卡片上的「允许 / 拒绝」只有这一个 admin 档凭据够得着(Tauri 的
  // pet_permission_resolve)。少了这条路由,按钮按下去就是 403 route_not_allowed。
  it('operator token 够得着桌宠权限卡片的 resolve 路由,但够不着待决列表', () => {
    const r = makeTokenRegistry()
    r.registerOperatorToken('dd'.repeat(32))
    const allow = r.resolve('dd'.repeat(32))?.routeAllow
    expect(allow?.has('POST /v1/permissions/resolve')).toBe(true)
    // 待决列表桌面走 GET /v1/companion/pet 读,operator 不需要这一条。
    expect(allow?.has('GET /v1/permissions/pending')).toBe(false)
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

  // 梳理第 6 步(2026-09-29):手机的链接令牌 / 设备令牌进同一个注册表。
  describe('register / listSessions / 可注入时钟(手机令牌)', () => {
    const ROUTES = new Set(['GET /m'])
    it('register 外部生成的秘钥:resolve 得到 origin / tier / sessionKey / routeAllow', () => {
      const r = makeTokenRegistry()
      r.register('d' + 'a'.repeat(48), { tier: 'admin', origin: 'device', sessionKey: 'device:aaaa', routeAllow: ROUTES })
      expect(r.resolve('d' + 'a'.repeat(48))).toEqual({ tier: 'admin', origin: 'device', sessionKey: 'device:aaaa', routeAllow: ROUTES })
    })
    it('ttlMs 按注入的 now 过期:过期后 resolve 为 null,listSessions 也不再列出', () => {
      let t = 1_000
      const r = makeTokenRegistry(undefined, () => t)
      r.register('t1', { tier: 'admin', origin: 'link', sessionKey: 'link', routeAllow: ROUTES, ttlMs: 600_000 })
      expect(r.listSessions('link')).toEqual([{ token: 't1', sessionKey: 'link' }])
      t += 599_999
      expect(r.resolve('t1')?.origin).toBe('link')
      t += 1
      expect(r.listSessions('link')).toEqual([])
      expect(r.resolve('t1')).toBeNull()
    })
    it('invalidateSession 按 sessionKey 撤销一台设备,别的不动;session 令牌照旧能撤', () => {
      const r = makeTokenRegistry()
      r.register('dA', { tier: 'admin', origin: 'device', sessionKey: 'device:a', routeAllow: ROUTES })
      r.register('dB', { tier: 'admin', origin: 'device', sessionKey: 'device:b', routeAllow: ROUTES })
      const s = r.mint('admin', 'claude/x')
      r.invalidateSession('device:a')
      expect(r.resolve('dA')).toBeNull()
      expect(r.resolve('dB')?.sessionKey).toBe('device:b')
      r.invalidateSession('claude/x')
      expect(r.resolve(s)).toBeNull()
    })
    it('listSessions 只列指定 origin', () => {
      const r = makeTokenRegistry()
      r.register('dA', { tier: 'admin', origin: 'device', sessionKey: 'device:a', routeAllow: ROUTES })
      r.register('tL', { tier: 'admin', origin: 'link', sessionKey: 'link', routeAllow: ROUTES })
      r.mint('admin', 'claude/x')
      expect(r.listSessions('device')).toEqual([{ token: 'dA', sessionKey: 'device:a' }])
      expect(r.listSessions('link')).toEqual([{ token: 'tL', sessionKey: 'link' }])
    })
    it('file / operator 令牌不会被任何 invalidateSession 误删', () => {
      const r = makeTokenRegistry()
      r.registerFileToken('ff'.repeat(32)); r.registerOperatorToken('00'.repeat(32))
      r.invalidateSession('link'); r.invalidateSession('')
      expect(r.resolve('ff'.repeat(32))?.origin).toBe('file')
      expect(r.resolve('00'.repeat(32))?.origin).toBe('operator')
    })
  })
})
