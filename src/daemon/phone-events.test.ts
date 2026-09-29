import { describe, it, expect, vi } from 'vitest'
import { makePhoneEvents, type TopicSource } from './phone-events'

/** 放开一拍宏任务,等所有已排的微任务(Promise 链)先跑完。 */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('makePhoneEvents', () => {
  it('订阅时算一次快照并发送;since 与当下 {epoch,seq} 一致就不重发', async () => {
    const source: TopicSource = { match: t => t === 'home', snapshot: async () => ({ b: 2, a: 1 }) }
    const hub = makePhoneEvents({ sources: [source] })
    const received: Array<{ epoch: string; seq: number; data: unknown }> = []
    hub.subscribe('home', undefined, ev => received.push(ev))
    await tick()
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ seq: 1, data: { a: 1, b: 2 } })
    const { epoch, seq } = received[0]!

    const received2: unknown[] = []
    hub.subscribe('home', { epoch, seq }, ev => received2.push(ev))
    await tick()
    expect(received2).toHaveLength(0) // since 命中,省一次发送

    hub.dispose()
  })

  it('since 的 epoch 不匹配(daemon 重启过)⇒ 照样发,不当成命中', async () => {
    const source: TopicSource = { match: t => t === 'home', snapshot: async () => ({ v: 1 }) }
    const hub = makePhoneEvents({ sources: [source] })
    const received: unknown[] = []
    hub.subscribe('home', { epoch: 'stale-epoch', seq: 1 }, ev => received.push(ev))
    await tick()
    expect(received).toHaveLength(1)
    hub.dispose()
  })

  it('快照不变不广播;变了才 seq+1、广播给该主题所有订阅者', async () => {
    let value: Record<string, number> = { x: 1 }
    const source: TopicSource = { match: t => t === 'agents', snapshot: async () => value }
    const hub = makePhoneEvents({ sources: [source] })
    const r1: Array<{ seq: number }> = []
    const r2: Array<{ seq: number }> = []
    hub.subscribe('agents', undefined, ev => r1.push(ev))
    await tick()
    hub.subscribe('agents', undefined, ev => r2.push(ev))
    await tick()
    expect(r1).toHaveLength(1) // r1 已经是最新的,这一轮不重发给它
    expect(r2).toHaveLength(1)

    hub.poke()
    await tick()
    expect(r1).toHaveLength(1) // 数据没变,谁都不重发
    expect(r2).toHaveLength(1)

    value = { x: 2 }
    hub.poke()
    await tick()
    expect(r1).toHaveLength(2) // 变了 ⇒ 该主题所有订阅者都收到
    expect(r2).toHaveLength(2)
    expect(r1[1]!.seq).toBe(r2[1]!.seq)
    expect(r1[1]!.seq).toBe(r1[0]!.seq + 1)

    hub.dispose()
  })

  it('send 抛错只移除那一个订阅,其它订阅者不受影响', async () => {
    let value = 1
    const source: TopicSource = { match: t => t === 'home', snapshot: async () => ({ v: value }) }
    const hub = makePhoneEvents({ sources: [source] })
    const good: unknown[] = []
    hub.subscribe('home', undefined, () => {
      throw new Error('boom')
    })
    hub.subscribe('home', undefined, ev => good.push(ev))
    await tick()
    await tick()
    expect(good).toHaveLength(1)

    value = 2
    hub.poke()
    await tick()
    expect(good).toHaveLength(2) // 坏的那个已经被摘掉,不再拖累好的这个

    hub.dispose()
  })

  it('来源抛错:本轮跳过、记一条日志,其它主题不受影响;来源恢复后能补上', async () => {
    let shouldThrow = true
    const logs: Array<[string, string]> = []
    const sourceHome: TopicSource = {
      match: t => t === 'home',
      snapshot: async () => {
        if (shouldThrow) throw new Error('down')
        return { ok: true }
      },
    }
    const sourceAgents: TopicSource = { match: t => t === 'agents', snapshot: async () => ({ ok: true }) }
    const hub = makePhoneEvents({ sources: [sourceHome, sourceAgents], log: (tag, line) => logs.push([tag, line]) })
    const homeEvents: unknown[] = []
    const agentEvents: unknown[] = []
    hub.subscribe('home', undefined, ev => homeEvents.push(ev))
    hub.subscribe('agents', undefined, ev => agentEvents.push(ev))
    await tick()
    await tick()
    expect(homeEvents).toHaveLength(0) // 来源抛错,这轮啥都没发出去
    expect(agentEvents).toHaveLength(1) // 另一个主题不受影响
    expect(logs).toHaveLength(1)
    expect(logs[0]![0]).toBe('phone-events')

    shouldThrow = false
    hub.poke()
    await tick()
    await tick()
    expect(homeEvents).toHaveLength(1) // 源恢复后能补上

    hub.dispose()
  })

  it('没有订阅者的主题不计算', async () => {
    let calls = 0
    const source: TopicSource = {
      match: t => t === 'home',
      snapshot: async () => {
        calls++
        return { n: calls }
      },
    }
    const hub = makePhoneEvents({ sources: [source] })
    hub.poke()
    await tick()
    expect(calls).toBe(0)
    hub.dispose()
  })

  it('poll 定时器缺省 2000ms、unref 过', () => {
    const realSetInterval = globalThis.setInterval
    let capturedMs: number | undefined
    let unrefCalled = false
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((((fn: (...a: unknown[]) => void, ms?: number) => {
      capturedMs = ms
      const t = realSetInterval(fn as never, ms) as unknown as { unref: () => void }
      const realUnref = t.unref.bind(t)
      t.unref = () => {
        unrefCalled = true
        return realUnref()
      }
      return t
    }) as unknown) as typeof globalThis.setInterval)

    const hub = makePhoneEvents({ sources: [] })
    expect(capturedMs).toBe(2000)
    expect(unrefCalled).toBe(true)

    hub.dispose()
    spy.mockRestore()
  })

  it('pollMs 可覆盖', () => {
    const realSetInterval = globalThis.setInterval
    let capturedMs: number | undefined
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((((fn: (...a: unknown[]) => void, ms?: number) => {
      capturedMs = ms
      return realSetInterval(fn as never, ms)
    }) as unknown) as typeof globalThis.setInterval)

    const hub = makePhoneEvents({ sources: [], pollMs: 250 })
    expect(capturedMs).toBe(250)

    hub.dispose()
    spy.mockRestore()
  })

  it('dispose 清定时器与订阅;之后的 subscribe/poke/dispose 都是空操作', async () => {
    let calls = 0
    const source: TopicSource = {
      match: t => t === 'home',
      snapshot: async () => {
        calls++
        return { calls }
      },
    }
    const hub = makePhoneEvents({ sources: [source], pollMs: 5 })
    hub.subscribe('home', undefined, () => {})
    await tick()
    const before = calls

    hub.dispose()

    const received: unknown[] = []
    const unsub = hub.subscribe('home', undefined, ev => received.push(ev))
    hub.poke()
    await new Promise(resolve => setTimeout(resolve, 20)) // 就算定时器没清也不该再触发

    expect(calls).toBe(before)
    expect(received).toHaveLength(0)
    expect(() => hub.dispose()).not.toThrow()
    expect(() => unsub()).not.toThrow()
  })

  it('连续 10 次 poke 合并成一轮重算;不在调用栈内同步执行', async () => {
    let calls = 0
    const source: TopicSource = {
      match: t => t === 'home',
      snapshot: async () => {
        calls++
        return { n: calls }
      },
    }
    const hub = makePhoneEvents({ sources: [source] })
    hub.subscribe('home', undefined, () => {})
    await tick()
    const before = calls

    for (let i = 0; i < 10; i++) hub.poke()
    expect(calls).toBe(before) // 还没让出调用栈,一次都没重算 —— 证明不是同步的

    await tick()
    expect(calls).toBe(before + 1) // 合并成了一轮

    hub.dispose()
  })

  it('同一主题的重算不重叠;进行中的多次 poke 只追加一轮', async () => {
    let calls = 0
    let pending: Array<(v: unknown) => void> = []
    const source: TopicSource = {
      match: t => t === 'home',
      snapshot: () =>
        new Promise(resolve => {
          calls++
          pending.push(resolve)
        }),
    }
    const hub = makePhoneEvents({ sources: [source] })
    hub.subscribe('home', undefined, () => {})
    await tick()
    expect(calls).toBe(1)
    pending.shift()!({ n: 1 }) // 放开订阅触发的第一轮
    await tick()
    expect(calls).toBe(1) // 没有新的 poke/subscribe,不该再算

    hub.poke()
    await tick()
    expect(calls).toBe(2) // 新的一轮正在进行中(snapshot 还没 resolve)

    hub.poke()
    hub.poke()
    hub.poke()
    await tick()
    expect(calls).toBe(2) // 进行中收到的多次 poke 没有并发开出新的 snapshot() 调用

    pending.shift()!({ n: 2 }) // 放开进行中的这一轮
    await tick()
    expect(calls).toBe(3) // dirty 标记只追加了一轮(不是三轮)

    pending.shift()!({ n: 3 })
    await tick()
    expect(calls).toBe(3) // 追加的那轮完成后没有更多 dirty,不再重算

    hub.dispose()
  })

  it('支持 matter/<id> 这类带前缀的主题;来源按 match 决定谁接', async () => {
    const source: TopicSource = {
      match: t => t.startsWith('matter/'),
      snapshot: async t => ({ id: t.slice('matter/'.length) }),
    }
    const hub = makePhoneEvents({ sources: [source] })
    const events: Array<{ data: unknown }> = []
    hub.subscribe('matter/abc123', undefined, ev => events.push(ev))
    await tick()
    expect(events).toMatchObject([{ data: { id: 'abc123' } }])
    hub.dispose()
  })

  it('稳定序列化:键顺序不同但值相同 ⇒ 不算变化(不广播)', async () => {
    let value: Record<string, unknown> = { a: 1, b: { y: 2, x: 1 } }
    const source: TopicSource = { match: t => t === 'home', snapshot: async () => value }
    const hub = makePhoneEvents({ sources: [source] })
    const received: Array<{ seq: number }> = []
    hub.subscribe('home', undefined, ev => received.push(ev))
    await tick()
    expect(received).toHaveLength(1)

    value = { b: { x: 1, y: 2 }, a: 1 } // 键顺序不同,值一样
    hub.poke()
    await tick()
    expect(received).toHaveLength(1) // 没有被当成变化

    hub.dispose()
  })
})
