import { describe, it, expect } from 'vitest'
import { GROUP_OF, togetherGroups, togetherView } from './together'

const m = (id: string, updatedAt: number, status = 'open', projectPath: string | null = null) => ({ id, kind: 'task', title: `t${id}`, projectPath, status, ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt }) as any
const agents = { running: 0, waiting: 0, tasks: [] }

describe('togetherView', () => {
  it('等你决定的排最前,其余按 updatedAt 倒序', () => {
    const v = togetherView([m('a', 10), m('b', 5), m('c', 1), m('d', 7)], [{ taskId: 'c', kind: 'permission', id: '1', summary: 'Bash: ls' }], agents)
    expect(v.map(x => x.id)).toEqual(['c', 'a', 'd', 'b'])
    expect(v[0]).toMatchObject({ status: 'waiting', subtitle: 'Bash: ls' })
  })
  it('subtitle 无待批准时用项目路径', () => {
    expect(togetherView([m('a', 1, 'open', '/p')], [], agents)[0]).toMatchObject({ subtitle: '/p', status: 'working', agents: [] })
    expect(togetherView([{ ...m('b', 1, 'open', '/p'), agents: ['codex', 'claude'] }], [], agents)[0]!.agents).toEqual(['codex', 'claude'])
  })
  it('归档的不出现,不改动入参顺序', () => {
    const input = [m('a', 1), m('b', 2, 'archived')]
    expect(togetherView(input, [], agents).map(x => x.id)).toEqual(['a'])
    expect(input.map(x => x.id)).toEqual(['a', 'b'])
  })
  it('聊天类不列(主人对话单独置顶,访客聊天不进一起做)', () => {
    expect(togetherView([m('a', 1), { ...m('c', 2), kind: 'chat' }], [], agents).map(x => x.id)).toEqual(['a'])
  })
})

describe('togetherGroups(等你 / 在做 / 做完)', () => {
  const tk = (id: string, status: string, phase?: string) => ({ id, phase, status: 'running' }) as any
  it('按用词表分组:等你决定 ⇒ 等你;在做 ⇒ 在做;做完了 / 完成 / 没做成 / 停下了 ⇒ 做完;顺序固定,空组不出', () => {
    const ms = [m('w', 9), m('r', 8, 'replied'), m('d', 7, 'done'), m('run', 6), m('f', 5), m('s', 4), m('i', 3)]
    const ag = { running: 1, waiting: 0, tasks: [tk('f', 'running', 'failed'), tk('s', 'running', 'cancelled'), tk('i', 'running', 'interrupted')] } as any
    const rows = togetherView(ms, [{ taskId: 'w', kind: 'question', id: '1', summary: 'q' }] as any, ag)
    const g = togetherGroups(rows)
    expect(g.map(x => x.key)).toEqual(['waiting', 'working', 'done'])
    expect(g[0]!.rows.map(r => r.id)).toEqual(['w'])
    expect(g[1]!.rows.map(r => r.id)).toEqual(['run'])
    expect(g[2]!.rows.map(r => [r.id, r.status])).toEqual([['r', 'replied'], ['d', 'done'], ['f', 'failed'], ['s', 'stopped'], ['i', 'stopped']])
  })
  it('没有等你的 ⇒ 不出「等你」那组;全空 ⇒ 空数组', () => {
    expect(togetherGroups(togetherView([m('a', 1)], [], agents)).map(x => x.key)).toEqual(['working'])
    expect(togetherGroups([])).toEqual([])
  })
  it('每个状态都有组', () => {
    for (const s of ['working', 'waiting', 'replied', 'done', 'failed', 'stopped'] as const) expect(GROUP_OF[s]).toBeDefined()
  })
})
