import { describe, it, expect, vi } from 'vitest'
import { makePhoneInsight } from './phone-insight'
import { makeApprovalExplainer } from './phone-explain'
import { makeProgressSummarizer } from './phone-progress'

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

  describe('路由截止时间(协议客户端 15 秒无流量就断)', () => {
    const GOOD_EXPLAIN = JSON.stringify({ title: '装组件吗?', what: '安装 sharp。', scope: '作品集项目。', effect: '联网下载软件包。' })
    const GOOD_PROGRESS = JSON.stringify({ summary: '在装依赖', steps: [{ title: '装依赖', detail: 'npm i' }] })
    it('说明/概括超过默认 8 秒 ⇒ 8 秒时用原文返回;底层继续跑完填缓存,下一次拿到模型结果', async () => {
      vi.useFakeTimers()
      try {
        const cheap = vi.fn((prompt: string) => new Promise<string>(res => setTimeout(() => res(prompt.includes('Events:') ? GOOD_PROGRESS : GOOD_EXPLAIN), 20_000)))
        const explainer = makeApprovalExplainer({ cheapEval: () => cheap, budgetMs: () => 30_000, log: () => {} })
        const summarizer = makeProgressSummarizer({ cheapEval: () => cheap, budgetMs: () => 30_000, log: () => {}, now: () => Date.now() })
        const ins = makePhoneInsight({ detail: async () => DETAIL, explainer, summarizer })
        let done = false
        const p = ins.forMatter('ab12cd34', 'zh-Hans').then(r => { done = true; return r })
        await vi.advanceTimersByTimeAsync(7_999)
        expect(done).toBe(false)
        await vi.advanceTimersByTimeAsync(2)
        expect(done).toBe(true)
        const r = await p
        expect(r.explanations['perm-1']!.source).toBe('raw')
        expect(r.progress!.source).toBe('raw')
        await vi.advanceTimersByTimeAsync(20_000)
        const r2 = await ins.forMatter('ab12cd34', 'zh-Hans')
        expect(r2.explanations['perm-1']!.source).toBe('model')
        expect(r2.progress!.source).toBe('model')
        expect(cheap).toHaveBeenCalledTimes(2)
      } finally { vi.useRealTimers() }
    })
    it('deadlineMs 可调;截止后底层迟到的拒绝不会变成未处理拒绝', async () => {
      vi.useFakeTimers()
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      try {
        const explain = vi.fn(() => new Promise<never>((_, rej) => setTimeout(() => rej(new Error('late')), 5_000)))
        const summarize = vi.fn(() => new Promise<never>((_, rej) => setTimeout(() => rej(new Error('late')), 5_000)))
        const ins = makePhoneInsight({ detail: async () => DETAIL, explainer: { explain }, summarizer: { summarize }, deadlineMs: 1_000 })
        const p = ins.forMatter('ab12cd34', 'en')
        await vi.advanceTimersByTimeAsync(1_001)
        const r = await p
        expect(r.explanations['perm-1']!.source).toBe('raw')
        expect(r.progress!.source).toBe('raw')
        await vi.advanceTimersByTimeAsync(5_000)
        for (let i = 0; i < 5; i++) await Promise.resolve()
        expect(unhandled).not.toHaveBeenCalled()
      } finally { process.off('unhandledRejection', unhandled); vi.useRealTimers() }
    })
    it('快的时候不等截止时间', async () => {
      const { ins } = setup()
      const r = await ins.forMatter('ab12cd34', 'en')
      expect(r.explanations['perm-1']!.source).toBe('model')
    })
  })
})
