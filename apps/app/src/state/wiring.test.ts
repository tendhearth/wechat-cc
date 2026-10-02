import { describe, it, expect, vi } from 'vitest'
import type { ProtocolClient, ProtocolSocket } from '@wechat-cc/protocol'
import type { Backend, Connection } from '../backend/types'
import { makeCredentialStore, PAIRING_KEY, type SecureStoreLike } from '../net/credentials'
import type { ParsedLink } from '../net/link'
import { pairWithLink, PairError, type PairingRecord } from '../net/pairing'
import { canSubmit, connectionNotice } from '../view/connection'
import { getDraft, setDraft, clearDrafts } from './drafts'
import { makeStore } from './store'
import { INITIAL_CONNECTION } from '../net/connection'
import { backendFor, pairAndSave, verifyLaunch, watchConnection, watchLaunch } from './wiring'

const LINK: ParsedLink = { daemonId: 'r' + 'a'.repeat(26), linkToken: 't' + '0'.repeat(32), relayHost: 'relay.tendhearth.com', relayUrl: 'wss://relay.tendhearth.com/v2/phone?id=r' + 'a'.repeat(26), lan: null }
const REC: PairingRecord = { v: 1, daemonId: LINK.daemonId, relayHost: LINK.relayHost, relayUrl: LINK.relayUrl, deviceToken: 'd' + '1'.repeat(48), deviceId: 'aa11bb22', pairedAt: 1 }

function spySecureStore() {
  const m = new Map<string, string>()
  const ss = {
    getItemAsync: vi.fn(async (k: string) => m.get(k) ?? null),
    setItemAsync: vi.fn(async (k: string, v: string) => { m.set(k, v) }),
    deleteItemAsync: vi.fn(async (k: string) => { m.delete(k) }),
  } satisfies SecureStoreLike
  return { ss, m }
}
/** 链接令牌阶段就失败的协议客户端。 */
const failingConnect = (err: string) => (): ProtocolClient => ({
  version: () => 2,
  request: async () => { throw new Error(err) },
  subscribe: () => () => {},
  close: () => {},
})
const quietSocket = (): ProtocolSocket => ({ send() {}, close() {}, onOpen() {}, onMessage() {}, onClose() {} } as unknown as ProtocolSocket)

describe('配对失败不留痕(Review Focus 1)', () => {
  it.each([['auth_failed', 'expired'], ['daemon_offline', 'offline'], ['timeout', 'offline']])(
    '链接阶段 %s ⇒ PairError(%s);钥匙串一个字都没写,后端还是演示、连接不是 revoked',
    async (err, code) => {
      const { ss, m } = spySecureStore()
      const creds = makeCredentialStore(ss)
      const save = vi.spyOn(creds, 'save')
      const failed = pairAndSave(() => pairWithLink(LINK, { connect: failingConnect(err), label: 'x' }), r => creds.save(r))
      await expect(failed).rejects.toBeInstanceOf(PairError)
      await expect(failed).rejects.toMatchObject({ code })
      expect(save).not.toHaveBeenCalled()
      expect(ss.setItemAsync).not.toHaveBeenCalled()
      expect(m.has(PAIRING_KEY)).toBe(false)
      expect(await creds.load()).toBeNull()
      // 会话里的配对仍是 null ⇒ 选中的后端是演示,连接不会是「已撤销」
      const open = vi.fn(quietSocket)
      const w = backendFor(null, { lang: 'en', open })
      expect(w.backend.mode).toBe('demo')
      expect(w.backend.connection().state).not.toBe('revoked')
      expect(open).not.toHaveBeenCalled()
      w.backend.dispose()
    },
  )
  it('配对成功 ⇒ 先配成再存,存的就是那条记录', async () => {
    const { ss } = spySecureStore()
    const creds = makeCredentialStore(ss)
    const rec = await pairAndSave(async () => REC, r => creds.save(r))
    expect(rec).toBe(REC)
    expect(await creds.load()).toEqual(REC)
  })
})

describe('backendFor', () => {
  it('有配对 ⇒ 真后端,用配对里的中继地址开 socket', () => {
    const open = vi.fn(quietSocket)
    const w = backendFor(REC, { lang: 'en', open })
    expect(w.backend.mode).toBe('live')
    expect(w.demo).toBeNull()
    expect(open).toHaveBeenCalledWith(REC.relayUrl)
    w.backend.dispose()
  })
  it('注入的后端优先', () => {
    const injected = { mode: 'demo' } as Backend
    expect(backendFor(REC, { lang: 'en', open: quietSocket, injected }).backend).toBe(injected)
  })
})

function fakeBackend(initial: Connection) {
  let conn = initial
  const cbs = new Set<(c: Connection) => void>()
  const b = {
    mode: 'live' as const,
    connection: () => conn,
    onConnection(cb: (c: Connection) => void) { cbs.add(cb); cb(conn); return () => { cbs.delete(cb) } },
    say: vi.fn(async () => {}), create: vi.fn(async () => ({ matterId: 'x' })), decide: vi.fn(async () => {}), answer: vi.fn(async () => {}),
  }
  const emit = (c: Connection) => { conn = c; for (const cb of [...cbs]) cb(c) }
  return { b, emit }
}

describe('watchConnection', () => {
  it('epoch 前进 ⇒ revalidateAll;离线来回不重拉;撤销只通知一次;退订后不再响应', () => {
    const { b, emit } = fakeBackend({ state: 'connecting', lastSyncedAt: null, epoch: 0 })
    const store = { revalidateAll: vi.fn() }
    const onRevoked = vi.fn()
    const off = watchConnection(b as unknown as Backend, store, onRevoked)
    expect(store.revalidateAll).not.toHaveBeenCalled()
    emit({ state: 'online', lastSyncedAt: 1, epoch: 1 })
    expect(store.revalidateAll).toHaveBeenCalledTimes(1)
    emit({ state: 'offline', lastSyncedAt: 1, epoch: 1 })
    emit({ state: 'offline', lastSyncedAt: 1, epoch: 1 })
    expect(store.revalidateAll).toHaveBeenCalledTimes(1)
    emit({ state: 'online', lastSyncedAt: 2, epoch: 2 })
    expect(store.revalidateAll).toHaveBeenCalledTimes(2)
    emit({ state: 'revoked', lastSyncedAt: 2, epoch: 2 })
    emit({ state: 'revoked', lastSyncedAt: 3, epoch: 2 })
    expect(onRevoked).toHaveBeenCalledTimes(1)
    off()
    emit({ state: 'online', lastSyncedAt: 4, epoch: 3 })
    expect(store.revalidateAll).toHaveBeenCalledTimes(2)
  })

  it('冷启动电脑关着、从没同步过(Review Focus 4):「暂时连不上」、提交锁住、草稿保留;连上后只重拉读,草稿不自动发', () => {
    clearDrafts()
    const cold: Connection = { state: 'offline', lastSyncedAt: null, epoch: 0 }
    const { b, emit } = fakeBackend(cold)
    const store = makeStore(b as unknown as Backend, { lang: 'zh-Hans' })
    const revalidate = vi.spyOn(store, 'revalidateAll')
    const off = watchConnection(b as unknown as Backend, store, () => {})
    const n = connectionNotice(b.connection(), Date.now(), 'zh-Hans')
    expect(n?.kind).toBe('offline')
    expect(n?.text).toContain('暂时连不上')
    expect(n?.text).not.toMatch(/同步|\d\d:\d\d/)
    expect(canSubmit(b.connection())).toBe(false)
    setDraft('new', '帮我把作品集的图压一下')
    setDraft('m1', '顺便更新 README')
    emit({ state: 'online', lastSyncedAt: 10, epoch: 1 })
    expect(revalidate).toHaveBeenCalledTimes(1)
    expect(canSubmit(b.connection())).toBe(true)
    expect(getDraft('new')).toBe('帮我把作品集的图压一下')
    expect(getDraft('m1')).toBe('顺便更新 README')
    expect(b.say).not.toHaveBeenCalled()
    expect(b.create).not.toHaveBeenCalled()
    expect(b.decide).not.toHaveBeenCalled()
    expect(b.answer).not.toHaveBeenCalled()
    off()
    clearDrafts()
  })
})

describe('启动核验(spec §7、D8)', () => {
  type Conn = { state: 'connecting' | 'online' | 'offline' | 'revoked'; lastSyncedAt: number | null; epoch: number }
  function fakeBackend(devices: () => Promise<Array<{ id: string; current: boolean; created_at: string; last_seen_at: string }>>) {
    let c: Conn = { state: 'connecting', lastSyncedAt: null, epoch: 0 }
    const subs = new Set<(c: Conn) => void>()
    return {
      connection: () => c,
      onConnection: (cb: (c: Conn) => void) => { subs.add(cb); return () => { subs.delete(cb) } },
      devices,
      emit(next: Partial<Conn>) { c = { ...c, ...next }; for (const s of subs) s(c) },
      subs,
    }
  }
  const row = (id: string, current: boolean) => ({ id, current, created_at: 'x', last_seen_at: 'x' })

  it('启动时从不先画「在线」', () => {
    expect(INITIAL_CONNECTION.state).toBe('connecting')
  })
  it('verifyLaunch:这台的 id 对上 ⇒ ok;对不上 / 没有这台 ⇒ stale;读失败 ⇒ unknown', async () => {
    expect(await verifyLaunch({ devices: async () => [row('aa11bb22', true)] } as never, 'aa11bb22')).toBe('ok')
    expect(await verifyLaunch({ devices: async () => [row('ffffffff', true)] } as never, 'aa11bb22')).toBe('stale')
    expect(await verifyLaunch({ devices: async () => [row('aa11bb22', false)] } as never, 'aa11bb22')).toBe('stale')
    expect(await verifyLaunch({ devices: async () => { throw new Error('timeout') } } as never, 'aa11bb22')).toBe('unknown')
  })
  it('watchLaunch:第一次 online 才核对,只核对一次;对不上 ⇒ onStale', async () => {
    const b = fakeBackend(async () => [row('ffffffff', true)])
    const onStale = vi.fn()
    watchLaunch(b as never, 'aa11bb22', onStale)
    b.emit({ state: 'offline' })
    expect(onStale).not.toHaveBeenCalled()
    b.emit({ state: 'online', epoch: 1 })
    b.emit({ state: 'online', epoch: 2 })
    await vi.waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
  })
  it('watchLaunch:电脑不在线 / 读设备失败 ⇒ 不清(Review Focus 4);取消订阅后结果作废', async () => {
    const onStale = vi.fn()
    const offline = fakeBackend(async () => [row('aa11bb22', true)])
    watchLaunch(offline as never, 'aa11bb22', onStale)
    offline.emit({ state: 'offline' })
    const failing = fakeBackend(async () => { throw new Error('timeout') })
    watchLaunch(failing as never, 'aa11bb22', onStale)
    failing.emit({ state: 'online', epoch: 1 })
    let release!: () => void
    const slow = fakeBackend(() => new Promise(r => { release = () => r([row('ffffffff', true)]) }))
    const off = watchLaunch(slow as never, 'aa11bb22', onStale)
    slow.emit({ state: 'online', epoch: 1 })
    off()
    release()
    await new Promise(r => setTimeout(r, 0))
    expect(onStale).not.toHaveBeenCalled()
  })
  it('watchConnection:还没连上过就被拒 ⇒ onStale;连上过之后被拒 ⇒ onRevoked(维持现状)', () => {
    const store = { revalidateAll: vi.fn() }
    const a = fakeBackend(async () => [])
    const r1 = vi.fn(), s1 = vi.fn()
    watchConnection(a as never, store, r1, s1)
    a.emit({ state: 'revoked' })
    expect([r1.mock.calls.length, s1.mock.calls.length]).toEqual([0, 1])
    const b = fakeBackend(async () => [])
    const r2 = vi.fn(), s2 = vi.fn()
    watchConnection(b as never, store, r2, s2)
    b.emit({ state: 'online', epoch: 1, lastSyncedAt: 1000 })
    b.emit({ state: 'revoked' })
    expect([r2.mock.calls.length, s2.mock.calls.length]).toEqual([1, 0])
  })
  it('watchConnection:明文 hello 已 online 但没同步成功过就被拒(令牌失效)⇒ 仍是 onStale', () => {
    const store = { revalidateAll: vi.fn() }
    const a = fakeBackend(async () => [])
    const r = vi.fn(), s = vi.fn()
    watchConnection(a as never, store, r, s)
    a.emit({ state: 'online', epoch: 1 })
    a.emit({ state: 'revoked' })
    expect([r.mock.calls.length, s.mock.calls.length]).toEqual([0, 1])
  })
  it('watchLaunch:读设备失败(unknown)不算核对过,下次连接变化再核对', async () => {
    let fail = true
    const b = fakeBackend(async () => { if (fail) throw new Error('timeout'); return [row('ffffffff', true)] })
    const onStale = vi.fn()
    watchLaunch(b as never, 'aa11bb22', onStale)
    b.emit({ state: 'online', epoch: 1 })
    await new Promise(r => setTimeout(r, 0))
    expect(onStale).not.toHaveBeenCalled()
    fail = false
    b.emit({ state: 'online', lastSyncedAt: 5 })
    await vi.waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
  })
})
