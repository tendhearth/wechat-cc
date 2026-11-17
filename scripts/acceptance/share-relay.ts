/** Local relay boundary only: real daemon login, opaque v2 phone frames. */
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyRelayLogin } from '@wechat-cc/protocol'
import type { ServerWebSocket } from 'bun'

type Peer = { role: 'daemon' | 'phone'; stream: string; challenge: string; authenticated: boolean }
export function startShareRelay(dir: string) {
  let daemon: ServerWebSocket<Peer> | undefined
  const phones = new Map<string, ServerWebSocket<Peer>>()
  let authenticated = false, forwarded = 0
  const evidence = (event: string) => appendFileSync(join(dir, 'share-relay.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, forwarded }) + '\n')
  const server = Bun.serve<Peer>({
    hostname: '127.0.0.1', port: 0,
    fetch(req, server) {
      const u = new URL(req.url)
      if (u.pathname === '/status') return Response.json({ authenticated, forwarded })
      const role = u.pathname === '/v2/daemon' ? 'daemon' : u.pathname === '/v2/phone' ? 'phone' : null
      if (!role) return new Response('local relay', { status: 404 })
      if (role === 'phone' && !authenticated) return new Response('daemon unavailable', { status: 503 })
      if (server.upgrade(req, { data: { role, stream: randomUUID(), challenge: randomUUID(), authenticated: false } })) return
      return new Response('upgrade required', { status: 400 })
    },
    websocket: {
      open(ws) {
        if (ws.data.role === 'daemon') {
          daemon?.close(); daemon = ws; authenticated = false
          ws.send(JSON.stringify({ challenge: ws.data.challenge, ts: Date.now() }))
        } else phones.set(ws.data.stream, ws)
      },
      message(ws, raw) {
        try {
          const m = JSON.parse(String(raw))
          if (ws.data.role === 'phone') { daemon?.send(JSON.stringify({ stream: ws.data.stream, frame: m })); forwarded++; return }
          if (!ws.data.authenticated) {
            // The identity is created by this isolated daemon; no production identity is read.
            const identity = JSON.parse(readFileSync(join(dir, 'share-relay-identity.json'), 'utf8'))
            if (!verifyRelayLogin(identity.id, ws.data.challenge, m.pub, m.sig)) { ws.close(); return }
            ws.data.authenticated = true; authenticated = true; ws.send('{"login_ok":true}'); evidence('login'); return
          }
          if (m.ping === 1) { ws.send('{"pong":1}'); return }
          if (typeof m.stream === 'string') {
            const phone = phones.get(m.stream)
            if (m.close) phone?.close()
            else if (m.frame) { phone?.send(JSON.stringify(m.frame)); forwarded++ }
          }
        } catch { ws.close() }
      },
      close(ws) {
        if (ws === daemon) { authenticated = false; daemon = undefined; for (const p of phones.values()) p.close() }
        else { phones.delete(ws.data.stream); daemon?.send(JSON.stringify({ stream: ws.data.stream, closed: true })) }
      },
    },
  })
  const base = `ws://127.0.0.1:${server.port}`
  writeFileSync(join(dir, 'share-relay.json'), JSON.stringify({ base }), { mode: 0o600 })
  return { base, stop() { evidence('stop'); server.stop(true) } }
}
