import { describe, expect, it } from 'vitest'
import { DESKTOP_FRESH_MS, makeDesktopSurface } from './desktop-surface'

describe('desktop-surface(S3b)', () => {
  it('没来拉过 ⇒ 没开;拉过 ⇒ 开着,过了新鲜期 ⇒ 没开', () => {
    let t = 1_000_000
    const s = makeDesktopSurface(() => t)
    expect(s.appConnected()).toBe(false)
    s.notePoll()
    expect(s.appConnected()).toBe(true)
    t += DESKTOP_FRESH_MS
    expect(s.appConnected()).toBe(false)
  })
})
