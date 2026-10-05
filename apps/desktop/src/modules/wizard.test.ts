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
