import { describe, it, expect } from 'vitest'
import { AsyncQueue } from './async-queue'

describe('AsyncQueue — contract snapshot (collectTurn watchdog depends on it)', () => {
  it('push before consume buffers; end() drains parked consumers with done', async () => {
    const q = new AsyncQueue<number>()
    q.push(1); q.push(2)
    const it = q.iterable()[Symbol.asyncIterator]()
    expect((await it.next()).value).toBe(1)
    expect((await it.next()).value).toBe(2)
    const pending = it.next()
    q.end()
    expect((await pending).done).toBe(true)
  })

  it('buffered items remain drainable after end(); push after end() is a silent no-op', async () => {
    const q = new AsyncQueue<number>()
    q.push(1); q.end(); q.push(99)
    const it = q.iterable()[Symbol.asyncIterator]()
    expect((await it.next())).toEqual({ value: 1, done: false })
    expect((await it.next()).done).toBe(true)
  })

  it('return() resolves same-tick (the collectTurn watchdog contract) and closes the queue', async () => {
    const q = new AsyncQueue<number>()
    const it = q.iterable()[Symbol.asyncIterator]()
    let settled = false
    const p = it.return!().then(r => { settled = true; return r })
    await Promise.resolve()          // one microtask — a sync-resolved promise has settled by now
    expect(settled).toBe(true)
    expect((await p).done).toBe(true)
    expect((await it.next()).done).toBe(true)
  })
})
