import { describe, expect, it } from 'vitest'
import { DESKTOP_FRESH_MS, MAX_SEEN, makeDesktopSurface } from './desktop-surface'

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
  it('桌面读过哪件:某一刻以后读过才算;记多了丢最早的', () => {
    let t = 1_000
    const s = makeDesktopSurface(() => t)
    s.noteSeen('a')
    expect(s.seenSince('a', 1_000)).toBe(true)
    expect(s.seenSince('a', 1_001)).toBe(false)
    expect(s.seenSince('b', 0)).toBe(false)
    for (let i = 0; i < MAX_SEEN; i++) { t++; s.noteSeen(`x${i}`) }
    expect(s.seenSince('a', 0)).toBe(false)
    expect(s.seenSince(`x${MAX_SEEN - 1}`, 0)).toBe(true)
  })
})
