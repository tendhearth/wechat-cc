import { describe, it, expect } from 'vitest'
import type { ProtocolClient, ProtocolRequest } from '@wechat-cc/protocol'
import { pairWithLink, PairError } from './pairing'
import { parsePairLink, type ParsedLink } from './link'
import { STATE } from './../backend/fixtures'

const LINK: ParsedLink = { daemonId: 'r' + 'a'.repeat(26), linkToken: 't' + '0'.repeat(32), relayHost: 'relay.tendhearth.com', relayUrl: 'wss://relay.tendhearth.com/v2/phone?id=r' + 'a'.repeat(26), lan: null }
const DEV = 'd' + '1'.repeat(48)

type Script = Record<string, { status: number; json: unknown } | Error>
function fakeConnect(byToken: Record<string, { script: Script; version?: 1 | 2 }>) {
  const log: Array<{ token: string; key: string; body?: any }> = []
  const closed: string[] = []
  const connect = (url: string, token: string): ProtocolClient => {
    expect(url).toBe(LINK.relayUrl)
    const cfg = byToken[token] ?? { script: {} }
    return {
      version: () => cfg.version ?? 2,
      async request(r: ProtocolRequest) {
        const key = `${r.method} ${r.path}`
        log.push({ token, key, body: typeof r.body === 'string' ? JSON.parse(r.body) : undefined })
        const out = cfg.script[key]
        if (!out) throw new Error('timeout')
        if (out instanceof Error) throw out
        const text = JSON.stringify(out.json)
        return { status: out.status, headers: {}, body: new TextEncoder().encode(text), text: () => text, json: <T,>() => JSON.parse(text) as T }
      },
      subscribe: () => () => {},
      close: () => { closed.push(token) },
    }
  }
  return { connect, log, closed }
}
const happyDevice = { script: { 'GET /set/api/state': { status: 200, json: STATE }, 'POST /set/api/apply': { status: 200, json: { ok: true } } } }

describe('pairWithLink', () => {
  it('链接令牌配对 → 设备令牌确认 v2 与本机 id → 给本机起名;两条连接都关掉', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': { status: 200, json: { ok: true, device_token: DEV } } } }, [DEV]: happyDevice })
    const rec = await pairWithLink(LINK, { connect: f.connect, label: 'Tendhearth · iPhone', now: () => 42 })
    expect(rec).toEqual({ v: 1, daemonId: LINK.daemonId, relayHost: LINK.relayHost, relayUrl: LINK.relayUrl, deviceToken: DEV, deviceId: 'aa11bb22', pairedAt: 42 })
    expect(f.log.map(l => `${l.token === DEV ? 'dev' : 'link'} ${l.key}`)).toEqual(['link POST /set/api/pair', 'dev GET /set/api/state', 'dev POST /set/api/apply'])
    expect(f.log[2]?.body).toEqual({ op: 'label_device', id: 'aa11bb22', label: 'Tendhearth · iPhone' })
    expect(f.closed.sort()).toEqual([DEV, LINK.linkToken].sort())
  })
  it('链接令牌过期(auth_failed)⇒ expired,且根本不用设备令牌连', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': new Error('auth_failed') } } })
    await expect(pairWithLink(LINK, { connect: f.connect, label: 'x' })).rejects.toMatchObject({ code: 'expired' })
    expect(f.log.every(l => l.token === LINK.linkToken)).toBe(true)
  })
  it('设备数满了 ⇒ device_limit', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': { status: 200, json: { ok: false, error: 'device_limit' } } } } })
    await expect(pairWithLink(LINK, { connect: f.connect, label: 'x' })).rejects.toMatchObject({ code: 'device_limit' })
  })
  it('电脑不在线(daemon_offline / timeout)⇒ offline', async () => {
    for (const err of ['daemon_offline', 'timeout', 'unreachable']) {
      const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': new Error(err) } } })
      await expect(pairWithLink(LINK, { connect: f.connect, label: 'x' })).rejects.toMatchObject({ code: 'offline' })
    }
  })
  it('电脑上的版本太老(协商出 v1)⇒ too_old', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': { status: 200, json: { ok: true, device_token: DEV } } } }, [DEV]: { ...happyDevice, version: 1 } })
    await expect(pairWithLink(LINK, { connect: f.connect, label: 'x' })).rejects.toMatchObject({ code: 'too_old' })
  })
  it('起名失败不影响配对', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': { status: 200, json: { ok: true, device_token: DEV } } } }, [DEV]: { script: { 'GET /set/api/state': { status: 200, json: STATE }, 'POST /set/api/apply': new Error('timeout') } } })
    expect((await pairWithLink(LINK, { connect: f.connect, label: 'x' })).deviceToken).toBe(DEV)
  })
  it('过期/已用的链接令牌 ⇒ expired(不是 revoked),错误文案不含令牌', async () => {
    for (const script of [{ 'POST /set/api/pair': new Error('auth_failed') }, { 'POST /set/api/pair': { status: 401, json: { ok: false, error: 'unauthorized' } } }] as Script[]) {
      const f = fakeConnect({ [LINK.linkToken]: { script } })
      let err: any
      try { await pairWithLink(LINK, { connect: f.connect, label: 'x' }) } catch (e) { err = e }
      expect(err).toBeInstanceOf(PairError)
      expect(err.code).toBe('expired')
      expect(err.code).not.toBe('revoked')
      expect(String(err.message) + String(err.stack)).not.toContain(LINK.linkToken)
      expect(f.log.every(l => l.token === LINK.linkToken)).toBe(true)
    }
  })
  it('局域网 http://…/set?t= 链接 ⇒ remote_off,根本不建连', () => {
    expect(parsePairLink('http://192.168.1.5:8080/set?t=' + 't' + '0'.repeat(32))).toEqual({ ok: false, error: 'remote_off' })
  })
  it('设备阶段失败(state 形状坏)⇒ 用设备令牌 best-effort unpair_self,抛出原错误', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': { status: 200, json: { ok: true, device_token: DEV } } } }, [DEV]: { script: { 'GET /set/api/state': { status: 200, json: { nope: 1 } }, 'POST /set/api/apply': { status: 200, json: { ok: true } } } } })
    await expect(pairWithLink(LINK, { connect: f.connect, label: 'x' })).rejects.toMatchObject({ code: 'unknown' })
    const un = f.log.find(l => l.token === DEV && l.key === 'POST /set/api/apply')
    expect(un?.body).toEqual({ op: 'unpair_self' })
    expect(f.closed).toContain(DEV)
  })
  it('too_old 同样回收设备位;unpair_self 失败不改变抛出的错误', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': { status: 200, json: { ok: true, device_token: DEV } } } }, [DEV]: { ...happyDevice, script: { 'GET /set/api/state': { status: 200, json: STATE }, 'POST /set/api/apply': new Error('boom') }, version: 1 } })
    await expect(pairWithLink(LINK, { connect: f.connect, label: 'x' })).rejects.toMatchObject({ code: 'too_old', message: 'too_old' })
    expect(f.log.some(l => l.token === DEV && l.body?.op === 'unpair_self')).toBe(true)
  })
  it('链接阶段失败不发 unpair_self(还没有设备令牌)', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': { status: 200, json: { ok: false, error: 'device_limit' } } } } })
    await expect(pairWithLink(LINK, { connect: f.connect, label: 'x' })).rejects.toMatchObject({ code: 'device_limit' })
    expect(f.log.every(l => l.key === 'POST /set/api/pair')).toBe(true)
  })
  it('非传输层异常(响应体不是 JSON)⇒ unknown,不是 offline', async () => {
    const connect = (): ProtocolClient => ({ version: () => 2, async request() { return { status: 200, headers: {}, body: new Uint8Array(), text: () => 'x', json: () => JSON.parse('<html>') } }, subscribe: () => () => {}, close() {} })
    await expect(pairWithLink(LINK, { connect, label: 'x' })).rejects.toMatchObject({ code: 'unknown' })
  })
  it('PairError 带 code', () => { expect(new PairError('expired').code).toBe('expired') })
})
