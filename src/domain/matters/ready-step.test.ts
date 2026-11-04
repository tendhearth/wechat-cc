import { describe, expect, it } from 'vitest'
import { isReadyStep, latestTurnReady, readyStepKey } from './ready-step'

describe('ready 步(M6e)', () => {
  it('认得出:只认 system + ready: 前缀', () => {
    expect(isReadyStep({ kind: 'system', key: readyStepKey('t1') })).toBe(true)
    expect(isReadyStep({ kind: 'system', key: null })).toBe(false)
    expect(isReadyStep({ kind: 'system', key: 'other' })).toBe(false)
    expect(isReadyStep({ kind: 'agent_message', key: readyStepKey('t1') })).toBe(false)
  })
  it('只看 seq 最大的那一轮', () => {
    const items = [{ kind: 'system' as const, key: readyStepKey('a') }]
    expect(latestTurnReady([], items)).toBe(false)
    expect(latestTurnReady([{ id: 'a', seq: 1 }], items)).toBe(true)
    expect(latestTurnReady([{ id: 'b', seq: 2 }, { id: 'a', seq: 1 }], items)).toBe(false)
    expect(latestTurnReady([{ id: 'a', seq: 2 }, { id: 'b', seq: 1 }], items)).toBe(true)
  })
})
