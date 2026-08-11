import { describe, it, expect } from 'vitest'
import { makeSelfRestartCheck, type SelfRestartDeps } from './wire'
import { BOOT_GRACE_MS } from './stale-code'

const BOOT = 1_000_000
// Deliberately NOT `as never`: that cast is what let a newly-required dep
// (bootLockBlob) slip past every one of these tests while the production
// call site went unwired. Typed overrides make the compiler the guard.
function setup(over: Partial<SelfRestartDeps> = {}) {
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
    // Lockfile unchanged between boot and now ⇒ the drift guard is a no-op
    // for every test that isn't specifically about it.
    bootLockBlob: 'lock000',
    readLockBlob: async () => 'lock000',
    readDirty: async () => 'clean' as const,
    busy: () => false,
    lastPollSuccessAgoMs: () => 0,
    ...over,
  })
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

  // Task 3 review #2 —— 依赖树可能对不上时,宁可永远不重启。
  it('bun.lock 在开机后变了 ⇒ 不重启(bun install 可能还没跟上)', async () => {
    const { restarts, check } = setup({ readLockBlob: async () => 'lock999' })
    await check()
    expect(restarts).toEqual([])
  })

  it('开机时读不到 bun.lock ⇒ 永远不重启', async () => {
    const { restarts, check } = setup({ bootLockBlob: null })
    await check()
    expect(restarts).toEqual([])
  })

  it('检查时读不到 bun.lock ⇒ 不重启', async () => {
    const { restarts, check } = setup({ readLockBlob: async () => null })
    await check()
    expect(restarts).toEqual([])
  })

  it('readLockBlob 抛异常 ⇒ 吞掉,不重启', async () => {
    const { restarts, check } = setup({ readLockBlob: async () => { throw new Error('boom') } })
    await expect(check()).resolves.toBeUndefined()
    expect(restarts).toEqual([])
  })

  // 最终评审 C2 —— 比的是 HEAD,加载的是工作树。daemon 跑的就是主人日常
  // 开发的那个 checkout,所以"HEAD 动了"完全可能对应半截的磁盘状态;那样
  // 重启会让新进程起不来,launchd 每 10 秒重试一次,bot 彻底下线还不吭声。
  it('工作树有未提交改动 ⇒ 不重启', async () => {
    const { restarts, check } = setup({ readDirty: async () => 'dirty' })
    await check()
    expect(restarts).toEqual([])
  })

  it('问不出工作树状态 ⇒ 当作脏,不重启', async () => {
    const { restarts, check } = setup({ readDirty: async () => null })
    await check()
    expect(restarts).toEqual([])
  })

  it('readDirty 抛异常 ⇒ 吞掉,不重启', async () => {
    const { restarts, check } = setup({ readDirty: async () => { throw new Error('boom') } })
    await expect(check()).resolves.toBeUndefined()
    expect(restarts).toEqual([])
  })

  // 最终评审 I2 —— 空闲是在最开头采样的,而三次 git 调用最坏要花约 9 秒。
  // 退出不可撤销,所以临门必须再查一次。
  it('git 调用期间来了新活动 ⇒ 临门复查拦下,不重启', async () => {
    let inFlight = false
    const { restarts, check } = setup({
      anyInFlight: () => inFlight,
      // 模拟"读 HEAD 期间主人开始了一轮对话"
      readHead: async () => { inFlight = true; return 'bbb222' },
    })
    await check()
    expect(restarts).toEqual([])
  })

  it('git 调用期间来了入站消息 ⇒ 临门复查拦下,不重启', async () => {
    let quiet = Number.POSITIVE_INFINITY
    const { restarts, check } = setup({
      quietFor: () => quiet,
      readHead: async () => { quiet = 0; return 'bbb222' },
    })
    await check()
    expect(restarts).toEqual([])
  })

  // Task 3 review #3 —— 廉价判断前置之后,判定语义必须一字不变;
  // 这几条钉住"该省的 spawn 真省了",省错了就会变成"该重启却不重启"。
  it('仍在 5 分钟宽限期内 ⇒ 不重启,且根本不 spawn git', async () => {
    let spawned = 0
    const { t, restarts, check } = setup({ readHead: async () => { spawned++; return 'bbb222' } })
    t.ms = BOOT + BOOT_GRACE_MS - 1
    await check()
    expect(restarts).toEqual([])
    expect(spawned).toBe(0)
  })

  it('不空闲 ⇒ 不重启,且根本不 spawn git', async () => {
    let spawned = 0
    const { restarts, check } = setup({
      anyInFlight: () => true,
      readHead: async () => { spawned++; return 'bbb222' },
    })
    await check()
    expect(restarts).toEqual([])
    expect(spawned).toBe(0)
  })

  it('非 git checkout(loadedHead 为 null)⇒ 不重启,且根本不 spawn git', async () => {
    let spawned = 0
    const { restarts, check } = setup({
      loadedHead: null,
      readHead: async () => { spawned++; return 'bbb222' },
    })
    await check()
    expect(restarts).toEqual([])
    expect(spawned).toBe(0)
  })

  // spec 2026-08-11 §5 —— busy 登记处
  it('登记处有工作在跑 ⇒ 不重启,且不 spawn git', async () => {
    let spawned = 0
    const { restarts, check } = setup({ busy: () => true, readHead: async () => { spawned++; return 'bbb222' } })
    await check()
    expect(restarts).toEqual([])
    expect(spawned).toBe(0)
  })
  it('busy() 抛异常 ⇒ 吞掉,不重启', async () => {
    const { restarts, check } = setup({ busy: () => { throw new Error('boom') } })
    await expect(check()).resolves.toBeUndefined()
    expect(restarts).toEqual([])
  })
  it('git 调用期间登记处出现工作 ⇒ 临门复查拦下', async () => {
    let b = false
    const { restarts, check } = setup({ busy: () => b, readHead: async () => { b = true; return 'bbb222' } })
    await check()
    expect(restarts).toEqual([])
  })

  // spec 2026-08-11 §4 —— poll 新鲜度(唤醒闸门)
  it('poll 从未成功(null)⇒ 不重启', async () => {
    const { restarts, check } = setup({ lastPollSuccessAgoMs: () => null })
    await check()
    expect(restarts).toEqual([])
  })
  it('上次 poll 成功已超过 2 分钟(如睡眠唤醒)⇒ 不重启', async () => {
    const { restarts, check } = setup({ lastPollSuccessAgoMs: () => 120_001 })
    await check()
    expect(restarts).toEqual([])
  })
  it('恰好 2 分钟整 ⇒ 仍算新鲜,重启', async () => {
    const { restarts, check } = setup({ lastPollSuccessAgoMs: () => 120_000 })
    await check()
    expect(restarts).toHaveLength(1)
  })
})
