import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import type { ConnState } from '../backend/types'
import { makePushRunner, nextSyncAction, type PushStatus } from './register'

const base = { live: true, conn: 'online' as ConnState, status: 'idle' as PushStatus, epoch: 1, lastEpoch: null as number | null }

describe('nextSyncAction —— PushProvider 什么时候跑 syncPush', () => {
  it('不是真连接 / 没配对 ⇒ 什么都不做', () => {
    expect(nextSyncAction({ ...base, live: false, trigger: 'online' })).toBe('none')
    expect(nextSyncAction({ ...base, live: false, trigger: 'foreground', status: 'denied', conn: 'connecting' })).toBe('none')
  })
  it('上线:这条连接还没同步过就跑(已登记也跑,裁决 C3:token / 权限可能变了);离线时不跑', () => {
    expect(nextSyncAction({ ...base, trigger: 'online' })).toBe('sync')
    expect(nextSyncAction({ ...base, status: 'registered', epoch: 2, lastEpoch: 1, trigger: 'online' })).toBe('sync')
    expect(nextSyncAction({ ...base, conn: 'offline', trigger: 'online' })).toBe('none')
  })
  it('同一条连接(epoch 没变)上的重复「上线」⇒ 不再跑:unavailable / failed 不会每次重渲染都重发登记', () => {
    for (const status of ['registered', 'unavailable', 'failed', 'offline', 'denied'] as const) {
      expect(nextSyncAction({ ...base, status, epoch: 3, lastEpoch: 3, trigger: 'online' }), status).toBe('none')
    }
  })
  it('回前台:在线就跑(刚在系统设置里打开了通知 / unavailable 也再试一次)', () => {
    expect(nextSyncAction({ ...base, status: 'denied', lastEpoch: 1, trigger: 'foreground' })).toBe('sync')
    expect(nextSyncAction({ ...base, status: 'unavailable', lastEpoch: 1, trigger: 'foreground' })).toBe('sync')
  })
  it('回前台但还没连上:denied ⇒ 只在本机重查权限(设置页状态跟着变);其余等上线', () => {
    expect(nextSyncAction({ ...base, conn: 'connecting', status: 'denied', trigger: 'foreground' })).toBe('recheck')
    expect(nextSyncAction({ ...base, conn: 'offline', status: 'denied', trigger: 'foreground' })).toBe('recheck')
    expect(nextSyncAction({ ...base, conn: 'connecting', status: 'registered', trigger: 'foreground' })).toBe('none')
    expect(nextSyncAction({ ...base, conn: 'revoked', status: 'denied', trigger: 'foreground' })).toBe('none')
  })
  it('token 变了 ⇒ 强制重登(在线时);撤销 / 离线时什么都不做', () => {
    expect(nextSyncAction({ ...base, status: 'registered', lastEpoch: 1, trigger: 'token' })).toBe('force')
    expect(nextSyncAction({ ...base, conn: 'revoked', status: 'registered', trigger: 'token' })).toBe('none')
    expect(nextSyncAction({ ...base, conn: 'offline', status: 'registered', trigger: 'token' })).toBe('none')
  })
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

function runner(over: { sync?: (force: boolean) => Promise<PushStatus>; recheck?: () => Promise<'granted' | 'denied' | 'undetermined'> } = {}) {
  const ctx = { live: true, conn: 'online' as ConnState, epoch: 1 }
  const statuses: PushStatus[] = []
  const logs: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const syncImpl = over.sync ?? (async () => 'registered' as const)
  const sync = vi.fn(async (force: boolean) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    try { return await syncImpl(force) } finally { inFlight-- }
  })
  const recheck = vi.fn(over.recheck ?? (async () => 'denied' as const))
  const r = makePushRunner({ ctx: () => ctx, sync, recheck, onStatus: s => statuses.push(s), log: l => logs.push(l) })
  return { r, ctx, sync, recheck, statuses, logs, maxInFlight: () => maxInFlight }
}

describe('makePushRunner —— 单飞、接住异常、按连接代数去重', () => {
  it('同时来的触发不会并发登记:跑着的时候来的排队,跑完再补一次', async () => {
    const d = deferred<PushStatus>()
    const h = runner({ sync: () => d.promise })
    const a = h.r.trigger('online')
    void h.r.trigger('foreground')
    void h.r.trigger('online')
    expect(h.sync).toHaveBeenCalledTimes(1)
    d.resolve('registered')
    await a
    await h.r.idle()
    expect(h.sync).toHaveBeenCalledTimes(2)       // 排队的 foreground 补跑一次;同一代的 online 不再跑
    expect(h.maxInFlight()).toBe(1)
    expect(h.r.status()).toBe('registered')
  })
  it('排队里有 token ⇒ 补跑的是强制重登', async () => {
    const d = deferred<PushStatus>()
    const h = runner({ sync: force => (force ? Promise.resolve('registered') : d.promise) })
    void h.r.trigger('online')
    void h.r.trigger('foreground')
    void h.r.trigger('token')
    d.resolve('registered')
    await h.r.idle()
    expect(h.sync.mock.calls.map(c => c[0])).toEqual([false, true])
  })
  it('syncPush 抛了(首次解锁前读钥匙串 / 登记成功后存指纹失败)⇒ failed,只记错误类名,不留未处理的拒绝', async () => {
    const secret = 'd' + 'ab'.repeat(24)
    const h = runner({ sync: async () => { throw Object.assign(new Error(`keychain ${secret}`), { name: 'KeychainError' }) } })
    await expect(h.r.trigger('online')).resolves.toBeUndefined()
    expect(h.r.status()).toBe('failed')
    expect(h.statuses).toEqual(['failed'])
    expect(h.logs).toEqual(['push: sync threw (KeychainError)'])
    expect(h.logs.join()).not.toContain(secret)
  })
  it('unavailable 之后:同一条连接上的「上线」不再重发;回前台 / 重连(新 epoch)才再试', async () => {
    const h = runner({ sync: async () => 'unavailable' })
    await h.r.trigger('online')
    await h.r.trigger('online')
    await h.r.trigger('online')
    expect(h.sync).toHaveBeenCalledTimes(1)
    await h.r.trigger('foreground')
    expect(h.sync).toHaveBeenCalledTimes(2)
    h.ctx.epoch = 2
    await h.r.trigger('online')
    expect(h.sync).toHaveBeenCalledTimes(3)
  })
  it('撤销后什么都不跑', async () => {
    const h = runner()
    h.ctx.conn = 'revoked'
    await h.r.trigger('online')
    await h.r.trigger('foreground')
    await h.r.trigger('token')
    expect(h.sync).not.toHaveBeenCalled()
    expect(h.recheck).not.toHaveBeenCalled()
  })
  it('reset(解除配对 / 换配对)时正在跑的那次结果作废;idle() 等它跑完(之后才清密钥)', async () => {
    const d = deferred<PushStatus>()
    const h = runner({ sync: () => d.promise })
    void h.r.trigger('online')
    h.r.reset()
    expect(h.r.status()).toBe('idle')
    let idle = false
    const w = h.r.idle().then(() => { idle = true })
    await Promise.resolve()
    expect(idle).toBe(false)
    d.resolve('registered')
    await w
    expect(h.r.status()).toBe('idle')
    expect(h.statuses).toEqual(['idle'])
    // reset 之后同一代连接可以再同步(新配对)
    h.ctx.epoch = 1
    await h.r.trigger('online')
    expect(h.sync).toHaveBeenCalledTimes(2)
  })
  it('reset 时旧的那次还在跑:reset 之后来的触发排队,旧的跑完照样补跑(不因代数变了被丢)', async () => {
    const d = deferred<PushStatus>()
    let n = 0
    const h = runner({ sync: () => (++n === 1 ? d.promise : Promise.resolve('registered')) })
    void h.r.trigger('online')
    h.r.reset()
    void h.r.trigger('online')          // 新配对的第一次上线:旧的还在跑 ⇒ 排队
    expect(h.sync).toHaveBeenCalledTimes(1)
    d.resolve('unavailable')
    await h.r.idle()
    expect(h.sync).toHaveBeenCalledTimes(2)
    expect(h.r.status()).toBe('registered')   // 旧结果作废,新结果生效
  })
  it('拒过通知、在系统设置里打开、回来时电脑还连不上 ⇒ 本机重查权限,状态变成「等连上再设好」;连上后照常登记', async () => {
    const h = runner({ sync: async () => 'denied', recheck: async () => 'granted' })
    await h.r.trigger('online')
    expect(h.r.status()).toBe('denied')
    h.ctx.conn = 'connecting'
    await h.r.trigger('foreground')
    expect(h.recheck).toHaveBeenCalledTimes(1)
    expect(h.r.status()).toBe('offline')
    h.sync.mockImplementation(async () => 'registered')
    h.ctx.conn = 'online'; h.ctx.epoch = 2
    await h.r.trigger('online')
    expect(h.r.status()).toBe('registered')
  })
  it('重查权限还是拒 ⇒ 仍是 denied', async () => {
    const h = runner({ sync: async () => 'denied' })
    await h.r.trigger('online')
    h.ctx.conn = 'offline'
    await h.r.trigger('foreground')
    expect(h.r.status()).toBe('denied')
  })
})

describe('native.ts 的钥匙串 / category 选项(源码守卫:native.ts 引 expo,单测里 import 不了)', () => {
  const src = readFileSync(new URL('./native.ts', import.meta.url), 'utf8')
  it('推送密钥读 / 写 / 删共用一组选项:service、iOS access group(extra.keychainGroup)、AFTER_FIRST_UNLOCK', () => {
    const shared = src.slice(src.indexOf('shared: {'), src.indexOf('local:'))
    expect(shared).toContain('keychainService: PUSH_KEY_SERVICE')
    expect(shared).toContain('keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK')
    expect(shared).toMatch(/Platform\.OS === 'ios'[^\n]*accessGroup: extra\.keychainGroup/)
  })
  it('五个 category 都注册,且不带任何动作', () => {
    expect(src).toContain("['th.approval', 'th.question', 'th.done', 'th.failed', 'th.test']")
    expect(src).toContain('setNotificationCategoryAsync(id, [])')
  })
  it('解除 / 撤销:清密钥的同时向系统注销推送', () => {
    expect(src).toMatch(/pushKeys\.clear\(\), Notifications\.unregisterForNotificationsAsync\(\)/)
  })
})
