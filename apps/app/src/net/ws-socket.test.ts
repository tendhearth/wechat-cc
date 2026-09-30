import { describe, it, expect, vi } from 'vitest'
import { makeWsSocket, type WsLike } from './ws-socket'

class FakeWs implements WsLike {
  static last: FakeWs
  sent: string[] = []
  closes = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  constructor(public url: string) { FakeWs.last = this }
  send(s: string) { this.sent.push(s) }
  close() { this.closes++ }
}

describe('makeWsSocket', () => {
  it('open / 文本消息 / send 原样转交', () => {
    const s = makeWsSocket('wss://relay.example/v2/phone?id=r1', FakeWs)
    const open = vi.fn(), msg = vi.fn()
    s.onOpen(open); s.onMessage(msg)
    expect(FakeWs.last.url).toBe('wss://relay.example/v2/phone?id=r1')
    FakeWs.last.onopen!()
    FakeWs.last.onmessage!({ data: '{"hs":"x"}' })
    s.send('frame')
    expect(open).toHaveBeenCalledTimes(1)
    expect(msg).toHaveBeenCalledWith('{"hs":"x"}')
    expect(FakeWs.last.sent).toEqual(['frame'])
  })
  it('二进制帧丢掉(协议只走文本)', () => {
    const s = makeWsSocket('wss://x', FakeWs)
    const msg = vi.fn(); s.onMessage(msg)
    FakeWs.last.onmessage!({ data: new ArrayBuffer(3) })
    expect(msg).not.toHaveBeenCalled()
  })
  it('只报 error 不报 close(RN 常见)⇒ 仍然 onClose 一次,并关掉底层', () => {
    const s = makeWsSocket('wss://x', FakeWs)
    const close = vi.fn(); s.onClose(close)
    FakeWs.last.onerror!({})
    FakeWs.last.onclose!({})
    expect(close).toHaveBeenCalledTimes(1)
    expect(FakeWs.last.closes).toBe(1)
  })
  it('主动 close() ⇒ onClose 一次;之后的消息不再转交', () => {
    const s = makeWsSocket('wss://x', FakeWs)
    const close = vi.fn(), msg = vi.fn()
    s.onClose(close); s.onMessage(msg)
    s.close(); s.close()
    FakeWs.last.onclose!({})
    FakeWs.last.onmessage!({ data: 'late' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(msg).not.toHaveBeenCalled()
  })
})
