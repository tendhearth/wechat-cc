import { expect, it, vi } from 'vitest'
import { initDialoguePage, stopDialogueAutoRefresh } from './dialogue-page.js'

it('shows recovery instead of an empty conversation when listing chats fails', async () => {
  let retry: () => Promise<void> = async () => {}
  const button = { disabled: false, addEventListener: (_: string, fn: typeof retry) => { retry = fn } }
  const stage = { innerHTML: '', hidden: false, querySelector: () => button }
  const root = { dataset: { ready: 'true' } }
  vi.stubGlobal('document', {
    getElementById: (id: string) => id === 'dialogue-root' ? root : id === 'dialogue-timeline' ? stage : null,
    querySelectorAll: () => [],
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const invoke = vi.fn().mockRejectedValueOnce(new Error('internal socket path')).mockResolvedValue({ chats: [] })
  try {
    await initDialoguePage({ invoke })
    expect(stage.innerHTML).toContain('暂时无法读取会话')
    expect(stage.innerHTML).toContain('重新加载')
    expect(stage.innerHTML).not.toContain('还没有对话')
    expect(stage.innerHTML).not.toContain('internal socket')
    await retry()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(stage.innerHTML).toContain('还没有对话')
    expect(stage.innerHTML).not.toContain('重新加载')
  } finally { stopDialogueAutoRefresh(); vi.unstubAllGlobals(); log.mockRestore() }
})
