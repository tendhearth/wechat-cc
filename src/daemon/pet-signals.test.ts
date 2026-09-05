import { describe, it, expect } from 'vitest'
import { makePetSignals } from './pet-signals'

describe('makePetSignals', () => {
  it('按 chat 记 tool_call / 起飞 / 结束;contact 全局;snapshot 缺省 null', () => {
    let now = 1000
    const s = makePetSignals(() => now)
    expect(s.snapshot('c1')).toEqual({ inFlightSinceMs: null, lastToolCallAtMs: null, lastResultAtMs: null, lastContactMs: null })
    s.noteTurnStart('c1'); now = 1500; s.noteToolCall('c1'); now = 2000; s.noteContact()
    expect(s.snapshot('c1')).toEqual({ inFlightSinceMs: 1000, lastToolCallAtMs: 1500, lastResultAtMs: null, lastContactMs: 2000 })
    now = 2500; s.noteTurnEnd('c1')
    expect(s.snapshot('c1')).toMatchObject({ inFlightSinceMs: null, lastResultAtMs: 2500 })
    expect(s.snapshot('c2')).toMatchObject({ lastToolCallAtMs: null, lastContactMs: 2000 })
  })

  it('显式 nowMs 参数优先于时钟', () => {
    const s = makePetSignals(() => 1)
    s.noteTurnEnd('c', 99); expect(s.snapshot('c').lastResultAtMs).toBe(99)
  })
})
