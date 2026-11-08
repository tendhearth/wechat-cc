import { describe, it, expect } from 'vitest'
import { latestCCLine } from './now'

const a = (taskId: string, kind: 'permission' | 'question', id: string, summary: string) => ({ taskId, kind, id, summary })
const m = (id: string, title: string) => ({ id, title, kind: 'task', status: 'open', updatedAt: 1 }) as any

describe('latestCCLine', () => {
  it('跳过系统通知(重启 / 终端完成 / 命令回执),打猎与串门照常算', () => {
    expect(latestCCLine(page([msg('1', 'cc', '行程整理好了', 1), msg('2', 'cc', '🔄 wechat-cc daemon 已重启 pid=1', 2), msg('3', 'cc', '🔔 codex 完成了 · x', 3), msg('4', 'cc', '✅ 这个对话切到 Codex', 4)])))
      .toEqual({ id: '1', text: '行程整理好了', at: 1 })
    expect(latestCCLine(page([msg('1', 'cc', '🎯 今日猎物：x', 1)]))?.text).toBe('🎯 今日猎物：x')
    expect(latestCCLine(page([msg('1', 'cc', '🔄 已重启', 1)]))).toBeNull()
  })

  const msg = (id: string, role: 'me' | 'cc', text: string, at: number) => ({ id, role, text, at, source: 'wechat', truncated: false }) as any
  const page = (messages: any[]) => ({ matterId: 'c', title: 'CC', messages, hasMore: false, nextBefore: null, pending: null, failed: null }) as any
  it('取最近一条 CC 说的、非空的话', () => {
    expect(latestCCLine(page([msg('1', 'cc', '早', 1), msg('2', 'me', '在吗', 2), msg('3', 'cc', '行程整理好了', 3), msg('4', 'me', '好', 4)])))
      .toEqual({ id: '3', text: '行程整理好了', at: 3 })
  })
  it('没页 / 空页 / 只有「我」/ CC 的话全是空白 ⇒ null(不画空气泡)', () => {
    expect(latestCCLine(undefined)).toBeNull()
    expect(latestCCLine(page([]))).toBeNull()
    expect(latestCCLine(page([msg('1', 'me', 'hi', 1)]))).toBeNull()
    expect(latestCCLine(page([msg('1', 'cc', '   ', 1)]))).toBeNull()
  })
  it('首页预览保留文字,去掉 Markdown 语法与链接目标;用户消息不作为 CC 预览', () => {
    const raw = '## 已整理\n\n**可以继续**，查看 [资料](/Users/owner/a.md:13)。'
    const p = page([msg('1', 'cc', raw, 1), msg('2', 'me', '**保留原文**', 2)])
    expect(latestCCLine(p)).toEqual({ id: '1', text: '已整理\n\n可以继续，查看 资料。', at: 1 })
    expect(p.messages[0].text).toBe(raw)
  })
})
