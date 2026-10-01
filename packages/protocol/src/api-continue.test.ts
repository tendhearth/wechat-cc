import { describe, it, expect } from 'vitest'
import { MatterDetail, PHONE_API_SCHEMAS, SESSION_CONTINUE_STATES, SessionContinue, SessionContinueResult } from './index'

describe('接着做电脑会话的 schema(spec 2026-10-01-tendhearth-continue-sessions §4.3)', () => {
  it('预览接受全部八种状态,拒绝未知状态 / 未知执行者', () => {
    for (const state of SESSION_CONTINUE_STATES) expect(SessionContinue.safeParse({ state, provider: 'codex', project: null, mode: null, matterId: null }).success, state).toBe(true)
    expect(SessionContinue.safeParse({ state: 'running', provider: 'claude', project: 'p', mode: null, matterId: null }).success).toBe(false)
    expect(SessionContinue.safeParse({ state: 'ready', provider: 'cursor', project: 'p', mode: 'native_resume', matterId: null }).success).toBe(false)
  })
  it('两条路由都登记了;成功与错误回包都过', () => {
    const get = PHONE_API_SCHEMAS['GET /m/api/session/continue']!, post = PHONE_API_SCHEMAS['POST /m/api/session/continue']!
    expect(get.safeParse({ ok: true, state: 'ready', provider: 'claude', project: 'proj', mode: 'native_resume', matterId: null }).success).toBe(true)
    expect(get.safeParse({ ok: false, error: 'unsupported' }).success).toBe(true)
    expect(post.safeParse({ ok: true, matterId: 'deadbeef', created: false }).success).toBe(true)
    expect(post.safeParse({ ok: false, error: 'native_session_busy' }).success).toBe(true)
    expect(SessionContinueResult.safeParse({ matterId: 'deadbeef' }).success).toBe(false)
  })
  it('MatterDetail:nativeStart 可有可无;有就得是两种模式之一', () => {
    const base = { matter: { id: 'deadbeef', kind: 'task', title: 't', projectPath: null, status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1 }, bindings: [], sessions: [], task: null, events: [], permissions: [], questions: [], artifacts: [], inputs: [] }
    expect(MatterDetail.safeParse(base).success).toBe(true)
    expect(MatterDetail.safeParse({ ...base, nativeStart: { mode: 'fresh_context', providerId: 'claude' } }).success).toBe(true)
    expect(MatterDetail.safeParse({ ...base, nativeStart: { mode: 'resume', providerId: 'claude' } }).success).toBe(false)
  })
})
