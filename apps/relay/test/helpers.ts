import { SELF } from 'cloudflare:test'
import { relayIdFromPub, relayKeyPair, signRelayLogin, RELAY_SUBPROTOCOL } from '@wechat-cc/protocol'

export interface Ident { seed: Uint8Array; id: string }
export function newIdentity(): Ident {
  const { seed, pub } = relayKeyPair()
  return { seed, id: relayIdFromPub(pub) }
}

export interface Sock { ws: WebSocket; msgs: unknown[]; closed: Promise<number>; next(): Promise<any> }

function wrap(ws: WebSocket): Sock {
  const msgs: unknown[] = []
  const waiters: Array<(m: unknown) => void> = []
  ws.addEventListener('message', ev => {
    const m = JSON.parse(String(ev.data))
    const w = waiters.shift()
    if (w) w(m); else msgs.push(m)
  })
  const closed = new Promise<number>(res => ws.addEventListener('close', ev => res(ev.code)))
  return {
    ws, msgs, closed,
    next: () => msgs.length ? Promise.resolve(msgs.shift()) : new Promise(res => waiters.push(res)),
  }
}

export async function openDaemonSocket(id: string, protocols = `${RELAY_SUBPROTOCOL}, id.${id}`): Promise<Sock> {
  const r = await SELF.fetch('https://relay.test/v2/daemon', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocols } })
  if (r.status !== 101 || !r.webSocket) throw new Error(`daemon upgrade failed: ${r.status}`)
  r.webSocket.accept()
  return wrap(r.webSocket)
}

/** 连上并完成挑战登录,返回已认证的 socket。 */
export async function connectDaemon(ident: Ident = newIdentity()): Promise<Sock & { ident: Ident }> {
  const s = await openDaemonSocket(ident.id)
  const ch = await s.next()
  s.ws.send(JSON.stringify(signRelayLogin(ident.seed, ch.challenge, ident.id)))
  const ok = await s.next()
  if (!ok.login_ok) throw new Error('login failed: ' + JSON.stringify(ok))
  return Object.assign(s, { ident })
}

export async function connectPhone(id: string): Promise<Sock> {
  const r = await SELF.fetch(`https://relay.test/v2/phone?id=${id}`, { headers: { Upgrade: 'websocket' } })
  if (r.status !== 101 || !r.webSocket) throw new Error(`phone upgrade failed: ${r.status}`)
  r.webSocket.accept()
  return wrap(r.webSocket)
}
