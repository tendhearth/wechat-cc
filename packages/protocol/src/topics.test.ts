import { describe, it, expect } from 'vitest'
import { HomeTopic, ApprovalsTopic, AgentsTopic, MatterTopic } from './topics'

describe('订阅主题形状', () => {
  it('home', () => {
    expect(HomeTopic.safeParse({ unread: 2, presenceState: { level: 'home', activity: 'working' }, nextCursor: null }).success).toBe(true)
    expect(HomeTopic.safeParse({ unread: '2', presenceState: null, nextCursor: null }).success).toBe(false)
  })
  it('approvals', () => {
    expect(ApprovalsTopic.safeParse([{ taskId: 'ab12cd34', kind: 'permission', id: 'p1', summary: 'Bash: ls' }]).success).toBe(true)
    expect(ApprovalsTopic.safeParse([{ taskId: 'x', kind: 'other', id: 'p1', summary: '' }]).success).toBe(false)
  })
  it('agents', () => {
    expect(AgentsTopic.safeParse({ running: 1, waiting: 0, tasks: [{ id: 'a', title: 't', phase: 'working' }] }).success).toBe(true)
  })
  it('matter', () => {
    expect(MatterTopic.safeParse({ found: false }).success).toBe(true)
    expect(MatterTopic.safeParse({ found: true, kind: 'task', version: 3, phase: 'working' }).success).toBe(true)
    expect(MatterTopic.safeParse({ found: true }).success).toBe(false)
  })
})
