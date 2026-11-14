import { describe, expect, it } from 'vitest'
import { SHARE_NOTES_MAX, SHARE_TTL_MS, shareName, shareRefusal, sharedMatterView, withoutLocalPaths, type ShareSource } from './share-scope'

describe('分享时给合伙人起的名字', () => {
  it.each([['小林', '小林'], ['  Lin   Wei ', 'Lin Wei'], ['a'.repeat(24), 'a'.repeat(24)]])('%j → %j', (raw, name) => expect(shareName(raw)).toBe(name))
  it.each(['', '   ', 'a'.repeat(25), 'partner:小林', '小林：设计', '<b>林', '`林`', 42, null])('%j 不收', raw => expect(shareName(raw)).toBeNull())
  it('换行和控制字符去掉,不留成两行署名', () => expect(shareName('小\n林\u0000')).toBe('小林'))
})

describe('链接还能不能打开', () => {
  const T0 = 1_800_000_000_000, share = { expiresAt: T0 + SHARE_TTL_MS, revokedAt: null }, task = { kind: 'task', archivedAt: null }
  it('没撤销、没过期、事还在 → 能', () => expect(shareRefusal(share, task, T0)).toBeNull())
  it.each([
    ['撤销了', { ...share, revokedAt: T0 - 1 }, task, T0, 'revoked'],
    ['到期那一刻', share, task, T0 + SHARE_TTL_MS, 'expired'],
    ['事归档了', share, { kind: 'task', archivedAt: T0 - 5 }, T0, 'archived'],
    ['事没了', share, null, T0, 'not_shareable'],
    ['聊天不能分享', share, { kind: 'chat', archivedAt: null }, T0, 'not_shareable'],
    ['撤销优先于过期', { expiresAt: T0 - 1, revokedAt: T0 - 2 }, task, T0, 'revoked'],
  ] as const)('%s → 不能', (_n, s, m, now, reason) => expect(shareRefusal(s, m, now)).toBe(reason))
})

describe('本机路径不到合伙人那里', () => {
  const root = '/Users/nate/Documents/shop'
  it.each([
    ['改了 /Users/nate/Documents/shop/src/LoginHero.tsx', '改了 src/LoginHero.tsx'],
    ['工作区是 /Users/nate/Documents/shop。', '工作区是 .。'],
    ['日志在 /Users/nate/Library/Logs/cc/run.log', '日志在 …/run.log'],
    ['家目录 /Users/nate 下', '家目录 … 下'],
    ['放在 ~/Downloads/图/hero.webp', '放在 …/hero.webp'],
    ['见 /Users/nate/文档/设计稿/v2.fig', '见 …/v2.fig'],
    ['C:\\Users\\nate\\shop\\a.ts 也一样', '…/a.ts 也一样'],
    ['临时文件 /private/tmp/cc-123/out.png', '临时文件 …/out.png'],
  ])('%s', (text, expected) => expect(withoutLocalPaths(text, root)).toBe(expected))
  it.each([
    '接口是 /v1/health,返回 200',
    '文档见 https://example.com/docs/guide/start.html',
    '改了 src/pages/login/LoginHero.tsx 和 ./assets/img/hero.webp',
    '图是 1600×900 的 webp,深色那张文件名带 -dark',
    '支持 和/或 两种写法',
  ])('不该动的不动: %s', text => expect(withoutLocalPaths(text, root)).toBe(text))
  it('macOS 的 /tmp 与 /private/tmp 是同一个地方,两种写法都认成项目里', () => {
    expect(withoutLocalPaths('写了 /private/tmp/lab/notes.md 和 /tmp/lab/check.md', '/tmp/lab')).toBe('写了 notes.md 和 check.md')
  })
  it('没有项目路径时照样藏', () => expect(withoutLocalPaths('在 /Users/nate/x/y.md', null)).toBe('在 …/y.md'))
})

describe('合伙人看到的一件事', () => {
  const base = (): ShareSource => ({
    matter: { title: '登录页插图', projectPath: '/Users/nate/Documents/shop' },
    task: { status: 'running', phase: 'working', providerId: 'claude' },
    agentRuns: [
      { executor: 'claude', brief: '把插图接进 /Users/nate/Documents/shop/src/LoginHero.tsx', position: 2, status: 'running' },
      { executor: 'codex', brief: '出三张插图', position: 1, status: 'completed' },
      { executor: 'openai', brief: '跑一遍测试', position: 3, status: 'queued' },
    ],
    notes: [
      { author: 'CC', kind: 'plan', text: 'codex: 出三张插图', createdAt: 1 },
      { author: '执行者 codex', kind: 'note', text: '图在 /Users/nate/Documents/shop/public/hero-dark.webp,token=sk-abcdefghijklmnopqrstuvwxyz123456', createdAt: 2 },
      { author: 'partner:小林', kind: 'note', text: '第三张的熊再大一点', createdAt: 3 },
    ],
    notesTotal: 3, ownerPending: false,
    artifacts: [{ name: '.cc-workbench/ab12cd34/hero-dark.webp', size: 20480 }, { name: 'summary.md' }],
  })
  const edit = (f: (s: ShareSource) => void) => { const s = base(); f(s); return s }

  it('只有允许的字段:没有任何编号、路径、原始对话', () => {
    const view = sharedMatterView({ ...base(), matter: { ...base().matter, id: 'ab12cd34', ownerChatId: 'owner@im' } as never, events: [{ text: 'RAW_TRANSCRIPT' }], permissions: [{ description: 'rm -rf' }] } as never)
    expect(Object.keys(view).sort()).toEqual(['legs', 'notes', 'notesOmitted', 'outputs', 'state', 'title'])
    const wire = JSON.stringify(view)
    for (const hidden of ['ab12cd34', 'owner@im', 'RAW_TRANSCRIPT', 'rm -rf', '/Users/', 'nate', 'sk-abcdefghijklmnopqrstuvwxyz123456', 'runId', 'partner:']) expect(wire).not.toContain(hidden)
  })
  it('每一棒按顺序,是谁、做什么、到哪了', () => {
    expect(sharedMatterView(base()).legs).toEqual([
      { position: 1, executor: 'codex', brief: '出三张插图', status: 'done' },
      { position: 2, executor: 'claude', brief: '把插图接进 src/LoginHero.tsx', status: 'running' },
      { position: 3, executor: 'openai', brief: '跑一遍测试', status: 'queued' },
    ])
  })
  it('记录本:合伙人留的话显示成名字并标出来', () => {
    const notes = sharedMatterView(base()).notes
    expect(notes[2]).toEqual({ author: '小林', partner: true, kind: 'note', text: '第三张的熊再大一点', at: 3 })
    expect(notes[1]).toMatchObject({ author: '执行者 codex', partner: false })
    expect(notes[1]!.text).toContain('public/hero-dark.webp')
  })
  it('产出只给文件名和大小', () => {
    expect(sharedMatterView(base()).outputs).toEqual([{ name: 'hero-dark.webp', size: 20480 }, { name: 'summary.md', size: null }])
  })
  it('记录太多只给最新的,并说明省了多少', () => {
    const many = edit(s => { s.notes = Array.from({ length: SHARE_NOTES_MAX + 5 }, (_, i) => ({ author: 'CC', kind: 'note', text: `第 ${i} 条`, createdAt: i })); s.notesTotal = 200 })
    const view = sharedMatterView(many)
    expect(view.notes).toHaveLength(SHARE_NOTES_MAX)
    expect(view.notes.at(-1)!.text).toBe(`第 ${SHARE_NOTES_MAX + 4} 条`)
    expect(view.notesOmitted).toBe(200 - SHARE_NOTES_MAX)
  })
  it('没见过的记录种类不往外放', () => {
    expect(sharedMatterView(edit(s => { s.notes = [{ author: 'CC', kind: 'internal', text: '内部', createdAt: 1 }] })).notes).toEqual([])
  })

  it.each([
    ['有棒在做', (_s: ShareSource) => {}, 'working'],
    ['主人有没处理的批准或提问(内容不给)', (s: ShareSource) => { s.ownerPending = true }, 'waiting_owner'],
    ['有棒停在半路', (s: ShareSource) => { s.agentRuns = [{ ...s.agentRuns[0]!, status: 'failed' }, s.agentRuns[1]!, s.agentRuns[2]!] }, 'stopped'],
    ['上一棒刚做完、下一棒马上起', (s: ShareSource) => { s.agentRuns = s.agentRuns.map(r => r.status === 'running' ? { ...r, status: 'completed' } : r) }, 'working'],
    ['上一棒做完、下一棒派不出去', (s: ShareSource) => { s.agentRuns = s.agentRuns.map(r => r.status === 'running' ? { ...r, status: 'completed' } : r); s.task = { status: 'running', phase: 'replied', providerId: 'claude' } }, 'stopped'],
    ['每一棒都做完', (s: ShareSource) => { s.agentRuns = s.agentRuns.map(r => ({ ...r, status: 'completed' })); s.task = { status: 'running', phase: 'replied', providerId: 'claude' } }, 'done'],
    ['没见过的棒状态当成停下', (s: ShareSource) => { s.agentRuns = [{ ...s.agentRuns[0]!, status: 'mystery' }] }, 'stopped'],
  ] as const)('状态: %s → %s', (_n, change, state) => expect(sharedMatterView(edit(change)).state).toBe(state))

  it.each([
    [{ status: 'running', phase: 'working', providerId: 'codex' }, 'running', 'working'],
    [{ status: 'running', phase: 'replied', providerId: 'codex' }, 'done', 'done'],
    [{ status: 'completed', providerId: 'codex' }, 'done', 'done'],
    [{ status: 'failed', providerId: 'codex' }, 'stopped', 'stopped'],
  ] as const)('只有一位执行者(没有记录本)时用任务状态拼出一棒: %j', (task, leg, state) => {
    const view = sharedMatterView(edit(s => { s.agentRuns = []; s.task = task }))
    expect(view.legs).toEqual([{ position: 1, executor: 'codex', brief: '', status: leg }])
    expect(view.state).toBe(state)
  })
  it('任务信息没有时不编造', () => {
    const view = sharedMatterView(edit(s => { s.agentRuns = []; s.task = null }))
    expect(view.legs).toEqual([]); expect(view.state).toBe('stopped')
  })
})
