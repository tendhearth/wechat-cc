/**
 * memory-relay.fixture.ts — 测试用的进程内中继(只给 *.test.ts 用)。
 *
 * 照官方中继 v2 房间(apps/relay/src/room.ts)的转发语义:手机帧包成 `{stream, frame}` 给 daemon;daemon 的
 * `{stream, frame}` 原样转给那条手机流;daemon 的 `{stream, close:true}` 关掉那条手机流、不回头通知;手机断开
 * ⇒ 给 daemon 发 `{stream, closed:true}`;`{ping}` ⇒ `{pong}`;单帧超过 512 KiB 丢。不做登录挑战(测试里的
 * 隧道客户端不需要 login_ok 也能转流帧)、不做限额 —— 房间那些在 apps/relay 自己的测试里。
 *
 * 2026-10-25 之前 e2e 借用老 VPS 中继的 `relay/tunnel.ts`;它随 v1 退休,这里补一份只为测试的。
 */
export interface MemoryRelaySocket {
  send(data: string): void
  close(): void
  readyState: number
}

export interface MemoryRelay {
  registerDaemon(id: string, ws: MemoryRelaySocket): void
  dropDaemon(id: string): void
  attachPhone(daemonId: string, ws: MemoryRelaySocket): { ok: boolean; streamId?: string; error?: string }
  dropPhone(streamId: string): void
  onPhoneFrame(streamId: string, raw: string): void
  onDaemonFrame(daemonId: string, raw: string): void
}

const MAX_FRAME = 512 * 1024
let streamCounter = 0

export function makeMemoryRelay(): MemoryRelay {
  const daemons = new Map<string, MemoryRelaySocket>()
  const phones = new Map<string, { ws: MemoryRelaySocket; daemonId: string }>()
  const tooBig = (raw: string) => Buffer.byteLength(raw, 'utf8') > MAX_FRAME

  function sendDaemon(id: string, obj: unknown): void {
    const d = daemons.get(id)
    if (d && d.readyState === 1) { try { d.send(JSON.stringify(obj)) } catch { /* best effort */ } }
  }

  return {
    registerDaemon(id, ws) {
      // 重连的 daemon 换掉旧 socket;手机的流原样挂到新 socket 上(daemon 那头会对认不出的流回 stream_unknown)。
      daemons.set(id, ws)
    },
    dropDaemon(id) {
      daemons.delete(id)
      for (const [sid, p] of phones) {
        if (p.daemonId !== id) continue
        phones.delete(sid)
        try { p.ws.close() } catch { /* best effort */ }
      }
    },
    attachPhone(daemonId, ws) {
      if (!daemons.has(daemonId)) return { ok: false, error: 'daemon_offline' }
      const streamId = `s${(streamCounter++).toString(36)}`
      phones.set(streamId, { ws, daemonId })
      return { ok: true, streamId }
    },
    dropPhone(streamId) {
      const p = phones.get(streamId)
      if (!p) return
      phones.delete(streamId)
      sendDaemon(p.daemonId, { stream: streamId, closed: true })
    },
    onPhoneFrame(streamId, raw) {
      const p = phones.get(streamId)
      if (!p || tooBig(raw)) return
      let frame: unknown
      try { frame = JSON.parse(raw) } catch { return }
      sendDaemon(p.daemonId, { stream: streamId, frame })
    },
    onDaemonFrame(daemonId, raw) {
      if (tooBig(raw)) return
      let msg: { stream?: unknown; frame?: unknown; ping?: unknown; close?: unknown }
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.ping !== undefined) { sendDaemon(daemonId, { pong: msg.ping }); return }
      if (typeof msg.stream !== 'string') return
      const p = phones.get(msg.stream)
      if (!p || p.daemonId !== daemonId || p.ws.readyState !== 1) return
      if (msg.close === true) {
        phones.delete(msg.stream)
        try { p.ws.close() } catch { /* best effort */ }
        return
      }
      p.ws.send(JSON.stringify(msg.frame ?? {}))
    },
  }
}
