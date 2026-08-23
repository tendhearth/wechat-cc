import { describe, it, expect } from 'vitest'
import { formatInbound, RECALL_BLOCK_MAX } from './prompt-format'

describe('formatInbound', () => {
  it('wraps a plain text message with channel tag', () => {
    const out = formatInbound({
      chatId: 'cid1', userId: 'u1', userName: '小白',
      text: 'hello', msgType: 'text', createTimeMs: 1_000_000,
      accountId: 'acct-a',
    })
    expect(out).toContain('<wechat')
    expect(out).toContain('chat_id="cid1"')
    expect(out).toContain('user="小白"')
    expect(out).toContain('hello')
    expect(out).toContain('</wechat>')
  })

  it('escapes angle brackets inside body but preserves tag', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '<script>alert(1)</script>', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('inlines attachments with local paths', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '看图', msgType: 'image', createTimeMs: 1, accountId: 'a',
      attachments: [{ kind: 'image', path: '/home/u/.claude/channels/wechat/inbox/a/b.jpg' }],
    })
    expect(out).toContain('[image:/home/u/.claude/channels/wechat/inbox/a/b.jpg]')
  })

  it('renders full quoted content as a <quote> element', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '这条', msgType: 'text', createTimeMs: 1, accountId: 'a',
      quote: { type: 'text', text: '明天下午三点的会议改到周四了' },
    })
    expect(out).toContain('<quote type="text">明天下午三点的会议改到周四了</quote>')
    expect(out).not.toContain('quote_to')
  })

  it('escapes quote body and preserves newlines', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '回', msgType: 'text', createTimeMs: 1, accountId: 'a',
      quote: { type: 'text', text: 'a < b & c\nsecond line' },
    })
    expect(out).toContain('<quote type="text">a &lt; b &amp; c\nsecond line</quote>')
  })

  it('omits <quote> entirely when no quote present', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })
    expect(out).not.toContain('<quote')
  })

  it('renders a <recall> element before the body when msg.recall is set', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a',
      recall: ['[2026-08-01 张三] 上次说搬去上海', '[2026-08-02 我] 记得带书'],
    })
    expect(out).toContain('<recall hint="自动检索的相关片段，可能不相关，仅供参考">')
    expect(out).toContain('</recall>')
    expect(out.indexOf('<recall')).toBeLessThan(out.indexOf('hi'))
    expect(out).toContain('上次说搬去上海')
    expect(out).toContain('记得带书')
  })

  it('omits <recall> entirely when recall is absent, empty, or blank-only', () => {
    const base = { chatId: 'c', userId: 'u', userName: 'x', text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a' }
    expect(formatInbound(base)).not.toContain('<recall')
    expect(formatInbound({ ...base, recall: [] })).not.toContain('<recall')
    expect(formatInbound({ ...base, recall: ['  ', ''] })).not.toContain('<recall')
  })

  it('escapes recall body', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a',
      recall: ['a < b & <script>'],
    })
    expect(out).toContain('a &lt; b &amp; &lt;script&gt;')
    expect(out).not.toContain('<script>')
  })

  it('caps the joined recall block at RECALL_BLOCK_MAX chars', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a',
      recall: ['x'.repeat(2000)],
    })
    const start = out.indexOf('仅供参考">\n') + '仅供参考">\n'.length
    const body = out.slice(start, out.indexOf('\n</recall>'))
    expect(body.length).toBeLessThanOrEqual(RECALL_BLOCK_MAX)
  })

  it('emits ts as ISO-8601 UTC (legible to the agent), not raw epoch ms', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: 'hi', msgType: 'text', createTimeMs: 1_000_000, accountId: 'a',
    })
    expect(out).toContain('ts="1970-01-01T00:16:40.000Z"') // new Date(1_000_000).toISOString()
    expect(out).not.toContain('ts="1000000"')
  })
})
