import { describe, expect, it } from 'vitest'
import { buildRoster, ROSTER_BACK_WINDOW_MS, type RosterInput } from './roster'

const NOW = 1_800_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

function input(over: Partial<RosterInput> = {}): RosterInput {
  return { matters: [], tasks: new Map(), pending: new Map(), relays: new Map(), terminals: [], seen: () => null, now: NOW, ...over }
}
const task = (id: string, over: Partial<RosterInput['matters'][number]> = {}) => ({ id, kind: 'task', title: `事 ${id}`, state: 'working' as const, archivedAt: null, updatedAt: NOW - MIN, agents: ['codex'], ...over })
const term = (id: string, over: Partial<RosterInput['terminals'][number]> = {}) => ({ session_id: id, code: id.slice(0, 4), source: 'claude', status: 'running' as const, project: 'bx', last_summary: '在改', last_event_at: NOW - MIN, pending: null, ...over })

describe('buildRoster', () => {
  it('task 事在跑 ⇒ working、kind matter、key matter:<id>', () => {
    const [r] = buildRoster(input({ matters: [task('aaaa0001')], tasks: new Map([['aaaa0001', { status: 'running', phase: 'working' }]]) }))
    expect(r).toMatchObject({ key: 'matter:aaaa0001', kind: 'matter', id: 'aaaa0001', group: 'working', status: 'working', agents: [{ id: 'codex', current: true }], quiet: false, unseen: false })
  })

  it('task 事有 2 条待批 ⇒ waiting,count 2,requestId 取等得最久那条', () => {
    const pending = new Map([['aaaa0001', [
      { kind: 'question' as const, id: 'q2', summary: '后来的', since: NOW - 2 * MIN },
      { kind: 'permission' as const, id: 'p1', summary: 'Bash: bun test', since: NOW - 5 * MIN },
    ]]])
    const [r] = buildRoster(input({ matters: [task('aaaa0001')], tasks: new Map([['aaaa0001', { status: 'running' }]]), pending }))
    expect(r!.group).toBe('waiting')
    expect(r!.waiting).toEqual({ kind: 'permission', requestId: 'p1', summary: 'Bash: bun test', count: 2 })
  })

  it('已完成的 task 事仍挂着待批 ⇒ waiting,不是 back', () => {
    const pending = new Map([['aaaa0001', [{ kind: 'permission' as const, id: 'p1', summary: 'x', since: NOW - MIN }]]])
    const [r] = buildRoster(input({ matters: [task('aaaa0001', { state: 'done' })], pending }))
    expect(r!.group).toBe('waiting')
  })

  it('act / chat / 归档的事不出现', () => {
    const out = buildRoster(input({ matters: [task('aaaa0001', { kind: 'act' }), task('aaaa0002', { kind: 'chat' }), task('aaaa0003', { archivedAt: NOW - MIN })] }))
    expect(out).toEqual([])
  })

  it('terminal 事与它的会话只出一行 matter 行,agents 用会话的执行者', () => {
    const out = buildRoster(input({
      matters: [task('bbbb0001', { kind: 'terminal', agents: [] })],
      terminals: [term('sess-1', { matter_id: 'bbbb0001' })],
    }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ key: 'matter:bbbb0001', kind: 'matter', group: 'working', agents: [{ id: 'claude', current: true }], terminal: { sessionId: 'sess-1', code: 'sess' } })
  })

  it('没有 matter_id 的会话 ⇒ kind terminal,带 code 与项目名', () => {
    const [r] = buildRoster(input({ terminals: [term('sess-2', { source: 'cursor', displayName: 'Cursor', project: 'rici' })] }))
    expect(r).toMatchObject({ key: 'terminal:sess-2', kind: 'terminal', id: 'sess-2', title: 'rici', project: 'rici', group: 'working', agents: [{ id: 'cursor', name: 'Cursor', current: true }], terminal: { sessionId: 'sess-2', code: 'sess', summary: '在改' }, unseen: false })
  })

  it('ended 会话不出现;等你的会话进 waiting', () => {
    const out = buildRoster(input({ terminals: [term('sess-3', { status: 'ended' }), term('sess-4', { status: 'waiting', pending: { since: NOW - 3 * MIN, actionable: true } })] }))
    expect(out.map(r => r.key)).toEqual(['terminal:sess-4'])
    expect(out[0]).toMatchObject({ group: 'waiting', terminal: { actionable: true } })
  })

  it('back 只收 24 小时内', () => {
    const out = buildRoster(input({ matters: [
      task('cccc0001', { state: 'done', updatedAt: NOW - 25 * HOUR }),
      task('cccc0002', { state: 'done', updatedAt: NOW - 23 * HOUR }),
    ] }))
    expect(out.map(r => r.id)).toEqual(['cccc0002'])
    expect(ROSTER_BACK_WINDOW_MS).toBe(24 * HOUR)
  })

  it('多棒:relay 带上,只有当前棒 current', () => {
    const [r] = buildRoster(input({
      matters: [task('dddd0001', { agents: ['claude', 'codex'] })],
      tasks: new Map([['dddd0001', { status: 'running', phase: 'working' }]]),
      relays: new Map([['dddd0001', { index: 2, total: 3, currentAgent: 'codex' }]]),
    }))
    expect(r!.relay).toEqual({ index: 2, total: 3 })
    expect(r!.agents).toEqual([{ id: 'claude', current: false }, { id: 'codex', current: true }])
  })

  it('在做却 31 分钟没动静 ⇒ quiet', () => {
    const [r] = buildRoster(input({ matters: [task('eeee0001', { updatedAt: NOW - 31 * MIN })], tasks: new Map([['eeee0001', { status: 'running', phase: 'working' }]]) }))
    expect(r!.quiet).toBe(true)
  })

  it('back 组:没看过的在前;哪一端看过就算看过', () => {
    const out = buildRoster(input({
      matters: [task('ffff0001', { state: 'done', updatedAt: NOW - 1 * MIN }), task('ffff0002', { state: 'done', updatedAt: NOW - 2 * HOUR })],
      seen: id => (id === 'ffff0001' ? 'phone' : null),
    }))
    expect(out.map(r => [r.id, r.unseen])).toEqual([['ffff0002', true], ['ffff0001', false]])
  })

  it('排序:waiting 按等待开始升序 → working 按更新降序 → back', () => {
    const pending = new Map([
      ['a0000001', [{ kind: 'permission' as const, id: 'p', summary: 's', since: NOW - 1 * MIN }]],
      ['a0000002', [{ kind: 'permission' as const, id: 'p', summary: 's', since: NOW - 9 * MIN }]],
    ])
    const out = buildRoster(input({
      matters: [
        task('a0000001'), task('a0000002'),
        task('a0000003', { updatedAt: NOW - 10 * MIN }), task('a0000004', { updatedAt: NOW - 1 * MIN }),
        task('a0000005', { state: 'done', updatedAt: NOW }),
      ],
      pending,
    }))
    expect(out.map(r => r.id)).toEqual(['a0000002', 'a0000001', 'a0000004', 'a0000003', 'a0000005'])
  })

  it('stale 会话(登记处已折算成 idle)⇒ 照样列,算这一轮做完了', () => {
    const [r] = buildRoster(input({ terminals: [term('sess-5', { status: 'idle', last_event_at: NOW - 2 * HOUR })] }))
    expect(r).toMatchObject({ group: 'back', status: 'replied', unseen: false })
  })
})
