import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('入口 Worker', () => {
  it('/healthz', async () => {
    const r = await SELF.fetch('https://relay.test/healthz')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, version: 'test', apns: false, fcm: false })
  })
  it('/pset/ 回壳页', async () => {
    const r = await SELF.fetch('https://relay.test/pset/')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(await r.text()).toContain('new WebSocket(')   // Task 13 改成断言 '/v2/phone'
  })
  it('未知路径 404', async () => {
    expect((await SELF.fetch('https://relay.test/tunnel/phone?id=x')).status).toBe(404)
  })
  it('/v2/daemon 不是升级 ⇒ 426;子协议缺 / id 畸形 ⇒ 400', async () => {
    expect((await SELF.fetch('https://relay.test/v2/daemon')).status).toBe(426)
    const up = { Upgrade: 'websocket' }
    expect((await SELF.fetch('https://relay.test/v2/daemon', { headers: up })).status).toBe(400)
    expect((await SELF.fetch('https://relay.test/v2/daemon', { headers: { ...up, 'Sec-WebSocket-Protocol': 'wcc.relay.v2, id.NOPE' } })).status).toBe(400)
  })
  it('/v2/phone 缺 id / id 畸形 ⇒ 400', async () => {
    const up = { Upgrade: 'websocket' }
    expect((await SELF.fetch('https://relay.test/v2/phone', { headers: up })).status).toBe(400)
    expect((await SELF.fetch('https://relay.test/v2/phone?id=t123', { headers: up })).status).toBe(400)
  })
})
