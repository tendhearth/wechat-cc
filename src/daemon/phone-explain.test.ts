import { describe, it, expect, vi } from 'vitest'
import { makeApprovalExplainer, rawExplanation } from './phone-explain'

const P = { taskId: 'ab12cd34', id: 'perm-1', tool: 'Bash', description: 'npm i sharp', path: '/Users/me/portfolio', lang: 'zh-Hans' as const }
const GOOD = JSON.stringify({ title: '可以安装图片处理组件吗?', what: '安装 sharp 图片处理组件。', scope: '作品集项目的依赖文件。', effect: '联网下载软件包,可能运行安装脚本,并更新项目的依赖记录。' })

function explainer(reply: string | Error | (() => Promise<string>), budget = 5000) {
  const cheap = vi.fn(async (_p: string) => { if (reply instanceof Error) throw reply; if (typeof reply === 'function') return reply(); return reply })
  const log = vi.fn()
  return { e: makeApprovalExplainer({ cheapEval: () => cheap, budgetMs: () => budget, log }), cheap, log }
}

describe('批准说明', () => {
  it('模型给出合格 JSON ⇒ source model,字段原样', async () => {
    const { e } = explainer(GOOD)
    expect(await e.explain(P)).toEqual({ title: '可以安装图片处理组件吗?', what: '安装 sharp 图片处理组件。', scope: '作品集项目的依赖文件。', effect: '联网下载软件包,可能运行安装脚本,并更新项目的依赖记录。', source: 'model' })
  })
  it('提示词里带着工具、描述、目录与语言要求,并明令不做安全判断', async () => {
    const { e, cheap } = explainer(GOOD)
    await e.explain(P)
    const prompt = cheap.mock.calls[0]![0]
    expect(prompt).toContain('npm i sharp')
    expect(prompt).toContain('/Users/me/portfolio')
    expect(prompt).toContain('简体中文')
    expect(prompt).toMatch(/不要.*(安全|建议)/)
  })
  it('英文请求 ⇒ 提示词要求英文', async () => {
    const { e, cheap } = explainer(GOOD)
    await e.explain({ ...P, lang: 'en', id: 'perm-en' })
    expect(cheap.mock.calls[0]![0]).toContain('English')
  })
  it('没有便宜模型 / 抛错 / 超时 / 坏 JSON / 缺字段 / 含判断词 ⇒ 回退原文', async () => {
    const raw = rawExplanation(P)
    expect(raw.source).toBe('raw')
    expect(raw.what).toContain('npm i sharp')
    expect(raw.scope).toBe('/Users/me/portfolio')
    const none = makeApprovalExplainer({ cheapEval: () => null, budgetMs: () => 5000, log: () => {} })
    expect(await none.explain(P)).toEqual(raw)
    expect(await explainer(new Error('boom')).e.explain(P)).toEqual(raw)
    expect(await explainer('not json').e.explain(P)).toEqual(raw)
    expect(await explainer(JSON.stringify({ title: 'x' })).e.explain(P)).toEqual(raw)
    expect(await explainer(JSON.stringify({ title: '可以吗?', what: '这很安全,建议允许', scope: 's', effect: 'e' })).e.explain(P)).toEqual(raw)
    vi.useFakeTimers()
    try {
      const { e } = explainer(() => new Promise(() => {}), 1000)
      const p = e.explain({ ...P, id: 'perm-slow' })
      await vi.advanceTimersByTimeAsync(1001)
      expect(await p).toEqual(rawExplanation({ ...P, id: 'perm-slow' }))
    } finally { vi.useRealTimers() }
  })
  it('字段过长 ⇒ 截断(标题 ≤ 80、其余 ≤ 200 个字)', async () => {
    const { e } = explainer(JSON.stringify({ title: '长'.repeat(200), what: 'w'.repeat(500), scope: 's', effect: 'e' }))
    const r = await e.explain(P)
    expect([...r.title].length).toBeLessThanOrEqual(80)
    expect([...r.what].length).toBeLessThanOrEqual(200)
  })
  it('同一键:缓存 + 在飞复用(并发两次只调一次模型)', async () => {
    let release!: (s: string) => void
    const { e, cheap } = explainer(() => new Promise<string>(r => { release = r }))
    const a = e.explain(P), b = e.explain(P)
    release(GOOD)
    expect(await a).toEqual(await b)
    await e.explain(P)
    expect(cheap).toHaveBeenCalledTimes(1)
  })
  it('回退结果不缓存(下次还会再试模型)', async () => {
    const cheap = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(GOOD)
    const e = makeApprovalExplainer({ cheapEval: () => cheap, budgetMs: () => 5000, log: () => {} })
    expect((await e.explain(P)).source).toBe('raw')
    expect((await e.explain(P)).source).toBe('model')
  })
  it('缓存有上限(最老的先淘汰)', async () => {
    const { cheap } = explainer(GOOD)
    const e = makeApprovalExplainer({ cheapEval: () => cheap, budgetMs: () => 5000, log: () => {}, maxCache: 2 })
    await e.explain({ ...P, id: 'a' }); await e.explain({ ...P, id: 'b' }); await e.explain({ ...P, id: 'c' })
    await e.explain({ ...P, id: 'a' })
    expect(cheap).toHaveBeenCalledTimes(4)
  })
})
