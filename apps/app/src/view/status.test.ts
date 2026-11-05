import { describe, it, expect } from 'vitest'
import { isMatterArchived, statusOfMatter, statusOf } from './status'

describe('statusOf', () => {
  it('待处理 > 0 ⇒ waiting(压过其他)', () => {
    expect(statusOf({ status: 'running', phase: 'working' }, 1)).toBe('waiting')
    expect(statusOf({ status: 'failed' }, 2)).toBe('waiting')
  })
  it('failed(status 或 phase)⇒ failed', () => {
    expect(statusOf({ status: 'failed' }, 0)).toBe('failed')
    expect(statusOf({ status: 'running', phase: 'failed' }, 0)).toBe('failed')
  })
  it('cancelled / interrupted ⇒ stopped(用词表:停下了)', () => {
    expect(statusOf({ status: 'cancelled' }, 0)).toBe('stopped')
    expect(statusOf({ status: 'interrupted' }, 0)).toBe('stopped')
    expect(statusOf({ status: 'running', phase: 'interrupted' }, 0)).toBe('stopped')
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

describe('M6f new fields with legacy fallback', () => {
  it('uses new state, while task phases and pending decisions keep their priority', () => {
    expect(statusOfMatter({ status: 'open', state: 'done', kind: 'task', archivedAt: null }, null, 0)).toBe('done')
    expect(statusOfMatter({ status: 'done', state: 'working', kind: 'task' }, null, 0)).toBe('working')
    expect(statusOfMatter({ state: 'done', kind: 'act' }, null, 0)).toBe('working')
    expect(statusOfMatter({ state: 'done' }, { status: 'running', phase: 'replied' }, 0)).toBe('replied')
    expect(statusOfMatter({ state: 'done' }, null, 1)).toBe('waiting')
    expect(statusOfMatter({ status: 'replied' }, null, 0)).toBe('replied')
    expect(statusOfMatter({ status: 'archived' }, null, 0)).toBe('done')
  })
  it('explicit archivedAt wins, including zero and null', () => {
    expect(isMatterArchived({ status: 'open', archivedAt: 0 })).toBe(true)
    expect(isMatterArchived({ status: 'archived', archivedAt: null })).toBe(false)
    expect(isMatterArchived({ status: 'archived' })).toBe(true)
    expect(isMatterArchived({ status: 'open' })).toBe(false)
  })
})
