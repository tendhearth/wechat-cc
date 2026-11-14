import { describe, expect, it } from 'vitest'
import { renderChatApprovalPrompt } from './chat-approval'

describe('matter_plan 批准卡', () => {
  const brief = '读 notes.md 把三条要点扩成 summary.md，每条写两三句，保留原来的顺序和小标题；写完回读一遍确认三条都在。' + '补充说明'.repeat(30) + '不要修改前两个文件。'
  it('每一棒的要求写全:主人批准的是整句话,不是前半句(第二轮真模型验收,结尾的「不要修改前两个文件」被截成「不要…」)', () => {
    const card = renderChatApprovalPrompt('openai', 'mcp__wechat__matter_plan', { title: '整理书桌', legs: [{ executor: 'claude', brief: '建 notes.md' }, { executor: 'openai', brief }] }, 'r1')
    expect(card).toContain('不要修改前两个文件。')
    expect(card).toContain('第 2 棒 · openai：')
  })
  it('特别长的仍然截断,并且看得出被截了', () => {
    const card = renderChatApprovalPrompt('openai', 'matter_plan', { title: '长', legs: [{ executor: 'claude', brief: '字'.repeat(900) }] }, 'r2')
    expect(card).toContain('…')
    expect(card.length).toBeLessThan(700)
  })
})
