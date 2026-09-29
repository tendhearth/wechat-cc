/**
 * phone-topic-sources.test.ts — 真实来源的边角(端到端的主路径在 phone-e2e.test.ts)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
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
