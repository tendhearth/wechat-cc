import { describe, expect, it } from 'vitest'
import { makeTunnelHub } from './tunnel'

// A fake WS: records sent frames, lets tests drive close.
function fakeWs() {
  const sent: string[] = []
  let closed = false
  return {
    ws: {
      send: (s: string) => { sent.push(s) },
      close: () => { closed = true },
      readyState: 1,
    } as unknown as import('./tunnel').TunnelSocket,
    sent,
    isClosed: () => closed,
  }
}

describe('makeTunnelHub — content-blind daemon<->phone relay', () => {
  it('心跳:daemon 发 {ping} → relay 回 {pong}(值原样带回)', () => {
    const hub = makeTunnelHub({ now: () => 0 })
    const daemon = fakeWs()
    hub.registerDaemon('cc-1', daemon.ws)
    hub.onDaemonFrame('cc-1', JSON.stringify({ ping: 42 }))
    expect(daemon.sent.map(s => JSON.parse(s)).some(m => m.pong === 42)).toBe(true)
  })

  it('routes a phone frame to the registered daemon and the reply back', () => {
    const hub = makeTunnelHub({ rate: { capacity: 100, refillPerSec: 100 }, now: () => 0 })
    const daemon = fakeWs()
    const phone = fakeWs()
    hub.registerDaemon('cc-1', daemon.ws)
    const attach = hub.attachPhone('cc-1', phone.ws)
    expect(attach.ok).toBe(true)

    // phone → daemon: hub forwards the opaque frame, tagged with the phone's stream id
    hub.onPhoneFrame(attach.streamId!, JSON.stringify({ iv: 'x', ct: 'y' }))
    expect(daemon.sent).toHaveLength(1)
    const toDaemon = JSON.parse(daemon.sent[0]!)
    expect(toDaemon.stream).toBe(attach.streamId)
    expect(toDaemon.frame).toEqual({ iv: 'x', ct: 'y' })

    // daemon → phone: reply tagged with the same stream id lands on that phone only
    hub.onDaemonFrame('cc-1', JSON.stringify({ stream: attach.streamId, frame: { iv: 'a', ct: 'b' } }))
    expect(phone.sent).toHaveLength(1)
    expect(JSON.parse(phone.sent[0]!)).toEqual({ iv: 'a', ct: 'b' })
  })

  it('a phone for an offline daemon is rejected (no daemon socket)', () => {
    const hub = makeTunnelHub({ now: () => 0 })
    const phone = fakeWs()
    const attach = hub.attachPhone('nope', phone.ws)
    expect(attach.ok).toBe(false)
    expect(attach.error).toBe('daemon_offline')
  })

  it('daemon reply for an unknown stream is dropped, never crashes', () => {
    const hub = makeTunnelHub({ now: () => 0 })
    const daemon = fakeWs()
    hub.registerDaemon('cc-1', daemon.ws)
    expect(() => hub.onDaemonFrame('cc-1', JSON.stringify({ stream: 'ghost', frame: {} }))).not.toThrow()
  })

  it('never inspects frame contents — a frame with no iv/ct still forwards verbatim', () => {
    const hub = makeTunnelHub({ now: () => 0 })
    const daemon = fakeWs()
    const phone = fakeWs()
    hub.registerDaemon('cc-1', daemon.ws)
    const attach = hub.attachPhone('cc-1', phone.ws)
    hub.onPhoneFrame(attach.streamId!, '{"anything":123}')
    expect(JSON.parse(daemon.sent[0]!).frame).toEqual({ anything: 123 })
  })

  it('rate-limits phone frames per stream', () => {
    const hub = makeTunnelHub({ rate: { capacity: 2, refillPerSec: 0 }, now: () => 0 })
    const daemon = fakeWs()
    const phone = fakeWs()
    hub.registerDaemon('cc-1', daemon.ws)
    const attach = hub.attachPhone('cc-1', phone.ws)
    hub.onPhoneFrame(attach.streamId!, '{}')
    hub.onPhoneFrame(attach.streamId!, '{}')
    hub.onPhoneFrame(attach.streamId!, '{}')   // over budget
    expect(daemon.sent).toHaveLength(2)
  })

  it('daemon disconnect drops its phones; phone disconnect frees the stream', () => {
    const hub = makeTunnelHub({ now: () => 0 })
    const daemon = fakeWs()
    const phone = fakeWs()
    hub.registerDaemon('cc-1', daemon.ws)
    const attach = hub.attachPhone('cc-1', phone.ws)
    hub.dropDaemon('cc-1')
    expect(phone.isClosed()).toBe(true)
    // a new frame for that stream is now a no-op (daemon gone)
    expect(() => hub.onPhoneFrame(attach.streamId!, '{}')).not.toThrow()
    hub.dropPhone(attach.streamId!)   // idempotent
  })

  it('phone disconnect notifies the daemon with a closed control frame', () => {
    const hub = makeTunnelHub({ now: () => 0 })
    const daemon = fakeWs()
    const phone = fakeWs()
    hub.registerDaemon('cc-1', daemon.ws)
    const attach = hub.attachPhone('cc-1', phone.ws)
    hub.dropPhone(attach.streamId!)
    const last = JSON.parse(daemon.sent.at(-1)!)
    expect(last).toEqual({ stream: attach.streamId, closed: true })
  })

  it('oversized frame is rejected before forwarding', () => {
    const hub = makeTunnelHub({ maxFrameBytes: 20, now: () => 0 })
    const daemon = fakeWs()
    const phone = fakeWs()
    hub.registerDaemon('cc-1', daemon.ws)
    const attach = hub.attachPhone('cc-1', phone.ws)
    hub.onPhoneFrame(attach.streamId!, JSON.stringify({ ct: 'x'.repeat(100) }))
    expect(daemon.sent).toHaveLength(0)
  })
})
