import { describe, it, expect } from 'vitest'
import { doctorHeadline } from './wizard.js'

describe('doctorHeadline', () => {
  it('nothing linked -> still missing', () => {
    expect(doctorHeadline({ checks: { claude: { ok: false }, codex: { ok: false } } }).ready).toBe(false)
  })
  it('either linked -> ready, and the copy no longer says "没检测到"', () => {
    for (const checks of [{ claude: { ok: true }, codex: { ok: false } }, { claude: { ok: false }, codex: { ok: true } }, { claude: { ok: true }, codex: { ok: true } }]) {
      const h = doctorHeadline({ checks })
      expect(h.ready).toBe(true)
      expect(h.title + h.note).not.toMatch(/还没检测到|还差一步/)
    }
  })
  it('recognizes an already configured API service or Cursor without requiring Claude or Codex',()=>{
    for(const checks of [{provider:{ok:true,provider:'openai'}},{cursor:{ok:true}},{gemini:{ok:true}}])expect(doctorHeadline({checks}).ready).toBe(true)
  })
})

describe('doctorHeadline — installed but not logged in (2026-10-13)', () => {
  it('still lets the owner continue, but says what is missing and the one command', () => {
    const h = doctorHeadline({ checks: { claude: { ok: true, loggedIn: false }, codex: { ok: false } } })
    expect(h.ready).toBe(true)
    expect(h.title).toBe('装好了，还差登录')
    expect(h.note).toContain('「claude」')
    expect(h.note).toContain('重新检测')
  })
  it('says nothing when another usable AI is logged in, or when login is unknown', () => {
    expect(doctorHeadline({ checks: { claude: { ok: true, loggedIn: false }, codex: { ok: true, loggedIn: true } } }).title).toBe('已经能见面了')
    expect(doctorHeadline({ checks: { claude: { ok: true, loggedIn: null } } }).title).toBe('已经能见面了')
    expect(doctorHeadline({ checks: { claude: { ok: true } } }).title).toBe('已经能见面了')
    expect(doctorHeadline({ checks: { codex: { ok: true, loggedIn: false }, cursor: { ok: true } } }).title).toBe('已经能见面了')
  })
})
