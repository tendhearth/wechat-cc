/**
 * 端到端(spec §9.2):本地 workerd 跑真中继,daemon 侧用真模块(身份 / 隧道客户端 / 推送),
 * 手机侧用真协议客户端。APNs 用本地假服务器(本地 workerd 连不了 Apple,workerd#4841)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync } from 'node:crypto'
import { unstable_startWorker } from 'wrangler'
import { makeProtocolClient, type ProtocolSocket } from '@wechat-cc/protocol'
import { loadOrCreateRelayIdentity } from '../../../../src/daemon/relay-identity'
import { makeTunnelClient } from '../../../../src/daemon/tunnel-client'
import { makePhonePush } from '../../../../src/daemon/phone-push'

const DEVICE_TOKEN = 'd' + 'e'.repeat(47)
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined
let apns: Server | undefined
const apnsHits: Array<{ path: string; body: any; headers: Record<string, unknown> }> = []
let base: string
let stateDir: string | undefined

function adapt(ws: WebSocket): ProtocolSocket {
  return {
    send: s => ws.send(s), close: () => ws.close(),
    onOpen: cb => { ws.onopen = () => cb() }, onMessage: cb => { ws.onmessage = ev => cb(String(ev.data)) }, onClose: cb => { ws.onclose = () => cb() },
  }
}
const until = async (pred: () => boolean, ms = 10_000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)) } }

beforeAll(async () => {
  apns = createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c }); req.on('end', () => { apnsHits.push({ path: req.url!, body: JSON.parse(b), headers: req.headers }); res.writeHead(200).end() })
  })
  await new Promise<void>(r => apns!.listen(0, '127.0.0.1', r))
  const port = (apns.address() as { port: number }).port
  const p8 = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL('../../wrangler.toml', import.meta.url)),
    bindings: {
      APNS_KEY_P8: { type: 'plain_text', value: p8 }, APNS_KEY_ID: { type: 'plain_text', value: 'KID' },
      APNS_TEAM_ID: { type: 'plain_text', value: '9Y6JAPDP7A' }, APNS_TOPIC: { type: 'plain_text', value: 'com.test.cc' },
      APNS_HOST: { type: 'plain_text', value: `http://127.0.0.1:${port}` },
    },
    // persist:false ⇒ DO 存储不落到 apps/relay/.wrangler(不进仓库、每次干净)。
    dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, persist: false, watch: false },
  })
  base = (await worker.url).toString().replace(/^http/, 'ws').replace(/\/$/, '')
  stateDir = mkdtempSync(join(tmpdir(), 'relay-e2e-'))
})
afterAll(async () => {
  await worker?.dispose()
  apns?.close()
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

describe('中继 v2 端到端', () => {
  it('登录 → 手机请求往返 → 推送到达假 APNs → 同 id 重连不踢新连接', async () => {
    const ident = loadOrCreateRelayIdentity(stateDir!)
    const logins: number[] = []
    let push: ReturnType<typeof makePhonePush>
    const mk = (logs: string[]) => makeTunnelClient({
      daemonId: ident.id, relayUrl: `${base}/v2/daemon`, login: ident,
      knownDeviceTokens: () => [DEVICE_TOKEN],
      handleRequest: async (req) => Response.json({ path: new URL(req.url).pathname }),
      onLogin: () => { logins.push(Date.now()); push.resync() },
      onControl: (m) => push.onControl(m),
      log: (_tag, line) => { logs.push(line) },
    })
    const d1Logs: string[] = [], d2Logs: string[] = []
    const d1 = mk(d1Logs)
    push = makePhonePush({ stateDir: stateDir!, send: m => d1.sendControl(m), deviceToken: () => DEVICE_TOKEN, deviceIds: () => ['dev1'], log: () => {} })
    d1.start()
    await until(() => logins.length === 1)

    const phone = makeProtocolClient({ open: () => adapt(new WebSocket(`${base}/v2/phone?id=${ident.id}`)), token: DEVICE_TOKEN })
    const r = await phone.request({ method: 'GET', path: '/m/api/home' })
    expect(r.json()).toEqual({ path: '/m/api/home' })
    expect(phone.version()).toBe(2)

    expect(push.register('dev1', 'apns', 'ab'.repeat(32))).toBe(true)
    expect(await push.test('dev1')).toEqual({ ok: true, code: 'ok' })
    expect(apnsHits.at(-1)!.path).toBe(`/3/device/${'ab'.repeat(32)}`)
    expect(apnsHits.at(-1)!.body.aps['mutable-content']).toBe(1)

    // 同 id 再起一个客户端(daemon 重连):新连接登录成功,老的被中继主动关掉(4000 replaced);手机再请求能到。
    // 只看「第二次请求能到」证明不了替换:房间本来就把流量发给 authedAt 最新的那条(反向核对里去掉替换照样绿),
    // 所以要亲眼看到 d1 的 socket 被中继关掉 —— 在我们 stop 它之前。
    const d2 = mk(d2Logs)
    d2.start()
    await until(() => logins.length >= 2)
    await until(() => d1Logs.some(l => l.includes('relay socket closed')))
    expect(d1.sendControl({ ping: 1 })).toBe(false)   // 被替换的那条已经没有可用连接
    expect(d2Logs.some(l => l.includes('socket closed'))).toBe(false)   // 新连接没被踢
    d1.stop()   // 旧进程退场(它在退避里等重连;不停的话两份同身份的 daemon 会互相替换)
    const r2 = await phone.request({ method: 'GET', path: '/m/api/feed' })
    expect(r2.json()).toEqual({ path: '/m/api/feed' })
    phone.close(); d2.stop()
  })
})
