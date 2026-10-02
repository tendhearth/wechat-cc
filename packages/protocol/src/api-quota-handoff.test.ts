import { describe, it, expect } from 'vitest'
import { MatterDetail, MatterQuotaHandoff, PHONE_API_SCHEMAS } from './index'

describe('额度用完交给另一位的 schema(spec 2026-10-01-tendhearth-continue-sessions §7-3)', () => {
  it('三种状态各自的字段;未知状态 / 缺字段不过', () => {
    expect(MatterQuotaHandoff.safeParse({ state: 'offer', from: 'claude', to: 'codex', kind: 'quota', resetAt: 1 }).success).toBe(true)
    expect(MatterQuotaHandoff.safeParse({ state: 'none', from: 'claude', kind: 'rate_limit', resetAt: 1 }).success).toBe(true)
    expect(MatterQuotaHandoff.safeParse({ state: 'handed', from: 'claude', to: 'codex', matterId: 'deadbeef' }).success).toBe(true)
    expect(MatterQuotaHandoff.safeParse({ state: 'offer', from: 'claude', kind: 'quota', resetAt: 1 }).success).toBe(false)
    expect(MatterQuotaHandoff.safeParse({ state: 'later', from: 'claude' }).success).toBe(false)
  })
  it('MatterDetail 的 quotaHandoff 可有可无', () => {
    const base = { matter: { id: 'deadbeef', kind: 'task', title: 't', projectPath: null, status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1 }, bindings: [], sessions: [], task: null, events: [], permissions: [], questions: [], artifacts: [], inputs: [] }
    expect(MatterDetail.safeParse(base).success).toBe(true)
    expect(MatterDetail.safeParse({ ...base, quotaHandoff: { state: 'none', from: 'codex', kind: 'quota', resetAt: 2 } }).success).toBe(true)
  })
  it('POST /m/api/matter/handoff 登记了;成功与错误回包都过', () => {
    const post = PHONE_API_SCHEMAS['POST /m/api/matter/handoff']!
    expect(post.safeParse({ ok: true, matterId: 'deadbeef', created: true }).success).toBe(true)
    expect(post.safeParse({ ok: false, error: 'quota_handoff_changed' }).success).toBe(true)
    expect(post.safeParse({ ok: true, matterId: 'deadbeef' }).success).toBe(false)
  })
})
