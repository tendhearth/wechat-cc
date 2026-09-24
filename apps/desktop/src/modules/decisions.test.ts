import { describe, expect, it } from 'vitest'
import { decisionRow, decisionGlyph, decisionSummary } from './decisions.js'

describe('decisionGlyph', () => {
  it.each(['cron_eval_pushed', 'cron_eval_skipped', 'observation_written', 'milestone', 'cron_eval_failed', 'unknown'])(
    '%s renders a decorative icon beside the event summary', (kind) => {
      expect(decisionGlyph(kind)).toMatch(/^<svg[^>]*aria-hidden="true"/)
    })
})

describe('decisionSummary', () => {
  it('quotes push_text for pushed events', () => {
    expect(decisionSummary({ kind: 'cron_eval_pushed', push_text: 'how are you' })).toBe('主动找你：「how are you」')
  })
  it('describes skip with trigger', () => {
    expect(decisionSummary({ kind: 'cron_eval_skipped', trigger: 'introspect' })).toBe('想了想，决定不打扰')
  })
  it('describes observation_written', () => {
    expect(decisionSummary({ kind: 'observation_written' })).toBe('写下一条新观察')
  })
  it('describes cron_eval_failed with prompt to expand', () => {
    expect(decisionSummary({ kind: 'cron_eval_failed' })).toContain('introspect 出错')
  })
})

describe('decisionRow', () => {
  it('renders glyph + ts (relative) + summary; reasoning in data attr', () => {
    const html = decisionRow({
      id: 'evt_1', ts: new Date().toISOString(), kind: 'cron_eval_skipped',
      trigger: 'introspect', reasoning: 'user在专注',
    })
    expect(html).toContain('<svg ')
    expect(html).toContain('刚刚')
    expect(html).toContain('想了想，决定不打扰')
    expect(html).toContain('data-reasoning="user在专注"')
  })

  it('escapes html in reasoning to prevent xss in attribute', () => {
    const html = decisionRow({
      id: 'evt_x', ts: new Date().toISOString(), kind: 'cron_eval_skipped',
      trigger: 't', reasoning: '<script>alert(1)</script>',
    })
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;')
  })

  it('preserves emoji inside the CC-generated push text', () => {
    expect(decisionRow({ id: 'evt_emoji', ts: new Date().toISOString(), kind: 'cron_eval_pushed', push_text: '庆祝一下 🎉' }))
      .toContain('主动找你：「庆祝一下 🎉」')
  })
})
