import { describe, it, expect } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import type { Room } from '../src/room'
import { connectDaemon } from './helpers'

const SEALED = { v: 1, iv: 'aXY', ct: 'Y3Q' }
const TOKEN = 'ab'.repeat(32)

async function withApns(id: string, status: number, reason?: string) {
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject<Room, void>(stub, room => {
    const r = room as unknown as { env: Record<string, unknown>; pushSend: unknown }
    r.env = { ...r.env, APNS_KEY_P8: 'unused', APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_TOPIC: 'x' }
    r.pushSend = async () => status === 200 ? { ok: true, code: 'ok' } : { ok: false, code: reason ?? `http_${status}`, invalid: status === 410 || reason === 'BadDeviceToken' }
  })
}

describe('房间:推送', () => {
  it('没登记 ⇒ not_registered', async () => {
    const d = await connectDaemon()
    d.ws.send(JSON.stringify({ push: { device: 'ab12cd34', sealed: SEALED, ref: 'r1' } }))
    expect(await d.next()).toEqual({ push_result: { device: 'ab12cd34', ok: false, code: 'not_registered', ref: 'r1' } })
  })

  it('登记后发送成功 ⇒ push_result ok', async () => {
    const d = await connectDaemon()
    await withApns(d.ident.id, 200)
    d.ws.send(JSON.stringify({ push_reg: { device: 'ab12cd34', platform: 'apns', token: TOKEN } }))
    d.ws.send(JSON.stringify({ push: { device: 'ab12cd34', sealed: SEALED, collapseId: 't1', ref: 'r2' } }))
    expect(await d.next()).toEqual({ push_result: { device: 'ab12cd34', ok: true, code: 'ok', ref: 'r2' } })
  })

  it('失效 token ⇒ 删登记 + push_invalid,再发就是 not_registered', async () => {
    const d = await connectDaemon()
    await withApns(d.ident.id, 400, 'BadDeviceToken')
    d.ws.send(JSON.stringify({ push_reg: { device: 'dev1', platform: 'apns', token: TOKEN } }))
    d.ws.send(JSON.stringify({ push: { device: 'dev1', sealed: SEALED, ref: 'a' } }))
    const got = [await d.next(), await d.next()]
    expect(got).toContainEqual({ push_invalid: { device: 'dev1' } })
    expect(got).toContainEqual({ push_result: { device: 'dev1', ok: false, code: 'BadDeviceToken', ref: 'a' } })
    d.ws.send(JSON.stringify({ push: { device: 'dev1', sealed: SEALED, ref: 'b' } }))
    expect(await d.next()).toMatchObject({ push_result: { code: 'not_registered' } })
  })

  it('push_unreg 之后 ⇒ not_registered', async () => {
    const d = await connectDaemon()
    d.ws.send(JSON.stringify({ push_reg: { device: 'dev2', platform: 'fcm', token: 'f'.repeat(30) } }))
    d.ws.send(JSON.stringify({ push_unreg: { device: 'dev2' } }))
    d.ws.send(JSON.stringify({ push: { device: 'dev2', sealed: SEALED } }))
    expect(await d.next()).toMatchObject({ push_result: { code: 'not_registered' } })
  })

  it('push_sync 是权威清单:不在单子上的登记全删,单子上的保留', async () => {
    const d = await connectDaemon()
    await withApns(d.ident.id, 200)
    d.ws.send(JSON.stringify({ push_reg: { device: 'devA', platform: 'apns', token: TOKEN } }))
    d.ws.send(JSON.stringify({ push_reg: { device: 'devB', platform: 'apns', token: TOKEN } }))
    d.ws.send(JSON.stringify({ push_sync: { devices: ['devB'] } }))
    d.ws.send(JSON.stringify({ push: { device: 'devA', sealed: SEALED, ref: 'a' } }))
    expect(await d.next()).toEqual({ push_result: { device: 'devA', ok: false, code: 'not_registered', ref: 'a' } })
    d.ws.send(JSON.stringify({ push: { device: 'devB', sealed: SEALED, ref: 'b' } }))
    expect(await d.next()).toEqual({ push_result: { device: 'devB', ok: true, code: 'ok', ref: 'b' } })
  })

  it('token 不合法 ⇒ invalid_token', async () => {
    const d = await connectDaemon()
    d.ws.send(JSON.stringify({ push_reg: { device: 'dev3', platform: 'apns', token: 'zz' } }))
    expect(await d.next()).toEqual({ push_result: { device: 'dev3', ok: false, code: 'invalid_token' } })
  })

  it('每日配额(测试上限 3)⇒ 第 4 条 quota_exceeded', async () => {
    const d = await connectDaemon()
    await withApns(d.ident.id, 200)
    d.ws.send(JSON.stringify({ push_reg: { device: 'dev4', platform: 'apns', token: TOKEN } }))
    for (let i = 0; i < 4; i++) d.ws.send(JSON.stringify({ push: { device: 'dev4', sealed: SEALED, ref: String(i) } }))
    const codes = [] as string[]
    for (let i = 0; i < 4; i++) codes.push((await d.next()).push_result.code)
    expect(codes).toEqual(['ok', 'ok', 'ok', 'quota_exceeded'])
  })

  it('没配凭据 ⇒ not_configured(用真 sendPush)', async () => {
    const d = await connectDaemon()
    d.ws.send(JSON.stringify({ push_reg: { device: 'dev5', platform: 'apns', token: TOKEN } }))
    d.ws.send(JSON.stringify({ push: { device: 'dev5', sealed: SEALED } }))
    expect(await d.next()).toMatchObject({ push_result: { ok: false, code: 'not_configured' } })
  })
})
