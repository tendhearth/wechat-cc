import { describe, it, expect } from 'vitest'
import {
  base32Lower, relayIdFromPub, relayKeyPair, signRelayLogin, verifyRelayLogin, RELAY_ID_RE,
  pushTokenValid, DaemonControl, RoomControl, relayIdProtocol, RELAY_SUBPROTOCOL,
} from './relay'

describe('base32Lower', () => {
  it('RFC 4648 向量(小写、无填充)', () => {
    const e = (s: string) => base32Lower(new TextEncoder().encode(s))
    expect(e('')).toBe('')
    expect(e('f')).toBe('my')
    expect(e('fo')).toBe('mzxq')
    expect(e('foo')).toBe('mzxw6')
    expect(e('foob')).toBe('mzxw6yq')
    expect(e('fooba')).toBe('mzxw6ytb')
    expect(e('foobar')).toBe('mzxw6ytboi')
  })
})

describe('daemon id', () => {
  it('由公钥派生:r + 26 个 base32 字符,同一把钥匙永远同一个 id', () => {
    const { seed, pub } = relayKeyPair()
    const id = relayIdFromPub(pub)
    expect(id).toMatch(RELAY_ID_RE)
    expect(relayIdFromPub(relayKeyPair(seed).pub)).toBe(id)
  })
  it('公钥不是 32 字节 ⇒ 抛', () => {
    expect(() => relayIdFromPub(new Uint8Array(31))).toThrow()
  })
  it('子协议名', () => {
    expect(RELAY_SUBPROTOCOL).toBe('wcc.relay.v2')
    expect(relayIdProtocol('rabc')).toBe('id.rabc')
  })
})

describe('登录签名', () => {
  const { seed, pub } = relayKeyPair()
  const id = relayIdFromPub(pub)
  it('正确签名通过', () => {
    const r = signRelayLogin(seed, 'chal-1', id)
    expect(verifyRelayLogin(id, 'chal-1', r.pub, r.sig)).toBe(true)
  })
  it('挑战不同 ⇒ 不通过', () => {
    const r = signRelayLogin(seed, 'chal-1', id)
    expect(verifyRelayLogin(id, 'chal-2', r.pub, r.sig)).toBe(false)
  })
  it('id 不是这把公钥派生的 ⇒ 不通过(哪怕签名本身对)', () => {
    const other = relayKeyPair()
    const otherId = relayIdFromPub(other.pub)
    const r = signRelayLogin(seed, 'c', otherId)   // 用自己的钥匙签别人的 id
    expect(verifyRelayLogin(otherId, 'c', r.pub, r.sig)).toBe(false)
  })
  it('畸形输入 ⇒ false,不抛', () => {
    expect(verifyRelayLogin(id, 'c', '!!', '??')).toBe(false)
    expect(verifyRelayLogin(id, 'c', '', '')).toBe(false)
  })
})

describe('推送 token 校验', () => {
  it('APNs:64–200 位十六进制', () => {
    expect(pushTokenValid('apns', 'a'.repeat(64))).toBe(true)
    expect(pushTokenValid('apns_sandbox', 'F'.repeat(64))).toBe(true)
    expect(pushTokenValid('apns', 'g'.repeat(64))).toBe(false)
    expect(pushTokenValid('apns', 'a'.repeat(63))).toBe(false)
  })
  it('FCM:20–4096 个 [A-Za-z0-9:_-]', () => {
    expect(pushTokenValid('fcm', 'abc:DEF_ghi-' + 'x'.repeat(20))).toBe(true)
    expect(pushTokenValid('fcm', 'short')).toBe(false)
    expect(pushTokenValid('fcm', 'has space ' + 'x'.repeat(20))).toBe(false)
  })
})

describe('控制帧 schema', () => {
  it('daemon → 房间', () => {
    expect(DaemonControl.safeParse({ pub: 'p', sig: 's' }).success).toBe(true)
    expect(DaemonControl.safeParse({ push_reg: { device: 'ab12cd34', platform: 'apns', token: 'a'.repeat(64) } }).success).toBe(true)
    expect(DaemonControl.safeParse({ push_unreg: { device: 'ab12cd34' } }).success).toBe(true)
    expect(DaemonControl.safeParse({ push: { device: 'ab12cd34', sealed: { v: 1, iv: 'i', ct: 'c' }, collapseId: 't1', ref: 'r1' } }).success).toBe(true)
    expect(DaemonControl.safeParse({ push: { device: '../x', sealed: { v: 1, iv: 'i', ct: 'c' } } }).success).toBe(false)
    expect(DaemonControl.safeParse({ push: { device: 'ab12cd34', sealed: { v: 1, iv: 'i', ct: 'c'.repeat(3501) } } }).success).toBe(false)
  })
  it('房间 → daemon', () => {
    expect(RoomControl.safeParse({ challenge: 'c', ts: 1 }).success).toBe(true)
    expect(RoomControl.safeParse({ login_ok: true }).success).toBe(true)
    expect(RoomControl.safeParse({ push_result: { device: 'ab12cd34', ok: false, code: 'BadDeviceToken', ref: 'r' } }).success).toBe(true)
    expect(RoomControl.safeParse({ push_invalid: { device: 'ab12cd34' } }).success).toBe(true)
    expect(RoomControl.safeParse({ error: 'rate_limited' }).success).toBe(true)
  })
})
