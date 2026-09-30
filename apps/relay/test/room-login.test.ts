import { describe, it, expect } from 'vitest'
import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test'
import { signRelayLogin } from '@wechat-cc/protocol'
import { expiredLogins } from '../src/room'
import { connectDaemon, connectPhone, newIdentity, openDaemonSocket } from './helpers'

describe('房间:daemon 登录', () => {
  it('升级回包带选中的子协议;先发挑战,签对了回 login_ok', async () => {
    const ident = newIdentity()
    const r = await SELF.fetch('https://relay.test/v2/daemon', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `wcc.relay.v2, id.${ident.id}` } })
    expect(r.status).toBe(101)
    expect(r.headers.get('sec-websocket-protocol')).toBe('wcc.relay.v2')
    r.webSocket!.accept()
    const d = await connectDaemon()
    expect(d.ident.id).toMatch(/^r/)
  })

  it('错签名 ⇒ login_failed 并关闭', async () => {
    const ident = newIdentity()
    const s = await openDaemonSocket(ident.id)
    const ch = await s.next()
    s.ws.send(JSON.stringify(signRelayLogin(ident.seed, ch.challenge + 'x', ident.id)))
    expect(await s.next()).toEqual({ error: 'login_failed' })
    expect(await s.closed).toBe(4001)
  })

  it('id 与公钥不符(拿别人的 id 连)⇒ login_failed', async () => {
    const victim = newIdentity(), attacker = newIdentity()
    const s = await openDaemonSocket(victim.id)
    const ch = await s.next()
    s.ws.send(JSON.stringify(signRelayLogin(attacker.seed, ch.challenge, victim.id)))
    expect(await s.next()).toEqual({ error: 'login_failed' })
  })

  it('闹钟到点前不关刚连上、还没登录的 socket', async () => {
    const ident = newIdentity()
    const s = await openDaemonSocket(ident.id)
    await s.next()   // challenge
    const stub = env.ROOM.get(env.ROOM.idFromName(ident.id))
    await runDurableObjectAlarm(stub)
    expect(s.msgs).toEqual([])   // 真正的过期判定由下面 expiredLogins 的纯函数测试覆盖
  })

  it('ping 自动回 pong(不唤醒房间)', async () => {
    const d = await connectDaemon()
    d.ws.send('{"ping":1}')
    expect(await d.next()).toEqual({ pong: 1 })
  })

  it('expiredLogins:未认证且 openedAt + 超时 ≤ now 的才算过期', () => {
    const a = { role: 'daemon', id: 'r', challenge: 'c', openedAt: 0, authed: false, authedAt: 0, replaced: false } as const
    expect(expiredLogins([a], 9_999, 10_000)).toEqual([])
    expect(expiredLogins([a], 10_000, 10_000)).toEqual([a])
    expect(expiredLogins([{ ...a, authed: true }], 99_999, 10_000)).toEqual([])
  })

  it('未登录 socket 每房间最多 4 条:第 5 条 login_failed(4001),已认证 daemon 不受影响', async () => {
    const d = await connectDaemon()
    const pending = []
    for (let i = 0; i < 4; i++) {
      const s = await openDaemonSocket(d.ident.id)
      expect(await s.next()).toHaveProperty('challenge')
      pending.push(s)
    }
    const fifth = await openDaemonSocket(d.ident.id)
    expect(await fifth.next()).toEqual({ error: 'login_failed' })
    expect(await fifth.closed).toBe(4001)
    const p = await connectPhone(d.ident.id)
    p.ws.send(JSON.stringify({ hs: 'z' }))
    expect(await d.next()).toMatchObject({ frame: { hs: 'z' } })
  })
})
