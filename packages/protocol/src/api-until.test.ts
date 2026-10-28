import { describe, it, expect } from 'vitest'
import { MatterDetail, MatterTaskView } from './index'

// 做到条件成立为止(v80,2026-10-20):手机详情里的 task.until 不能被 zod 剥掉 —— App 要整条命令原文。
describe('MatterTaskView.until', () => {
  const task = { id: 'deadbeef', title: 't', status: 'completed', providerId: 'claude', path: '/p', error: null, updatedAt: 1 }
  const until = { command: 'bun run test -- --reporter=dot', maxRounds: 3, rounds: 2, status: 'stopped', lastExit: 1, stopReason: '独立工作区已经删了' } as const
  it('解析后原样保留(命令逐字、停的原因)', () => {
    expect(MatterTaskView.parse({ ...task, until }).until).toEqual(until)
  })
  it('经 MatterDetail 也保留;老 daemon 不带 ⇒ 没有', () => {
    const base = { matter: { id: 'deadbeef', kind: 'task', title: 't', projectPath: null, status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1 }, bindings: [], sessions: [], events: [], permissions: [], questions: [], artifacts: [], inputs: [] }
    expect(MatterDetail.parse({ ...base, task: { ...task, until } }).task?.until).toEqual(until)
    expect(MatterDetail.parse({ ...base, task }).task?.until).toBeUndefined()
  })
  it('状态只认四种', () => {
    expect(MatterTaskView.safeParse({ ...task, until: { ...until, status: 'running' } }).success).toBe(false)
  })
})
