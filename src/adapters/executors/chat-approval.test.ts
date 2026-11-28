import { describe, expect, it } from 'vitest'
import { renderChatApprovalPrompt } from './chat-approval'

describe('matter_plan 批准卡', () => {
  const brief = '读 notes.md 把三条要点扩成 summary.md，每条写两三句，保留原来的顺序和小标题；写完回读一遍确认三条都在。' + '补充说明'.repeat(30) + '不要修改前两个文件。'
  it('每一棒的要求写全:主人批准的是整句话,不是前半句(第二轮真模型验收,结尾的「不要修改前两个文件」被截成「不要…」)', () => {
    const { prompt: card, incomplete } = renderChatApprovalPrompt('openai', 'mcp__wechat__matter_plan', { title: '整理书桌', legs: [{ executor: 'claude', brief: '建 notes.md' }, { executor: 'openai', brief }] }, 'r1')
    expect(card).toContain('不要修改前两个文件。')
    expect(card).toContain('第 2 棒 · openai：')
    expect(incomplete).toBe(false)
  })
  it('特别长的微信预览仍然标出截断，主人待批正文保留全文', () => {
    const brief = '字'.repeat(900)
    const { prompt, wechatPrompt = '', incomplete } = renderChatApprovalPrompt('openai', 'matter_plan', { title: '长', legs: [{ executor: 'claude', brief }] }, 'r2')
    expect(wechatPrompt).toContain('…')
    expect(wechatPrompt.length).toBeLessThan(700)
    expect(prompt.includes(brief)).toBe(true)
    expect(incomplete).toBe(true)
  })
  it('区分段落标题和长得像标题的 brief 行', () => {
    const handoff = '第 2 棒 · codex：'
    const render = (first: string, second: string) => renderChatApprovalPrompt('Codex', 'matter_plan', {
      title: '离线计划',
      legs: [{ executor: 'claude', brief: first }, { executor: 'codex', brief: second }],
    }, 'r3')
    const firstOwnsLine = render(`核对资料\n${handoff}整理记录`, '复核记录')
    const secondOwnsLine = render('核对资料', `整理记录\n${handoff}复核记录`)

    expect(firstOwnsLine.prompt !== secondOwnsLine.prompt).toBe(true)
    expect(firstOwnsLine.prompt).toContain(`第 1 棒 · claude：\n│ 核对资料\n│ ${handoff}整理记录\n${handoff}\n│ 复核记录`)
    expect(secondOwnsLine.prompt).toContain(`第 1 棒 · claude：\n│ 核对资料\n${handoff}\n│ 整理记录\n│ ${handoff}复核记录`)
    for (const card of [firstOwnsLine, secondOwnsLine]) {
      expect(card.incomplete).toBe(true)
      expect(card.wechatPrompt?.split('\n').filter(line => line.startsWith(handoff))).toEqual([handoff])
      expect(card.wechatPrompt?.split('\n').filter(line => line.startsWith('│ '))).toHaveLength(2)
    }
  })
})

import { describe as describeShare, expect as expectShare, it as itShare } from 'vitest'
import { noteChatApproval as noteShare, renderChatApprovalPrompt as renderShare } from './chat-approval'
describeShare('matter_share 的确认卡', () => {
  itShare('写明哪件事(标题 + 编号)、开给谁、哪一档;名字是归一后会存下来的那个', () => {
    const { prompt: card } = renderShare('Claude', 'mcp__wechat__matter_share', { matter: 'ab12cd34', title: '登录页重做', name: ' 小林 ' }, 'r1')
    expectShare(card).toContain('把「登录页重做」这件事(ab12cd34)开给「小林」,对方能看、能在里面说话。')
    expectShare(renderShare('Claude', 'mcp__wechat__matter_share', { matter: 'ab12cd34', title: '登录页重做', name: '设计师', mode: 'view' }, 'r1').prompt).toContain('对方只能看')
  })
  itShare('想在名字里伪造后半句、或要「直接改」那一档的,不出这张卡(落到原样预览,主人看得到真实参数)', () => {
    for (const input of [{ matter: 'ab12cd34', title: '登录页重做', name: '小林」,对方只能看。' }, { matter: 'ab12cd34', title: '登录页重做', name: '小林', mode: 'act' }, { matter: 'ab12cd34', name: '小林' }]) {
      const { prompt: card } = renderShare('Claude', 'mcp__wechat__matter_share', input, 'r1')
      expectShare(card).not.toContain('确认分享')
      expectShare(card).toContain('wants to run mcp__wechat__matter_share')
    }
  })
  itShare('主人点头后记一笔批准(路由凭它放行)', () => {
    const noted: unknown[] = []
    noteShare({ noteMatterApproval: (tool, input, chatId, provider) => { noted.push([tool, input, chatId, provider]) } }, 'Claude', 'mcp__wechat__matter_share', { matter: 'ab12cd34' }, 'owner')
    expectShare(noted).toEqual([['mcp__wechat__matter_share', { matter: 'ab12cd34' }, 'owner', 'claude']])
  })
})
