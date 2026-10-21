import { describe, it, expect, vi } from 'vitest'
import { FeedEvent, Connections, NativeSessionPage, ChatPage, ChatJob, MatterTopic, Matter, MatterDetail, SessionContinue, PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import { DEMO_CHAT_REPLY_MS, makeDemoBackend } from './demo'

describe('演示后端', () => {
  it('初始:一条待批准、一个待回答,四件事(含一件额度用完) + 主人那条对话(chat matter)', async () => {
    const b = makeDemoBackend()
    const ms = await b.matters('en')
    expect(ms.filter(m => m.kind !== 'chat').length).toBe(4)
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
      // 起点不写死:演示里这件事带着最初那句要求(独立工作区「另做一份」要用)
      const base = (await b.matter('e5f6a7b8', 'en')).events.length
      await b.say('e5f6a7b8', 'hi', 'say-1')
      expect((await b.matter('e5f6a7b8', 'en')).events.length).toBe(base + 1)
      // 同一个 requestId 重发(超时后重试)⇒ 不重复记
      await b.say('e5f6a7b8', 'hi', 'say-1')
      expect((await b.matter('e5f6a7b8', 'en')).events.length).toBe(base + 1)
      await vi.advanceTimersByTimeAsync(2000)
      expect((await b.matter('e5f6a7b8', 'en')).events.length).toBe(base + 2)
    } finally { vi.useRealTimers() }
  })
  it('演示独立工作区:合回 / 删除 / 重开会翻任务页上的状态(2026-10-08)', async () => {
    const b = makeDemoBackend()
    expect((await b.matter('e5f6a7b8', 'en')).task?.worktree).toMatchObject({ branch: 'cc/notes001', removed: false, projectId: 'portfolio' })
    expect((await b.matter('e5f6a7b8', 'en')).task?.until).toMatchObject({ command: 'bun run test', status: 'passed', rounds: 2, maxRounds: 3 })
    await b.worktree({ id: 'e5f6a7b8', action: 'merge' })
    expect((await b.matter('e5f6a7b8', 'en')).task?.worktree?.merged).toBe(true)
    await b.worktree({ id: 'e5f6a7b8', action: 'remove' })
    expect((await b.matter('e5f6a7b8', 'en')).task?.worktree?.removed).toBe(true)
    await b.worktree({ id: 'e5f6a7b8', action: 'reopen' })
    expect((await b.matter('e5f6a7b8', 'en')).task?.worktree?.removed).toBe(false)
    // 工作区脚本(2026-10-20):演示里运行 / 停下只翻状态
    expect((await b.worktreeScript({ id: 'e5f6a7b8', action: 'run' })).run).toBe('running')
    expect((await b.matter('e5f6a7b8', 'en')).task?.worktree).toMatchObject({ run: 'running', approved: true, port: 47100 })
    expect((await b.worktreeScript({ id: 'e5f6a7b8', action: 'stop' })).run).toBe('idle')
  })
  it('演示会话按标题/项目过滤,读取明确反映recent/start并限制近期20条', async () => {
    const b = makeDemoBackend()
    const all = await b.sessions('claude')
    const row = all.items[0]!
    expect((await b.sessions('claude', undefined, row.title)).items.map(item => item.key)).toContain(row.key)
    expect((await b.sessions('claude', undefined, 'definitely-no-match')).items).toEqual([])
    const recent = await b.session(row.key, undefined, 'recent')
    expect(recent.window).toBe('recent'); expect(recent.nextCursor).toBeNull(); expect(recent.messages.length).toBeLessThanOrEqual(20)
    expect((await b.session(row.key)).window).toBe('start')
    await expect(b.sessions('claude', undefined, 'x'.repeat(201))).rejects.toMatchObject({ code: 'invalid' })
  })
  it('交办 ⇒ 新事项正在整理,稍后回复', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      const { matterId } = await b.create({ requestId: 'req-1', text: '把周报整理一下' })
      expect((await b.matters('en')).filter(m => m.kind !== 'chat').length).toBe(5)
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
  it('撤掉这一轮(回退切片 4):作品集那件能撤;预览过协议;token 不对 ⇒ rewind_stale;撤了之后改动面板空了、时间线多一句;reset 还原', async () => {
    const { PHONE_API_SCHEMAS } = await import('@wechat-cc/protocol')
    const b = makeDemoBackend()
    const turn = (await b.changes('a1b2c3d4'))!
    expect(turn.rewindable).toBe(true)
    const p = await b.rewindPreview({ id: 'a1b2c3d4', artifactId: turn.artifactId! })
    PHONE_API_SCHEMAS['GET /m/api/matter/rewind']!.parse({ ok: true, preview: p })
    expect(p.files.count).toBe(2)
    await expect(b.rewind({ id: 'a1b2c3d4', artifactId: turn.artifactId!, token: '0'.repeat(64) })).rejects.toMatchObject({ code: 'rewind_stale' })
    await b.rewind({ id: 'a1b2c3d4', artifactId: turn.artifactId!, token: p.token })
    expect(await b.changes('a1b2c3d4')).toBeNull()
    expect((await b.matter('a1b2c3d4', 'zh-Hans')).events.at(-1)?.text).toContain('round 1 was undone')
    await expect(b.rewindPreview({ id: 'a1b2c3d4', artifactId: turn.artifactId! })).rejects.toMatchObject({ code: 'rewind_stale' })
    b.reset()
    expect((await b.changes('a1b2c3d4'))?.rewindable).toBe(true)
  })
  it('行评论(切片 4):每个文件一块、块对得上;存草稿幂等、同 id 不同内容 ⇒ comment_conflict;发出之后标已发出、删不了;reset 清掉', async () => {
    const { PhoneChangesTurn } = await import('@wechat-cc/protocol')
    const { fileHunks } = await import('../view/review-comments')
    const b = makeDemoBackend()
    const turn = (await b.changes('a1b2c3d4'))!
    const f = turn.files[0]!
    const piece = fileHunks(f)![0]!
    const p = { id: 'a1b2c3d4', commentId: '11111111-1111-4111-8111-111111111111', artifactId: turn.artifactId!, path: f.path, hunk: 0, hunkSha256: piece.sha256, body: '留白再多一点' }
    await b.reviewComment(p); await b.reviewComment(p)
    await expect(b.reviewComment({ ...p, body: '别的' })).rejects.toMatchObject({ code: 'comment_conflict' })
    await expect(b.reviewComment({ ...p, commentId: '22222222-2222-4222-8222-222222222222', hunkSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'hunk_stale' })
    const after = (await b.changes('a1b2c3d4'))!
    expect(after.pendingComments).toBe(1)
    expect(after.files[0]!.comments).toEqual([{ id: p.commentId, hunk: 0, body: '留白再多一点', state: 'draft' }])
    expect(() => PhoneChangesTurn.parse(after)).not.toThrow()
    expect(await b.reviewCommentsSend({ id: 'a1b2c3d4', requestId: '33333333-3333-4333-8333-333333333333' })).toEqual({ sent: 1, remaining: 0, skippedDiscarded: 0 })
    const sent = (await b.changes('a1b2c3d4'))!
    expect(sent.pendingComments).toBeUndefined()
    expect(sent.files[0]!.comments![0]).toMatchObject({ state: 'sent', sentAt: expect.any(Number) })
    await expect(b.reviewCommentDelete({ id: 'a1b2c3d4', commentId: p.commentId })).rejects.toMatchObject({ code: 'comment_sent' })
    await expect(b.reviewCommentsSend({ id: 'a1b2c3d4', requestId: '44444444-4444-4444-8444-444444444444' })).rejects.toMatchObject({ code: 'not_found' })
    b.reset()
    expect((await b.changes('a1b2c3d4'))!.files[0]!.comments).toBeUndefined()
  })
  it('用了多少额度:作品集那件带合计;没报的项是 null(不是 0)', async () => {
    const b = makeDemoBackend()
    expect((await b.matter('a1b2c3d4', 'en')).task?.usage).toMatchObject({ turns: 3, input: 48_210, output: 6_120, cacheRead: null })
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
    expect((await b.matters('en')).filter(m => m.kind !== 'chat').length).toBe(5)
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
    expect((await b.matters('en')).filter(m => m.kind !== 'chat').length).toBe(5)
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
  it('按住说话(演示):配好了;回一句写好的话(按语言),不进对话、不发;空的 / 太大的拒', async () => {
    const b = makeDemoBackend({ lang: 'zh-Hans' })
    expect(await b.transcribeStatus()).toEqual({ configured: true })
    const before = (await b.chat({})).messages.length
    expect(await b.transcribe({ mime: 'audio/mp4', audioBase64: 'QUFBQQ==' })).toBe('明天上午提醒我把周报发出去。')
    expect((await b.chat({})).messages.length).toBe(before)
    await expect(b.transcribe({ mime: 'audio/mp4', audioBase64: '' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(b.transcribe({ mime: 'audio/mp4', audioBase64: 'A'.repeat(300_000) })).rejects.toMatchObject({ code: 'too_large' })
    expect(await makeDemoBackend({ lang: 'en' }).transcribe({ mime: 'audio/mp4', audioBase64: 'QUFBQQ==' })).toMatch(/weekly report/)
  })
  it('演示聊天:说一句 ⇒ pending;几秒后主题唤醒、历史里多了一问一答;同一 requestId 不重复', async () => {
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
      // 「在想…」要留得够久,模拟器上的 UI 测试(一次点击要 2 秒多)才看得到
      expect(DEMO_CHAT_REPLY_MS).toBeGreaterThanOrEqual(4000)
      await vi.advanceTimersByTimeAsync(2500)
      expect((await b.chat({})).pending?.requestId).toBe('r1')
      await vi.advanceTimersByTimeAsync(DEMO_CHAT_REPLY_MS)
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
      await vi.advanceTimersByTimeAsync(DEMO_CHAT_REPLY_MS)
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
  it('演示事项的事件种类与 daemon 一致(user / text / tool_call / error),进展页「对话」卡才显示得出来', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      await b.say('a1b2c3d4', '再看看', 'r-say')
      await vi.advanceTimersByTimeAsync(DEMO_CHAT_REPLY_MS)
      for (const m of await b.matters('en')) {
        for (const e of (await b.matter(m.id, 'en')).events) expect(['user', 'text', 'tool_call', 'error'], `${m.id}:${e.kind}`).toContain(e.kind)
      }
    } finally { vi.useRealTimers() }
  })
  it('接着做(演示):进行中的那条 ⇒ busy;另两条 ready(恢复 / 新开);接成一件事带 nativeStart,再点回同一件;第一句后 nativeStart 消失;reset 清掉', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend({ lang: 'zh-Hans' })
      expect(SessionContinue.parse(await b.continuePreview('demo-claude-1'))).toMatchObject({ state: 'busy_session', provider: 'claude', matterId: null })
      expect(await b.continuePreview('demo-claude-2')).toMatchObject({ state: 'ready', mode: 'native_resume', project: 'notes' })
      expect(await b.continuePreview('demo-codex-1')).toMatchObject({ state: 'ready', mode: 'fresh_context', provider: 'codex' })
      await expect(b.continueSession('demo-claude-1')).rejects.toMatchObject({ code: 'session_busy' })
      await expect(b.continuePreview('nope')).rejects.toMatchObject({ code: 'not_found' })
      const { matterId } = await b.continueSession('demo-claude-2')
      expect((await b.continueSession('demo-claude-2')).matterId).toBe(matterId)
      expect(await b.continuePreview('demo-claude-2')).toMatchObject({ state: 'managed', matterId })
      expect((await b.session('demo-claude-2')).managed).toBe(true)
      const d = MatterDetail.parse(await b.matter(matterId, 'zh-Hans'))
      expect(d.nativeStart).toEqual({ mode: 'native_resume', providerId: 'claude' })
      expect(d.task?.status).toBe('interrupted')
      expect(d.events.map(e => e.kind)).toEqual(['user', 'text', 'user'])
      expect((await b.matters('zh-Hans')).some(m => m.id === matterId)).toBe(true)
      await b.say(matterId, '接着把首页改完', 'r-continue')
      expect((await b.matter(matterId, 'zh-Hans')).nativeStart).toBeUndefined()
      await vi.advanceTimersByTimeAsync(2000)
      b.reset()
      expect(await b.continuePreview('demo-claude-2')).toMatchObject({ state: 'ready', matterId: null })
    } finally { vi.useRealTimers() }
  })
  it('接着做(演示):Codex 那条接成「带记录新开」;不认识的 key ⇒ not_found;不是 ready ⇒ 对应的码、什么都不建', async () => {
    const b = makeDemoBackend({ lang: 'en' })
    const before = (await b.matters('en')).length
    await expect(b.continueSession('nope')).rejects.toMatchObject({ code: 'not_found' })
    await expect(b.continueSession('demo-claude-1')).rejects.toMatchObject({ code: 'session_busy' })
    expect((await b.matters('en')).length).toBe(before)
    const { matterId } = await b.continueSession('demo-codex-1')
    expect((await b.matter(matterId, 'en')).nativeStart).toEqual({ mode: 'fresh_context', providerId: 'codex' })
  })
  it('接着做(演示):第一句后在跑,CC 回话后停下(不会一直「在跑」);标题与带过来的记录随语言变', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend({ lang: 'zh-Hans' })
      const { matterId } = await b.continueSession('demo-claude-2')
      const en = await b.matter(matterId, 'en')
      const zh = await b.matter(matterId, 'zh-Hans')
      expect(en.matter.title).not.toBe(zh.matter.title)
      expect(en.events[0]!.text).not.toBe(zh.events[0]!.text)
      await b.say(matterId, 'keep going', 'r-first')
      expect((await b.matter(matterId, 'en')).task?.status).toBe('running')
      await vi.advanceTimersByTimeAsync(2000)
      const after = await b.matter(matterId, 'en')
      expect(after.task?.status).not.toBe('running')
      expect(after.task?.phase).not.toBe('working')
    } finally { vi.useRealTimers() }
  })

})

describe('演示后端 · 额度用完交给另一位(spec continue-sessions §7-3)', () => {
  const REQ = '5a7e0000-0000-4000-8000-000000000001'
  it('种子里那件:Claude Code 额度用完、可交给 Codex;详情过协议 schema', async () => {
    const d = await makeDemoBackend().matter('f3a4b5c6', 'zh-Hans')
    expect(MatterDetail.parse(d).quotaHandoff).toMatchObject({ state: 'offer', from: 'claude', to: 'codex', kind: 'quota' })
    expect(d.events.map(e => e.text)).toContain('Claude Code 的额度用完了，这一轮没做完。')
  })
  it('交出去 ⇒ 新一件(Codex、同一文件夹、第一句说清接替谁、正在做,2 秒后回复);原来那件变 handed;同 requestId / 另一个 requestId 都回同一件', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      const { matterId } = await b.handoff({ id: 'f3a4b5c6', requestId: REQ, providerId: 'codex' })
      const made = await b.matter(matterId, 'zh-Hans')
      expect(made.task).toMatchObject({ providerId: 'codex', path: '~/Projects/notes', phase: 'working' })
      expect(made.matter.originMatterId).toBe('f3a4b5c6')
      expect(made.events[0]?.text).toBe('接替 Claude Code（额度用完）继续这件事：把周报整理成一页')
      expect((await b.matter('f3a4b5c6', 'en')).quotaHandoff).toEqual({ state: 'handed', from: 'claude', to: 'codex', matterId })
      expect(await b.handoff({ id: 'f3a4b5c6', requestId: REQ, providerId: 'codex' })).toEqual({ matterId })
      expect(await b.handoff({ id: 'f3a4b5c6', requestId: 'other', providerId: 'codex' })).toEqual({ matterId })
      expect((await b.matters('en')).filter(m => m.kind !== 'chat').length).toBe(5)
      await vi.advanceTimersByTimeAsync(2000)
      expect((await b.matter(matterId, 'en')).task?.phase).toBe('replied')
    } finally { vi.useRealTimers() }
  })
  it('确认卡上的人不对 / 这件不缺额度 ⇒ handoff_changed', async () => {
    const b = makeDemoBackend()
    await expect(b.handoff({ id: 'f3a4b5c6', requestId: REQ, providerId: 'gemini' })).rejects.toMatchObject({ code: 'handoff_changed' })
    await expect(b.handoff({ id: 'e5f6a7b8', requestId: REQ, providerId: 'codex' })).rejects.toMatchObject({ code: 'handoff_changed' })
  })
})

describe('演示后端:终端里的会话(2026-10-14)', () => {
  it('一条等你批准(拍得了)、一条在跑、一条歇着;过 schema;允许 ⇒ 在跑 ⇒ 歇着并有回复;歇着的能说一句,在跑时说 ⇒ busy', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      const list = await b.cliSessions()
      expect(PHONE_API_SCHEMAS['GET /m/api/cli/sessions']!.safeParse({ ok: true, sessions: list }).success).toBe(true)
      expect(list.map(s => s.status)).toEqual(['waiting', 'running', 'idle'])
      await expect(b.cliSay(list[1]!.session_id, 'x')).rejects.toMatchObject({ code: 'busy' })
      const w = list[0]!
      expect(w.pending?.actionable).toBe(true)
      await b.cliPermission({ sessionId: w.session_id, hash: w.pending!.hash!, decision: 'allow' })
      expect((await b.cliSessions()).find(s => s.session_id === w.session_id)!.status).toBe('running')
      await expect(b.cliPermission({ sessionId: w.session_id, decision: 'allow' })).rejects.toMatchObject({ code: 'stale' })
      await vi.advanceTimersByTimeAsync(2000)
      const done = (await b.cliSessions()).find(s => s.session_id === w.session_id)!
      expect(done.status).toBe('idle')
      const api = list[2]!
      expect(await b.cliSay(api.session_id, 'next')).toEqual({ sayId: null })
      expect((await b.cliSessions()).find(s => s.session_id === api.session_id)!.status).toBe('running')
      await expect(b.cliSay('nope', 'x')).rejects.toMatchObject({ code: 'not_found' })
      b.reset()
      expect((await b.cliSessions())[0]!.status).toBe('waiting')
    } finally { vi.useRealTimers() }
  })
})

describe('演示后端:送进开着的窗口(2026-10-20)', () => {
  it('等批准那条开在窗口里:等批准时不能说;拍完在跑也能说 ⇒ 回 say_id,先在送、一会儿送到;再说一句 ⇒ 新 id 盖掉旧的', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      const w = (await b.cliSessions())[0]!
      expect(w.live_window).toBe(true)
      await expect(b.cliSay(w.session_id, 'x')).rejects.toMatchObject({ code: 'busy' })
      await b.cliPermission({ sessionId: w.session_id, hash: w.pending!.hash!, decision: 'allow' })
      const { sayId } = await b.cliSay(w.session_id, '顺手把标题也改了')
      expect(sayId).toBeTruthy()
      const row = async () => (await b.cliSessions()).find(s => s.session_id === w.session_id)!
      expect((await row()).last_say).toMatchObject({ id: sayId, state: 'sending' })
      const list = await b.cliSessions()
      expect(PHONE_API_SCHEMAS['GET /m/api/cli/sessions']!.safeParse({ ok: true, sessions: list }).success).toBe(true)
      await vi.advanceTimersByTimeAsync(1500)
      expect((await row()).last_say).toMatchObject({ id: sayId, state: 'sent' })
      const again = await b.cliSay(w.session_id, '再一句')
      expect(again.sayId).not.toBe(sayId)
      expect((await row()).last_say).toMatchObject({ id: again.sayId, state: 'sending' })
      b.reset()
      expect((await b.cliSessions())[0]!.last_say).toBeUndefined()
    } finally { vi.useRealTimers() }
  })
})

describe('演示后端:今天(2026-10-14)', () => {
  it('过真 schema;终端那条等你批准算进「等你」,歇着的算「做完」;数字与列表一致', async () => {
    const b = makeDemoBackend()
    const today = await b.today()
    expect(PHONE_API_SCHEMAS['GET /m/api/today']!.safeParse({ ok: true, today }).success).toBe(true)
    expect(today.needsYou.some(n => n.source === 'terminal' && n.replyRef === 'dm0a1')).toBe(true)
    expect(today.done.some(d => d.source === 'terminal' && d.project === 'api-server')).toBe(true)
    expect(today.running.some(r => r.source === 'terminal' && r.project === 'docs')).toBe(true)
    expect(today.counts).toEqual({ needsYou: today.needsYou.length, done: today.done.length, running: today.running.length, stuck: today.stuck.length })
    expect(today.unavailable).toEqual([])
  })
})

describe('演示:此刻页的伙伴', () => {
  it('带回来一篇没看过的打猎;看过之后主题未读归零、首屏也不再算新的', async () => {
    const b = makeDemoBackend()
    const home: any[] = []
    b.subscribe('home', d => home.push(d))
    const h = await b.home('zh-Hans')
    for (const e of h.events) expect(() => FeedEvent.parse(e)).not.toThrow()
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ kind: 'hunt', title: '一篇讲手机排版留白的文章' })
    expect(h.events[0]!.ref?.url).toMatch(/^https:\/\//)
    expect(h.seenUntil).toBeNull()
    expect(h.unread).toBe(1)
    expect(h.presence?.activity.kind).toBe('idle')
    expect(home.at(-1)).toMatchObject({ unread: 1, presenceState: { activity: 'idle' } })
    expect((await b.home('en')).events[0]!.title).toBe('An essay on whitespace in mobile typography')
    const until = await b.markSeen(h.events[0]!.ts)
    expect(until).toBe(h.events[0]!.ts)
    await Promise.resolve()
    expect(home.at(-1)).toMatchObject({ unread: 0 })
    expect((await b.home('en')).unread).toBe(0)
    // 只前进不后退;不是时间 ⇒ invalid
    expect(await b.markSeen('2020-01-01T00:00:00.000Z')).toBe(until)
    await expect(b.markSeen('nope')).rejects.toMatchObject({ code: 'invalid' })
    b.reset()
    expect((await b.home('en')).unread).toBe(1)
  })
  it('有执行者正在写 ⇒ activity working(演示不演别的状态)', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      await b.decide({ id: 'a1b2c3d4', runId: (await b.matter('a1b2c3d4', 'en')).runId!, requestId: 'perm-demo-1', decision: 'allow' })
      expect((await b.home('en')).presence?.activity.kind).toBe('working')
      await vi.advanceTimersByTimeAsync(2000)
      expect((await b.home('en')).presence?.activity.kind).toBe('idle')
    } finally { vi.useRealTimers() }
  })
})

describe('演示:待办与 CC 画的你(收敛清单 ④)', () => {
  it('三条在办、一条最近了结;画像过协议包的 state schema', async () => {
    const b = makeDemoBackend({ lang: 'zh-Hans' })
    await b.memory()
    const p = await b.pocket()
    expect(p.todos.active.map(r => r.id)).toEqual([101, 102, 103])
    expect(p.todos.settled.map(r => r.id)).toEqual([104])
    expect(Buffer.from(p.portraitPng!, 'base64').subarray(1, 4).toString()).toBe('PNG')
    const parsed = PHONE_API_SCHEMAS['GET /m/api/state']!.safeParse({ ok: true, name: 'CC', ...p, portrait: null, stickers: [] })
    expect(parsed.success).toBe(true)
  })
  it('完成 ⇒ 挪到最近了结(最新的在前);捞回 ⇒ 回到在办;不在的 ⇒ not_found;reset 还原', async () => {
    let t = 1_760_000_000_000
    const b = makeDemoBackend({ now: () => t })
    t += 1000
    await b.setTodo(102, 'resolved')
    let p = await b.pocket()
    expect(p.todos.active.map(r => r.id)).toEqual([101, 103])
    expect(p.todos.settled.map(r => r.id)).toEqual([102, 104])
    await b.setTodo(104, 'active')
    p = await b.pocket()
    expect(p.todos.active.map(r => r.id)).toEqual([101, 103, 104])
    await expect(b.setTodo(999, 'resolved')).rejects.toMatchObject({ code: 'not_found' })
    b.reset()
    p = await b.pocket()
    expect(p.todos.active.map(r => r.id)).toEqual([101, 102, 103])
  })
})
