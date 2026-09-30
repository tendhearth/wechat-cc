import { describe, it, expect, vi } from 'vitest'
import { sendApns } from '../src/push-apns'
import { sendFcm } from '../src/push-fcm'

const SEALED = { v: 1 as const, iv: 'aXY', ct: 'Y3Q' }

async function p256Pem(): Promise<string> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey) as ArrayBuffer)
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`
}
async function rsaPem(): Promise<string> {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey) as ArrayBuffer)
  let b = ''; for (const x of der) b += String.fromCharCode(x)
  return `-----BEGIN PRIVATE KEY-----\n${btoa(b)}\n-----END PRIVATE KEY-----`
}
const b64uJson = (s: string) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')))

describe('APNs', () => {
  it('请求形状:路径、头、占位 alert、mutable-content、加密块;JWT 是 ES256 + kid/iss', async () => {
    const keyP8 = await p256Pem()
    const f = vi.fn(async () => new Response(null, { status: 200 }))
    const r = await sendApns({ keyP8, keyId: 'KID1', teamId: '9Y6JAPDP7A', topic: 'com.example.cc', host: 'https://fake-apns.test', token: 'ab'.repeat(32), sealed: SEALED, collapseId: 't1', now: 1_700_000_000_000, fetch: f as never })
    expect(r).toEqual({ ok: true, code: 'ok' })
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe(`https://fake-apns.test/3/device/${'ab'.repeat(32)}`)
    const h = new Headers(init.headers)
    expect(h.get('apns-topic')).toBe('com.example.cc')
    expect(h.get('apns-push-type')).toBe('alert')
    expect(h.get('apns-collapse-id')).toBe('t1')
    const [hdr, claims] = h.get('authorization')!.replace('bearer ', '').split('.')
    expect(b64uJson(hdr!)).toEqual({ alg: 'ES256', kid: 'KID1' })
    expect(b64uJson(claims!)).toEqual({ iss: '9Y6JAPDP7A', iat: 1_700_000_000 })
    const body = JSON.parse(String(init.body))
    expect(body.aps).toEqual({ alert: { title: 'CC', body: 'CC 有新动态' }, 'mutable-content': 1, sound: 'default' })
    expect(body.wcc).toEqual(SEALED)
  })
  it('410 ⇒ invalid;400 BadDeviceToken ⇒ invalid;403 InvalidProviderToken ⇒ 不是 invalid', async () => {
    const keyP8 = await p256Pem()
    const base = { keyP8, keyId: 'K2', teamId: 'T', topic: 'x', host: 'https://h', token: 'cd'.repeat(32), sealed: SEALED, now: 1_700_000_000_000 }
    const resp = (status: number, reason?: string) => vi.fn(async () => new Response(reason ? JSON.stringify({ reason }) : null, { status })) as never
    expect(await sendApns({ ...base, fetch: resp(410, 'Unregistered') })).toEqual({ ok: false, code: 'Unregistered', invalid: true })
    expect(await sendApns({ ...base, fetch: resp(400, 'BadDeviceToken') })).toEqual({ ok: false, code: 'BadDeviceToken', invalid: true })
    expect(await sendApns({ ...base, fetch: resp(403, 'InvalidProviderToken') })).toEqual({ ok: false, code: 'InvalidProviderToken', invalid: false })
  })
  it('网络异常 ⇒ network', async () => {
    const keyP8 = await p256Pem()
    const r = await sendApns({ keyP8, keyId: 'K3', teamId: 'T', topic: 'x', host: 'https://h', token: 'ef'.repeat(32), sealed: SEALED, now: 1, fetch: (async () => { throw new Error('boom') }) as never })
    expect(r).toEqual({ ok: false, code: 'network', invalid: false })
  })
})

describe('FCM', () => {
  it('先换 OAuth token(缓存),再发 data message', async () => {
    const sa = JSON.stringify({ project_id: 'proj', client_email: 'svc@proj.iam.gserviceaccount.com', private_key: await rsaPem() })
    const f = vi.fn(async (url: string) => url.includes('oauth')
      ? Response.json({ access_token: 'AT', expires_in: 3600 })
      : Response.json({ name: 'projects/proj/messages/1' }))
    const opts = { serviceAccount: sa, host: 'https://fake-fcm.test', tokenUrl: 'https://fake-oauth.test/token', token: 'fcm-token-' + 'x'.repeat(20), sealed: SEALED, collapseId: 't1', now: 1_700_000_000_000, fetch: f as never }
    expect(await sendFcm(opts)).toEqual({ ok: true, code: 'ok' })
    expect(await sendFcm(opts)).toEqual({ ok: true, code: 'ok' })
    expect(f.mock.calls.filter(c => String(c[0]).includes('oauth'))).toHaveLength(1)
    const send = f.mock.calls.find(c => String(c[0]).includes('messages:send'))! as unknown as [string, RequestInit]
    expect(send[0]).toBe('https://fake-fcm.test/v1/projects/proj/messages:send')
    expect(new Headers(send[1].headers).get('authorization')).toBe('Bearer AT')
    const msg = JSON.parse(String(send[1].body)).message
    expect(msg.token).toBe(opts.token)
    expect(JSON.parse(msg.data.wcc)).toEqual(SEALED)
    expect(msg.android).toEqual({ priority: 'HIGH', collapse_key: 't1', ttl: '3600s' })
  })
  it('UNREGISTERED ⇒ invalid', async () => {
    const sa = JSON.stringify({ project_id: 'p2', client_email: 'a@p2.iam.gserviceaccount.com', private_key: await rsaPem() })
    const f = vi.fn(async (url: string) => url.includes('oauth')
      ? Response.json({ access_token: 'AT', expires_in: 3600 })
      : Response.json({ error: { status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, { status: 404 }))
    const r = await sendFcm({ serviceAccount: sa, host: 'https://h', tokenUrl: 'https://oauth.test', token: 't'.repeat(30), sealed: SEALED, now: 1, fetch: f as never })
    expect(r).toEqual({ ok: false, code: 'UNREGISTERED', invalid: true })
  })
})
