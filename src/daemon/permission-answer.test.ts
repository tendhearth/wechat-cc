import { describe, expect, it } from 'vitest'
import { resolveTaskReference } from '../features/workbench/task-reference'
import { makePermissionAnswer } from './permission-answer'

describe('makePermissionAnswer — the one consumer of a WeChat answer to a pending card', () => {
  it('keeps ordinary quotes and summarizes marked quotes even if the decision handler throws', () => {
    const logs: string[] = []
    const consume = makePermissionAnswer({
      ilink: { handlePermissionReply: text => { if (text === 'y') throw Error('test decision failure'); return false } },
      log: (_tag, line) => logs.push(line),
    })
    const ordinary = { text: 'ordinary quote' }
    const msg = { chatId: 'owner', text: 'follow-up', quote: ordinary }
    expect(consume(msg)).toBe(false)
    expect(msg.quote).toBe(ordinary)
    const marked = { chatId: 'owner', text: 'y', quote: { text: 'Fixture\n〔请求 1234567890abcdef〕\nprivate fixture' } }
    expect(() => consume(marked)).toThrow('test decision failure')
    expect(marked.quote.text).toBe('（引用了一张待批卡 · 〔请求 1234567890abcdef〕）')
    expect(logs).toEqual([])
  })

  it.each([
    '待批 / Approval · Fixture · abcdef12',
    'Fixture · abcdef12\nprivate fixture\n回「n 08」拒绝。',
    'Fixture · abcdef12\n〔请求 损坏〕\n〔命令开始〕\n│ private fixture',
    '任务 abcdef12\n回「y 08」允许这一步、「n 08」拒绝。',
    '〔命令开始〕\n│ private fixture\n〔命令结束〕',
    '│ private fixture',
    'Fixture · abcdef12\nprivate fixture\n 〔请求 1234567890abcdef〕 ',
    'other text\n〔请求 1234567890abcdef〕\nprivate fixture\n〔请求 0123456789abcdef〕',
  ])('uses the generic summary for an unbound card fragment', quoted => {
    const consume = makePermissionAnswer({
      ilink: { handlePermissionReply: (_text, _chat, input) => {
        expect(input === quoted).toBe(true)
        return false
      } },
      log: () => {},
    })
    const msg = { chatId: 'owner', text: 'follow-up', quote: { text: quoted } }
    expect(consume(msg)).toBe(false)
    expect(msg.quote.text).toBe(quoted.split('\n')[0]?.endsWith('abcdef12') ? '（引用了一张待批卡 · abcdef12）' : '（引用了一张待批卡）')
  })

  it.each([
    ['Fixture · abcdef12', '看看', false],
    ['Fixture · abcdef12\ncodex · 等待权限处理\n查看：任务 abcdef12 权限 246c6247-a81c-4fc8-b37b-c2af4872128f', '看看', false],
    ['Fixture · abcdef12\n〔请求 1234567890abcdef〕\n〔命令开始〕\n│ private fixture\n〔命令结束〕', '也把测试补上', true],
    ['Fixture · abcdef12\n〔请求 1234567890abcdef〕', '看看', true],
  ])('routes the follow-up to the quoted task even with another task in focus', async (quote, text, summarized) => {
    const consume = makePermissionAnswer({ ilink: { handlePermissionReply: () => false }, log: () => {} })
    const msg = { chatId: 'owner', text, quote: { text: quote } }
    expect(consume(msg)).toBe(false)
    expect(msg.quote.text).toBe(summarized ? '（引用了一张待批卡 · abcdef12 · 〔请求 1234567890abcdef〕）' : quote)
    const candidates = ['abcdef12', '01234567'].map(id => ({
      id, title: 'Fixture', project: 'demo', path: '/demo', providerId: 'codex', phase: 'running' as const, updatedAt: 0,
    }))
    await expect(resolveTaskReference({
      text, quotedText: msg.quote.text, candidates, focus: { taskId: '01234567', expiresAt: 20 }, nowMs: 10,
    })).resolves.toEqual({ kind: 'task', taskId: 'abcdef12', via: 'quote' })
  })

  it('consumed ⇒ true + one audit line; not consumed (not an answer, or the pending is gone) ⇒ false, no line', () => {
    const lines: string[] = []
    const calls: unknown[][] = []
    let pending = true
    const consume = makePermissionAnswer({
      ilink: { handlePermissionReply: (text, from, quoted) => { calls.push([text, from, quoted]); if (text !== 'y' || !pending) return false; pending = false; return true } },
      log: (t, l) => lines.push(`${t} ${l}`),
    })
    expect(consume({ chatId: 'owner', text: 'y', quote: { text: '卡片' } })).toBe(true)
    expect(calls[0]).toEqual(['y', 'owner', '卡片'])
    expect(lines).toEqual(['PERMISSION consumed reply from chat=owner'])
    expect(consume({ chatId: 'owner', text: 'y' })).toBe(false)   // 已经没有待批了(桌面拍过 / 过期)
    expect(consume({ chatId: 'owner' })).toBe(false)
    expect(calls[2]).toEqual(['', 'owner', undefined]) // 没有文字(图片 / 语音)⇒ 按空串问,不编一句出来
    expect(lines).toHaveLength(1)
  })
})
