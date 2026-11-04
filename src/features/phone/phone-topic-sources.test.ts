/**
 * phone-topic-sources.test.ts — 真实来源的边角(端到端的主路径在 phone-e2e.test.ts)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeTopic, ApprovalsTopic, AgentsTopic, MatterTopic } from '@wechat-cc/protocol'
import { makePhoneEventsWiring, makePhoneTopicSources, type PhoneWorkbench } from './phone-topic-sources'
import type { WriteHint } from '../../lib/write-hints'

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

describe('matter/<聊天> 主题', () => {
  const chatMatter = { id: 'c0ffee01', kind: 'chat' as const, title: '聊天', projectPath: null, status: 'open' as const, ownerChatId: 'wx', originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 100 }
  const src = (chat?: { latestAt(c: string): Promise<number | null>; pendingMatter(): string | null }) =>
    makePhoneTopicSources({ home: async () => { throw new Error('no') }, matters: { get: () => chatMatter }, ...(chat ? { chat } : {}) } as never).find(s => s.match('matter/c0ffee01'))!
  it('版本 = max(updatedAt, 最新消息时间):微信那边一来一回也会变', async () => {
    let latest: number | null = 50
    const s = src({ latestAt: async () => latest, pendingMatter: () => null })
    expect(await s.snapshot('matter/c0ffee01')).toEqual({ found: true, kind: 'chat', version: 100, phase: 'open' })
    latest = 500
    expect(await s.snapshot('matter/c0ffee01')).toMatchObject({ version: 500 })
  })
  it('手机那句在等回复 ⇒ phase working', async () => {
    const s = src({ latestAt: async () => null, pendingMatter: () => 'c0ffee01' })
    expect(await s.snapshot('matter/c0ffee01')).toMatchObject({ phase: 'working', version: 100 })
  })
  it('读最新消息抛错 ⇒ 退回 updatedAt;没接 chat ⇒ 原行为', async () => {
    expect(await src({ latestAt: async () => { throw new Error('db') }, pendingMatter: () => null }).snapshot('matter/c0ffee01')).toMatchObject({ version: 100 })
    expect(await src().snapshot('matter/c0ffee01')).toEqual({ found: true, kind: 'chat', version: 100, phase: 'open' })
  })
  it('快照形状仍过 MatterTopic', async () => {
    MatterTopic.parse(await src({ latestAt: async () => 7, pendingMatter: () => 'c0ffee01' }).snapshot('matter/c0ffee01'))
  })
})

describe('变化驱动的主题(P2)', () => {
  const kinds: Record<string, string> = { aaaa0001: 'task', aaaa0002: 'task', bbbb0001: 'terminal', cccc0001: 'chat', cccc0002: 'chat' }
  const owners: Record<string, string> = { cccc0001: 'owner@im', cccc0002: 'guest@im' }
  const rig = () => {
    vi.useFakeTimers()
    const calls: string[] = []
    let listener: ((id: string, cursor: number) => void) | null = null
    let hintCb: ((h: WriteHint) => void) | null = null
    const workbench = {
      list: () => { calls.push('agents'); return { tasks: [] } },
      attention: () => { calls.push('approvals'); return { tasks: [] } },
      detail: (id: string) => { calls.push(id); return { version: 1, task: { phase: 'working' }, permissions: [], questions: [] } },
    } as unknown as PhoneWorkbench
    const matters = { get: (id: string) => (kinds[id] ? { id, kind: kinds[id], status: 'open', updatedAt: 1, ownerChatId: owners[id] ?? null } : null) }
    const wiring = makePhoneEventsWiring({
      workbench, matters: matters as never, pollMs: 2000,
      home: async () => { calls.push('home'); return { unread: 0, presence: null, next_cursor: null } as never },
      chat: { latestAt: async (chatId: string) => { calls.push(`chat:${chatId}`); return 5 }, pendingMatter: () => null },
      changes: { onChange: (cb) => { listener = cb; return () => { listener = null } } },
      hints: (cb) => { hintCb = cb; return () => { hintCb = null } },
    })
    const count = (c: string) => calls.filter(x => x === c).length
    return { wiring, calls, count, change: (id: string) => listener!(id, 1), hint: (h: WriteHint) => hintCb!(h), hinted: () => hintCb !== null }
  }
  const ALL = ['matter/aaaa0001', 'matter/bbbb0001', 'matter/cccc0001', 'home', 'approvals', 'agents']

  it('没有主题每 2 秒算一次:matter / approvals / agents 每 30 秒兜一次底,home 每 10 秒', async () => {
    const { wiring, calls, count } = rig()
    for (const t of ALL) wiring.events.subscribe(t, undefined, () => {})
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0
    await vi.advanceTimersByTimeAsync(2000 * 4)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)                   // 第 5 拍:home 兜底
    expect(calls).toEqual(['home'])
    await vi.advanceTimersByTimeAsync(2000 * 10)              // 第 15 拍:全部兜底
    expect(count('home')).toBe(3)
    for (const c of ['aaaa0001', 'chat:owner@im', 'approvals', 'agents']) expect(count(c)).toBe(1)
    wiring.dispose()
  })

  it('一件事变了 ⇒ 只算那件事的主题 + 不分事的主题,别的 matter/<id> 不算', async () => {
    const { wiring, calls, change } = rig()
    for (const t of ['matter/aaaa0001', 'matter/aaaa0002', 'home', 'approvals', 'agents']) wiring.events.subscribe(t, undefined, () => {})
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0
    change('aaaa0001')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.sort()).toEqual(['aaaa0001', 'agents', 'approvals', 'home'])
    wiring.dispose()
  })

  it('新的一条消息 ⇒ 只算这个 chat 的聊天主题 + home;别的 chat、任务、approvals 不算', async () => {
    const { wiring, calls, hint } = rig()
    for (const t of [...ALL, 'matter/cccc0002']) wiring.events.subscribe(t, undefined, () => {})
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0
    hint({ kind: 'messages', chatId: 'owner@im' })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.sort()).toEqual(['chat:owner@im', 'home'])
    wiring.dispose()
  })

  it('matters 行变了 ⇒ 只算那件事;觅食台 / 看到哪了 / 伙伴的念头 ⇒ 只算 home', async () => {
    const { wiring, calls, hint } = rig()
    for (const t of ALL) wiring.events.subscribe(t, undefined, () => {})
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0
    hint({ kind: 'matter', matterId: 'bbbb0001' })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([])                                 // 终端会话:没有 workbench 读,走 updatedAt 那支,算了但不记 calls
    hint({ kind: 'matter', matterId: 'cccc0001' })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(['chat:owner@im'])
    calls.length = 0
    for (const kind of ['journal', 'journal-seen', 'plan-log'] as const) {
      hint({ kind })
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(calls).toEqual(['home', 'home', 'home'])
    wiring.dispose()
  })

  it('信号来了才推:聊天主题的版本变了,不等兜底就推一份新的', async () => {
    vi.useFakeTimers()
    let latest = 5
    let hintCb: ((h: WriteHint) => void) | null = null
    const wiring = makePhoneEventsWiring({
      matters: { get: () => ({ id: 'cccc0001', kind: 'chat', status: 'open', updatedAt: 1, ownerChatId: 'owner@im' }) } as never,
      pollMs: 2000, home,
      chat: { latestAt: async () => latest, pendingMatter: () => null },
      hints: (cb) => { hintCb = cb; return () => { hintCb = null } },
    })
    const got: unknown[] = []
    wiring.events.subscribe('matter/cccc0001', undefined, ev => got.push(ev.data))
    await vi.advanceTimersByTimeAsync(0)
    latest = 9
    await vi.advanceTimersByTimeAsync(2000 * 3)
    expect(got).toEqual([{ found: true, kind: 'chat', version: 5, phase: 'open' }])   // 没信号:不算、不推
    hintCb!({ kind: 'messages', chatId: 'owner@im' })
    await vi.advanceTimersByTimeAsync(0)
    expect(got).toEqual([{ found: true, kind: 'chat', version: 5, phase: 'open' }, { found: true, kind: 'chat', version: 9, phase: 'open' }])
    wiring.dispose()
  })

  it('dispose 退订写口提示', async () => {
    const { wiring, hinted } = rig()
    expect(hinted()).toBe(true)
    wiring.dispose()
    expect(hinted()).toBe(false)
  })
})
