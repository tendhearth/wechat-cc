/**
 * 官方中继 v2 入口(spec 2026-09-30 §3)。只分流:daemon / 手机的 WebSocket 交给按 daemon id
 * 命名的房间(Durable Object),壳页与健康检查就地回。**不解密任何东西,不记 id。**
 *
 * daemon 的 id 不进 URL(spec §7):放在 WebSocket 子协议里(`wcc.relay.v2, id.<rid>`),
 * 所有 WebSocket 实现都能带子协议,且不会出现在任何 URL 日志里。
 */
import { RELAY_ID_RE, RELAY_SUBPROTOCOL } from '@wechat-cc/protocol'
import PSET_HTML from '../../../relay/pset.html'
import { count } from './metrics'

export { Room } from './room'

function toRoom(req: Request, env: Env, id: string, role: 'daemon' | 'phone'): Promise<Response> {
  const h = new Headers(req.headers)
  h.set('x-relay-role', role)
  h.set('x-relay-id', id)
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  return stub.fetch(new Request('https://room/' + role, { headers: h }))
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true, version: env.RELAY_VERSION ?? 'dev', env: env.RELAY_ENV ?? 'local',
        apns: !!(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC),
        fcm: !!env.FCM_SERVICE_ACCOUNT,
      })
    }
    if (url.pathname === '/pset/' || url.pathname === '/pset') {
      return new Response(PSET_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    }
    const isUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
    if (url.pathname === '/v2/daemon') {
      if (!isUpgrade) return new Response('expected websocket', { status: 426 })
      const protos = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map(s => s.trim())
      const id = protos.find(p => p.startsWith('id.'))?.slice(3) ?? ''
      if (!protos.includes(RELAY_SUBPROTOCOL) || !RELAY_ID_RE.test(id)) return new Response('bad subprotocol', { status: 400 })
      count(env, 'daemon_connect')
      return toRoom(req, env, id, 'daemon')
    }
    if (url.pathname === '/v2/phone') {
      if (!isUpgrade) return new Response('expected websocket', { status: 426 })
      const id = url.searchParams.get('id') ?? ''
      if (!RELAY_ID_RE.test(id)) return new Response('bad id', { status: 400 })
      count(env, 'phone_connect')
      return toRoom(req, env, id, 'phone')
    }
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
