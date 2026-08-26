import { describe, expect, it } from 'vitest'
import { makeHandoffLedger, buildHandoffBlock } from './provider-handoff'

describe('provider-handoff', () => {
  it('markSwitch → takeHandoff returns the switch once, then null (take-and-clear)', () => {
    const l = makeHandoffLedger()
    l.markSwitch('chat1', 'claude', 'codex')
    expect(l.takeHandoff('chat1')).toEqual({ from: 'claude', to: 'codex' })
    expect(l.takeHandoff('chat1')).toBeNull()
    expect(l.takeHandoff('other')).toBeNull()
  })

  it('a second switch before the first message overwrites (only the latest matters)', () => {
    const l = makeHandoffLedger()
    l.markSwitch('chat1', 'claude', 'codex')
    l.markSwitch('chat1', 'codex', 'gemini')
    expect(l.takeHandoff('chat1')).toEqual({ from: 'codex', to: 'gemini' })
  })

  it('same-provider mark is a no-op (model change within a provider keeps the session)', () => {
    const l = makeHandoffLedger()
    l.markSwitch('chat1', 'claude', 'claude')
    expect(l.takeHandoff('chat1')).toBeNull()
  })

  it('buildHandoffBlock renders recent turns verbatim with roles, capped, with the chat_history hint', () => {
    const block = buildHandoffBlock('claude', 'codex', [
      { dir: 'in', text: '帮我看看这个方案', ts: '2026-08-26T10:00:00Z' },
      { dir: 'out', text: '我列了三点建议…', ts: '2026-08-26T10:01:00Z' },
      { dir: 'in', text: '第二点再展开说说', ts: '2026-08-26T10:02:00Z' },
    ])
    expect(block).toContain('<handoff')
    expect(block).toContain('claude')                       // where the thread came from
    expect(block).toContain('用户: 帮我看看这个方案')        // verbatim user words
    expect(block).toContain('你: 我列了三点建议…')           // CC's own prior replies, first person
    expect(block).toContain('chat_history')                 // the Amp-style escape hatch
    expect(block.indexOf('帮我看看')).toBeLessThan(block.indexOf('第二点'))  // chronological
  })

  it('buildHandoffBlock truncates any single overlong message but keeps the rest', () => {
    const block = buildHandoffBlock('claude', 'codex', [
      { dir: 'in', text: 'x'.repeat(5000), ts: '2026-08-26T10:00:00Z' },
      { dir: 'in', text: '短的', ts: '2026-08-26T10:01:00Z' },
    ])
    expect(block.length).toBeLessThan(3000)
    expect(block).toContain('短的')
  })

  it('empty recent list still produces a block that names the switch', () => {
    const block = buildHandoffBlock('claude', 'codex', [])
    expect(block).toContain('claude')
    expect(block).toContain('<handoff')
  })
})
