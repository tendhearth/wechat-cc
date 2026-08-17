import { describe, it, expect } from 'vitest'
import { makeTurnEmitter } from './turn-emitter'

describe('makeTurnEmitter', () => {
  it('event constructors produce exact AgentEvent shapes', () => {
    const em = makeTurnEmitter()
    expect(em.init('s1')).toEqual({ kind: 'init', sessionId: 's1' })
    expect(em.text('hi')).toEqual({ kind: 'text', text: 'hi' })
    expect(em.toolCall('reply', 'wechat')).toEqual({ kind: 'tool_call', server: 'wechat', tool: 'reply' })
    expect(em.toolCall('bash')).toEqual({ kind: 'tool_call', tool: 'bash' })   // server 缺省不出现
  })

  it('error(): Error→message, non-Error→String, sdk-error profile stamps auth_failed', () => {
    const em = makeTurnEmitter()
    expect(em.error(new Error('boom'))).toEqual({ kind: 'error', message: 'boom' })
    expect(em.error('raw')).toEqual({ kind: 'error', message: 'raw' })
    expect(em.error(new Error('Missing OPENAI_API_KEY'))).toEqual(
      { kind: 'error', code: 'auth_failed', message: 'Missing OPENAI_API_KEY' })
    expect(em.errorText('401 unauthorized')).toEqual(
      { kind: 'error', code: 'auth_failed', message: '401 unauthorized' })
    expect(em.error(new Error('x'), { code: 'step_budget' })).toEqual(
      { kind: 'error', code: 'step_budget', message: 'x' })
  })

  it('error(): HTTP 401 on the error object stamps auth_failed even with a generic message', () => {
    const em = makeTurnEmitter()
    const err = Object.assign(new Error('No output generated. Check the stream for errors.'), { statusCode: 401 })
    expect(em.error(err)).toEqual(
      { kind: 'error', code: 'auth_failed', message: 'No output generated. Check the stream for errors.' })
  })

  it('finish(): overrides win wholesale; defaults fill only the omitted', () => {
    const em = makeTurnEmitter()
    em.toolCall('a'); em.toolCall('b')
    const r1 = em.finish({ sessionId: 's', numTurns: 7, durationMs: 123 })
    expect(r1).toEqual({ kind: 'result', sessionId: 's', numTurns: 7, durationMs: 123 })  // 权威值不被克扣
    const r2 = em.finish({ sessionId: 's' })
    expect(r2.kind).toBe('result')
    if (r2.kind === 'result') {
      expect(r2.numTurns).toBe(2)              // 缺省 = toolCall 计数
      expect(r2.durationMs).toBeGreaterThanOrEqual(0)
    }
  })
})
