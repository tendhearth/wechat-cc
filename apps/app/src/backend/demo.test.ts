import { describe, it, expect, vi } from 'vitest'
import { makeDemoBackend } from './demo'

describe('演示后端', () => {
  it('初始:一条待批准、一个待回答,三件事', async () => {
    const b = makeDemoBackend()
    expect((await b.matters()).length).toBe(3)
    const d = await b.matter('a1b2c3d4')
    expect(d.permissions.map(p => p.id)).toEqual(['perm-demo-1'])
    expect((await b.insight('a1b2c3d4', 'zh-Hans')).explanations['perm-demo-1']?.source).toBe('model')
    expect((await b.matter('c9d0e1f2')).questions.length).toBe(1)
  })
  it('允许 ⇒ 立刻推「正在整理」,2 秒后「这一轮已回复」;四个主题都更新', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      const approvals: any[] = [], agents: any[] = [], matter: any[] = [], home: unknown[] = []
      b.subscribe('approvals', d => approvals.push(d)); b.subscribe('agents', d => agents.push(d))
      b.subscribe('matter/a1b2c3d4', d => matter.push(d)); b.subscribe('home', d => home.push(d))
      expect(approvals.length).toBe(1)
      await b.decide({ id: 'a1b2c3d4', runId: (await b.matter('a1b2c3d4')).runId!, requestId: 'perm-demo-1', decision: 'allow' })
      expect(approvals.at(-1).some((a: any) => a.id === 'perm-demo-1')).toBe(false)
      expect(agents.at(-1).tasks.find((t: any) => t.id === 'a1b2c3d4').phase).toBe('working')
      await vi.advanceTimersByTimeAsync(2000)
      expect(matter.at(-1).phase).toBe('replied')
      expect(home.length).toBeGreaterThanOrEqual(2)
      expect((await b.insight('a1b2c3d4', 'en')).progress?.steps.length).toBe(3)
    } finally { vi.useRealTimers() }
  })
  it('用已处理的 requestId 再提交 ⇒ stale', async () => {
    const b = makeDemoBackend()
    const runId = (await b.matter('a1b2c3d4')).runId!
    await b.decide({ id: 'a1b2c3d4', runId, requestId: 'perm-demo-1', decision: 'deny' })
    expect((await b.matter('a1b2c3d4')).task?.phase).toBe('replied')
    await expect(b.decide({ id: 'a1b2c3d4', runId, requestId: 'perm-demo-1', decision: 'allow' })).rejects.toThrow('stale')
  })
  it('回答问题(形状不对 ⇒ 拒绝)⇒ 问题移除、继续整理、2 秒后回复;再答 ⇒ stale', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      const d = await b.matter('c9d0e1f2')
      const p = { id: 'c9d0e1f2', runId: d.runId!, requestId: d.questions[0]!.id, answers: { depart: ['周一'] } }
      await expect(b.answer({ ...p, answers: { depart: '周一' } as any })).rejects.toThrow('unknown')
      await expect(b.answer({ ...p, answers: { depart: ['周一', '周二'] } })).rejects.toThrow('unknown')
      await b.answer(p)
      const after = await b.matter('c9d0e1f2')
      expect(after.questions).toEqual([]); expect(after.task?.phase).toBe('working')
      await vi.advanceTimersByTimeAsync(2000)
      expect((await b.matter('c9d0e1f2')).task?.phase).toBe('replied')
      await expect(b.answer(p)).rejects.toThrow('stale')
    } finally { vi.useRealTimers() }
  })
  it('说一句 ⇒ 用户消息,2 秒后 CC 回复', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      await b.say('e5f6a7b8', 'hi')
      expect((await b.matter('e5f6a7b8')).events.length).toBe(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect((await b.matter('e5f6a7b8')).events.length).toBe(2)
    } finally { vi.useRealTimers() }
  })
  it('交办 ⇒ 新事项正在整理,稍后回复', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      const { matterId } = await b.create({ text: '把周报整理一下' })
      expect((await b.matters()).length).toBe(4)
      expect((await b.matter(matterId)).task?.phase).toBe('working')
      await vi.advanceTimersByTimeAsync(2000)
      expect((await b.matter(matterId)).task?.phase).toBe('replied')
    } finally { vi.useRealTimers() }
  })
  it('改动:两个文件;reset 恢复初始', async () => {
    const b = makeDemoBackend()
    expect((await b.changes('a1b2c3d4'))?.files.length).toBe(2)
    await b.decide({ id: 'a1b2c3d4', runId: 'x', requestId: 'perm-demo-1', decision: 'deny' })
    b.reset()
    expect((await b.matter('a1b2c3d4')).permissions.length).toBe(1)
  })
  it('所有返回都符合协议包的 schema', async () => {
    const { MatterDetail, Matter, ApprovalsTopic, AgentsTopic, HomeTopic, MatterTopic, EntryOptions, PhoneChangesTurn, ApprovalExplanation, ProgressSummary } = await import('@wechat-cc/protocol')
    const b = makeDemoBackend()
    for (const m of await b.matters()) expect(() => Matter.parse(m)).not.toThrow()
    { const v = await b.matter('a1b2c3d4'); expect(() => MatterDetail.parse(v)).not.toThrow() }
    { const v = await b.matter('c9d0e1f2'); expect(() => MatterDetail.parse(v)).not.toThrow() }
    { const v = await b.matter('e5f6a7b8'); expect(() => MatterDetail.parse(v)).not.toThrow() }
    const got: Record<string, unknown> = {}
    for (const t of ['approvals', 'agents', 'home', 'matter/a1b2c3d4'] as const) b.subscribe(t, d => { got[t] = d })
    expect(() => ApprovalsTopic.parse(got.approvals)).not.toThrow()
    expect(() => AgentsTopic.parse(got.agents)).not.toThrow()
    expect(() => HomeTopic.parse(got.home)).not.toThrow()
    expect(() => MatterTopic.parse(got['matter/a1b2c3d4'])).not.toThrow()
    { const v = await b.entryOptions(); expect(() => EntryOptions.parse(v)).not.toThrow() }
    { const v = await b.changes('a1b2c3d4'); expect(() => PhoneChangesTurn.parse(v)).not.toThrow() }
    const ins = await b.insight('a1b2c3d4', 'en')
    expect(() => ApprovalExplanation.parse(ins.explanations['perm-demo-1'])).not.toThrow()
    expect(() => ProgressSummary.parse(ins.progress)).not.toThrow()
  })
  it('换语言不重建:已做的决定保留', async () => {
    const b = makeDemoBackend({ lang: 'en' })
    const runId = (await b.matter('a1b2c3d4')).runId!
    await b.decide({ id: 'a1b2c3d4', runId, requestId: 'perm-demo-1', decision: 'deny' })
    b.setLang('zh-Hans')
    expect((await b.matter('a1b2c3d4')).permissions.length).toBe(0)
    expect((await b.matters()).length).toBe(3)
  })
  it('换语言:种子文案换成新语言,状态留着;用户自己的字不变', async () => {
    const b = makeDemoBackend({ lang: 'zh-Hans' })
    const runId = (await b.matter('a1b2c3d4')).runId!
    await b.decide({ id: 'a1b2c3d4', runId, requestId: 'perm-demo-1', decision: 'deny' })
    await b.answer({ id: 'c9d0e1f2', runId: (await b.matter('c9d0e1f2')).runId!, requestId: 'q-demo-1', answers: { depart: ['周一'] } })
    const { matterId } = await b.create({ text: '我自己的话' })
    b.setLang('en')
    const d = await b.matter('a1b2c3d4')
    expect(d.matter.title).toBe('A better portfolio on mobile')
    expect(d.task?.title).toBe('A better portfolio on mobile')
    expect(d.permissions.length).toBe(0)
    expect(d.events.map(e => e.text)).toEqual(['Reviewed the current homepage', 'Refined the mobile layout', 'Not now'])
    expect((await b.matter('c9d0e1f2')).questions.length).toBe(0)
    expect((await b.matter('c9d0e1f2')).events.at(-1)?.text).toBe('Answered: 周一')
    const c = await b.matter(matterId)
    expect(c.matter.title).toBe('我自己的话')
    expect(c.events[0]?.text).toBe('我自己的话')
    expect(c.events[1]?.text).toBe('Got it, working on it.')
  })
  it('语言没变不重推', () => {
    const b = makeDemoBackend({ lang: 'en' })
    let n = 0
    b.subscribe('home', () => n++)
    const before = n
    b.setLang('en')
    expect(n).toBe(before)
  })
})
