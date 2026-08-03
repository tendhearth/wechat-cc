import { describe, it, expect } from 'vitest'
import { classifyFailure } from './classify'

describe('classifyFailure', () => {
  it('被接管 → 可操作(要主人去扫码)', () => {
    const c = classifyFailure(new Error('ilink/getupdates errcode=-14: session replaced'))
    expect(c).toMatchObject({ kind: 'login_taken_over', actionable: true })
    expect(c.body).toMatch(/扫码|重新绑定/)
  })

  it('LLM 认证失败 → 可操作', () => {
    expect(classifyFailure(new Error('HTTP 401 Unauthorized'))).toMatchObject({ kind: 'llm_auth', actionable: true })
    expect(classifyFailure(new Error('403 forbidden: invalid api key'))).toMatchObject({ kind: 'llm_auth', actionable: true })
  })

  it('网络/TLS/超时 → 不可操作(等它自愈)', () => {
    for (const msg of [
      'unknown certificate verification error',
      'Unable to connect. Is the computer able to access the url?',
      'The operation timed out.',
      'getaddrinfo ENOTFOUND api.example.com',
      'ECONNRESET',
    ]) {
      expect(classifyFailure(new Error(msg)), msg).toMatchObject({ kind: 'network', actionable: false })
    }
  })

  it('认不出来的一律当不可操作 —— 不要用猜测去打扰主人', () => {
    expect(classifyFailure(new Error('something weird'))).toMatchObject({ kind: 'unknown', actionable: false })
  })

  it('非 Error 也能分类,不抛', () => {
    expect(() => classifyFailure(undefined)).not.toThrow()
    expect(classifyFailure(undefined).kind).toBe('unknown')
  })

  it('文案里不出现原始错误码 —— 给主人看的是结论', () => {
    const c = classifyFailure(new Error('unknown certificate verification error'))
    expect(c.title + c.body).not.toMatch(/certificate|errcode|ECONN/i)
  })

  it('任何输入都不抛,含 Symbol 与畸形对象', () => {
    expect(() => classifyFailure(Symbol('x'))).not.toThrow()
    expect(() => classifyFailure({ toString() { throw new Error('boom') } })).not.toThrow()
    expect(() => classifyFailure(null)).not.toThrow()
    expect(classifyFailure(Symbol('x')).kind).toBe('unknown')
  })

  it('同时命中网络与认证时,取更保守的一侧', () => {
    // 判不准就别打扰:可操作 = 3 分钟通知 + 每 6 小时重复提醒,
    // 对一个会自愈的网络抖动来说是反复骚扰。
    const c = classifyFailure(new Error('HTTP 403 Forbidden: certificate verification failed'))
    expect(c).toMatchObject({ kind: 'network', actionable: false })
  })

  it('纯认证错误仍然是可操作的', () => {
    expect(classifyFailure(new Error('401 Unauthorized'))).toMatchObject({ kind: 'llm_auth', actionable: true })
  })
})
