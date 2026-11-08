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
  it('willAnnounce:照桌面的判法 —— 上一拍 working、这一拍做完 ⇒ 弹了;最近一拍还在做 ⇒ 下一拍会弹;没见过 working ⇒ 不会', () => {
    let t = 1_000
    const s = makeDesktopSurface(() => t)
    s.notePoll([{ id: 'a', phase: 'working' }, { id: 'b', phase: 'queued' }])
    expect(s.willAnnounce('a')).toBe(true)
    expect(s.willAnnounce('b')).toBe(false)
    t += 3_000
    s.notePoll([{ id: 'a', phase: 'replied' }, { id: 'b', phase: 'replied' }])
    expect(s.willAnnounce('a')).toBe(true)
    expect(s.willAnnounce('b')).toBe(false)
    expect(s.willAnnounce('c')).toBe(false)
    t += DESKTOP_FRESH_MS
    expect(s.willAnnounce('a')).toBe(false)
    s.notePoll(null)   // 老桌面没有 progress:只记来过
    expect(s.appConnected()).toBe(true)
  })
})
