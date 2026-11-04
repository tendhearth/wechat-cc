import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPresenceFeed, readPresenceTopic, DOWN_FACTS } from './presence-feed.js'
import { DOWN_PRESENCE } from '../../presence-poller.js'

const presence = { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } }
const pet = (phase = 'idle') => ({ owner_last_contact_at: null, turn: { phase, since: null }, last_done_at: null, pending_permissions: [] })

/** 一个按 since 回答的假 daemon:since 和手里的 cursor 一样就挂着,直到 push()。 */
function fakeDaemon() {
  let cursor = 100, body: Record<string, unknown> = { presence, pet: pet() }
  let hang: (() => void) | null = null
  const calls: string[] = []
  const invokeApi = vi.fn(async (_m: string, path: string, _b?: unknown, opts?: { timeoutMs?: number }) => {
    calls.push(path)
    const q = new URL(path, 'http://x').searchParams
    const since = q.get('since')
    if (since !== null && Number(since) === cursor && Number(q.get('wait_ms')) > 0) await new Promise<void>(r => { hang = r })
    void opts
    return { cursor, ...body }
  })
  return {
    invokeApi, calls,
    push(next: Record<string, unknown>) { cursor++; body = next; const h = hang; hang = null; h?.() },
  }
}

describe('presence 主题的桌面那头(S5,替掉 pet-poller 的 2 / 10 秒轮询)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('start 先要一份(since=0 ⇒ 马上回),然后按回来的 cursor 挂着等;daemon 一推就到,不等下一次轮询', async () => {
    const d = fakeDaemon()
    const feed = createPresenceFeed({ invokeApi: d.invokeApi })
    const got: unknown[] = []
    feed.subscribe(f => got.push(f))
    feed.start(); await vi.advanceTimersByTimeAsync(0)
    expect(d.calls[0]).toBe('/v1/subscribe/presence?since=0&wait_ms=20000')
    expect(got).toEqual([{ presence, pet: pet() }])
    expect(d.calls[1]).toBe('/v1/subscribe/presence?since=100&wait_ms=20000')
    d.push({ presence, pet: pet('thinking') })
    await vi.advanceTimersByTimeAsync(0)
    expect(got.at(-1)).toEqual({ presence, pet: pet('thinking') })
    // 长轮询的超时给够:挂 20 秒 + 5 秒余量
    expect(d.invokeApi.mock.calls[1]![3]).toEqual({ timeoutMs: 25_000 })
    feed.stop()
  })

  it('不撒谎:拉不到 ⇒ DOWN + null;某一半是 null ⇒ 那一半 DOWN / null;断了按退避重连,连上马上有新的一份', async () => {
    const invokeApi = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ cursor: 5, presence: null, pet: null })
      .mockImplementation(() => new Promise(() => {}))
    const feed = createPresenceFeed({ invokeApi, backoff: [1000] })
    const got: unknown[] = []
    feed.subscribe(f => got.push(f))
    feed.start(); await vi.advanceTimersByTimeAsync(0)
    expect(got).toEqual([DOWN_FACTS])
    await vi.advanceTimersByTimeAsync(1000)
    expect(got.at(-1)).toEqual({ presence: DOWN_PRESENCE, pet: null })
    await vi.advanceTimersByTimeAsync(10)
    expect(invokeApi).toHaveBeenCalledTimes(3)
    expect(invokeApi.mock.calls[2]![1]).toBe('/v1/subscribe/presence?since=5&wait_ms=20000')
    feed.stop()
  })

  it('形状不对就当拉不到(不猜)', () => {
    expect(() => readPresenceTopic(null)).toThrow()
    expect(() => readPresenceTopic({ presence })).toThrow()
    expect(readPresenceTopic({ cursor: 1, presence: { nope: 1 }, pet: 'x' })).toEqual({ cursor: 1, presence: DOWN_PRESENCE, pet: null })
  })

  it('refresh:现在就要一份(拍板之后 / 安静刚结束),发出去后从这份的 cursor 接着订', async () => {
    const d = fakeDaemon()
    const feed = createPresenceFeed({ invokeApi: d.invokeApi })
    const got: unknown[] = []
    feed.subscribe(f => got.push(f))
    feed.start(); await vi.advanceTimersByTimeAsync(0)
    const facts = await feed.refresh()
    expect(facts).toEqual({ presence, pet: pet() })
    expect(d.calls).toContain('/v1/subscribe/presence?wait_ms=0')
    await vi.advanceTimersByTimeAsync(0)
    expect(d.calls.at(-1)).toBe('/v1/subscribe/presence?since=100&wait_ms=20000')
    expect(got).toHaveLength(2)
    feed.stop()
    // 停订以后 refresh 只要一份,不再接着订
    const before = d.calls.length
    await feed.refresh(); await vi.advanceTimersByTimeAsync(0)
    expect(d.calls.length).toBe(before + 1)
  })

  it('挂满 wait_ms 原样回来(cursor 没变)不再发一遍;重新 start / 断线恢复后那一份照发', async () => {
    let n = 0
    const invokeApi = vi.fn(async (_m: string, path: string) => {
      n++
      if (n === 4) throw new Error('ECONNRESET')
      if (path.includes('since=7') && n > 5) return new Promise(() => {})
      return { cursor: 7, presence, pet: pet() }
    })
    const feed = createPresenceFeed({ invokeApi, backoff: [1000] })
    const got: unknown[] = []
    feed.subscribe(f => got.push(f))
    feed.start(); await vi.advanceTimersByTimeAsync(10)
    // 第 1 份发;第 2、3 份 cursor 一样(心跳)不发;第 4 次断了发 DOWN
    expect(got).toEqual([{ presence, pet: pet() }, DOWN_FACTS])
    await vi.advanceTimersByTimeAsync(1_010)
    // 恢复后的第一份即使 cursor 一样也发(它推翻了刚才的 DOWN)
    expect(got.at(-1)).toEqual({ presence, pet: pet() })
    expect(got).toHaveLength(3)
    feed.stop(); feed.start(); await vi.advanceTimersByTimeAsync(10)
    expect(got).toHaveLength(4)
    feed.stop()
  })

  it('stop 之后挂着的那条回来也不发(窗口看不见时不画)', async () => {
    const d = fakeDaemon()
    const feed = createPresenceFeed({ invokeApi: d.invokeApi })
    const got: unknown[] = []
    feed.subscribe(f => got.push(f))
    feed.start(); await vi.advanceTimersByTimeAsync(0)
    feed.stop()
    d.push({ presence, pet: pet('working') })
    await vi.advanceTimersByTimeAsync(0)
    expect(got).toHaveLength(1)
  })
})
