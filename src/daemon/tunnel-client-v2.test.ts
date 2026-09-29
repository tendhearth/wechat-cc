/**
 * 隧道客户端 v2(2026-09-29,手机协议 v2 第 10 步)。手机一端用协议包的真密码学
 * (x25519 + deriveV2Keys + makeV2Channel('client'))加 zod 消息形状拼出来,不手搓密文。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  x25519KeyPair, x25519Shared, deriveV2Keys, makeV2Channel, b64uEncode, b64uDecode, b64Encode, b64Decode,
  ServerHello, SealedV2Frame, V2ServerMessage,
} from '@wechat-cc/protocol'
import type { V2ClientMessageT, V2ServerMessageT, SealedFrameV2 } from '@wechat-cc/protocol'
import { makeTunnelClient } from './tunnel-client'
import { makePhoneEvents, type PhoneEvents, type TopicSource } from './phone-events'

const DTOK = 'dtest0000'

function fakeSocket() {
  const sent: string[] = []
  const handlers: Record<string, (ev: unknown) => void> = {}
  return {
    ws: {
      send: (s: string) => { sent.push(s) },
      close: vi.fn(),
      addEventListener: (t: string, h: (ev: unknown) => void) => { handlers[t] = h },
      readyState: 1,
    },
    sent,
    emit: (o: unknown) => handlers['message']?.({ data: JSON.stringify(o) }),
    emitClose: () => handlers['close']?.({}),
  }
}
type Sock = ReturnType<typeof fakeSocket>

async function waitFor(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) { if (cond()) return; await new Promise(r => setTimeout(r, 1)) }
  throw new Error(`timed out waiting for ${what}`)
}
/** 让排队的微任务 / 链上的帧都跑完(不睡长觉)。 */
async function settle(): Promise<void> { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)) }

type Inbound = { error: string } | V2ServerMessageT

/** 一台 v2 手机:握手、发密封消息、按顺序拆收件箱。 */
async function v2Phone(sock: Sock, stream: string, token = DTOK) {
  const kp = x25519KeyPair()
  const start = sock.sent.length
  sock.emit({ stream, frame: { hs: b64uEncode(kp.pub), v: [1, 2] } })
  await waitFor(() => sock.sent.slice(start).some(s => JSON.parse(s).stream === stream), 'hello')
  const idx = sock.sent.findIndex((s, i) => i >= start && JSON.parse(s).stream === stream)
  const hello = ServerHello.parse(JSON.parse(sock.sent[idx]!).frame)
  const chan = makeV2Channel(deriveV2Keys(x25519Shared(kp.priv, b64uDecode(hello.hs)), token), 'client')
  let cursor = idx + 1
  const inbox: Inbound[] = []
  return {
    hello,
    send(m: V2ClientMessageT): SealedFrameV2 {
      const f = chan.seal(new TextEncoder().encode(JSON.stringify(m)))
      sock.emit({ stream, frame: f })
      return f
    },
    raw(f: unknown) { sock.emit({ stream, frame: f }) },
    /** 把新到的帧拆进 inbox 并返回整个 inbox。 */
    drain(): Inbound[] {
      for (; cursor < sock.sent.length; cursor++) {
        const env = JSON.parse(sock.sent[cursor]!)
        if (env.stream !== stream) continue
        if (typeof env.frame?.error === 'string') { inbox.push({ error: env.frame.error }); continue }
        const sealed = SealedV2Frame.parse(env.frame)
        inbox.push(V2ServerMessage.parse(JSON.parse(new TextDecoder().decode(chan.open(sealed)))))
      }
      return inbox
    },
    async next(pred: (m: Inbound) => boolean = () => true): Promise<Inbound> {
      let hit: Inbound | undefined
      await waitFor(() => { hit = this.drain().find(pred); return hit !== undefined }, 'inbound message')
      inbox.splice(inbox.indexOf(hit!), 1)
      return hit!
    },
  }
}

/** 真集线器 + 数得清活订阅数的包装。 */
function countedHub(sources: TopicSource[]): { hub: PhoneEvents; live: () => number } {
  const real = makePhoneEvents({ sources, pollMs: 3_600_000 })
  let live = 0
  return {
    live: () => live,
    hub: {
      subscribe(topic, since, send) {
        live++
        const un = real.subscribe(topic, since, send)
        let done = false
        return () => { if (!done) { done = true; live--; un() } }
      },
      poke: () => real.poke(),
      dispose: () => real.dispose(),
    },
  }
}

function client(sock: Sock, over: Partial<Parameters<typeof makeTunnelClient>[0]> = {}) {
  const c = makeTunnelClient({
    daemonId: 'cc-1', knownDeviceTokens: () => [DTOK],
    handleRequest: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    connect: () => sock.ws as never, log: () => {}, ...over,
  })
  c.start()
  return c
}

describe('tunnel-client v2', () => {
  it('握手:v 含 2 ⇒ 回 {hs, v:2};不带 v ⇒ 回的还是只有 {hs}(v1 原样)', async () => {
    const sock = fakeSocket()
    client(sock)
    const p = await v2Phone(sock, 's2')
    expect(p.hello.v).toBe(2)
    sock.emit({ stream: 's1', frame: { hs: b64uEncode(x25519KeyPair().pub) } })
    await waitFor(() => sock.sent.some(s => JSON.parse(s).stream === 's1'))
    const v1Reply = JSON.parse(sock.sent.find(s => JSON.parse(s).stream === 's1')!).frame
    expect(Object.keys(v1Reply)).toEqual(['hs'])
    // v:[1] 只会 v1 ⇒ 也按 v1
    sock.emit({ stream: 's3', frame: { hs: b64uEncode(x25519KeyPair().pub), v: [1] } })
    await waitFor(() => sock.sent.some(s => JSON.parse(s).stream === 's3'))
    expect(Object.keys(JSON.parse(sock.sent.find(s => JSON.parse(s).stream === 's3')!).frame)).toEqual(['hs'])
  })

  it('req ⇒ res:URL 改写同 v1(去 d/t、注入认证过的 d 与 _via),带全部响应头,JSON 正文 utf8', async () => {
    const sock = fakeSocket()
    let seen: URL | null = null
    let seenBody = ''
    let seenCT: string | null = null
    client(sock, {
      handleRequest: async (req) => {
        seen = new URL(req.url); seenBody = await req.text(); seenCT = req.headers.get('content-type')
        return new Response(JSON.stringify({ ok: 1 }), { status: 201, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Custom': 'yes' } })
      },
    })
    const p = await v2Phone(sock, 'sR')
    p.send({ t: 'req', rid: 'r1', method: 'POST', path: '/m/api/state?d=forged&t=x&q=1', body: '{"a":1}', bodyEncoding: 'utf8' })
    const res = await p.next()
    expect(res).toMatchObject({ t: 'res', rid: 'r1', status: 201, bodyEncoding: 'utf8', body: '{"ok":1}' })
    expect((res as { headers: Record<string, string> }).headers).toMatchObject({ 'content-type': 'application/json; charset=utf-8', 'x-custom': 'yes' })
    expect(seen!.pathname).toBe('/m/api/state')
    expect(seen!.searchParams.get('d')).toBe(DTOK)
    expect(seen!.searchParams.get('t')).toBeNull()
    expect(seen!.searchParams.get('q')).toBe('1')
    expect(seen!.searchParams.get('_via')).toBe('tunnel')
    expect(seenBody).toBe('{"a":1}')
    expect(seenCT).toBe('application/json')
  })

  it('二进制(贴纸):image/png 响应 ⇒ base64;base64 请求正文按字节交给面板', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 250, 251, 255])
    let got: Uint8Array | null = null
    const sock = fakeSocket()
    client(sock, {
      handleRequest: async (req) => {
        if (req.method === 'PUT') { got = new Uint8Array(await req.arrayBuffer()); return new Response('ok', { headers: { 'content-type': 'text/plain' } }) }
        return new Response(png, { headers: { 'content-type': 'image/png' } })
      },
    })
    const p = await v2Phone(sock, 'sB')
    p.send({ t: 'req', rid: 'g', method: 'GET', path: '/m/sticker.png' })
    const res = await p.next() as { bodyEncoding: string; body: string; headers: Record<string, string> }
    expect(res.bodyEncoding).toBe('base64')
    expect(res.headers['content-type']).toBe('image/png')
    expect(Array.from(b64Decode(res.body))).toEqual(Array.from(png))
    p.send({ t: 'req', rid: 'u', method: 'PUT', path: '/m/api/upload', headers: { 'content-type': 'application/octet-stream' }, body: b64Encode(png), bodyEncoding: 'base64' })
    expect(await p.next()).toMatchObject({ t: 'res', rid: 'u', body: 'ok', bodyEncoding: 'utf8' })
    expect(Array.from(got!)).toEqual(Array.from(png))
  })

  it('重放帧被丢,流不崩,后面的请求照常', async () => {
    const sock = fakeSocket()
    let calls = 0
    const logs: string[] = []
    client(sock, { handleRequest: async () => { calls++; return new Response('{}', { headers: { 'content-type': 'application/json' } }) }, log: (_t, l) => logs.push(l) })
    const p = await v2Phone(sock, 'sP')
    const f = p.send({ t: 'req', rid: 'r1', method: 'POST', path: '/m/api/x' })
    await p.next()
    p.raw(f)                                          // 中继原样再塞一遍
    p.raw({ c: '99', ct: 'AAAA' })                    // 篡改帧
    p.raw({ c: '98', ct: 'AAAA' })
    await settle()
    expect(calls).toBe(1)
    expect(p.drain()).toEqual([])                     // 没回任何东西(包括明文 auth_failed)
    expect(logs.filter(l => /replay|auth/i.test(l) && l.includes('sP')).length).toBe(1)   // 每流只记一次
    p.send({ t: 'req', rid: 'r2', method: 'GET', path: '/m/api/x' })
    expect(await p.next()).toMatchObject({ t: 'res', rid: 'r2' })
    expect(calls).toBe(2)
  })

  it('未知令牌 ⇒ 明文 auth_failed,面板没被调用', async () => {
    const sock = fakeSocket()
    let calls = 0
    client(sock, { knownDeviceTokens: () => ['dother'], handleRequest: async () => { calls++; return new Response('x') } })
    const p = await v2Phone(sock, 'sU', 'dmine')
    p.send({ t: 'req', rid: 'r1', method: 'GET', path: '/m/api/x' })
    expect(await p.next()).toEqual({ error: 'auth_failed' })
    expect(calls).toBe(0)
  })

  it('链接令牌也能握 v2', async () => {
    const sock = fakeSocket()
    let d: string | null = null
    client(sock, { knownDeviceTokens: () => [], activeLinkToken: () => 'tlink', handleRequest: async (r) => { d = new URL(r.url).searchParams.get('d'); return new Response('{}') } })
    const p = await v2Phone(sock, 'sL', 'tlink')
    p.send({ t: 'req', rid: 'r1', method: 'GET', path: '/set' })
    expect(await p.next()).toMatchObject({ t: 'res', rid: 'r1', status: 200 })
    expect(d).toBe('tlink')
  })

  it('每条流串行:前一个请求没回,后一个不进面板(v2 与 v1 都是)', async () => {
    const sock = fakeSocket()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    client(sock, {
      handleRequest: async (req) => {
        const path = new URL(req.url).pathname
        order.push(`start ${path}`)
        if (path === '/slow') await gate
        order.push(`end ${path}`)
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      },
    })
    const p = await v2Phone(sock, 'sS')
    p.send({ t: 'req', rid: 'a', method: 'GET', path: '/slow' })
    p.send({ t: 'req', rid: 'b', method: 'GET', path: '/fast' })
    await settle()
    expect(order).toEqual(['start /slow'])
    release()
    await p.next(m => 't' in m && m.t === 'res' && m.rid === 'b')
    expect(order).toEqual(['start /slow', 'end /slow', 'start /fast', 'end /fast'])
  })

  it('sub:先收到当下状态,poke 后收到变化;同 epoch seq 递增', async () => {
    let state = { n: 1 }
    const { hub, live } = countedHub([{ match: t => t === 'home', snapshot: async () => state }])
    const sock = fakeSocket()
    client(sock, { events: hub })
    const p = await v2Phone(sock, 'sE')
    p.send({ t: 'sub', sid: 's1', topic: 'home' })
    const ev1 = await p.next() as { t: string; sid: string; epoch: string; seq: number; data: unknown }
    expect(ev1).toMatchObject({ t: 'ev', sid: 's1', data: { n: 1 } })
    expect(live()).toBe(1)
    state = { n: 2 }
    hub.poke()
    const ev2 = await p.next() as typeof ev1
    expect(ev2).toMatchObject({ t: 'ev', sid: 's1', epoch: ev1.epoch, data: { n: 2 } })
    expect(ev2.seq).toBeGreaterThan(ev1.seq)
    // unsub ⇒ 集线器里摘掉
    p.send({ t: 'unsub', sid: 's1' })
    await waitFor(() => live() === 0, 'unsub')
    hub.dispose()
  })

  it('同一流上重复的 sid ⇒ 替换旧订阅', async () => {
    const { hub, live } = countedHub([{ match: () => true, snapshot: async (t) => ({ t }) }])
    const sock = fakeSocket()
    client(sock, { events: hub })
    const p = await v2Phone(sock, 'sD')
    p.send({ t: 'sub', sid: 'x', topic: 'home' })
    await p.next()
    p.send({ t: 'sub', sid: 'x', topic: 'agents' })
    expect(await p.next()).toMatchObject({ t: 'ev', sid: 'x', data: { t: 'agents' } })
    expect(live()).toBe(1)
    hub.dispose()
  })

  it('不在册主题 ⇒ err topic_not_allowed;没有集线器 ⇒ err subscriptions_unavailable', async () => {
    const { hub, live } = countedHub([{ match: () => true, snapshot: async () => ({}) }])
    const sock = fakeSocket()
    client(sock, { events: hub })
    const p = await v2Phone(sock, 'sT')
    p.send({ t: 'sub', sid: 'bad', topic: 'secrets' })
    expect(await p.next()).toEqual({ t: 'err', sid: 'bad', code: 'topic_not_allowed' })
    expect(live()).toBe(0)

    const sock2 = fakeSocket()
    client(sock2)
    const p2 = await v2Phone(sock2, 'sN')
    p2.send({ t: 'sub', sid: 'h', topic: 'home' })
    expect(await p2.next()).toEqual({ t: 'err', sid: 'h', code: 'subscriptions_unavailable' })
    hub.dispose()
  })

  it('撤销设备:下一条事件发出前关流 —— 明文 auth_failed、订阅全退、流被忘掉', async () => {
    let tokens = [DTOK]
    let state = { n: 1 }
    const { hub, live } = countedHub([{ match: () => true, snapshot: async () => state }])
    const sock = fakeSocket()
    let calls = 0
    client(sock, { events: hub, knownDeviceTokens: () => tokens, handleRequest: async () => { calls++; return new Response('{}') } })
    const p = await v2Phone(sock, 'sV')
    p.send({ t: 'sub', sid: 'a', topic: 'home' })
    p.send({ t: 'sub', sid: 'b', topic: 'agents' })
    await p.next(m => 't' in m && m.t === 'ev' && m.sid === 'a')
    await p.next(m => 't' in m && m.t === 'ev' && m.sid === 'b')
    expect(live()).toBe(2)
    tokens = []
    state = { n: 2 }
    hub.poke()
    expect(await p.next()).toEqual({ error: 'auth_failed' })
    await settle()
    expect(live()).toBe(0)
    expect(p.drain().filter(m => 't' in m && m.t === 'ev')).toEqual([])
    // 流已忘:后面的密封帧当成「握手前」丢掉,面板不被调用
    tokens = [DTOK]
    p.send({ t: 'req', rid: 'late', method: 'GET', path: '/m/api/x' })
    await settle()
    expect(calls).toBe(0)
    hub.dispose()
  })

  it('撤销设备:下一个 req 之前关流', async () => {
    let tokens = [DTOK]
    const sock = fakeSocket()
    let calls = 0
    client(sock, { knownDeviceTokens: () => tokens, handleRequest: async () => { calls++; return new Response('{}') } })
    const p = await v2Phone(sock, 'sW')
    p.send({ t: 'req', rid: 'r1', method: 'GET', path: '/m/api/x' })
    await p.next()
    tokens = []
    p.send({ t: 'req', rid: 'r2', method: 'GET', path: '/m/api/x' })
    expect(await p.next()).toEqual({ error: 'auth_failed' })
    expect(calls).toBe(1)
  })

  it('流关闭 / 中继断线 / 同流重新握手 ⇒ 集线器里没有残留订阅', async () => {
    const { hub, live } = countedHub([{ match: () => true, snapshot: async () => ({}) }])
    const sock = fakeSocket()
    client(sock, { events: hub, reconnectMs: 3_600_000 })
    const a = await v2Phone(sock, 'sA')
    a.send({ t: 'sub', sid: '1', topic: 'home' })
    await a.next()
    expect(live()).toBe(1)
    sock.emit({ stream: 'sA', closed: true })
    await waitFor(() => live() === 0, 'closed stream unsubscribed')

    const b = await v2Phone(sock, 'sB')
    b.send({ t: 'sub', sid: '1', topic: 'home' })
    await b.next()
    await v2Phone(sock, 'sB')                          // 同一流 id 新握手
    await waitFor(() => live() === 0, 're-handshake unsubscribed')

    const c = await v2Phone(sock, 'sC')
    c.send({ t: 'sub', sid: '1', topic: 'home' })
    c.send({ t: 'sub', sid: '2', topic: 'agents' })
    await c.next(); await c.next()
    expect(live()).toBe(2)
    sock.emitClose()
    await waitFor(() => live() === 0, 'socket close unsubscribed')
    hub.dispose()
  })
})
