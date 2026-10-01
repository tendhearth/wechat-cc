import { describe, expect, it } from 'vitest'
import { ACCEPTED_TTL_MS, acceptedSettled, chatBubbles, isOwnerChatMatter, mergeChatPages, olderCursor } from './chat'
import type { ChatMessageT, ChatPageT } from '../backend/types'

const msg = (id: string, at: number, role: 'me' | 'cc' = 'me', text = id, source: ChatMessageT['source'] = 'wechat'): ChatMessageT => ({ id, role, kind: 'text', text, truncated: false, at, source })
const page = (messages: ChatMessageT[], over: Partial<ChatPageT> = {}): ChatPageT => ({ matterId: 'c0ffee01', title: 't', messages, hasMore: false, nextBefore: null, pending: null, failed: null, ...over })

describe('chat 视图', () => {
  it('合并:旧页在前、按时间排、按 id 去重(重拉最新页与旧页重叠)', () => {
    const latest = page([msg('b', 2), msg('c', 3)]), older = [page([msg('a', 1), msg('b', 2)], { nextBefore: 'x', hasMore: true })]
    expect(mergeChatPages(latest, older).map(m => m.id)).toEqual(['a', 'b', 'c'])
    expect(olderCursor(latest, older)).toBe('x')
    expect(olderCursor(page([], { hasMore: true, nextBefore: 'y' }), [])).toBe('y')
    expect(olderCursor(page([], { hasMore: false, nextBefore: null }), [])).toBeNull()
  })
  it('pending ⇒ 我的气泡 + CC 在想', () => {
    const b = chatBubbles([msg('a', 1, 'cc')], { pending: { requestId: 'r', text: '你好', status: 'pending', since: 5 }, failed: null }, null)
    expect(b.slice(-2).map(x => [x.side, x.state, x.text])).toEqual([['me', 'sent', '你好'], ['cc', 'thinking', '']])
  })
  it('failed busy ⇒ 可重试的失败气泡', () => {
    const b = chatBubbles([], { pending: null, failed: { requestId: 'r', text: 'hi', status: 'failed', since: 5, error: 'busy' } }, null)
    expect(b).toEqual([expect.objectContaining({ side: 'me', state: 'failed', failedKind: 'busy', requestId: 'r', text: 'hi' })])
  })
  it('failed 其它原因 ⇒ unavailable', () => {
    const b = chatBubbles([], { pending: null, failed: { requestId: 'r', text: 'hi', status: 'failed', since: 5, error: 'not_configured' } }, null)
    expect(b[0]).toMatchObject({ failedKind: 'unavailable' })
  })
  it('本机收过回执,daemon 却既没 pending 也没历史(重启丢了)⇒ 可能没送到', () => {
    const acc = { requestId: 'r', text: '在吗', at: 1000 }
    expect(chatBubbles([], { pending: null, failed: null }, acc).at(-1)).toMatchObject({ state: 'failed', failedKind: 'maybeLost', requestId: 'r' })
    expect(chatBubbles([msg('x', 1200, 'me', '在吗', 'phone')], { pending: null, failed: null }, acc).filter(x => x.state === 'failed')).toEqual([])
  })
  it('回执对应的还在 pending / 已经 failed ⇒ 不另起「可能没送到」', () => {
    const acc = { requestId: 'r', text: '在吗', at: 1000 }
    expect(chatBubbles([], { pending: { requestId: 'r', text: '在吗', status: 'pending', since: 1000 }, failed: null }, acc).filter(x => x.failedKind === 'maybeLost')).toEqual([])
    expect(chatBubbles([], { pending: null, failed: { requestId: 'r', text: '在吗', status: 'failed', since: 1000, error: 'busy' } }, acc).map(x => x.failedKind)).toEqual(['busy'])
  })
  it('落地的我消息被截断过 ⇒ 按前缀也算落地', () => {
    const acc = { requestId: 'r', text: 'abcdef', at: 1000 }
    const m = { ...msg('x', 1000, 'me', 'abc', 'phone'), truncated: true }
    expect(chatBubbles([m], { pending: null, failed: null }, acc).filter(x => x.state === 'failed')).toEqual([])
  })
  it('acceptedSettled(Ruling 5):看到落地即清;pending/failed 中不清;过了约 2 分钟一律清', () => {
    const acc = { requestId: 'r', text: '在吗', at: 1000 }
    const none = { pending: null, failed: null }
    expect(acceptedSettled(null, [], none, 0)).toBe(true)
    expect(acceptedSettled(acc, [], none, 1000 + 5_000)).toBe(false)
    expect(acceptedSettled(acc, [msg('x', 1100, 'me', '在吗', 'phone')], none, 1100)).toBe(true)
    expect(acceptedSettled(acc, [msg('x', 1100, 'me', '在吗', 'wechat')], none, 1100)).toBe(false)
    expect(acceptedSettled(acc, [], { pending: { requestId: 'r', text: '在吗', status: 'pending', since: 1000 }, failed: null }, 1000 + ACCEPTED_TTL_MS + 1)).toBe(false)
    expect(acceptedSettled(acc, [], none, 1000 + ACCEPTED_TTL_MS + 1)).toBe(true)
  })
  it('只有主人那条对话才算主人对话(Ruling 9)', () => {
    expect(isOwnerChatMatter({ id: 'c0ffee01', kind: 'chat' }, 'c0ffee01')).toBe(true)
    expect(isOwnerChatMatter({ id: 'guest', kind: 'chat' }, 'c0ffee01')).toBe(false)
    expect(isOwnerChatMatter({ id: 'c0ffee01', kind: 'task' }, 'c0ffee01')).toBe(false)
    expect(isOwnerChatMatter({ id: 'c0ffee01', kind: 'chat' }, null)).toBe(false)
  })
})
