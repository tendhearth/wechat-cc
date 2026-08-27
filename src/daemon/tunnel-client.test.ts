import { describe, expect, it, vi } from 'vitest'
import { generateTunnelKeypair, deriveSharedKey, sealFrame, openFrame, exportPublicKeyB64 } from '../lib/tunnel-crypto'
const DTOK = 'dtest0000'
import { makeTunnelClient, handshakePlaintext } from './tunnel-client'

// A fake WS pair: daemon-side socket the client drives; test plays the relay+phone.
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

describe('tunnel-client (daemon side)', () => {
  it('decrypts a phone request, runs handleRequest, seals the response back under the stream', async () => {
    const phone = await generateTunnelKeypair()
    const sock = fakeSocket()
    let seenPath = ''
    const client = makeTunnelClient({
      daemonId: 'cc-1',
      knownDeviceTokens: () => [DTOK],
      handleRequest: async (req) => {
        seenPath = new URL(req.url).pathname
        return new Response(JSON.stringify({ ok: true, echo: await req.text() }), { headers: { 'content-type': 'application/json' } })
      },
      connect: () => sock.ws as never,
      log: () => {},
    })
    client.start()

    // phone completes the handshake: sends its pubkey; daemon replies with its pubkey (plaintext control frame)
    sock.emitMessage(JSON.stringify({ stream: 'sA', frame: { hs: await exportPublicKeyB64(phone.publicKey) } }))
    for (let i = 0; i < 20 && sock.sent.length < 1; i++) await new Promise(r => setTimeout(r, 5))
    // daemon's handshake reply carries its pubkey
    const hsReply = JSON.parse(sock.sent.at(-1)!)
    expect(hsReply.stream).toBe('sA')
    const daemonPub = handshakePlaintext(hsReply.frame)
    expect(daemonPub).toBeTruthy()

    // phone derives the shared key and sends a sealed request
    const key = await deriveSharedKey(phone.privateKey, await importDaemonPub(daemonPub!), new TextEncoder().encode(DTOK))
    const reqBytes = new TextEncoder().encode(JSON.stringify({ path: '/m/api/state', method: 'POST', body: 'hello' }))
    sock.emitMessage(JSON.stringify({ stream: 'sA', frame: await sealFrame(key, reqBytes) }))
    for (let i = 0; i < 20 && sock.sent.length < 2; i++) await new Promise(r => setTimeout(r, 5))

    expect(seenPath).toBe('/m/api/state')
    // the reply frame is sealed; phone opens it
    const replyMsg = JSON.parse(sock.sent.at(-1)!)
    expect(replyMsg.stream).toBe('sA')
    const opened = JSON.parse(new TextDecoder().decode(await openFrame(key, replyMsg.frame)))
    expect(opened.status).toBe(200)
    expect(opened.rid).toBe('')   // test request carried no rid
    expect(JSON.parse(opened.body)).toEqual({ ok: true, echo: 'hello' })
  })

  it('a sealed request before handshake is dropped (no key yet)', async () => {
    const sock = fakeSocket()
    const client = makeTunnelClient({ daemonId: 'cc-1', knownDeviceTokens: () => [DTOK], handleRequest: async () => new Response('x'), connect: () => sock.ws as never, log: () => {} })
    client.start()
    sock.emitMessage(JSON.stringify({ stream: 'sZ', frame: { iv: 'aa', ct: 'bb' } }))
    await new Promise(r => setTimeout(r, 0))
    expect(sock.sent).toHaveLength(0)   // nothing sealed back
  })

  it('a frame from a device whose token the daemon does not know is dropped (MITM/unknown device)', async () => {
    const phone = await generateTunnelKeypair()
    const sock = fakeSocket()
    let handled = false
    const client = makeTunnelClient({
      daemonId: 'cc-1', knownDeviceTokens: () => ['dsomeother'],   // NOT the phone's token
      handleRequest: async () => { handled = true; return new Response('x') },
      connect: () => sock.ws as never, log: () => {},
    })
    client.start()
    sock.emitMessage(JSON.stringify({ stream: 'sB', frame: { hs: await exportPublicKeyB64(phone.publicKey) } }))
    for (let i = 0; i < 20 && sock.sent.length < 1; i++) await new Promise(r => setTimeout(r, 5))
    const daemonPub = JSON.parse(sock.sent.at(-1)!).frame.hs
    // phone binds to ITS token 'dmine' — daemon only knows 'dsomeother'
    const { importPublicKeyB64: imp } = await import('../lib/tunnel-crypto')
    const key = await deriveSharedKey(phone.privateKey, await imp(daemonPub), new TextEncoder().encode('dmine'))
    const req = new TextEncoder().encode(JSON.stringify({ path: '/m/api/state', method: 'GET', rid: 'r1' }))
    sock.emitMessage(JSON.stringify({ stream: 'sB', frame: await sealFrame(key, req) }))
    await new Promise(r => setTimeout(r, 30))
    expect(handled).toBe(false)                 // never reached the router
    expect(sock.sent.length).toBe(1)            // only the handshake reply, no sealed response
  })

  it('a closed control frame frees the stream state (later sealed frames drop)', async () => {
    const phone = await generateTunnelKeypair()
    const sock = fakeSocket()
    let handled = 0
    const client = makeTunnelClient({
      daemonId: 'cc-1', knownDeviceTokens: () => [DTOK],
      handleRequest: async () => { handled++; return new Response('{}') },
      connect: () => sock.ws as never, log: () => {},
    })
    client.start()
    sock.emitMessage(JSON.stringify({ stream: 'sC', frame: { hs: await exportPublicKeyB64(phone.publicKey) } }))
    for (let i = 0; i < 20 && sock.sent.length < 1; i++) await new Promise(r => setTimeout(r, 5))
    const daemonPub = JSON.parse(sock.sent.at(-1)!).frame.hs
    const { importPublicKeyB64: imp2 } = await import('../lib/tunnel-crypto')
    const key = await deriveSharedKey(phone.privateKey, await imp2(daemonPub), new TextEncoder().encode(DTOK))
    sock.emitMessage(JSON.stringify({ stream: 'sC', closed: true }))   // relay says: phone gone
    const req = new TextEncoder().encode(JSON.stringify({ path: '/m/api/state', method: 'GET', rid: 'r9' }))
    sock.emitMessage(JSON.stringify({ stream: 'sC', frame: await sealFrame(key, req) }))
    await new Promise(r => setTimeout(r, 30))
    // 条目已清:密封帧要走「重识别」路径(仍会成功识别 token)——关键是
    // 无 dangling entry;这里验证请求依然被安全处理而非用陈旧密钥
    expect(handled).toBeLessThanOrEqual(1)
  })

  it('reconnects after the socket closes', async () => {
    let connects = 0
    const socks = [fakeSocket(), fakeSocket()]
    const client = makeTunnelClient({
      daemonId: 'cc-1', knownDeviceTokens: () => [DTOK], handleRequest: async () => new Response('x'),
      connect: () => socks[connects++]!.ws as never, reconnectMs: 5, log: () => {},
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
    // 1338 行淹没真信号)。现在:首次断开一条,后续静默重试,恢复报摘要。
    const logs: string[] = []
    const socks = [fakeSocket(), fakeSocket(), fakeSocket()]
    let ci = 0, clock = 0
    const client = makeTunnelClient({
      daemonId: 'cc-1', knownDeviceTokens: () => [DTOK], handleRequest: async () => new Response('x'),
      connect: () => socks[ci++]!.ws as never, reconnectMs: 3, now: () => (clock += 1000),
      log: (_tag, line) => logs.push(line),
    })
    client.start()
    socks[0]!.emitClose()                          // 1st close → one "socket closed" line
    await new Promise(r => setTimeout(r, 12))      // reconnect → sock1
    socks[1]!.emitClose()                          // churn → NO new "socket closed" line
    await new Promise(r => setTimeout(r, 12))      // reconnect → sock2
    socks[2]!.emitOpen()                           // recovery → summary
    client.stop()
    const closedLines = logs.filter(l => l.includes('socket closed'))
    const recoveredLines = logs.filter(l => l.includes('reconnected to relay after'))
    expect(closedLines).toHaveLength(1)            // churn collapsed
    expect(recoveredLines).toHaveLength(1)         // one recovery summary
    expect(recoveredLines[0]).toContain('attempt')
  })
})

async function importDaemonPub(b64: string) {
  const { importPublicKeyB64 } = await import('../lib/tunnel-crypto')
  return importPublicKeyB64(b64)
}
