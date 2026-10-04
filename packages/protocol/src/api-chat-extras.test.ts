import { describe, expect, it } from 'vitest'
import { ChatAttachment, ChatMessage, ChatPage, ChatVoice, PHONE_API_SCHEMAS } from './index'

const base = { id: 'app:phone:1:out', role: 'cc' as const, kind: 'text', text: '好了', truncated: false, at: 1, source: 'phone' as const }

describe('跟 CC 说:回复的附件与旁白(2026-10-04)', () => {
  it('老 daemon 不带 attachments / narration:照样过,字段缺省', () => {
    const m = ChatMessage.parse(base)
    expect(m.attachments).toBeUndefined()
    expect(m.narration).toBeUndefined()
  })

  it('三种附件 + 旁白按原样过', () => {
    const m = ChatMessage.parse({
      ...base,
      attachments: [
        { kind: 'voice', text: '晚安' },
        { kind: 'sticker', label: '开心', file: 'a1b2.png' },
        { kind: 'sticker', label: '加油' },
        { kind: 'file', name: 'report.pdf' },
      ],
      narration: ['我先看看日程。'],
    })
    expect(m.attachments).toEqual([
      { kind: 'voice', text: '晚安' },
      { kind: 'sticker', label: '开心', file: 'a1b2.png' },
      { kind: 'sticker', label: '加油' },
      { kind: 'file', name: 'report.pdf' },
    ])
    expect(m.narration).toEqual(['我先看看日程。'])
  })

  it('认不得的附件逐条丢掉,不让整页失败(新 daemon 加了种类)', () => {
    const page = ChatPage.parse({
      matterId: 'm', title: 't', hasMore: false, nextBefore: null, pending: null, failed: null,
      messages: [{ ...base, attachments: [{ kind: 'video', url: 'x' }, { kind: 'voice' }, { kind: 'file', name: 'a.txt' }] }],
    })
    expect(page.messages[0]!.attachments).toEqual([{ kind: 'file', name: 'a.txt' }])
  })

  it('文件附件的线上形状不带路径(多余字段被剥掉)', () => {
    expect(ChatAttachment.parse({ kind: 'file', name: 'a.txt', path: '/Users/x/a.txt' })).toEqual({ kind: 'file', name: 'a.txt' })
  })

  it('GET /m/api/chat/voice 的成功与失败形状都登记了', () => {
    const s = PHONE_API_SCHEMAS['GET /m/api/chat/voice']!
    expect(s.safeParse({ ok: true, mime: 'audio/mpeg', data: 'AAAA' }).success).toBe(true)
    expect(s.safeParse({ ok: false, error: 'too_large' }).success).toBe(true)
    expect(s.safeParse({ ok: true, mime: 'audio/mpeg' }).success).toBe(false)
    expect(ChatVoice.safeParse({ mime: 'audio/wav', data: '' }).success).toBe(true)
  })
})
