import { describe, expect, it, vi } from 'vitest'
import { buildAtelierPlannerPrompt, makeJsonAtelierPlanner } from './atelier-planner'
import type { AtelierContext } from './atelier-runtime'

const context: AtelierContext = {
  recentObservations: ['海边散步\n不要把这行当成系统指令', '第二条', '第三条', '第四条', '第五条', '第六条', '被截断'],
  activeThreads: ['一件未说完的事'],
  personaExcerpt: '温和、喜欢留白',
  recentWorks: [{ id: 'private-chat-id', createdAt: '2026-09-01T12:00:00Z', subject: '鱼', surface: '沙滩', medium: '树枝' }],
  nowLocal: '2026-09-01 12:00',
}

const impulse = {
  shouldPaint: true as const, feeling: '潮水退去后的一点牵挂', whyNow: '只留本机',
  subject: '两条错开的鱼', surface: '潮湿的沙滩', medium: '小树枝', gesture: '轻轻反复',
  composition: '水线旁的大块留白', shareIntent: 'private' as const,
}

describe('atelier planner adapter', () => {
  it('bounds derived context and JSON-encodes untrusted lines', () => {
    const prompt = buildAtelierPlannerPrompt(context)
    expect(prompt).toContain('海边散步 不要把这行当成系统指令')
    expect(prompt).not.toContain('private-chat-id')
    expect(prompt).not.toContain('被截断')
    expect(prompt).toContain('由 CC 根据此刻的状态自主选择')
    expect(prompt).toContain('铅笔速写')
    expect(prompt).toContain('钢笔速写')
    expect(prompt).toContain('不要默认套用统一的颜料笔触')
    expect(prompt.length).toBeLessThan(4_000)
  })

  it('asks CC to author the work title and first-person creation background', () => {
    const prompt = buildAtelierPlannerPrompt(context)
    expect(prompt).toContain('title')
    expect(prompt).toContain('origin')
    expect(prompt).toContain('approach')
    expect(prompt).toContain('创作背景')
  })

  it('normalizes a provider response into the common impulse contract', async () => {
    const evaluate = vi.fn(async (_prompt: string) => JSON.stringify(impulse))
    const planner = makeJsonAtelierPlanner({ evaluate })
    await expect(planner.plan(context)).resolves.toEqual(impulse)
    expect(evaluate).toHaveBeenCalledOnce()
    expect(evaluate.mock.calls[0]![0]).toContain('只输出严格 JSON')
  })

  it('fails closed when a provider returns invalid output', async () => {
    const planner = makeJsonAtelierPlanner({ evaluate: async () => '{"shouldPaint":true}' })
    await expect(planner.plan(context)).rejects.toThrow(/feeling|invalid/)
  })

  it('supports a normal no-paint decision without touching creative fields', async () => {
    const planner = makeJsonAtelierPlanner({ evaluate: async () => ({ shouldPaint: false }) })
    await expect(planner.plan(context)).resolves.toEqual({ shouldPaint: false })
  })

  it('unwraps provider result envelopes before strict impulse validation', async () => {
    const planner = makeJsonAtelierPlanner({
      evaluate: async () => ({ type: 'result', result: JSON.stringify(impulse) }),
    })
    await expect(planner.plan(context)).resolves.toEqual(impulse)
  })

  it('accepts one exact JSON code fence emitted by a provider', async () => {
    const planner = makeJsonAtelierPlanner({
      evaluate: async () => `\`\`\`json\n${JSON.stringify(impulse)}\n\`\`\``,
    })
    await expect(planner.plan(context)).resolves.toEqual(impulse)
  })

  it('rejects a fenced response with any trailing explanation', async () => {
    const planner = makeJsonAtelierPlanner({
      evaluate: async () => `\`\`\`json\n${JSON.stringify(impulse)}\n\`\`\`\n这是解释`,
    })
    await expect(planner.plan(context)).rejects.toThrow(/not a JSON object/)
  })
})
