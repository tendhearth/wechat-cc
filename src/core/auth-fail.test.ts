import { describe, it, expect } from 'vitest'
import { isAuthFail, isAuthFailError } from './auth-fail'

describe('isAuthFail — two channel profiles', () => {
  it('assistant-text (narrow): error-shape phrases hit, bare env-var name does NOT', () => {
    expect(isAuthFail('assistant-text', 'Please run /login')).toBe(true)
    expect(isAuthFail('assistant-text', 'Not logged in · run /login')).toBe(true)
    expect(isAuthFail('assistant-text', '401 unauthorized')).toBe(true)
    expect(isAuthFail('assistant-text', 'OPENAI_API_KEY not set')).toBe(true)
    // 合法模型输出里引用变量名 —— 决不能命中(agent-provider.ts 原注释的用例)
    expect(isAuthFail('assistant-text', 'what does OPENAI_API_KEY do?')).toBe(false)
    expect(isAuthFail('assistant-text', 'remember: put OPENAI_API_KEY in .env')).toBe(false)
  })

  it('sdk-error (wide): bare OPENAI_API_KEY and auth…expired hit', () => {
    expect(isAuthFail('sdk-error', 'Missing OPENAI_API_KEY environment variable')).toBe(true)
    expect(isAuthFail('sdk-error', 'auth token expired, run codex login')).toBe(true)
    expect(isAuthFail('sdk-error', 'Please run /login')).toBe(true)
    expect(isAuthFail('sdk-error', 'Not logged in')).toBe(true)
    expect(isAuthFail('sdk-error', 'connection reset by peer')).toBe(false)
    expect(isAuthFail('sdk-error', 'expired certificate')).toBe(false)   // 无 auth 前缀不命中
  })

  it('claude-sentinel (dedicated, narrowest): only the two literal binary phrases hit', () => {
    expect(isAuthFail('claude-sentinel', 'Please run /login')).toBe(true)
    expect(isAuthFail('claude-sentinel', 'Not logged in')).toBe(true)
    // 真机探针实测的确定性误判用例:合法正文引用/复述 401 错误 —— 不该命中
    // (assistant-text 宽集会误伤,claude-sentinel 专属窄集必须放行)
    expect(isAuthFail('claude-sentinel', '你这个 curl 返回 401 unauthorized,说明 token 过期了,建议检查一下认证配置。')).toBe(false)
    expect(isAuthFail('claude-sentinel', '401 unauthorized')).toBe(false)
    expect(isAuthFail('claude-sentinel', 'not authenticated')).toBe(false)
  })
})

describe('isAuthFailError — structured (HTTP status) classification', () => {
  it('statusCode: 401 → true regardless of message', () => {
    expect(isAuthFailError({ statusCode: 401, message: 'whatever' })).toBe(true)
  })

  it('status: 401 (alternate field name) → true', () => {
    expect(isAuthFailError({ status: 401 })).toBe(true)
  })

  it('statusCode: 500 → false (not an auth failure)', () => {
    expect(isAuthFailError({ statusCode: 500 })).toBe(false)
  })

  it('falls back to sdk-error message regex when no status field', () => {
    expect(isAuthFailError(new Error('401 unauthorized'))).toBe(true)
    expect(isAuthFailError(new Error('boom'))).toBe(false)
  })
})
