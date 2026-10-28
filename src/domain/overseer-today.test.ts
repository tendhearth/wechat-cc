import { describe, it, expect } from 'vitest'
import { buildOverseerToday, formatOverseerToday, TODAY_TEXT_MAX_LINES, TODAY_WINDOW_MS, type TodayAttentionInput, type TodayTaskInput } from './overseer-today'
import type { CliDigestView } from './cli-session-digest'

const NOW = 1_800_000_000_000
const MIN = 60_000, HOUR = 60 * MIN

const term = (id: string, over: Partial<CliDigestView> = {}): CliDigestView => ({
  session_id: `${id}-full-session`, code: id, source: 'claude', status: 'idle', stale: false,
  project: `proj-${id}`, cwd: `/Users/me/secret/proj-${id}`, machine: 'here', origin_agent: null,
  last_summary: `${id} 做完了`, last_event_at: NOW - 5 * MIN, last_prompt_at: null, created_at: NOW - 2 * HOUR, pending: null, ...over,
})
const task = (id: string, over: Partial<TodayTaskInput> = {}): TodayTaskInput => ({
  id, title: `任务 ${id}`, path: `/Users/me/code/repo-${id}`, providerId: 'codex', phase: 'replied',
  updatedAt: NOW - 10 * MIN, error: null, archivedAt: null, ...over,
})
const att = (id: string, over: Partial<TodayAttentionInput> = {}): TodayAttentionInput => ({
  id, title: `任务 ${id}`, providerId: 'claude', pendingPermissionCount: 1, pendingQuestionCount: 0, first: { kind: 'permission', text: 'Bash: npm publish' }, ...over,
})
const build = (o: { terminal?: CliDigestView[] | null; tasks?: TodayTaskInput[] | null; attention?: TodayAttentionInput[] | null }) =>
  buildOverseerToday({ now: NOW, terminal: o.terminal === undefined ? [] : o.terminal, tasks: o.tasks === undefined ? [] : o.tasks, attention: o.attention === undefined ? [] : o.attention, localMachine: 'here' })

describe('buildOverseerToday', () => {
  it('四组分得开:等你 / 做完 / 在跑 / 可能卡住;数字与列表一致', () => {
    const t = build({
      terminal: [
        term('w1', { status: 'waiting', last_summary: null, pending: { tool: 'Bash', summary: 'rm -rf dist', since: NOW - 3 * MIN, hash: 'k3x9z', reply_code: '07' } }),
        term('r1', { status: 'running', last_event_at: NOW - MIN }),
        term('d1'),
        term('q1', { status: 'idle', stale: true, last_event_at: NOW - 45 * MIN }),
      ],
      tasks: [task('aaaa0001', { phase: 'working', pendingPermissionCount: 1 }), task('aaaa0002'), task('aaaa0003', { phase: 'working', updatedAt: NOW - 2 * MIN }), task('aaaa0004', { phase: 'failed', error: 'exit 1: tests failed' })],
      attention: [att('aaaa0001')],
    })
    expect(t.counts).toEqual({ needsYou: 2, done: 2, running: 2, stuck: 2 })
    // 一起做那件 10 分钟前起就在等,终端那条 3 分钟前 ⇒ 一起做在前
    expect(t.needsYou.map(n => n.id)).toEqual(['aaaa0001', 'w1-full-session'])
    expect(t.needsYou.find(n => n.source === 'terminal')).toMatchObject({ code: 'w1', replyRef: '07', kind: 'permission', summary: 'Bash: rm -rf dist', at: NOW - 3 * MIN })
    expect(t.needsYou.find(n => n.source === 'together')).toMatchObject({ code: 'aaaa0001', replyRef: null, summary: 'Bash: npm publish', project: 'repo-aaaa0001', agent: 'Codex' })   // 任务视图上的执行者为准
    expect(t.done.map(d => d.id).sort()).toEqual(['aaaa0002', 'd1-full-session'])
    expect(t.running.map(r => r.id).sort()).toEqual(['aaaa0003', 'r1-full-session'])
    expect(t.stuck.map(s => [s.id, s.reason])).toEqual([['aaaa0004', 'failed'], ['q1-full-session', 'quiet']])
    expect(t.stuck[0]!.summary).toBe('exit 1: tests failed')
    expect(t.unavailable).toEqual([])
    expect(t.windowHours).toBe(24)
    expect(t.since).toBe(NOW - TODAY_WINDOW_MS)
  })

  it('时间窗是滚动 24 小时:23 小时前做完的算(哪怕在昨天),25 小时前的不算;窗外没动静的终端也不提', () => {
    const t = build({
      terminal: [term('in', { last_event_at: NOW - 23 * HOUR }), term('out', { last_event_at: NOW - 25 * HOUR }), term('oldq', { stale: true, last_event_at: NOW - 30 * HOUR })],
      tasks: [task('aaaa0001', { updatedAt: NOW - 23 * HOUR }), task('aaaa0002', { updatedAt: NOW - 25 * HOUR }), task('aaaa0003', { phase: 'failed', updatedAt: NOW - 26 * HOUR })],
    })
    expect(t.done.map(d => d.code)).toEqual(['aaaa0001', 'in'])   // 同一时刻按 id 定序
    expect(t.stuck).toEqual([])
  })

  it('排序:等你的等得最久在前;做完 / 在跑新的在前;卡住先失败 / 中断再没动静', () => {
    const t = build({
      terminal: [
        term('wa', { status: 'waiting', pending: { tool: 'Bash', summary: 'a', since: NOW - MIN } }),
        term('wb', { status: 'waiting', pending: { tool: 'Bash', summary: 'b', since: NOW - 9 * MIN } }),
        term('d-old', { last_event_at: NOW - 3 * HOUR }), term('d-new', { last_event_at: NOW - MIN }),
        term('q', { stale: true, last_event_at: NOW - 40 * MIN }),
      ],
      tasks: [task('bbbb0001', { phase: 'interrupted', updatedAt: NOW - 5 * HOUR, error: 'daemon_restarted' }), task('bbbb0002', { updatedAt: NOW - 2 * HOUR })],
    })
    expect(t.needsYou.map(n => n.code)).toEqual(['wb', 'wa'])
    expect(t.done.map(d => d.code)).toEqual(['d-new', 'bbbb0002', 'd-old'])
    expect(t.stuck.map(s => s.code)).toEqual(['bbbb0001', 'q'])
    expect(t.stuck[0]!.reason).toBe('interrupted')
  })

  it('一起做:在做却 30 分钟没动静 ⇒ 可能卡住;排队算在跑;取消、归档不出现;有待决的只在「等你」', () => {
    const t = build({
      tasks: [
        task('cccc0001', { phase: 'working', updatedAt: NOW - 31 * MIN }),
        task('cccc0002', { phase: 'queued', updatedAt: NOW - 2 * HOUR }),
        task('cccc0003', { phase: 'cancelled' }),
        task('cccc0004', { archivedAt: NOW - MIN }),
        task('cccc0005', { phase: 'working', updatedAt: NOW - 50 * MIN }),
      ],
      attention: [att('cccc0005', { pendingPermissionCount: 0, pendingQuestionCount: 2, first: { kind: 'question', text: '用哪个分支?' } })],
    })
    expect(t.stuck.map(s => [s.code, s.reason])).toEqual([['cccc0001', 'quiet']])
    expect(t.running.map(r => r.code)).toEqual(['cccc0002'])
    expect(t.done).toEqual([])
    expect(t.needsYou).toHaveLength(1)
    expect(t.needsYou[0]).toMatchObject({ code: 'cccc0005', kind: 'question', count: 2, summary: '用哪个分支?' })
  })

  it('终端:已结束且留了最后一句 ⇒ 做完;已结束没话 ⇒ 不提;别的机器标机器名;不暴露完整路径', () => {
    const t = build({ terminal: [term('e1', { status: 'ended' }), term('e2', { status: 'ended', last_summary: null }), term('far', { machine: 'win-test' })] })
    expect(t.done.map(d => d.code).sort()).toEqual(['e1', 'far'])
    expect(t.done.find(d => d.code === 'far')!.machine).toBe('win-test')
    expect(t.done.find(d => d.code === 'e1')!.machine).toBeNull()
    expect(JSON.stringify(t)).not.toContain('/Users/me')
  })

  it('读不到的来源记进 unavailable;attention 读不到时用任务上的待决计数兜底', () => {
    expect(build({ terminal: null, tasks: null, attention: null }).unavailable).toEqual(['terminal', 'together'])
    const t = build({ terminal: null, tasks: [task('dddd0001', { phase: 'working', pendingQuestionCount: 1 })], attention: null })
    expect(t.unavailable).toEqual(['terminal'])
    expect(t.needsYou[0]).toMatchObject({ code: 'dddd0001', kind: 'question', count: 1, summary: null })
    expect(t.running).toEqual([])
  })

  it('同样的输入同样的输出(确定性)', () => {
    const input = { terminal: [term('a'), term('b', { last_event_at: NOW - 5 * MIN })], tasks: [task('eeee0001', { updatedAt: NOW - 5 * MIN })] }
    expect(build(input)).toEqual(build(input))
    expect(build(input).done.map(d => d.id)).toEqual(['a-full-session', 'b-full-session', 'eeee0001'])
  })
})

describe('formatOverseerToday', () => {
  it('等你在最前、带怎么回;做完带最后一句;最后一行是怎么接着操作;纯文本', () => {
    const text = formatOverseerToday(build({
      terminal: [
        term('ab12c3', { project: 'wechat-cc', status: 'waiting', last_summary: null, pending: { tool: 'Bash', summary: 'rm -rf dist', since: NOW - 2 * MIN, hash: 'k3x9z', reply_code: '07' } }),
        term('9f8e7d', { project: 'melu', source: 'codex', status: 'running', last_event_at: NOW - 3 * MIN }),
        term('1a2b3c', { project: 'leni', last_event_at: NOW - 2 * HOUR, last_summary: '登录页改好了, 测试也过了' }),
      ],
      tasks: [task('a1b2c3d4', { title: '修好打包脚本', path: '/x/wechat-cc', updatedAt: NOW - 40 * MIN })],
    }))
    const lines = text.split('\n')
    expect(lines[0]).toBe('今天(过去 24 小时):1 件事等你 · 2 件做完 · 1 件在跑')
    expect(lines[1]).toBe('等你 · wechat-cc · Claude · 码 ab12c3 · Bash: rm -rf dist · 2 分钟前 · 回「y 07」/「n 07」')
    expect(lines[2]).toBe('做完 · 修好打包脚本 · 一起做 a1b2c3d4 · 40 分钟前')
    expect(lines[3]).toBe('做完 · leni · Claude · 码 1a2b3c · 2 小时前 · 登录页改好了, 测试也过了')
    expect(lines[4]).toBe('在跑 · melu · Codex · 码 9f8e7d · 3 分钟前有动静')
    expect(lines[5]).toBe('「看 码」看终端对话,「@码 话」接着说,「任务 编号」看一起做')
    expect(text).not.toMatch(/[*#`]/)
  })

  it('没开码 ⇒ 回终端处理;一起做等你 ⇒ 「任务 编号」;卡住写原因', () => {
    const text = formatOverseerToday(build({
      terminal: [term('ab12c3', { status: 'waiting', pending: { tool: 'permission', summary: null, since: NOW - MIN, hash: null, reply_code: null } }), term('q1', { stale: true, last_event_at: NOW - 3 * HOUR })],
      tasks: [task('ffff0001', { phase: 'working' }), task('ffff0002', { phase: 'failed', error: 'tests failed' })],
      attention: [att('ffff0001', { pendingPermissionCount: 2 })],
    }))
    expect(text).toContain('· 回终端处理')
    expect(text).toContain('等你 · 任务 ffff0001 · 一起做(2 条) · Bash: npm publish · ')
    expect(text).toContain('回「任务 ffff0001」看详情')
    expect(text).toContain('卡住 · 任务 ffff0002 · 一起做 ffff0002 · 失败了 · tests failed')
    expect(text).toContain('卡住 · proj-q1 · Claude · 码 q1 · 3 小时没动静')
    expect(text.split('\n')[0]).toContain('2 件可能卡住')
  })

  it('很多的时候 ≤ 15 行,没列出的合成一行', () => {
    const terminal = [
      ...Array.from({ length: 6 }, (_, i) => term(`w${i}`, { status: 'waiting', pending: { tool: 'Bash', summary: `cmd ${i}`, since: NOW - (i + 1) * MIN, hash: null, reply_code: null } })),
      ...Array.from({ length: 9 }, (_, i) => term(`d${i}`, { last_event_at: NOW - (i + 1) * MIN })),
      ...Array.from({ length: 4 }, (_, i) => term(`r${i}`, { status: 'running', last_event_at: NOW - (i + 1) * MIN })),
      ...Array.from({ length: 3 }, (_, i) => term(`q${i}`, { stale: true, last_event_at: NOW - (40 + i) * MIN })),
    ]
    const text = formatOverseerToday(build({ terminal }))
    const lines = text.split('\n')
    expect(lines.length).toBeLessThanOrEqual(TODAY_TEXT_MAX_LINES)
    expect(lines).toHaveLength(15)
    expect(text).toContain('(没列出的:2 件事等你、1 件可能卡住、5 件做完、2 件在跑)')
    expect(lines[1]!.startsWith('等你 · ')).toBe(true)
  })

  it('什么都没有 / 一路读不到', () => {
    expect(formatOverseerToday(build({}))).toBe('过去 24 小时没有新动静:终端和一起做都没有在跑、等你或做完的事。')
    expect(formatOverseerToday(build({ terminal: null }))).toContain('(终端暂时读不到)')
    expect(formatOverseerToday(build({ terminal: [term('a')], tasks: null })).split('\n')[0]).toContain('(一起做暂时读不到)')
  })
})

// 放行规则(2026-10-19):CC 替主人批过的,日报里看得见。
describe('日报 × CC 替你批了', () => {
  const withCc = (cc: { rule: number; review: number } | null, o: Parameters<typeof build>[0] = {}) =>
    buildOverseerToday({ now: NOW, terminal: o.terminal ?? [], tasks: o.tasks ?? [], attention: o.attention ?? [], localMachine: 'here', ccDecided: cc === null ? null : { ...cc, recent: [] } })
  it('有数 ⇒ 第一行带「CC 替你批了 N 条(规则 M、初审 K)」', () => {
    const t = withCc({ rule: 2, review: 1 }, { terminal: [term('d1')] })
    expect(t.ccDecided).toMatchObject({ rule: 2, review: 1 })
    expect(formatOverseerToday(t).split('\n')[0]).toContain('CC 替你批了 3 条(规则 2、初审 1)')
  })
  it('只有规则 ⇒ 不写初审', () => {
    expect(formatOverseerToday(withCc({ rule: 4, review: 0 }, { terminal: [term('d1')] }))).toContain('CC 替你批了 4 条(规则 4)')
  })
  it('全 0 / 读不到 ⇒ 不出现', () => {
    expect(formatOverseerToday(withCc({ rule: 0, review: 0 }, { terminal: [term('d1')] }))).not.toContain('替你批了')
    expect(formatOverseerToday(withCc(null, { terminal: [term('d1')] }))).not.toContain('替你批了')
    expect(build({}).ccDecided).toBeNull()
  })
  it('别的都没动静、只有 CC 批过 ⇒ 也说', () => {
    expect(formatOverseerToday(withCc({ rule: 0, review: 2 }))).toContain('CC 替你批了 2 条(初审 2)')
  })
})

describe('日报 × 定时任务(10-20)', () => {
  const withJobs = (jobs: { ran: number; spoke: number; paused: Array<{ id: string; text: string }> } | null, o: { terminal?: CliDigestView[] } = {}) =>
    buildOverseerToday({ now: NOW, terminal: o.terminal ?? [], tasks: [], attention: [], localMachine: 'here', jobs })
  it('head carries 定时 N 个(说了 M 个); zero runs ⇒ nothing', () => {
    expect(formatOverseerToday(withJobs({ ran: 3, spoke: 1, paused: [] }, { terminal: [term('d1')] })).split('\n')[0]).toContain('定时 3 个(说了 1 个)')
    expect(formatOverseerToday(withJobs({ ran: 0, spoke: 0, paused: [] }, { terminal: [term('d1')] }))).not.toContain('定时')
    expect(formatOverseerToday(withJobs(null, { terminal: [term('d1')] }))).not.toContain('定时')
  })
  it('auto-paused jobs get their own line, even on a quiet day', () => {
    const t = formatOverseerToday(withJobs({ ran: 0, spoke: 0, paused: [{ id: 'j3', text: '看 issue' }] }))
    expect(t).toContain('定时 j3「看 issue」连着没跑成,停了')
  })
})
