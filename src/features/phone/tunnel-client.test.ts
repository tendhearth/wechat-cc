/**
 * 隧道客户端的传输层:心跳、重连退避、中继 v2 登录与控制帧、每条流的排队上限,以及几条
 * 端到端的流(真 settings-panel、过期链接、中继说手机走了)。协议 v2 一条流里的细节见
 * tunnel-client-v2.test.ts。手机一端用协议包的真密码学拼,不手搓密文。
 */
import { describe, expect, it, vi } from 'vitest'
import { x25519KeyPair, x25519Shared, deriveV2Keys, makeV2Channel, b64uEncode, b64uDecode, ServerHello, V2ServerMessage } from '@wechat-cc/protocol'
import type { V2ClientMessageT } from '@wechat-cc/protocol'
import { makeTunnelClient, MAX_QUEUED_FRAMES_PER_STREAM } from './tunnel-client'

const DTOK = 'dtest0000'
const LOGIN = { sign: (c: string) => ({ pub: 'P', sig: `S(${c})` }) }
const RELAY = 'wss://relay.test/v2/daemon'

// A fake WS: daemon-side socket the client drives; the test plays the relay + phone.
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
    emitOpen: () => handlers['open']?.({}),
    emitMessage: (data: string) => handlers['message']?.({ data }),
    emitClose: () => handlers['close']?.({}),
  }
}
type Sock = ReturnType<typeof fakeSocket>

async function waitFor(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) { if (cond()) return; await new Promise(r => setTimeout(r, 1)) }
  throw new Error(`timed out waiting for ${what}`)
}

/** 握手一条 v2 流,返回发消息 / 读回复的两只手。 */
async function phone(sock: Sock, stream: string, token = DTOK) {
  const kp = x25519KeyPair()
  const start = sock.sent.length
  sock.emitMessage(JSON.stringify({ stream, frame: { hs: b64uEncode(kp.pub), v: [2] } }))
  await waitFor(() => sock.sent.slice(start).some(s => JSON.parse(s).stream === stream), 'hello')
  const hello = ServerHello.parse(JSON.parse(sock.sent.slice(start).find(s => JSON.parse(s).stream === stream)!).frame)
  const chan = makeV2Channel(deriveV2Keys(x25519Shared(kp.priv, b64uDecode(hello.hs)), token), 'client')
  let cursor = start
  const inbox: unknown[] = []
  return {
    send(m: V2ClientMessageT) { sock.emitMessage(JSON.stringify({ stream, frame: chan.seal(new TextEncoder().encode(JSON.stringify(m))) })) },
    /** 握手之后发给这台手机的帧(按到达顺序):明文错误原样,密封帧解开(每帧只开一次,计数器不许回头)。 */
    replies(): unknown[] {
      for (; cursor < sock.sent.length; cursor++) {
        const e = JSON.parse(sock.sent[cursor]!)
        if (e.stream !== stream || e.close || e.frame?.hs) continue
        inbox.push(typeof e.frame?.error === 'string' ? { error: e.frame.error } : V2ServerMessage.parse(JSON.parse(new TextDecoder().decode(chan.open(e.frame)))))
      }
      return inbox
    },
  }
}

function mk(sock: Sock, over: Partial<Parameters<typeof makeTunnelClient>[0]> = {}) {
  const client = makeTunnelClient({
    daemonId: 'rabc', knownDeviceTokens: () => [DTOK],
    handleRequest: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    connect: () => sock.ws as never, log: () => {}, relayUrl: RELAY, login: LOGIN, ...over,
  })
  client.start()
  return client
}

describe('tunnel-client (daemon side)', () => {
  it('心跳:定时 ping;有 pong 就保持,连续两轮没 pong 就强制 close(触发重连);心跳是固定的 {"ping":1}', () => {
    vi.useFakeTimers()
    try {
      const sock = fakeSocket()
      mk(sock, { pingIntervalMs: 100, now: () => 0 })
      sock.emitOpen()
      // 第一轮:发出 ping,还没判死
      vi.advanceTimersByTime(100)
      expect(sock.sent).toContain('{"ping":1}')
      expect(sock.ws.close).not.toHaveBeenCalled()
      // 回 pong → 活着,下一轮继续 ping、不关
      sock.emitMessage(JSON.stringify({ pong: 0 }))
      vi.advanceTimersByTime(100)
      expect(sock.ws.close).not.toHaveBeenCalled()
      // 这一轮 ping 没人回 → 再下一轮判死、强制 close
      vi.advanceTimersByTime(100)
      expect(sock.ws.close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('心跳:活跃数据帧也算「活着」,不在会话中误杀(pong 被拖慢也不怕)', () => {
    vi.useFakeTimers()
    try {
      const sock = fakeSocket()
      mk(sock, { pingIntervalMs: 100, now: () => 0 })
      sock.emitOpen()
      vi.advanceTimersByTime(100)                                   // 发出 ping、等 pong
      sock.emitMessage(JSON.stringify({ stream: 'sX', frame: {} })) // 来了个数据帧 = 连接活着
      vi.advanceTimersByTime(100)                                   // 不该判死
      expect(sock.ws.close).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('/m/api/home 经隧道往返:真 settings-panel 处理,设备 token 生效', async () => {
    const { makeSettingsPanel } = await import('./settings-panel')
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const stateDir = mkdtempSync(join(tmpdir(), 'tunnel-home-'))
    // 隧道用 knownDeviceTokens 认证流;panel 用 settings-devices.json 认 ?d= —— 两边写同一枚。
    writeFileSync(join(stateDir, 'settings-devices.json'), JSON.stringify({ [DTOK]: { created_at: '2026-09-06T00:00:00.000Z' } }))
    const panel = makeSettingsPanel({
      stateDir, ownerChatId: () => 'o', chatPrefs: { get: () => ({}), set: () => ({}) },
      getUserName: () => null, setUserName: async () => {},
      feed: { journal: { list: () => [] }, planLogDays: () => [], turnsRecent: () => [], timezone: () => 'UTC' },
      seen: { read: () => null, write: () => {} },
      log: () => {},
    })
    try {
      const sock = fakeSocket()
      mk(sock, { handleRequest: (req) => panel.handleRequest(req) })
      const p = await phone(sock, 'sH')
      p.send({ t: 'req', rid: 'r1', method: 'GET', path: `/m/api/home?d=${DTOK}` })
      await waitFor(() => p.replies().length === 1, 'home reply')
      const res = p.replies()[0] as { t: string; status: number; body: string }
      expect(res).toMatchObject({ t: 'res', rid: 'r1', status: 200 })
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.events).toEqual([])
      expect(body.sources_degraded).toEqual([])
      expect(body.presence).toBeNull()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('畸形路径被干净拒绝 —— 不路由、不 unhandled reject(边界测试)', async () => {
    // '%' / ' /x' 会让 new URL 抛;'set/api' 会把 host 污染成 127.0.0.1set → 误路由到 /api。都该被拒。
    for (const badPath of ['%', ' /x', 'set/api', '@evil.com/steal']) {
      const sock = fakeSocket()
      let calls = 0
      mk(sock, { handleRequest: async () => { calls++; return new Response('x') } })
      const p = await phone(sock, 'sA')
      p.send({ t: 'req', rid: 'r1', method: 'GET', path: badPath })
      await waitFor(() => p.replies().length === 1, `reply for ${badPath}`)
      expect(p.replies()[0]).toMatchObject({ t: 'err', rid: 'r1', code: 'bad_request' })
      expect(calls).toBe(0)
    }
  })

  it('排队帧上限:握手未完时同一流连发 70 帧 ⇒ 超出 64 的丢弃,只记一行 queue full', async () => {
    const sock = fakeSocket()
    const logs: string[] = []
    mk(sock, { log: (_t, l) => { logs.push(l) }, now: () => 0 })
    sock.emitMessage(JSON.stringify({ stream: 'sQ', frame: { hs: b64uEncode(x25519KeyPair().pub), v: [2] } }))
    for (let i = 0; i < 69; i++) sock.emitMessage(JSON.stringify({ stream: 'sQ', frame: { c: String(i), ct: 'bb' } }))
    await new Promise(r => setTimeout(r, 50))
    expect(MAX_QUEUED_FRAMES_PER_STREAM).toBe(64)
    expect(logs.filter(l => l.includes('queue full'))).toHaveLength(1)
  })

  it('an expired /set link (no active link token) is refused with auth_failed + close', async () => {
    const sock = fakeSocket()
    let handled = false
    mk(sock, { knownDeviceTokens: () => [], activeLinkToken: () => null, handleRequest: async () => { handled = true; return new Response('x') } })
    const p = await phone(sock, 'sE', 'tstale')
    p.send({ t: 'req', rid: 'r1', method: 'GET', path: '/set' })
    await waitFor(() => sock.sent.some(s => JSON.parse(s).close === true), 'close')
    expect(handled).toBe(false)
    expect(p.replies()).toEqual([{ error: 'auth_failed' }])
  })

  it('a closed control frame frees the stream state (later sealed frames ⇒ stream_unknown, never the router)', async () => {
    const sock = fakeSocket()
    let handled = 0
    mk(sock, { handleRequest: async () => { handled++; return new Response('{}') } })
    const p = await phone(sock, 'sC')
    sock.emitMessage(JSON.stringify({ stream: 'sC', closed: true }))   // relay says: phone gone
    p.send({ t: 'req', rid: 'r9', method: 'GET', path: '/m/api/state' })
    await waitFor(() => p.replies().length === 1, 'stream_unknown')
    expect(p.replies()).toEqual([{ error: 'stream_unknown' }])
    expect(handled).toBe(0)
  })

  it('reconnects after the socket closes', async () => {
    let connects = 0
    const socks = [fakeSocket(), fakeSocket()]
    const client = makeTunnelClient({
      daemonId: 'rabc', knownDeviceTokens: () => [DTOK], handleRequest: async () => new Response('x'),
      connect: () => socks[connects++]!.ws as never, reconnectMs: 5, log: () => {}, relayUrl: RELAY, login: LOGIN,
    })
    client.start()
    expect(connects).toBe(1)
    socks[0]!.emitClose()
    await new Promise(r => setTimeout(r, 20))
    expect(connects).toBe(2)
    client.stop()
  })

  it('collapses reconnect churn into one disconnect line + one recovery summary', async () => {
    // Regression (2026-08-27 日志:网络抖动时每 15s 刷一条 "socket closed",
    // 1338 行淹没真信号)。现在:首次断开一条,后续静默重试,恢复(login_ok)报摘要。
    const logs: string[] = []
    const socks = [fakeSocket(), fakeSocket(), fakeSocket()]
    let ci = 0, clock = 0
    const client = makeTunnelClient({
      daemonId: 'rabc', knownDeviceTokens: () => [DTOK], handleRequest: async () => new Response('x'),
      connect: () => socks[ci++]!.ws as never, reconnectMs: 3, now: () => (clock += 1000),
      log: (_tag, line) => logs.push(line), relayUrl: RELAY, login: LOGIN,
    })
    client.start()
    socks[0]!.emitClose()                          // 1st close → one "socket closed" line
    await new Promise(r => setTimeout(r, 12))      // reconnect → sock1
    socks[1]!.emitClose()                          // churn → NO new "socket closed" line
    await new Promise(r => setTimeout(r, 12))      // reconnect → sock2
    socks[2]!.emitOpen()
    socks[2]!.emitMessage(JSON.stringify({ login_ok: true }))   // recovery → summary
    client.stop()
    const closedLines = logs.filter(l => l.includes('socket closed'))
    const recoveredLines = logs.filter(l => l.includes('reconnected to relay after'))
    expect(closedLines).toHaveLength(1)            // churn collapsed
    expect(recoveredLines).toHaveLength(1)         // one recovery summary
    expect(recoveredLines[0]).toContain('attempt')
  })
})

describe('tunnel-client:中继 v2 登录与控制帧', () => {
  function v2Client(extra: Partial<Parameters<typeof makeTunnelClient>[0]> = {}) {
    const sock = fakeSocket()
    const connect = vi.fn((_url: string, _protocols?: string[]) => sock.ws as never)
    const client = makeTunnelClient({
      daemonId: 'rabc', knownDeviceTokens: () => [DTOK],
      handleRequest: async () => new Response('x'),
      connect, log: () => {}, relayUrl: RELAY, login: LOGIN,
      ...extra,
    })
    return { sock, connect, client }
  }

  it('URL 不带 id,id 走子协议', () => {
    const { connect, client } = v2Client()
    client.start()
    expect(connect).toHaveBeenCalledWith('wss://relay.test/v2/daemon', ['wcc.relay.v2', 'id.rabc'])
    client.stop()
  })

  it('收到挑战 ⇒ 回签名;login_ok ⇒ onLogin,之后 sendControl 才发得出去', () => {
    const onLogin = vi.fn()
    const { sock, client } = v2Client({ onLogin })
    client.start(); sock.emitOpen()
    expect(client.sendControl({ push_unreg: { device: 'd1' } })).toBe(false)
    sock.emitMessage(JSON.stringify({ challenge: 'CH', ts: 1 }))
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ pub: 'P', sig: 'S(CH)' })
    sock.emitMessage(JSON.stringify({ login_ok: true }))
    expect(onLogin).toHaveBeenCalledTimes(1)
    expect(client.sendControl({ push_unreg: { device: 'd1' } })).toBe(true)
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ push_unreg: { device: 'd1' } })
    client.stop()
  })

  it('push_result / push_invalid / error ⇒ onControl', () => {
    const onControl = vi.fn()
    const { sock, client } = v2Client({ onControl })
    client.start(); sock.emitOpen()
    sock.emitMessage(JSON.stringify({ push_result: { device: 'd', ok: true, code: 'ok', ref: 'r' } }))
    sock.emitMessage(JSON.stringify({ push_invalid: { device: 'd' } }))
    sock.emitMessage(JSON.stringify({ error: 'rate_limited' }))
    expect(onControl.mock.calls.map(c => Object.keys(c[0])[0])).toEqual(['push_result', 'push_invalid', 'error'])
    client.stop()
  })

  it('断线重连后要重新登录:sendControl 回到 false', () => {
    vi.useFakeTimers()
    try {
      const { sock, client } = v2Client()
      client.start(); sock.emitOpen()
      sock.emitMessage(JSON.stringify({ challenge: 'C', ts: 1 }))
      sock.emitMessage(JSON.stringify({ login_ok: true }))
      sock.emitClose()
      expect(client.sendControl({ x: 1 })).toBe(false)
      client.stop()
    } finally { vi.useRealTimers() }
  })

  it('v2 被拒(open 后 login_failed 再 close)⇒ 退避翻倍,不卡在 2s', () => {
    vi.useFakeTimers()
    try {
      const socks = [fakeSocket(), fakeSocket(), fakeSocket()]
      let n = 0
      const connect = vi.fn((_u: string, _p?: string[]) => socks[n++]!.ws as never)
      const client = makeTunnelClient({
        daemonId: 'rabc', knownDeviceTokens: () => [], handleRequest: async () => new Response(''),
        connect, log: () => {}, relayUrl: RELAY, login: { sign: () => ({ pub: 'P', sig: 'S' }) },
      })
      client.start()
      for (let i = 0; i < 2; i++) {
        socks[i]!.emitOpen()
        socks[i]!.emitMessage(JSON.stringify({ challenge: 'C', ts: 1 }))
        socks[i]!.emitMessage(JSON.stringify({ error: 'login_failed' }))
        socks[i]!.emitClose()
      }
      expect(connect).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1999); expect(connect).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1); expect(connect).toHaveBeenCalledTimes(2)   // 第一次 2s
      socks[1]!.emitOpen(); socks[1]!.emitMessage(JSON.stringify({ error: 'login_failed' })); socks[1]!.emitClose()
      vi.advanceTimersByTime(3999); expect(connect).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(1); expect(connect).toHaveBeenCalledTimes(3)   // 第二次 4s
      client.stop()
    } finally { vi.useRealTimers() }
  })

  it('v2 login_ok 清零退避:之后断线又是 2s', () => {
    vi.useFakeTimers()
    try {
      const socks = [fakeSocket(), fakeSocket(), fakeSocket()]
      let n = 0
      const connect = vi.fn((_u: string, _p?: string[]) => socks[n++]!.ws as never)
      const client = makeTunnelClient({
        daemonId: 'rabc', knownDeviceTokens: () => [], handleRequest: async () => new Response(''),
        connect, log: () => {}, relayUrl: RELAY, login: { sign: () => ({ pub: 'P', sig: 'S' }) },
      })
      client.start()
      socks[0]!.emitOpen(); socks[0]!.emitClose()               // 被拒:attempts=1
      vi.advanceTimersByTime(2000)
      socks[1]!.emitOpen(); socks[1]!.emitMessage(JSON.stringify({ login_ok: true }))
      socks[1]!.emitClose()                                      // 登录成功后断线 ⇒ 重新从 2s 起
      vi.advanceTimersByTime(1999); expect(connect).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(1); expect(connect).toHaveBeenCalledTimes(3)
      client.stop()
    } finally { vi.useRealTimers() }
  })
})
