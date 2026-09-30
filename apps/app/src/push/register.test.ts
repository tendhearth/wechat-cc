import { describe, it, expect, vi } from 'vitest'
import { BackendError } from '../backend/types'
import { makePushKeyStore, PUSH_KEY_SERVICE } from './key-store'
import { memSecureStore } from './mem-secure-store'
import { syncPush, platformFor, permState, shouldSync, REREGISTER_MS, type PushDeps } from './register'

const TOKEN = 'd' + 'ab'.repeat(24)
const APNS = 'a1'.repeat(32)

function harness(over: Partial<PushDeps> = {}) {
  const { m, ss } = memSecureStore()
  const logs: string[] = []
  let now = 1_000_000
  const order: string[] = []
  const register = vi.fn(async () => { order.push('register') })
  const requestPermission = vi.fn(async () => { order.push('request'); return 'granted' as const })
  const keys = makePushKeyStore(ss, { shared: { keychainService: PUSH_KEY_SERVICE }, local: {} })
  const ensure = keys.ensure
  keys.ensure = async (t, l) => { order.push('ensure'); return ensure(t, l) }
  const d: PushDeps = {
    os: 'ios', apnsEnv: 'development', deviceId: 'ab12cd34', deviceToken: TOKEN, lang: null, keys,
    permission: async () => 'granted', requestPermission, nativeToken: async () => APNS, register,
    now: () => now, log: l => logs.push(l), ...over,
  }
  return { d, m, logs, register, requestPermission, order, tick: (ms: number) => { now += ms } }
}

describe('syncPush —— 配对后 / 启动 / token 刷新 / 回前台都走这一个', () => {
  it('已授权:先存推送密钥,再拿 token,登记 apns_sandbox;记下指纹', async () => {
    const h = harness()
    expect(await syncPush(h.d)).toBe('registered')
    expect(h.register).toHaveBeenCalledWith('apns_sandbox', APNS)
    expect(h.order[0]).toBe('ensure')
    expect(await h.d.keys.loadReg()).toEqual({ fp: `ab12cd34|apns_sandbox|${APNS}`, at: 1_000_000 })
  })
  it('24 小时内同一 token ⇒ 不再登记;过了 24 小时 / force / token 变了 ⇒ 再登记', async () => {
    const h = harness()
    await syncPush(h.d)
    expect(await syncPush(h.d)).toBe('registered')
    expect(h.register).toHaveBeenCalledTimes(1)
    await syncPush(h.d, { force: true })
    expect(h.register).toHaveBeenCalledTimes(2)
    h.tick(REREGISTER_MS)
    await syncPush(h.d)
    expect(h.register).toHaveBeenCalledTimes(3)
    await syncPush({ ...h.d, nativeToken: async () => 'b2'.repeat(32) })
    expect(h.register).toHaveBeenCalledTimes(4)
  })
  it('没问过权限 ⇒ 先 prepare(安卓建渠道)再弹系统框;拒了 ⇒ denied,不登记,但推送密钥已存', async () => {
    const prepare = vi.fn(async () => {})
    const h = harness({ permission: async () => 'undetermined', requestPermission: vi.fn(async () => 'denied' as const), prepare })
    expect(await syncPush(h.d)).toBe('denied')
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(h.register).not.toHaveBeenCalled()
    expect(h.m.size).toBe(1)
  })
  it('早就拒过 ⇒ 不再弹框,直接 denied', async () => {
    const h = harness({ permission: async () => 'denied' })
    expect(await syncPush(h.d)).toBe('denied')
    expect(h.requestPermission).not.toHaveBeenCalled()
  })
  it('登记过之后在系统设置里关了通知 ⇒ 回前台再同步得到 denied(不是一直显示 registered)', async () => {
    const h = harness()
    expect(await syncPush(h.d)).toBe('registered')
    expect(await syncPush({ ...h.d, permission: async () => 'denied' })).toBe('denied')
  })
  it('拿不到原生 token(模拟器没有 FCM / 没有 google-services)⇒ failed(unavailable 只指电脑没接推送)', async () => {
    const h = harness({ nativeToken: async () => { throw new Error('no firebase') } })
    expect(await syncPush(h.d)).toBe('failed')
    expect(h.register).not.toHaveBeenCalled()
  })
  it('token 形状不对 ⇒ failed,不发请求', async () => {
    const h = harness({ nativeToken: async () => 'xyz' })
    expect(await syncPush(h.d)).toBe('failed')
    expect(h.register).not.toHaveBeenCalled()
  })
  it('daemon 没接推送(还在老中继)⇒ unavailable;离线 / 超时 ⇒ offline;撤销等其余 ⇒ failed;都不记指纹', async () => {
    for (const [code, want] of [['unavailable', 'unavailable'], ['offline', 'offline'], ['timeout', 'offline'], ['revoked', 'failed'], ['invalid', 'failed']] as const) {
      const h = harness({ register: vi.fn(async () => { throw new BackendError(code) }) })
      expect(await syncPush(h.d), code).toBe(want)
      expect(await h.d.keys.loadReg(), code).toBeNull()
    }
  })
  it('日志里从不出现设备令牌、推送密钥、APNs token;只写操作名与错误码', async () => {
    const h = harness({ register: vi.fn(async () => { throw new BackendError('offline') }) })
    await syncPush(h.d)
    await syncPush({ ...h.d, nativeToken: async () => 'xyz' })
    await syncPush({ ...h.d, nativeToken: async () => { throw new Error(`boom ${APNS}`) } })
    await syncPush({ ...h.d, register: vi.fn(async () => { throw new Error(`boom ${APNS} ${TOKEN}`) }) })
    const all = h.logs.join('\n')
    expect(all.length).toBeGreaterThan(0)
    for (const secret of [TOKEN, APNS, JSON.parse([...h.m.values()][0]!).key]) expect(all).not.toContain(secret)
    for (const line of h.logs) expect(line).toMatch(/^push: [a-z ]+ \([A-Za-z_]+\)$/)
  })
})

describe('小函数', () => {
  it('platformFor:iOS 开发构建 ⇒ apns_sandbox;TestFlight / 商店 ⇒ apns;安卓 ⇒ fcm', () => {
    expect(platformFor('ios', 'development')).toBe('apns_sandbox')
    expect(platformFor('ios', 'production')).toBe('apns')
    expect(platformFor('android', 'production')).toBe('fcm')
  })
  it('permState:granted / iOS 临时授权(provisional=3、ephemeral=4)都算允许;undetermined;其余 denied', () => {
    expect(permState({ status: 'granted', granted: true })).toBe('granted')
    expect(permState({ status: 'denied', granted: false, ios: { status: 3 } })).toBe('granted')
    expect(permState({ status: 'denied', granted: false, ios: { status: 4 } })).toBe('granted')
    expect(permState({ status: 'undetermined', granted: false })).toBe('undetermined')
    expect(permState({ status: 'denied', granted: false })).toBe('denied')
  })
  it('shouldSync:token 变了、上线、回前台都同步 —— 已登记也要(token 可能换了、权限可能在系统设置里被关了);去重交给 syncPush 的指纹', () => {
    for (const s of ['idle', 'registered', 'denied', 'unavailable', 'offline', 'failed'] as const) {
      for (const tr of ['token', 'online', 'foreground'] as const) expect(shouldSync(s, tr), `${s}/${tr}`).toBe(true)
    }
  })
})
