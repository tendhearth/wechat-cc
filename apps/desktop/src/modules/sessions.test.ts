import { describe, expect, it } from 'vitest'
import { avatarInitial, attachmentUrl } from './sessions.js'

describe('attachmentUrl (shared, Tauri-safe)', () => {
  it('falls back to /attachment endpoint when convertFileSrc is unavailable', () => {
    // happy-dom window has no __TAURI__; the dev-shim path is used.
    expect(attachmentUrl('/inbox/a b.png')).toBe('/attachment?path=' + encodeURIComponent('/inbox/a b.png'))
  })
  it('coerces nullish path to an empty query', () => {
    // @ts-expect-error — exercising the defensive String(path||'') coercion
    expect(attachmentUrl(undefined)).toBe('/attachment?path=')
  })
  it('routes through convertFileSrc when Tauri exposes it', () => {
    // This test file runs in a node env (no DOM). attachmentUrl reads the
    // global `window`; define it on globalThis for the duration of the test.
    const g = globalThis as unknown as { window?: unknown }
    const prev = g.window
    g.window = { __TAURI__: { core: { convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}` } } }
    try {
      expect(attachmentUrl('/inbox/x.png')).toBe('asset://localhost/' + encodeURIComponent('/inbox/x.png'))
    } finally {
      if (prev === undefined) delete g.window
      else g.window = prev
    }
  })
})

describe('avatarInitial', () => {
  it('returns uppercased first char for latin names', () => {
    expect(avatarInitial('GSR')).toBe('G')
    expect(avatarInitial('alice')).toBe('A')
  })

  it('returns first char as-is for CJK', () => {
    expect(avatarInitial('张三')).toBe('张')
    expect(avatarInitial('李华')).toBe('李')
  })

  it('falls back to "?" on empty/null/undefined', () => {
    expect(avatarInitial('')).toBe('?')
    expect(avatarInitial(null)).toBe('?')
    expect(avatarInitial(undefined)).toBe('?')
  })

  it('skips leading whitespace', () => {
    expect(avatarInitial('  Bob')).toBe('B')
  })
})
