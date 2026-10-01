import { describe, it, expect } from 'vitest'
import { togetherView } from './together'

const m = (id: string, updatedAt: number, status = 'open', projectPath: string | null = null) => ({ id, kind: 'task', title: `t${id}`, projectPath, status, ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt }) as any
const agents = { running: 0, waiting: 0, tasks: [] }

describe('togetherView', () => {
  it('等你决定的排最前,其余按 updatedAt 倒序', () => {
    const v = togetherView([m('a', 10), m('b', 5), m('c', 1), m('d', 7)], [{ taskId: 'c', kind: 'permission', id: '1', summary: 'Bash: ls' }], agents)
    expect(v.map(x => x.id)).toEqual(['c', 'a', 'd', 'b'])
    expect(v[0]).toMatchObject({ status: 'waiting', subtitle: 'Bash: ls' })
  })
  it('subtitle 无待批准时用项目路径', () => {
    expect(togetherView([m('a', 1, 'open', '/p')], [], agents)[0]).toMatchObject({ subtitle: '/p', status: 'working' })
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
