import { describe, it, expect } from 'vitest'
import { makeActivityMarker } from './activity-marker'

describe('makeActivityMarker', () => {
  it('从未 mark 过 ⇒ 静默时长为无穷(刚启动没有对话在进行)', () => {
    const m = makeActivityMarker({ now: () => 1000 })
    expect(m.quietFor(1000)).toBe(Number.POSITIVE_INFINITY)
  })

  it('mark 之后按当前时刻算静默时长', () => {
    const t = { ms: 1000 }
    const m = makeActivityMarker({ now: () => t.ms })
    m.mark()
    expect(m.quietFor(1000)).toBe(0)
    expect(m.quietFor(1500)).toBe(500)
  })

  it('再次 mark 会重置', () => {
    const t = { ms: 1000 }
    const m = makeActivityMarker({ now: () => t.ms })
    m.mark()
    t.ms = 5000
    m.mark()
    expect(m.quietFor(5200)).toBe(200)
  })
})
