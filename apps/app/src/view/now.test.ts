import { describe, it, expect } from 'vitest'
import { nowView } from './now'

const m = (id: string, updatedAt: number, status = 'open') => ({ id, kind: 'task', title: `t${id}`, projectPath: null, status, ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt }) as any
const agents = { running: 0, waiting: 0, tasks: [] }
const run = (over: any = {}) => nowView({ approvals: [], agents, matters: [], hour: 9, ...over })

describe('nowView', () => {
  it('待批准按 taskId 分组,count > 1', () => {
    const v = run({ approvals: [
      { taskId: 'a', kind: 'permission', id: '1', summary: 'first' },
      { taskId: 'b', kind: 'question', id: '2', summary: 'other' },
      { taskId: 'a', kind: 'permission', id: '3', summary: 'second' },
    ] })
    expect(v.needsYou).toEqual([{ taskId: 'a', count: 2, firstSummary: 'first' }, { taskId: 'b', count: 1, firstSummary: 'other' }])
  })
  it('一起做:按更新时间倒序,最多 5 条', () => {
    const matters = [1, 2, 3, 4, 5, 6, 7].map(i => m(String(i), i))
    const v = run({ matters })
    expect(v.together.map(x => x.id)).toEqual(['7', '6', '5', '4', '3'])
  })
  it('状态:有待批准 ⇒ waiting;agents 的 phase 决定;否则看 matter', () => {
    const v = run({
      matters: [m('a', 5), m('b', 4), m('c', 3, 'done'), m('d', 2, 'replied')],
      approvals: [{ taskId: 'a', kind: 'permission', id: '1', summary: 's' }],
      agents: { running: 1, waiting: 0, tasks: [{ id: 'b', title: 'b', phase: 'failed' }] },
    })
    expect(v.together.map(x => x.status)).toEqual(['waiting', 'failed', 'done', 'replied'])
  })
  it('归档的不出现', () => {
    expect(run({ matters: [m('a', 1, 'archived')] }).together).toEqual([])
  })
  it('问候边界 4/5/11/12/17/18', () => {
    const g = (hour: number) => run({ hour }).greetingKey
    expect(g(4)).toBe('now.greetingEvening')
    expect(g(5)).toBe('now.greetingMorning')
    expect(g(11)).toBe('now.greetingMorning')
    expect(g(12)).toBe('now.greetingAfternoon')
    expect(g(17)).toBe('now.greetingAfternoon')
    expect(g(18)).toBe('now.greetingEvening')
    expect(g(0)).toBe('now.greetingEvening')
  })
  it('聊天类不列(主人对话单独置顶,访客聊天不进一起做)', () => {
    expect(run({ matters: [m('a', 1), { ...m('c', 2), kind: 'chat' }] }).together.map(x => x.id)).toEqual(['a'])
  })
})
