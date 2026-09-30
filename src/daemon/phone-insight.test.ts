import { describe, it, expect, vi } from 'vitest'
import { makePhoneInsight } from './phone-insight'

const DETAIL = {
  matter: { id: 'ab12cd34', kind: 'task' },
  task: { id: 'ab12cd34', title: '作品集', path: '/Users/me/portfolio', phase: 'working', updatedAt: 100 },
  events: [{ kind: 'text', text: 'hi', createdAt: 5 }],
  permissions: [{ id: 'perm-1', taskId: 'ab12cd34', tool: 'Bash', description: 'npm i sharp', createdAt: 9 }],
}

function setup(detail: unknown = DETAIL) {
  const explain = vi.fn(async (p: { id: string }) => ({ title: `t-${p.id}`, what: 'w', scope: 's', effect: 'e', source: 'model' as const }))
  const summarize = vi.fn(async () => ({ summary: 'ok', steps: [], source: 'model' as const }))
  const ins = makePhoneInsight({ detail: vi.fn(async () => detail), explainer: { explain }, summarizer: { summarize } })
  return { ins, explain, summarize }
}

describe('makePhoneInsight', () => {
  it('任务事项 ⇒ 每条权限一份说明(键是权限 id)+ 进展概括', async () => {
    const { ins, explain, summarize } = setup()
    const r = await ins.forMatter('ab12cd34', 'zh-Hans')
    expect(Object.keys(r.explanations)).toEqual(['perm-1'])
    expect(explain).toHaveBeenCalledWith({ taskId: 'ab12cd34', id: 'perm-1', tool: 'Bash', description: 'npm i sharp', path: '/Users/me/portfolio', lang: 'zh-Hans' })
    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'ab12cd34', versionKey: '100:1:5', title: '作品集', phase: 'working', lang: 'zh-Hans' }))
    expect(r.progress?.summary).toBe('ok')
  })
  it('聊天事项(task 为 null)⇒ 空说明、progress null,不调模型', async () => {
    const { ins, explain, summarize } = setup({ ...DETAIL, task: null, permissions: [] })
    expect(await ins.forMatter('ab12cd34', 'en')).toEqual({ explanations: {}, progress: null })
    expect(explain).not.toHaveBeenCalled()
    expect(summarize).not.toHaveBeenCalled()
  })
  it('detail 抛 matter_not_found ⇒ 原样抛', async () => {
    const ins = makePhoneInsight({ detail: () => { throw new Error('matter_not_found') }, explainer: { explain: vi.fn() }, summarizer: { summarize: vi.fn() } })
    await expect(ins.forMatter('ab12cd34', 'en')).rejects.toThrow('matter_not_found')
  })
})
