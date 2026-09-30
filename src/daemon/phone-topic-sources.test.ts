/**
 * phone-topic-sources.test.ts — 真实来源的边角(端到端的主路径在 phone-e2e.test.ts)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeTopic, ApprovalsTopic, AgentsTopic, MatterTopic } from '@wechat-cc/protocol'
import { makePhoneEventsWiring, makePhoneTopicSources, type PhoneWorkbench } from './phone-topic-sources'

afterEach(() => { vi.useRealTimers() })

const home = async () => ({ unread: 0, presence: null, next_cursor: null }) as never

/** 登记处里有这件任务型事项,但工作台里的任务已经被清掉:detail 抛(与真工作台一样)。 */
function purgedTask(): { workbench: PhoneWorkbench; matters: { get: (id: string) => unknown } } {
  const workbench = {
    list: () => ({ tasks: [] }),
    attention: () => ({ tasks: [] }),
    detail: (id: string) => { throw new Error(`task not found: ${id}`) },
  } as unknown as PhoneWorkbench
  const matters = { get: (id: string) => (id === 'deadbeef' ? { id, kind: 'task', status: 'open', updatedAt: 1 } : null) }
  return { workbench, matters }
}

describe('matter/<id> 来源', () => {
  it('任务型事项的任务已不存在 ⇒ {found:false},不抛', async () => {
    const { workbench, matters } = purgedTask()
    const matter = makePhoneTopicSources({ workbench, matters: matters as never, home })[1]!
    await expect(matter.snapshot('matter/deadbeef')).resolves.toEqual({ found: false })
  })

  it('订阅者先收到 {found:false};之后的轮询不反复记错误日志', async () => {
    vi.useFakeTimers()
    const { workbench, matters } = purgedTask()
    const log = vi.fn()
    const wiring = makePhoneEventsWiring({ workbench, matters: matters as never, home, pollMs: 2000, log })
    const got: unknown[] = []
    wiring.events.subscribe('matter/deadbeef', undefined, ev => got.push(ev.data))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(got).toEqual([{ found: false }])
    expect(log).not.toHaveBeenCalled()
    wiring.dispose()
  })
})

describe('真实来源的快照符合协议包的主题形状', () => {
  it('home / approvals / agents / matter 四路都能 parse', async () => {
    const workbench = {
      list: () => ({ tasks: [{ id: 'ab12cd34', title: 'fix  bug', status: 'running', phase: 'working', createdAt: 1, pendingPermissionCount: 0, pendingQuestionCount: 0 }] }),
      attention: () => ({ tasks: [{ id: 'ab12cd34' }] }),
      detail: () => ({
        version: 3, task: { phase: 'working' },
        permissions: [{ id: 'p1', tool: 'Bash', description: 'ls' }],
        questions: [{ id: 'q1', questions: [{ question: 'which?' }] }],
      }),
    } as unknown as PhoneWorkbench
    const matters = { get: (id: string) => (id === 'deadbeef' ? { id, kind: 'task', status: 'open', updatedAt: 1 } : id === 'cafe0001' ? { id, kind: 'chat', status: 'open', updatedAt: 99 } : null) }
    const richHome = async () => ({ unread: 2, presence: { presence: 'ok', activity: { kind: 'working' } }, next_cursor: 'abc' }) as never
    const [h, m, a, g] = makePhoneTopicSources({ workbench, matters: matters as never, home: richHome })
    HomeTopic.parse(await h!.snapshot('home'))
    HomeTopic.parse(await makePhoneTopicSources({ home })[0]!.snapshot('home'))
    const apr = ApprovalsTopic.parse(await a!.snapshot('approvals'))
    expect(apr).toHaveLength(2)
    const ag = AgentsTopic.parse(await g!.snapshot('agents'))
    expect(ag.running).toBe(1)
    for (const t of ['matter/deadbeef', 'matter/cafe0001', 'matter/00000000']) MatterTopic.parse(await m!.snapshot(t))
  })
})
