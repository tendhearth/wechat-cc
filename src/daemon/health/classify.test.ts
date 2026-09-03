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

// 2026-09-02 采集第一遍就照出的真 bug。六处判定里五处说「这是登录失效」,
// 而**唯一决定要不要通知主人**的这处说 unknown:
//
//   LLM_AUTH_RE = /401|403|unauthorized|forbidden|invalid api key|authentication/i
//
// 它不含 `auth_failed` —— 本仓库自己的规范错误码,assertNotAuthFailed 抛的
// 那个、TurnSummary.errorCode 带的那个。于是 claude 登录真死时,主人收到的是
// 「暂时无法正常工作,恢复后会再通知你」(actionable:false = 一句「你等着」),
// 而真相是「只有你能修,它永远不会自己好」。
describe('classifyFailure —— 必须认识本仓库自己的 auth_failed 码', () => {
  it('auth_failed 码 → llm_auth + actionable(此前是 unknown + 不可操作)', () => {
    const c = classifyFailure(new Error('auth_failed: credentials stale: Not logged in'))
    expect(c.kind).toBe('llm_auth')
    expect(c.actionable).toBe(true)
  })

  it('厂商散文继续认(没有为了新的把旧的弄丢)', () => {
    for (const m of ['401 unauthorized', 'authentication failed', 'invalid api key']) {
      expect(classifyFailure(new Error(m)).kind).toBe('llm_auth')
    }
  })

  it('**歧义让位给瞬时**:agy 那句 authentication failed or timed out 仍判 network', () => {
    // owner 的通则:误报「去重新登录」比多等一轮贵。这条不能因为上面的修复而破。
    expect(classifyFailure(new Error('authentication failed or timed out')).kind).toBe('network')
  })

  it('连 auth_failed 码撞上连接失败也让位给 network(同一条通则)', () => {
    expect(classifyFailure(new Error('auth_failed: connection refused')).kind).toBe('network')
  })
})
