import { describe, expect, it } from 'vitest'
import { homeGroups, taskStatusKey, BACK_WINDOW_MS } from './home-list.js'
import { STATUS_WORDS } from '../generated/status-table.js'

const NOW = Date.UTC(2026, 10, 1, 12)
const task = (over: Record<string, unknown>) => ({ id: 'a1b2c3d4', title: '作品集', path: '/p', providerId: 'claude', status: 'running', createdAt: NOW - 1000, updatedAt: NOW - 60_000, error: null, ...over })
const session = (over: Record<string, unknown>) => ({ session_id: 's1', code: 'k3x', source: 'codex', displayName: 'Codex', status: 'running', stale: false, project: 'wechat-cc', machine: null, last_summary: null, last_event_at: NOW - 120_000, last_prompt_at: null, created_at: NOW - 600_000, pending: null, ...over })
const base = { tasks: [], attention: { tasks: [], stale: false }, sessions: [], now: NOW }

describe('taskStatusKey:一件事的状态并进同一套词(同 App 的 statusOf)', () => {
  it.each([
    [{ status: 'running' }, 'working'],
    [{ status: 'queued' }, 'working'],
    [{ status: 'running', phase: 'replied' }, 'replied'],
    [{ status: 'completed' }, 'done'],
    [{ status: 'failed' }, 'failed'],
    [{ status: 'running', phase: 'failed' }, 'failed'],
    [{ status: 'cancelled' }, 'stopped'],
    [{ status: 'interrupted' }, 'stopped'],
    // 老 daemon 不给 phase:会话还留着、前台空着、后台也没活 ⇒ 这一轮做完了,不算在做;后台还有活 ⇒ 在做
    [{ status: 'running', runtime: { retained: true, foreground: 'idle', backgroundCount: 0 } }, 'replied'],
    [{ status: 'running', runtime: { retained: true, foreground: 'idle', backgroundCount: 2 } }, 'working'],
  ])('%j ⇒ %s', (t, key) => { expect(taskStatusKey(t as never)).toBe(key) })
})

describe('homeGroups:主页的「在做」「带回来的」两组(等你那一组照旧由此刻页自己画)', () => {
  it('在做的一件事:标题是这件事,不带状态词;带回来的:小字是状态词', () => {
    const g = homeGroups({ ...base, tasks: [task({ id: 'w' }), task({ id: 'd', title: '日报', status: 'completed', updatedAt: NOW - 3_600_000 })] } as never)
    expect(g.working.map(r => [r.id, r.title, r.caption])).toEqual([['w', '作品集', null]])
    expect(g.back.map(r => [r.id, r.title, r.caption, r.status])).toEqual([['d', '日报', STATUS_WORDS.done, 'done']])
  })
  it('在做却 30 分钟没动静 ⇒ 小字「可能卡住」(三端同一句,状态表里;和微信日报同一条线)', () => {
    const g = homeGroups({ ...base, tasks: [task({ id: 'q', updatedAt: NOW - 31 * 60_000 }), task({ id: 'f', updatedAt: NOW - 60_000 })] } as never)
    expect(g.working.map(r => [r.id, r.caption])).toEqual([['f', null], ['q', '可能卡住']])
  })
  it('等你的事不进这两组(不论 attention 读到没有):不把它误标成在做', () => {
    const t = task({ id: 'p', pendingPermissionCount: 1 })
    expect(homeGroups({ ...base, attention: null, tasks: [t] } as never).working).toEqual([])
    const fromAttention = { tasks: [{ id: 'q', title: '作品集', providerId: 'claude', pendingPermissionCount: 0, pendingQuestionCount: 1, attentionKey: '["x"]' }], stale: false }
    expect(homeGroups({ ...base, tasks: [task({ id: 'q' })], attention: fromAttention } as never).working).toEqual([])
    expect(homeGroups({ ...base, tasks: [t], attention: { tasks: [], stale: true } } as never).working).toEqual([])
  })
  it('attention 读到了、说它不等了 ⇒ 列表里旧的计数不算,回到在做', () => {
    const g = homeGroups({ ...base, tasks: [task({ id: 'p', pendingPermissionCount: 1 })], attention: { tasks: [], stale: false } } as never)
    expect(g.working.map(r => r.id)).toEqual(['p'])
  })
  it('归档的不出现;带回来的只收 24 小时内,更早的记进 moreCount;backWindowMs=null 不限', () => {
    const tasks = [task({ id: 'old', status: 'completed', updatedAt: NOW - BACK_WINDOW_MS - 1 }), task({ id: 'arch', status: 'completed', archivedAt: NOW })]
    const g = homeGroups({ ...base, tasks } as never)
    expect(g.back).toEqual([])
    expect(g.moreCount).toBe(1)
    expect(homeGroups({ ...base, tasks, backWindowMs: null } as never).back.map(r => r.id)).toEqual(['old'])
  })
  it('两组都按最近动静排;导入后还没执行的说「还没开始做」', () => {
    const g = homeGroups({ ...base, tasks: [task({ id: 'x', status: 'completed', updatedAt: NOW - 5000 }), task({ id: 'y', status: 'completed', updatedAt: NOW - 1000 }), task({ id: 'z', status: 'completed', importedOnly: true, updatedAt: NOW - 9000 })] } as never)
    expect(g.back.map(r => r.id)).toEqual(['y', 'x', 'z'])
    expect(g.back[2]!.caption).toBe('还没开始做')
  })
  it('执行者:任务自己的在前,再接 daemon 给的 agents;名字表只读 daemon 给的', () => {
    const g = homeGroups({ ...base, tasks: [task({ agents: ['codex'] })], agentNames: { claude: 'Claude Code' } } as never)
    expect(g.working[0]!.agents).toEqual(['claude', 'codex'])
    expect(g.working[0]!.agentNames).toEqual({ claude: 'Claude Code' })
  })
  it('终端会话:在跑 ⇒ 在做,标题是项目,第三行是此刻那一步;歇着 ⇒ 带回来的「这一轮做完了 · N 分钟前」', () => {
    const g = homeGroups({ ...base, sessions: [
      session({ session_id: 'r', now: { kind: 'step', text: '运行 bun test', at: NOW } }),
      session({ session_id: 'i', status: 'idle', last_summary: '改好了两处', last_event_at: NOW - 5 * 60_000 }),
      session({ session_id: 'e', status: 'ended' }),
      session({ session_id: 'w', status: 'waiting', pending: { tool: 'Bash', summary: 'ls', since: NOW } }),
    ] } as never)
    expect(g.working.map(r => [r.source, r.id, r.title, r.detail, r.agents, r.agentNames])).toEqual([['terminal', 'r', 'wechat-cc', '运行 bun test', ['codex'], { codex: 'Codex' }]])
    expect(g.back.map(r => [r.id, r.caption, r.detail])).toEqual([['i', `${STATUS_WORDS.replied} · 5 分钟前`, '改好了两处']])
  })
  it('终端会话太久没动静(stale)⇒ 不写此刻那一步,小字说「有一阵没动静了」', () => {
    const g = homeGroups({ ...base, sessions: [session({ status: 'idle', stale: true, now: { kind: 'step', text: '运行 bun test', at: NOW } })] } as never)
    expect(g.back[0]!.detail).toBeNull()
    expect(g.back[0]!.caption).toBe('有一阵没动静了 · 2 分钟前')
  })
  it('读不到列表(tasks=null)⇒ 两组只剩终端的', () => {
    const g = homeGroups({ ...base, tasks: null, sessions: [session({})] } as never)
    expect(g.working.map(r => r.source)).toEqual(['terminal'])
  })
  it('「还有 N 件更早的」只数「全部」里找得到的(一件件事);24 小时前的终端会话不列也不数', () => {
    const g = homeGroups({ ...base, tasks: [task({ id: 'old', status: 'completed', updatedAt: NOW - BACK_WINDOW_MS - 1 })],
      sessions: [session({ session_id: 'idle-old', status: 'idle', last_event_at: NOW - BACK_WINDOW_MS - 1 })] } as never)
    expect(g.back).toEqual([])
    expect(g.moreCount).toBe(1)
  })
})

