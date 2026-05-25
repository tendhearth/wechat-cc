import { describe, it, expect } from 'vitest'
import { botNameFromModeFallback } from './bot-name'
import { botName } from './bot-name'

describe('botNameFromModeFallback', () => {
  it('solo+claude → cc', () => {
    expect(botNameFromModeFallback({ kind: 'solo', provider: 'claude' })).toBe('cc')
  })

  it('solo+codex → codex', () => {
    expect(botNameFromModeFallback({ kind: 'solo', provider: 'codex' })).toBe('codex')
  })

  it('primary_tool primary=claude → cc', () => {
    expect(botNameFromModeFallback({ kind: 'primary_tool', primary: 'claude' })).toBe('cc')
  })

  it('primary_tool primary=codex → codex', () => {
    expect(botNameFromModeFallback({ kind: 'primary_tool', primary: 'codex' })).toBe('codex')
  })

  it('parallel → cc + codex', () => {
    expect(botNameFromModeFallback({ kind: 'parallel' })).toBe('cc + codex')
  })

  it('chatroom → cc + codex', () => {
    expect(botNameFromModeFallback({ kind: 'chatroom' })).toBe('cc + codex')
  })

  it('unknown provider id passes through (defensive)', () => {
    expect(botNameFromModeFallback({ kind: 'solo', provider: 'gemini' as never })).toBe('gemini')
  })
})

describe('botName (override + fallback)', () => {
  it('cfg.bot_name set → returns it regardless of mode', () => {
    expect(botName({ kind: 'solo', provider: 'claude' }, { bot_name: '小希' })).toBe('小希')
    expect(botName({ kind: 'parallel' }, { bot_name: '小希' })).toBe('小希')
  })

  it('cfg.bot_name null → falls back to mode-derived name', () => {
    expect(botName({ kind: 'solo', provider: 'claude' }, { bot_name: null })).toBe('cc')
    expect(botName({ kind: 'solo', provider: 'codex' }, { bot_name: null })).toBe('codex')
  })

  it('cfg.bot_name undefined → falls back', () => {
    expect(botName({ kind: 'solo', provider: 'claude' }, {})).toBe('cc')
  })

  it('cfg.bot_name empty/whitespace → falls back (treat as unset)', () => {
    expect(botName({ kind: 'solo', provider: 'claude' }, { bot_name: '' })).toBe('cc')
    expect(botName({ kind: 'solo', provider: 'claude' }, { bot_name: '   ' })).toBe('cc')
  })

  it('cfg.bot_name with surrounding whitespace → trimmed', () => {
    expect(botName({ kind: 'solo', provider: 'claude' }, { bot_name: '  小希  ' })).toBe('小希')
  })
})
