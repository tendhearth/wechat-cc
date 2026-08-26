import { describe, expect, it, vi } from 'vitest'
import { generateTunnelKeypair, deriveSharedKey, sealFrame, openFrame, exportPublicKeyB64 } from '../lib/tunnel-crypto'
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
    const key = await deriveSharedKey(phone.privateKey, await importDaemonPub(daemonPub!))
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
    const client = makeTunnelClient({ daemonId: 'cc-1', handleRequest: async () => new Response('x'), connect: () => sock.ws as never, log: () => {} })
    client.start()
    sock.emitMessage(JSON.stringify({ stream: 'sZ', frame: { iv: 'aa', ct: 'bb' } }))
    await new Promise(r => setTimeout(r, 0))
    expect(sock.sent).toHaveLength(0)   // nothing sealed back
  })

  it('reconnects after the socket closes', async () => {
    let connects = 0
    const socks = [fakeSocket(), fakeSocket()]
    const client = makeTunnelClient({
      daemonId: 'cc-1', handleRequest: async () => new Response('x'),
      connect: () => socks[connects++]!.ws as never, reconnectMs: 5, log: () => {},
    })
    client.start()
    expect(connects).toBe(1)
    socks[0]!.emitClose()
    await new Promise(r => setTimeout(r, 20))
    expect(connects).toBe(2)
    client.stop()
  })
})

async function importDaemonPub(b64: string) {
  const { importPublicKeyB64 } = await import('../lib/tunnel-crypto')
  return importPublicKeyB64(b64)
}
