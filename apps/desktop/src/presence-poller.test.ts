import { describe, expect, it, vi } from 'vitest'
import { createPresencePoller, DOWN_PRESENCE } from './presence-poller.js'

const ok = { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } }

describe('createPresencePoller', () => {
  it('refresh() 打 GET /v1/companion/presence 一次并通知订阅者', async () => {
    const invokeApi = vi.fn().mockResolvedValue(ok)
    const p = createPresencePoller({ invokeApi, intervalMs: 60_000 })
    const sub = vi.fn(); p.subscribe(sub)
    await p.refresh()
    expect(invokeApi).toHaveBeenCalledWith('GET', '/v1/companion/presence', undefined, { timeoutMs: 5_000 })
    expect(sub).toHaveBeenCalledWith(ok)
    expect(p.current).toEqual(ok)
  })
  it('并发 refresh 共享一个 in-flight', () => {
    const invokeApi = vi.fn(() => new Promise(() => {}))
    const p = createPresencePoller({ invokeApi, intervalMs: 60_000 })
    expect(p.refresh()).toBe(p.refresh())
    expect(invokeApi).toHaveBeenCalledOnce()
  })
  it('拉不到 → 发布 down,不保留上一次的好状态(灯该灭就灭)', async () => {
    const invokeApi = vi.fn().mockResolvedValueOnce(ok).mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const p = createPresencePoller({ invokeApi, intervalMs: 60_000 })
    const sub = vi.fn(); p.subscribe(sub)
    await p.refresh(); await p.refresh()
    expect(sub).toHaveBeenLastCalledWith(DOWN_PRESENCE)
    expect(p.current).toEqual(DOWN_PRESENCE)
  })
  it('subscribe 回放缓存;退订后不再收到;一个订阅者抛不影响别人', async () => {
    const invokeApi = vi.fn().mockResolvedValue(ok)
    const p = createPresencePoller({ invokeApi, intervalMs: 60_000 })
    await p.refresh()
    const late = vi.fn(); const unsub = p.subscribe(late)
    expect(late).toHaveBeenCalledWith(ok)
    p.subscribe(() => { throw new Error('crash') })
    const good = vi.fn(); p.subscribe(good)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    unsub(); late.mockClear()
    await p.refresh()
    expect(late).not.toHaveBeenCalled()
    expect(good).toHaveBeenCalledWith(ok)
    errSpy.mockRestore()
  })
  it('start() 立即刷一次并按 interval 重复;stop() 停', async () => {
    vi.useFakeTimers()
    const invokeApi = vi.fn().mockResolvedValue(ok)
    const p = createPresencePoller({ invokeApi, intervalMs: 1000 })
    p.start(); p.start()
    expect(invokeApi).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2500)
    expect(invokeApi).toHaveBeenCalledTimes(3)
    p.stop()
    await vi.advanceTimersByTimeAsync(3000)
    expect(invokeApi).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })
  it('坏响应(null、[]、{})→ 发布 down', async () => {
    for (const badVal of [null, [], {}]) {
      const invokeApi = vi.fn().mockResolvedValue(badVal)
      const p = createPresencePoller({ invokeApi, intervalMs: 60_000 })
      const sub = vi.fn(); p.subscribe(sub)
      await p.refresh()
      expect(sub).toHaveBeenCalledWith(DOWN_PRESENCE)
      expect(p.current).toEqual(DOWN_PRESENCE)
    }
  })
})
