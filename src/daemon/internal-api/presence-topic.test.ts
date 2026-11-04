import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePresenceTopic, petBusy } from './presence-topic'
import type { PetTurnPayload } from '../../domain/pet-turn'
import type { Presence } from '../../domain/companion-presence'

const presenceOk = { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } } as unknown as Presence
const pet = (over: Partial<PetTurnPayload> = {}): PetTurnPayload => ({ owner_last_contact_at: null, turn: { phase: 'idle', since: null }, last_done_at: null, pending_permissions: [], ...over })

describe('presence 主题(S5)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-11-04T10:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  function setup() {
    let current = pet()
    let presence: Presence | null = presenceOk
    const computePet = vi.fn(async () => current)
    const computePresence = vi.fn(async () => presence)
    const topic = makePresenceTopic({ computePet, computePresence })
    return { topic, computePet, computePresence, setPet: (p: PetTurnPayload) => { current = p }, setPresence: (p: Presence | null) => { presence = p } }
  }

  it('since 不给 ⇒ 马上回一份;cursor 从开机毫秒数起跳(重启后桌面手里的旧 cursor 一定对不上)', async () => {
    const { topic } = setup()
    const first = await topic.wait(null, 20_000)
    expect(first.presence).toEqual(presenceOk)
    expect(first.pet).toEqual(pet())
    expect(first.cursor).toBeGreaterThan(Date.parse('2026-11-04T10:00:00Z'))
    // 桌面手里是别的数(上一次开机的)⇒ 不等,马上回
    expect((await topic.wait(first.cursor - 7, 20_000)).cursor).toBe(first.cursor)
  })

  it('戳一下就推:内容变了 cursor 加一、挂着的马上回;内容没变就接着挂,到 maxMs 回原样', async () => {
    const { topic, setPet } = setup()
    const first = await topic.wait(null, 0)
    const waiting = topic.wait(first.cursor, 20_000)
    let settled = false; void waiting.then(() => { settled = true })
    topic.poke()                       // 戳了,但内容没变
    await vi.advanceTimersByTimeAsync(100)
    expect(settled).toBe(false)
    setPet(pet({ turn: { phase: 'thinking', since: '2026-11-04T10:00:00.000Z' } }))
    topic.poke()
    await vi.advanceTimersByTimeAsync(100)   // 合并 30ms 后重算:远快于以前桌面 2 秒一拉
    const got = await waiting
    expect(got.cursor).toBe(first.cursor + 1)
    expect(got.pet?.turn.phase).toBe('thinking')
    const idle = topic.wait(got.cursor, 20_000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await idle).cursor).toBe(got.cursor)
  })

  it('没戳到的变化:忙的时候 2 秒内、闲着 10 秒内兜底重算出来(和以前轮询的快慢档一样快)', async () => {
    const { topic, setPet } = setup()
    const first = await topic.wait(null, 0)
    const idleWait = topic.wait(first.cursor, 20_000)
    setPet(pet({ pending_permissions: [{ hash: 'h', prompt: 'p', since: '2026-11-04T10:00:00.000Z', expires_at: '2026-11-04T11:00:00.000Z' }] }))
    await vi.advanceTimersByTimeAsync(9_000)
    let settled = false; void idleWait.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_100)
    const busy = await idleWait
    expect(busy.pet?.turn.phase).toBe('idle')
    expect(busy.pet?.pending_permissions).toHaveLength(1)
    const busyWait = topic.wait(busy.cursor, 20_000)
    setPet(pet())
    await vi.advanceTimersByTimeAsync(2_100)
    expect((await busyWait).pet?.pending_permissions).toEqual([])
  })

  it('「在干活」到点就退:最后一次工具调用 + 5 秒那一刻重算,不等兜底', async () => {
    const { topic, setPet, computePet } = setup()
    const at = new Date(Date.now() - 4_000).toISOString()   // 4 秒前调过工具:再过 1 秒就不算「在干活」了
    setPet(pet({ turn: { phase: 'working', since: at } }))
    const first = await topic.wait(null, 0)
    const waiting = topic.wait(first.cursor, 20_000)
    setPet(pet({ turn: { phase: 'thinking', since: at } }))
    const calls = computePet.mock.calls.length
    await vi.advanceTimersByTimeAsync(900)
    expect(computePet.mock.calls.length).toBe(calls)   // 还没到点:不算
    await vi.advanceTimersByTimeAsync(200)             // 到点(比 2 秒兜底早)
    expect((await waiting).pet?.turn.phase).toBe('thinking')
  })

  it('没人在等就一次都不算;戳过的话下一个来问的先重算', async () => {
    const { topic, computePet, setPet } = setup()
    await topic.wait(null, 0)
    const calls = computePet.mock.calls.length
    setPet(pet({ last_done_at: '2026-11-04T10:00:01.000Z' }))
    topic.poke()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(computePet.mock.calls.length).toBe(calls)
    const next = await topic.wait(null, 0)
    expect(next.pet?.last_done_at).toBe('2026-11-04T10:00:01.000Z')
  })

  it('不撒谎:算不出来的那一半是 null(不拿旧值顶);恢复了照常推', async () => {
    const { topic, computePet, setPresence } = setup()
    const first = await topic.wait(null, 0)
    computePet.mockRejectedValueOnce(new Error('db busy'))
    setPresence(null)
    const waiting = topic.wait(first.cursor, 20_000)
    topic.poke()
    await vi.advanceTimersByTimeAsync(100)
    const broken = await waiting
    expect(broken.pet).toBeNull()
    expect(broken.presence).toBeNull()
    setPresence(presenceOk)
    const again = topic.wait(broken.cursor, 20_000)
    topic.poke()
    await vi.advanceTimersByTimeAsync(100)
    expect((await again).pet).toEqual(pet())
  })

  it('处境那一半只在被戳或旧了 10 秒才重算(要扫每个会话的入站时间);在做什么每次都算', async () => {
    const { topic, computePresence, setPet } = setup()
    const first = await topic.wait(null, 0)
    expect(computePresence).toHaveBeenCalledTimes(1)
    setPet(pet({ turn: { phase: 'thinking', since: null } }))   // 忙 ⇒ 2 秒一兜底
    const w = topic.wait(first.cursor, 20_000)
    await vi.advanceTimersByTimeAsync(10_500)
    await w
    // 0 → 10.5s:兜底算了好几次在做什么,处境只在旧了 10 秒那次重算过一次
    expect(computePresence.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('请求断开(signal)⇒ 不再挂着;dispose 叫醒所有等着的', async () => {
    const { topic } = setup()
    const first = await topic.wait(null, 0)
    const ac = new AbortController()
    const a = topic.wait(first.cursor, 20_000, ac.signal)
    ac.abort()
    expect((await a).cursor).toBe(first.cursor)
    const b = topic.wait(first.cursor, 20_000)
    topic.dispose()
    expect((await b).cursor).toBe(first.cursor)
  })

  it('petBusy:有回合 / 待批 / 在跑的任务 = 忙;做完了的任务不算', () => {
    expect(petBusy(null)).toBe(false)
    expect(petBusy(pet())).toBe(false)
    expect(petBusy(pet({ turn: { phase: 'thinking', since: null } }))).toBe(true)
    expect(petBusy(pet({ activities: [{ taskId: 'deadbeef', title: 't', phase: 'replied', detail: null, updatedAt: 1 }] }))).toBe(false)
    expect(petBusy(pet({ activities: [{ taskId: 'deadbeef', title: 't', phase: 'working', detail: null, updatedAt: 1 }] }))).toBe(true)
  })
})
