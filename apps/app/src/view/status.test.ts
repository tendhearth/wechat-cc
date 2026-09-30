import { describe, it, expect } from 'vitest'
import { statusOf } from './status'

describe('statusOf', () => {
  it('待处理 > 0 ⇒ waiting(压过其他)', () => {
    expect(statusOf({ status: 'running', phase: 'working' }, 1)).toBe('waiting')
    expect(statusOf({ status: 'failed' }, 2)).toBe('waiting')
  })
  it('failed / interrupted(status 或 phase)⇒ failed', () => {
    expect(statusOf({ status: 'failed' }, 0)).toBe('failed')
    expect(statusOf({ status: 'running', phase: 'failed' }, 0)).toBe('failed')
    expect(statusOf({ status: 'interrupted' }, 0)).toBe('failed')
    expect(statusOf({ status: 'running', phase: 'interrupted' }, 0)).toBe('failed')
  })
  it('cancelled ⇒ stopped', () => {
    expect(statusOf({ status: 'cancelled' }, 0)).toBe('stopped')
  })
  it('phase replied ⇒ replied(即使 completed)', () => {
    expect(statusOf({ status: 'running', phase: 'replied' }, 0)).toBe('replied')
    expect(statusOf({ status: 'completed', phase: 'replied' }, 0)).toBe('replied')
  })
  it('completed ⇒ done', () => {
    expect(statusOf({ status: 'completed' }, 0)).toBe('done')
    expect(statusOf({ status: 'completed', phase: 'working' }, 0)).toBe('done')
  })
  it('其余 ⇒ working', () => {
    expect(statusOf({ status: 'running', phase: 'working' }, 0)).toBe('working')
    expect(statusOf({ status: 'running' }, 0)).toBe('working')
  })
})
