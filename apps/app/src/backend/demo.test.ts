import { describe, it, expect, vi } from 'vitest'
import { Connections, NativeSessionPage, ChatPage, ChatJob, MatterTopic, Matter } from '@wechat-cc/protocol'
import { makeDemoBackend } from './demo'

describe('演示后端', () => {
  it('初始:一条待批准、一个待回答,三件事 + 主人那条对话(chat matter)', async () => {
    const b = makeDemoBackend()
    const ms = await b.matters('en')
    expect(ms.filter(m => m.kind !== 'chat').length).toBe(3)
    expect(ms.filter(m => m.kind === 'chat').map(m => m.id)).toEqual(['c0ffee01'])
    const d = await b.matter('a1b2c3d4', 'en')
    expect(d.permissions.map(p => p.id)).toEqual(['perm-demo-1'])
    expect((await b.insight('a1b2c3d4', 'zh-Hans')).explanations['perm-demo-1']?.source).toBe('model')
    expect((await b.matter('c9d0e1f2', 'en')).questions.length).toBe(1)
  })
  it('允许 ⇒ 立刻推「正在整理」,2 秒后「这一轮已回复」;四个主题都更新', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      const approvals: any[] = [], agents: any[] = [], matter: any[] = [], home: unknown[] = []
      b.subscribe('approvals', d => approvals.push(d)); b.subscribe('agents', d => agents.push(d))
      b.subscribe('matter/a1b2c3d4', d => matter.push(d)); b.subscribe('home', d => home.push(d))
      expect(approvals.length).toBe(1)
      await b.decide({ id: 'a1b2c3d4', runId: (await b.matter('a1b2c3d4', 'en')).runId!, requestId: 'perm-demo-1', decision: 'allow' })
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
    const runId = (await b.matter('a1b2c3d4', 'en')).runId!
    await b.decide({ id: 'a1b2c3d4', runId, requestId: 'perm-demo-1', decision: 'deny' })
    expect((await b.matter('a1b2c3d4', 'en')).task?.phase).toBe('replied')
    await expect(b.decide({ id: 'a1b2c3d4', runId, requestId: 'perm-demo-1', decision: 'allow' })).rejects.toThrow('stale')
  })
  it('回答问题(形状不对 ⇒ 拒绝)⇒ 问题移除、继续整理、2 秒后回复;再答 ⇒ stale', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      const d = await b.matter('c9d0e1f2', 'en')
      const p = { id: 'c9d0e1f2', runId: d.runId!, requestId: d.questions[0]!.id, answers: { depart: ['周一'] } }
      await expect(b.answer({ ...p, answers: { depart: '周一' } as any })).rejects.toThrow('unknown')
      await expect(b.answer({ ...p, answers: { depart: ['周一', '周二'] } })).rejects.toThrow('unknown')
      await b.answer(p)
      const after = await b.matter('c9d0e1f2', 'en')
      expect(after.questions).toEqual([]); expect(after.task?.phase).toBe('working')
      await vi.advanceTimersByTimeAsync(2000)
      expect((await b.matter('c9d0e1f2', 'en')).task?.phase).toBe('replied')
      await expect(b.answer(p)).rejects.toThrow('stale')
    } finally { vi.useRealTimers() }
  })
  it('说一句 ⇒ 用户消息,2 秒后 CC 回复', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      await b.say('e5f6a7b8', 'hi', 'say-1')
      expect((await b.matter('e5f6a7b8', 'en')).events.length).toBe(1)
      // 同一个 requestId 重发(超时后重试)⇒ 不重复记
      await b.say('e5f6a7b8', 'hi', 'say-1')
      expect((await b.matter('e5f6a7b8', 'en')).events.length).toBe(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect((await b.matter('e5f6a7b8', 'en')).events.length).toBe(2)
    } finally { vi.useRealTimers() }
  })
  it('交办 ⇒ 新事项正在整理,稍后回复', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      const { matterId } = await b.create({ requestId: 'req-1', text: '把周报整理一下' })
      expect((await b.matters('en')).filter(m => m.kind !== 'chat').length).toBe(4)
      expect((await b.matter(matterId, 'en')).task?.phase).toBe('working')
      await vi.advanceTimersByTimeAsync(2000)
      expect((await b.matter(matterId, 'en')).task?.phase).toBe('replied')
    } finally { vi.useRealTimers() }
  })
  it('改动:两个文件;reset 恢复初始', async () => {
    const b = makeDemoBackend()
    expect((await b.changes('a1b2c3d4'))?.files.length).toBe(2)
    await b.decide({ id: 'a1b2c3d4', runId: 'x', requestId: 'perm-demo-1', decision: 'deny' })
    b.reset()
    expect((await b.matter('a1b2c3d4', 'en')).permissions.length).toBe(1)
  })
  it('所有返回都符合协议包的 schema', async () => {
    const { MatterDetail, Matter, ApprovalsTopic, AgentsTopic, HomeTopic, MatterTopic, EntryOptions, DeviceRow, PhoneChangesTurn, ApprovalExplanation, ProgressSummary } = await import('@wechat-cc/protocol')
    const b = makeDemoBackend()
    for (const m of await b.matters('en')) expect(() => Matter.parse(m)).not.toThrow()
    { const v = await b.matter('a1b2c3d4', 'en'); expect(() => MatterDetail.parse(v)).not.toThrow() }
    { const v = await b.matter('c9d0e1f2', 'en'); expect(() => MatterDetail.parse(v)).not.toThrow() }
    { const v = await b.matter('e5f6a7b8', 'en'); expect(() => MatterDetail.parse(v)).not.toThrow() }
    const got: Record<string, unknown> = {}
    for (const t of ['approvals', 'agents', 'home', 'matter/a1b2c3d4'] as const) b.subscribe(t, d => { got[t] = d })
    expect(() => ApprovalsTopic.parse(got.approvals)).not.toThrow()
    expect(() => AgentsTopic.parse(got.agents)).not.toThrow()
    expect(() => HomeTopic.parse(got.home)).not.toThrow()
    expect(() => MatterTopic.parse(got['matter/a1b2c3d4'])).not.toThrow()
    { const v = await b.entryOptions('en'); expect(() => EntryOptions.parse(v)).not.toThrow() }
    { const v = await b.changes('a1b2c3d4'); expect(() => PhoneChangesTurn.parse(v)).not.toThrow() }
    for (const d of await b.devices()) expect(() => DeviceRow.parse(d)).not.toThrow()
    const ins = await b.insight('a1b2c3d4', 'en')
    expect(() => ApprovalExplanation.parse(ins.explanations['perm-demo-1'])).not.toThrow()
    expect(() => ProgressSummary.parse(ins.progress)).not.toThrow()
  })
  it('每次读按请求的语言给文案;状态不因语言重建,用户自己的字不变', async () => {
    const b = makeDemoBackend({ lang: 'zh-Hans' })
    const runId = (await b.matter('a1b2c3d4', 'zh-Hans')).runId!
    await b.decide({ id: 'a1b2c3d4', runId, requestId: 'perm-demo-1', decision: 'deny' })
    await b.answer({ id: 'c9d0e1f2', runId: (await b.matter('c9d0e1f2', 'zh-Hans')).runId!, requestId: 'q-demo-1', answers: { depart: ['周一'] } })
    const { matterId } = await b.create({ requestId: 'req-1', text: '我自己的话' })
    const d = await b.matter('a1b2c3d4', 'en')
    expect(d.matter.title).toBe('A better portfolio on mobile')
    expect(d.task?.title).toBe('A better portfolio on mobile')
    expect(d.permissions.length).toBe(0)
    expect(d.events.map(e => e.text)).toEqual(['Reviewed the current homepage', 'Refined the mobile layout', 'Not now'])
    expect((await b.matter('a1b2c3d4', 'zh-Hans')).matter.title).toBe('让作品集在手机上更好看')
    expect((await b.matter('c9d0e1f2', 'en')).questions.length).toBe(0)
    expect((await b.matter('c9d0e1f2', 'en')).events.at(-1)?.text).toBe('Answered: 周一')
    const c = await b.matter(matterId, 'en')
    expect(c.matter.title).toBe('我自己的话')
    expect(c.events[0]?.text).toBe('我自己的话')
    expect(c.events[1]?.text).toBe('Got it, working on it.')
    expect((await b.matters('en')).filter(m => m.kind !== 'chat').length).toBe(4)
  })
  it('未处理的问题按读的语言出题', async () => {
    const b = makeDemoBackend({ lang: 'en' })
    expect((await b.matter('c9d0e1f2', 'zh-Hans')).questions[0]?.questions[0]?.header).toBe('出发时间')
    expect((await b.matter('c9d0e1f2', 'en')).questions[0]?.questions[0]?.header).toBe('Departure')
  })
  it('读的语言变了 ⇒ 主题按新语言补推一次;没变不推', async () => {
    const b = makeDemoBackend({ lang: 'en' })
    const got: any[] = []
    b.subscribe('agents', d => got.push(d))
    await b.matters('en'); await Promise.resolve()
    expect(got).toHaveLength(1)
    await b.matters('zh-Hans'); await Promise.resolve()
    expect(got).toHaveLength(2)
    expect(got.at(-1).tasks.find((t: any) => t.id === 'a1b2c3d4').title).toBe('让作品集在手机上更好看')
  })
  it('同一 requestId 交办两次只建一件', async () => {
    const b = makeDemoBackend()
    const a = await b.create({ requestId: 'same', text: 'x' })
    const c = await b.create({ requestId: 'same', text: 'x' })
    expect(c.matterId).toBe(a.matterId)
    expect((await b.matters('en')).filter(m => m.kind !== 'chat').length).toBe(4)
  })
  it('交办带 projectId ⇒ 事项的项目路径来自演示的项目目录', async () => {
    const b = makeDemoBackend()
    const p = (await b.entryOptions('en')).projects[0]!
    const { matterId } = await b.create({ requestId: 'r', text: 'x', projectId: p.id })
    expect((await b.matter(matterId, 'en')).matter.projectPath).toBe(p.path)
  })
  it('设备:只有「这台手机」;改名生效;setActive / dispose / unpair 不抛', async () => {
    const b = makeDemoBackend()
    expect((await b.devices()).map(d => d.current)).toEqual([true])
    await b.renameDevice('我的手机')
    expect((await b.devices())[0]?.label).toBe('我的手机')
    b.setActive(false); b.setActive(true); await b.unpair(); b.dispose()
  })
  it('按 id 取的读找不到 ⇒ not_found(与真后端 matter_not_found 对齐)', async () => {
    const b = makeDemoBackend()
    await expect(b.matter('ffffffff', 'en')).rejects.toMatchObject({ code: 'not_found' })
    await expect(b.insight('ffffffff', 'en')).rejects.toMatchObject({ code: 'not_found' })
  })
  it('推送:登记是空操作;测试通知回 demo', async () => {
    const b = makeDemoBackend()
    await expect(b.registerPush('apns_sandbox', 'a1'.repeat(32))).resolves.toBeUndefined()
    expect(await b.testPush()).toEqual({ ok: false, code: 'demo' })
  })
  it('演示聊天:说一句 ⇒ pending;2 秒后主题唤醒、历史里多了一问一答;同一 requestId 不重复', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend({ lang: 'zh-Hans' })
      const first = await b.chat({})
      const before = first.messages.length
      expect(before).toBe(4)
      expect(first.messages.map(m => m.source)).toEqual(['wechat', 'wechat', 'desktop', 'phone'])
      const seen: any[] = []
      b.subscribe('matter/c0ffee01', d => seen.push(d))
      expect(seen.at(-1)).toMatchObject({ found: true, kind: 'chat', phase: 'open' })
      expect((await b.chatSay('你好', 'r1')).status).toBe('pending')
      expect(seen.at(-1)).toMatchObject({ phase: 'working' })
      await b.chatSay('你好', 'r1')
      await expect(b.chatSay('再说一句', 'r2')).rejects.toMatchObject({ code: 'busy' })
      expect((await b.chat({})).pending?.requestId).toBe('r1')
      await vi.advanceTimersByTimeAsync(2000)
      const after = await b.chat({})
      expect(after.messages.length).toBe(before + 2)
      expect(after.messages.at(-2)).toMatchObject({ role: 'me', text: '你好', source: 'phone' })
      expect(after.messages.at(-1)!.role).toBe('cc')
      expect(after.pending).toBeNull()
      expect(seen.at(-1)).toMatchObject({ phase: 'open' })
      expect(seen.at(-1).version).toBeGreaterThan(seen[0].version)
      expect((await b.chatSay('你好', 'r1')).status).toBe('replied')
      expect((await b.chat({})).messages.length).toBe(before + 2)
      ChatPage.parse(after)
      expect(() => MatterTopic.parse(seen.at(-1))).not.toThrow()
    } finally { vi.useRealTimers() }
  })
  it('演示聊天:按读的语言给种子文案;reset 回到 4 条、在等的那句作废', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend({ lang: 'zh-Hans' })
      ChatJob.parse(await b.chatSay('hi', 'r1'))
      b.reset()
      await vi.advanceTimersByTimeAsync(2000)
      const zh = await b.chat({})
      expect(zh.messages.length).toBe(4)
      expect(zh.pending).toBeNull()
      expect(zh.title).toBe('和 CC 的对话')
      await b.matters('en')
      expect((await b.chat({})).title).toBe('You & CC')
      expect((await b.chatSay('hi', 'r1')).status).toBe('pending')
    } finally { vi.useRealTimers() }
  })
  it('主人对话也是一件 chat matter:按 id 读得到,过 schema', async () => {
    const { MatterDetail } = await import('@wechat-cc/protocol')
    const b = makeDemoBackend()
    const d = await b.matter('c0ffee01', 'en')
    expect(() => MatterDetail.parse(d)).not.toThrow()
    expect(d.matter.kind).toBe('chat')
    expect(() => Matter.parse(d.matter)).not.toThrow()
  })
  it('演示连接与会话有数据且过 schema', async () => {
    const b = makeDemoBackend()
    const c = Connections.parse(await b.connections())
    expect(c.sources.map(s => [s.id, s.state])).toEqual([['wechat_history', 'ready'], ['knowledge', 'behind'], ['plugin:wxmedia', 'not_loaded'], ['plugin:wxsearch', 'ready']])
    const list = await b.sessions('claude')
    expect(list.items.length).toBe(2)
    expect((await b.sessions('codex')).items.length).toBe(1)
    const page = NativeSessionPage.parse(await b.session(list.items[0]!.key))
    expect(page.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    await expect(b.session('nope')).rejects.toMatchObject({ code: 'not_found' })
  })
})
