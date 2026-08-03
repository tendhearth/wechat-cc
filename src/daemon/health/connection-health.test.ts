import { describe, it, expect } from 'vitest'
import { makeConnectionHealth, SUSPEND_AFTER_MS } from './connection-health'

function at(t: { ms: number }) {
  return makeConnectionHealth({ now: () => t.ms })
}

describe('makeConnectionHealth', () => {
  it('起始是 healthy,不暂停外发', () => {
    const t = { ms: 1000 }
    const h = at(t)
    expect(h.get('wechat').status).toBe('healthy')
    expect(h.shouldSuspend('wechat')).toBe(false)
  })

  it('连续失败满 60 秒才转 degraded —— 短抖动不误伤', () => {
    const t = { ms: 0 }
    const h = at(t)
    h.recordFailure('wechat', new Error('boom'))
    t.ms = SUSPEND_AFTER_MS - 1
    h.recordFailure('wechat', new Error('boom'))
    expect(h.get('wechat').status).toBe('healthy')
    expect(h.shouldSuspend('wechat')).toBe(false)

    t.ms = SUSPEND_AFTER_MS
    h.recordFailure('wechat', new Error('boom'))
    expect(h.get('wechat').status).toBe('degraded')
    expect(h.shouldSuspend('wechat')).toBe(true)
  })

  it('一次成功即清零,时长重新起算', () => {
    const t = { ms: 0 }
    const h = at(t)
    h.recordFailure('wechat', new Error('a'))
    t.ms = 59_000
    h.recordSuccess('wechat')
    expect(h.get('wechat')).toMatchObject({ status: 'healthy', consecutiveFailures: 0, firstFailureAt: null })

    // 之前累计的 59 秒不能带过来
    h.recordFailure('wechat', new Error('b'))
    t.ms = 59_000 + SUSPEND_AFTER_MS - 1
    h.recordFailure('wechat', new Error('b'))
    expect(h.get('wechat').status).toBe('healthy')
  })

  it('两个依赖互不影响', () => {
    const t = { ms: 0 }
    const h = at(t)
    h.recordFailure('llm', new Error('x'))
    t.ms = SUSPEND_AFTER_MS
    h.recordFailure('llm', new Error('x'))
    expect(h.get('llm').status).toBe('degraded')
    expect(h.get('wechat').status).toBe('healthy')
  })

  it('记录连续失败次数与最后错误', () => {
    const t = { ms: 0 }
    const h = at(t)
    h.recordFailure('wechat', new Error('first'))
    h.recordFailure('wechat', new Error('second'))
    expect(h.get('wechat')).toMatchObject({ consecutiveFailures: 2, lastError: 'second' })
  })

  it('非 Error 的抛出物也能记录', () => {
    const t = { ms: 0 }
    const h = at(t)
    h.recordFailure('wechat', 'plain string')
    expect(h.get('wechat').lastError).toBe('plain string')
  })

  it('畸形错误对象也不会让健康机自己抛', () => {
    const t = { ms: 0 }
    const h = at(t)
    const evil = { toString() { throw new Error('nested boom') } }
    expect(() => h.recordFailure('wechat', evil)).not.toThrow()
    expect(typeof h.get('wechat').lastError).toBe('string')
  })
})
