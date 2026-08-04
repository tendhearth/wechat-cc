import { describe, it, expect, vi } from 'vitest'
import { makeSelfRestartCheck } from './wire'
import { BOOT_GRACE_MS } from './stale-code'

const BOOT = 1_000_000
function setup(over: Record<string, unknown> = {}) {
  const t = { ms: BOOT + BOOT_GRACE_MS }
  const restarts: number[] = []
  const check = makeSelfRestartCheck({
    cwd: '/repo',
    loadedHead: 'aaa111',
    now: () => t.ms,
    bootAtMs: BOOT,
    anyInFlight: () => false,
    quietFor: () => Number.POSITIVE_INFINITY,
    requestRestart: () => { restarts.push(t.ms) },
    log: () => {},
    readHead: async () => 'bbb222',
    ...over,
  } as never)
  return { t, restarts, check }
}

describe('makeSelfRestartCheck', () => {
  it('陈旧 + 空闲 ⇒ 触发既有的 requestRestart', async () => {
    const { restarts, check } = setup()
    await check()
    expect(restarts).toHaveLength(1)
  })

  it('有在途轮次 ⇒ 不重启', async () => {
    const { restarts, check } = setup({ anyInFlight: () => true })
    await check()
    expect(restarts).toEqual([])
  })

  it('最近 2 分钟内有入站 ⇒ 不重启', async () => {
    const { restarts, check } = setup({ quietFor: () => 119_000 })
    await check()
    expect(restarts).toEqual([])
  })

  it('刚好静默满 2 分钟 ⇒ 重启', async () => {
    const { restarts, check } = setup({ quietFor: () => 120_000 })
    await check()
    expect(restarts).toHaveLength(1)
  })

  it('只触发一次 —— 重启已在进行,后续 tick 不再重复请求', async () => {
    const { restarts, check } = setup()
    await check()
    await check()
    await check()
    expect(restarts).toHaveLength(1)
  })

  it('读 HEAD 失败 ⇒ 不重启也不抛', async () => {
    const { restarts, check } = setup({ readHead: async () => null })
    await expect(check()).resolves.toBeUndefined()
    expect(restarts).toEqual([])
  })

  it('readHead 抛异常 ⇒ 吞掉,不打断调用它的 tick', async () => {
    const { restarts, check } = setup({ readHead: async () => { throw new Error('boom') } })
    await expect(check()).resolves.toBeUndefined()
    expect(restarts).toEqual([])
  })

  it('requestRestart 抛异常 ⇒ 吞掉', async () => {
    const { check } = setup({ requestRestart: () => { throw new Error('boom') } })
    await expect(check()).resolves.toBeUndefined()
  })
})
