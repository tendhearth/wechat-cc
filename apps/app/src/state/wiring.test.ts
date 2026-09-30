import { describe, it, expect, vi } from 'vitest'
import type { ProtocolClient, ProtocolSocket } from '@wechat-cc/protocol'
import type { Backend, Connection } from '../backend/types'
import { makeCredentialStore, PAIRING_KEY, type SecureStoreLike } from '../net/credentials'
import type { ParsedLink } from '../net/link'
import { pairWithLink, PairError, type PairingRecord } from '../net/pairing'
import { canSubmit, connectionNotice } from '../view/connection'
import { getDraft, setDraft, clearDrafts } from './drafts'
import { makeStore } from './store'
import { backendFor, pairAndSave, watchConnection } from './wiring'

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
