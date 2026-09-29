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
  it('publish 不前进(seq 未超过已知值)不唤醒;真正前进才唤醒所有 waiter', async () => {
    const hub = makeTaskChangeHub(); hub.publish('t1', 1)
    const a = hub.wait('t1', 1, 5000), b = hub.wait('t1', 1, 5000)
    let aSettled = false, bSettled = false
    void a.then(() => { aSettled = true }); void b.then(() => { bSettled = true })
    hub.publish('t1', 1)
    await new Promise(r => setTimeout(r, 5))
    expect(aSettled).toBe(false); expect(bSettled).toBe(false)
    hub.publish('t1', 2)
    await expect(a).resolves.toBe(2); await expect(b).resolves.toBe(2)
  })
  it('dispose 唤醒所有 waiter', async () => {
    const hub = makeTaskChangeHub(); hub.publish('t1', 1)
    const p = hub.wait('t1', 1, 5000); hub.dispose()
    await expect(p).resolves.toBe(1)
  })
  it('publish 一个比缓存低的 seq ⇒ 只回落缓存、不唤醒;之后真正前进才唤醒(自愈幻影提前的 hub)', async () => {
    const hub = makeTaskChangeHub()
    hub.publish('t1', 3)
    const stale = hub.wait('t1', 3, 5000)          // parks: cached(3) 不大于 since(3)
    let staleSettled = false; void stale.then(() => { staleSettled = true })
    hub.publish('t1', 2)                            // 比缓存低 ⇒ 缓存回落,不唤醒
    expect(hub.seq('t1')).toBe(2)
    await new Promise(r => setTimeout(r, 5))
    expect(staleSettled).toBe(false)
    const b = hub.wait('t1', 2, 5000)               // 缓存已回落到 2,这里也会挂起
    hub.publish('t1', 3)                            // 真正前进(3>2)⇒ 唤醒所有挂起的 waiter
    await expect(stale).resolves.toBe(3)
    await expect(b).resolves.toBe(3)
  })
  it('onChange:前进的 publish 才回调,携带 taskId 与新 seq', async () => {
    const hub = makeTaskChangeHub()
    const calls: Array<[string, number]> = []
    hub.onChange((taskId, seq) => calls.push([taskId, seq]))
    hub.publish('t1', 1)
    expect(calls).toEqual([['t1', 1]])
    hub.publish('t2', 5)
    expect(calls).toEqual([['t1', 1], ['t2', 5]])
  })
  it('onChange:不前进(相等)或回落(变小)都不回调', async () => {
    const hub = makeTaskChangeHub()
    const calls: Array<[string, number]> = []
    hub.publish('t1', 3)
    hub.onChange((taskId, seq) => calls.push([taskId, seq]))
    hub.publish('t1', 3)   // 相等,不前进
    hub.publish('t1', 2)   // 回落
    expect(calls).toEqual([])
    hub.publish('t1', 4)   // 真前进
    expect(calls).toEqual([['t1', 4]])
  })
  it('onChange 退订后不再收到回调', async () => {
    const hub = makeTaskChangeHub()
    const calls: number[] = []
    const off = hub.onChange((_taskId, seq) => calls.push(seq))
    hub.publish('t1', 1)
    off()
    hub.publish('t1', 2)
    expect(calls).toEqual([1])
  })
  it('onChange 一个回调抛错不影响 publish 本身与其他回调', async () => {
    const hub = makeTaskChangeHub()
    const calls: number[] = []
    hub.onChange(() => { throw new Error('boom') })
    hub.onChange((_taskId, seq) => calls.push(seq))
    expect(() => hub.publish('t1', 1)).not.toThrow()
    expect(calls).toEqual([1])
    expect(hub.seq('t1')).toBe(1)
  })
  it('dispose 清空 onChange 回调', async () => {
    const hub = makeTaskChangeHub()
    const calls: number[] = []
    hub.onChange((_taskId, seq) => calls.push(seq))
    hub.publish('t1', 1)
    hub.dispose()
    hub.publish('t1', 2)
    expect(calls).toEqual([1])
  })
  it('超时 waiter 被剪枝,不占用上限配额', async () => {
    vi.useFakeTimers()
    const hub = makeTaskChangeHub({ maxWaitersPerTask: 8 })
    hub.publish('t1', 1)
    // 连续 9 次 wait 各超时;不被剪枝的话第 8 个之后就回不去了
    for (let i = 0; i < 9; i++) {
      const p = hub.wait('t1', 1, 50)
      vi.advanceTimersByTime(50)
      await expect(p).resolves.toBe(1)
    }
    // 第 10 次 wait 必须仍然挂起(不是因为配额满而立即返回)
    let settled = false
    const p = hub.wait('t1', 1, 5000)
    void p.then(() => { settled = true })
    vi.advanceTimersByTime(10); expect(settled).toBe(false)
    hub.publish('t1', 2)
    await expect(p).resolves.toBe(2)
    vi.useRealTimers()
  })
})
