import { describe, expect, it } from 'vitest'
import { makeChatMutex } from './async-mutex'

/** A promise + external resolve, for gating fn execution without real timers. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('makeChatMutex', () => {
  it('serializes overlapping runExclusive calls for the SAME chatId', async () => {
    const mutex = makeChatMutex()
    const order: string[] = []
    const gate1 = deferred<void>()

    const p1 = mutex.runExclusive('c1', async () => {
      order.push('fn1-start')
      await gate1.promise
      order.push('fn1-end')
    })

    // Let fn1 actually start (it's synchronous up to the await).
    await Promise.resolve()
    expect(order).toEqual(['fn1-start'])

    const p2 = mutex.runExclusive('c1', async () => {
      order.push('fn2-start')
    })

    // fn2 must NOT have started yet — fn1 is still gated.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['fn1-start'])

    gate1.resolve()
    await Promise.all([p1, p2])

    expect(order).toEqual(['fn1-start', 'fn1-end', 'fn2-start'])
  })

  it('runs DIFFERENT chatIds fully concurrently (no cross-key blocking)', async () => {
    const mutex = makeChatMutex()
    const gateA = deferred<void>()
    const gateB = deferred<void>()
    const entered: string[] = []

    const pA = mutex.runExclusive('a', async () => {
      entered.push('a')
      await gateA.promise
      return 'a-done'
    })
    const pB = mutex.runExclusive('b', async () => {
      entered.push('b')
      await gateB.promise
      return 'b-done'
    })

    // Both must have entered before either gate is released — proves
    // they're not waiting on each other.
    await Promise.resolve()
    await Promise.resolve()
    expect(entered.sort()).toEqual(['a', 'b'])

    gateB.resolve()
    gateA.resolve()
    await expect(pA).resolves.toBe('a-done')
    await expect(pB).resolves.toBe('b-done')
  })

  it('a throwing fn releases the lock — the next call on the same chatId still runs', async () => {
    const mutex = makeChatMutex()

    const p1 = mutex.runExclusive('c1', async () => {
      throw new Error('boom')
    })
    await expect(p1).rejects.toThrow('boom')

    let ran = false
    const p2 = mutex.runExclusive('c1', async () => {
      ran = true
      return 'ok'
    })
    await expect(p2).resolves.toBe('ok')
    expect(ran).toBe(true)
  })

  it('a throwing fn does not block a DIFFERENT concurrently-queued waiter on the same chatId', async () => {
    // fn1 throws; fn2 was already queued behind it (not yet started) — fn2
    // must still run once fn1 settles, proving the chain isn't poisoned.
    const mutex = makeChatMutex()
    const order: string[] = []

    const p1 = mutex.runExclusive('c1', async () => {
      order.push('fn1')
      throw new Error('boom')
    })
    const p2 = mutex.runExclusive('c1', async () => {
      order.push('fn2')
      return 'fn2-result'
    })

    await expect(p1).rejects.toThrow('boom')
    await expect(p2).resolves.toBe('fn2-result')
    expect(order).toEqual(['fn1', 'fn2'])
  })

  it('cleans up the map entry once a chatId chain drains (no unbounded growth)', async () => {
    const mutex = makeChatMutex()
    expect(mutex._size()).toBe(0)

    await mutex.runExclusive('c1', async () => 'done')

    // Cleanup happens in a microtask after the tail settles; flush it.
    await Promise.resolve()
    await Promise.resolve()
    expect(mutex._size()).toBe(0)
  })

  it('does not leak entries across many different chatIds after they all drain', async () => {
    const mutex = makeChatMutex()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => mutex.runExclusive(`chat-${i}`, async () => i)),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(mutex._size()).toBe(0)
  })
})
