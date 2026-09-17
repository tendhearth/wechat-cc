import { describe, it, expect, vi } from 'vitest'
import { makeTaskChangeHub } from './task-changes'

describe('TaskChangeHub', () => {
  it('seq > since ⇒ 立即返回当前 seq;不知道的任务 seq=0', async () => {
    const hub = makeTaskChangeHub()
    expect(hub.seq('t1')).toBe(0)
    hub.publish('t1', 3)
    expect(hub.seq('t1')).toBe(3)
    await expect(hub.wait('t1', 2, 1000)).resolves.toBe(3)
  })
  it('挂起直到 publish;多个 waiter 一起醒;别的任务不受影响', async () => {
    const hub = makeTaskChangeHub()
    hub.publish('t1', 1)
    const a = hub.wait('t1', 1, 5000), b = hub.wait('t1', 1, 5000), other = hub.wait('t2', 0, 30)
    let settled = false; void a.then(() => { settled = true })
    await new Promise(r => setTimeout(r, 5)); expect(settled).toBe(false)
    hub.publish('t1', 2)
    await expect(a).resolves.toBe(2); await expect(b).resolves.toBe(2)
    await expect(other).resolves.toBe(0)   // 超时返回当前值
  })
  it('超时返回当时的 seq', async () => {
    vi.useFakeTimers()
    const hub = makeTaskChangeHub(); hub.publish('t1', 1)
    const p = hub.wait('t1', 1, 100)
    vi.advanceTimersByTime(100)
    await expect(p).resolves.toBe(1)
    vi.useRealTimers()
  })
  it('每任务 waiter 上限:超出的直接返回当前 seq,不挂', async () => {
    const hub = makeTaskChangeHub({ maxWaitersPerTask: 2 })
    hub.publish('t1', 1)
    const a = hub.wait('t1', 1, 5000), b = hub.wait('t1', 1, 5000)
    await expect(hub.wait('t1', 1, 5000)).resolves.toBe(1)
    hub.publish('t1', 2); await a; await b
  })
  it('dispose 唤醒所有 waiter', async () => {
    const hub = makeTaskChangeHub(); hub.publish('t1', 1)
    const p = hub.wait('t1', 1, 5000); hub.dispose()
    await expect(p).resolves.toBe(1)
  })
})
