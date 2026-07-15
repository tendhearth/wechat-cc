import { describe, expect, it } from 'vitest'
import { createPendingConfirms } from './pending-confirm'

describe('createPendingConfirms', () => {
  it('ask + resolve("是") → true', async () => {
    const pc = createPendingConfirms()
    const p = pc.ask('k1', 5000)
    expect(pc.resolve('k1', '是')).toBe(true)
    expect(await p).toBe(true)
  })

  it('ask + resolve("否") → false', async () => {
    const pc = createPendingConfirms()
    const p = pc.ask('k1', 5000)
    expect(pc.resolve('k1', '否')).toBe(true)
    expect(await p).toBe(false)
  })

  it('accepts case-insensitive yes/no synonyms (y, YES, ok, 好, 同意, 行)', async () => {
    const pc = createPendingConfirms()
    for (const word of ['y', 'YES', 'ok', '好', '同意', '行', ' 是 ']) {
      const p = pc.ask('k', 5000)
      pc.resolve('k', word)
      expect(await p).toBe(true)
    }
  })

  it('unrecognized text resolves to false (treated as no)', async () => {
    const pc = createPendingConfirms()
    const p = pc.ask('k1', 5000)
    expect(pc.resolve('k1', '随便什么')).toBe(true)
    expect(await p).toBe(false)
  })

  it('times out to false when nobody resolves in time', async () => {
    const pc = createPendingConfirms()
    const p = pc.ask('k1', 20)
    expect(await p).toBe(false)
  })

  it('resolve with no pending key → returns false', () => {
    const pc = createPendingConfirms()
    expect(pc.resolve('nope', '是')).toBe(false)
  })

  it('double-resolve → second resolve returns false', async () => {
    const pc = createPendingConfirms()
    const p = pc.ask('k1', 5000)
    expect(pc.resolve('k1', '是')).toBe(true)
    expect(pc.resolve('k1', '否')).toBe(false)
    expect(await p).toBe(true)
  })

  it('a resolved key does not fire the timeout afterward', async () => {
    const pc = createPendingConfirms()
    const p = pc.ask('k1', 20)
    pc.resolve('k1', '是')
    expect(await p).toBe(true)
    // wait past the original timeout window; resolving again should still be false (already removed)
    await new Promise(r => setTimeout(r, 40))
    expect(pc.resolve('k1', '是')).toBe(false)
  })

  describe('hasPending', () => {
    it('true when a pending key equals the prefix exactly', () => {
      const pc = createPendingConfirms()
      pc.ask('op', 5000)
      expect(pc.hasPending('op')).toBe(true)
    })

    it('true when a pending key starts with "prefix:"', () => {
      const pc = createPendingConfirms()
      pc.ask('op:intent-1', 5000)
      expect(pc.hasPending('op')).toBe(true)
    })

    it('false when no pending key matches the prefix', () => {
      const pc = createPendingConfirms()
      pc.ask('other:intent-1', 5000)
      expect(pc.hasPending('op')).toBe(false)
    })

    it('false when a pending key merely contains the prefix without the ":" boundary', () => {
      const pc = createPendingConfirms()
      pc.ask('operator:intent-1', 5000)
      expect(pc.hasPending('op')).toBe(false)
    })
  })

  describe('resolveByOwner', () => {
    it('"是" → "yes" and resolves the ask to true', async () => {
      const pc = createPendingConfirms()
      const p = pc.ask('op:intent-1', 5000)
      expect(pc.resolveByOwner('op', '是')).toBe('yes')
      expect(await p).toBe(true)
    })

    it('"否" → "no" and resolves the ask to false', async () => {
      const pc = createPendingConfirms()
      const p = pc.ask('op:intent-1', 5000)
      expect(pc.resolveByOwner('op', '否')).toBe('no')
      expect(await p).toBe(false)
    })

    it('tolerates trailing punctuation / emoji on a real reply ("是。", "好的~", "yes!")', async () => {
      for (const reply of ['是。', '好的~', 'yes!', 'ok 👍']) {
        const pc = createPendingConfirms()
        const p = pc.ask('op:intent-1', 5000)
        expect(pc.resolveByOwner('op', reply)).toBe('yes')
        expect(await p).toBe(true)
      }
    })

    it('unclear text → "unclear" and resolves NOTHING (the ask stays pending)', async () => {
      const pc = createPendingConfirms()
      const p = pc.ask('op:intent-1', 5000)
      expect(pc.resolveByOwner('op', '啥?')).toBe('unclear')
      expect(pc.hasPending('op')).toBe(true)
      // still pending — resolve it for real so the test doesn't leak a timer
      pc.resolve('op:intent-1', '是')
      expect(await p).toBe(true)
    })

    it('resolves the OLDEST matching entry first (Map insertion order = FIFO)', async () => {
      const pc = createPendingConfirms()
      const first = pc.ask('op:intent-1', 5000)
      const second = pc.ask('op:intent-2', 5000)
      expect(pc.resolveByOwner('op', '是')).toBe('yes')
      expect(await first).toBe(true)
      // second is still pending — resolve it directly to avoid leaking a timer
      expect(pc.hasPending('op')).toBe(true)
      pc.resolve('op:intent-2', '否')
      expect(await second).toBe(false)
    })

    it('no pending entry matches the prefix → "unclear"', () => {
      const pc = createPendingConfirms()
      pc.ask('other:intent-1', 5000)
      expect(pc.resolveByOwner('op', '是')).toBe('unclear')
    })
  })
})
