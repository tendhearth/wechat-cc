import { afterEach, expect, it, vi } from 'vitest'
vi.mock('./sessions.js', () => ({ attachmentUrl: vi.fn(), avatarInitial: vi.fn(), avatarInfo: vi.fn() }))
import { initDialoguePage, stopDialogueAutoRefresh } from './dialogue-page.js'

afterEach(() => { stopDialogueAutoRefresh(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('shows a read failure instead of an empty history, then recovers the chat list and timeline', async () => {
  let retry: (() => Promise<void>) | undefined
  const button = {
    disabled: false, textContent: '',
    addEventListener: (_: string, fn: () => Promise<void>) => { retry = fn },
  }
  const stage = { innerHTML: '', hidden: false, querySelector: () => button }
  const root = { dataset: {}, innerHTML: '', querySelector: () => null }
  const switcher = { innerHTML: '', hidden: false }
  const nodes: Record<string, unknown> = { 'dialogue-root': root, 'dialogue-timeline': stage, 'dialogue-chat-switcher': switcher }
  vi.stubGlobal('document', { getElementById: (id: string) => nodes[id] ?? null, querySelector: () => null, querySelectorAll: () => [] })
  vi.stubGlobal('HTMLElement', class {})
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const invoke = vi.fn()
    .mockRejectedValueOnce(new Error('private database disconnected'))
    .mockResolvedValueOnce({ chats: [{ chat_id: 'visual-review', user_name: '我', session_count: 1 }] })
    .mockResolvedValueOnce({ messages: [], hasMore: false })
  initDialoguePage({ invoke })
  await vi.waitFor(() => expect(stage.innerHTML).toContain('暂时没能打开对话记录'))
  expect(stage.innerHTML).not.toContain('private database')
  expect(stage.innerHTML).not.toContain('还没有对话')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(stage.innerHTML).toContain('暂时没能打开对话记录')
  expect(invoke).toHaveBeenCalledTimes(1)
  await retry!()
  expect(invoke.mock.calls.map(call => call[1].args)).toEqual([
    ['sessions', 'list-chats', '--json'],
    ['sessions', 'list-chats', '--json'],
    ['dialogue', 'timeline', '--chat-id', 'visual-review', '--limit', '100', '--json'],
  ])
  expect(stage.innerHTML).toContain('这个对话还没有消息')
})
