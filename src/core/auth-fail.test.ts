import { describe, it, expect } from 'vitest'
import { isAuthFail } from './auth-fail'

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
})
