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
})
