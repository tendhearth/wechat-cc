/**
 * /v1/cli/say(terminal_say,2026-10-24)的门(架构终态 A5 从 internal-api/routes-cli-say.test.ts 搬来;路由由 terminal 模块挂):走真的 internal-api(HTTP + 令牌登记 + 档位表),
 * 证明访客 / 非主人 / file 令牌一句话都送不进终端会话;只有主人那条聊天的 admin 会话令牌能。
 * terminalSay 是假的 —— 不碰任何真的终端窗口。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInternalApi, type InternalApi } from '../../daemon/internal-api/index'
import { minTierFor } from '../../daemon/internal-api/route-tiers'
import { REQUEST_SCHEMAS } from '../../daemon/internal-api/schema'
import { WORKBENCH_ERRORS } from '@wechat-cc/protocol'
import { terminalRoutes, type TerminalRoutesDeps } from './routes'

const OWNER = 'owner@im.wechat'
let stateDir: string
let api: InternalApi | null
let said: Array<[string, string]>
let claimed: string[]

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'cli-say-')); api = null; said = []; claimed = [] })
afterEach(async () => { if (api) await api.stop({ unlinkToken: true }).catch(() => {}); rmSync(stateDir, { recursive: true, force: true }) })

const mountSay = (a: InternalApi, terminalSay: TerminalRoutesDeps['terminalSay']) =>
  a.mount('terminal', terminalRoutes({ terminalSay } as unknown as TerminalRoutesDeps))

async function boot(o: { mount?: boolean } = {}) {
  api = createInternalApi({ stateDir, daemonPid: 1 })
  const { port, tokenFilePath } = await api.start()
  if (o.mount !== false) mountSay(api, {
    say: (code, text) => { said.push([code, text]); return { ok: true, ticket: 'a1b2c3d4e5f6', via: 'window', code, source: 'claude', project: 'cc', was_running: false, read_only: false, max_wait_ms: 570_000 } },
    wait: async (ticket) => ticket === 'a1b2c3d4e5f6'
      ? { ticket, code: 'abc123', source: 'claude', project: 'cc', via: 'window', state: 'replied', final: true, delivered: true, reply: '好', reply_truncated: false, error: null, elapsed_ms: 5, was_running: false, reply_verified: true, read_only: false, owner_notified: false, owner_has_reply: false, max_wait_ms: 570_000 }
      : null,
    claim: (t) => { claimed.push(t) },
    isOwnerChat: (chatId) => chatId === OWNER,
  })
  const post = (token: string) => fetch(`http://127.0.0.1:${port}/v1/cli/say`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'abc123', text: '先停下' }),
  })
  const get = (token: string, ticket = 'a1b2c3d4e5f6') => fetch(`http://127.0.0.1:${port}/v1/cli/say?ticket=${ticket}&wait_ms=0`, { headers: { Authorization: `Bearer ${token}` } })
  return { api, post, get, fileToken: readFileSync(tokenFilePath, 'utf8').trim() }
}

describe('/v1/cli/say 的门', () => {
  it('terminal 模块还没挂上 ⇒ module_starting(以前是 terminal_say_not_wired);挂上之后照常过门', async () => {
    const h = await boot({ mount: false })
    const owner = h.api.mintSessionToken('admin', `claude/a/${OWNER}`)
    const before = await h.post(owner)
    expect(before.status).toBe(503)
    expect(await before.json()).toEqual({ error: 'module_starting', module: 'terminal' })
    mountSay(h.api, { say: (code, text) => { said.push([code, text]); return { ok: false, error: 'terminal_say_unknown_session', detail: '' } }, wait: async () => null, claim: () => {}, isOwnerChat: (c) => c === OWNER })
    expect((await h.post(owner)).status).toBe(404)
    expect(said).toEqual([['abc123', '先停下']])
  })

  it('访客会话令牌 ⇒ 403(档位),什么都没送', async () => {
    const h = await boot()
    const guest = h.api.mintSessionToken('guest', 'claude/a/stranger@im.wechat')
    expect((await h.post(guest)).status).toBe(403)
    expect((await h.get(guest)).status).toBe(403)
    // 访客冒用主人的 chatId 也一样:档位先挡
    const spoof = h.api.mintSessionToken('guest', `claude/a/${OWNER}`)
    expect((await h.post(spoof)).status).toBe(403)
    expect(said).toEqual([])
  })

  it('trusted 会话 / daemon file 令牌 ⇒ 403;admin 档但不是主人那条聊天 ⇒ 403 terminal_say_not_owner', async () => {
    const h = await boot()
    expect((await h.post(h.api.mintSessionToken('trusted', 'claude/a/friend@im.wechat'))).status).toBe(403)
    expect((await h.post(h.fileToken)).status).toBe(403)
    const otherAdmin = await h.post(h.api.mintSessionToken('admin', 'claude/a/coadmin@im.wechat'))
    expect(otherAdmin.status).toBe(403)
    expect(await otherAdmin.json()).toMatchObject({ error: 'terminal_say_not_owner' })
    expect(said).toEqual([])
  })

  it('主人那条聊天的 admin 会话 ⇒ 送出、拿票、能轮询', async () => {
    const h = await boot()
    const owner = h.api.mintSessionToken('admin', `claude/a/${OWNER}`)
    const r = await h.post(owner)
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, ticket: 'a1b2c3d4e5f6', via: 'window' })
    expect(said).toEqual([['abc123', '先停下']])
    const g = await h.get(owner)
    expect(await g.json()).toMatchObject({ ok: true, state: 'replied', reply: '好' })
    // 终局的回包写出去了('finish')才算领走
    for (let i = 0; i < 50 && claimed.length === 0; i++) await new Promise(r => setTimeout(r, 10))
    expect(claimed).toEqual(['a1b2c3d4e5f6'])
    expect((await h.get(owner, 'ffffffffffff')).status).toBe(404)
  })

  it('长轮询的调用方断开 ⇒ 交给 wait 的 signal 中止(挂着的等待不能当成「还有人在等」)', async () => {
    const h = await boot({ mount: false })
    let seen: AbortSignal | undefined
    const aborted = new Promise<void>((resolve) => {
      mountSay(h.api, {
        say: () => { throw new Error('unused') },
        wait: (_t, _ms, signal) => new Promise((res) => {
          seen = signal
          signal?.addEventListener('abort', () => { resolve(); res(null) }, { once: true })
        }),
        claim: (t) => { claimed.push(t) },
        isOwnerChat: (c) => c === OWNER,
      })
    })
    const owner = h.api.mintSessionToken('admin', `claude/a/${OWNER}`)
    const ac = new AbortController()
    const port = h.api.port()
    const req = fetch(`http://127.0.0.1:${port}/v1/cli/say?ticket=a1b2c3d4e5f6&wait_ms=20000`, { headers: { Authorization: `Bearer ${owner}` }, signal: ac.signal }).catch(() => null)
    for (let i = 0; i < 100 && !seen; i++) await new Promise(r => setTimeout(r, 10))
    expect(seen).toBeDefined()
    expect(seen!.aborted).toBe(false)
    ac.abort()
    await Promise.race([aborted, new Promise((_, rej) => setTimeout(() => rej(new Error('signal never aborted')), 3_000))])
    expect(seen!.aborted).toBe(true)
    await req
    await new Promise(r => setTimeout(r, 50))
    expect(claimed).toEqual([])   // 断开的那次没写出去,不算领走
  })

  it('keep-alive:同一条连接上连着 20 个请求,socket 上的 close 监听不越挂越多', async () => {
    // 拿到服务端那一侧的 socket:Bun 与 node 的 node:http 都经 emit('request', req, res) 派发
    const http = await import('node:http')
    const serverSockets = new Set<{ listenerCount(e: string): number }>()
    const origEmit = http.Server.prototype.emit
    http.Server.prototype.emit = function (this: unknown, ev: string, ...args: unknown[]) {
      if (ev === 'request') { const sk = (args[0] as { socket?: { listenerCount(e: string): number } }).socket; if (sk) serverSockets.add(sk) }
      return (origEmit as (...a: unknown[]) => boolean).call(this, ev, ...args)
    } as typeof origEmit
    const serverSocketCloseListeners = () => Math.max(0, ...[...serverSockets].map(sk => sk.listenerCount('close')))
    try {
    const h = await boot()
    const owner = h.api.mintSessionToken('admin', `claude/a/${OWNER}`)
    const { request, Agent } = http
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const counts: number[] = []
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port: h.api.port(), path: '/v1/cli/say?ticket=a1b2c3d4e5f6&wait_ms=0', agent, headers: { Authorization: `Bearer ${owner}` } }, (res) => {
          res.resume()
          res.on('end', () => resolve())
        })
        r.on('error', reject)
        r.end()
      })
      await new Promise(r => setTimeout(r, 5))
      counts.push(serverSocketCloseListeners())
    }
    agent.destroy()
    expect(serverSockets.size).toBeGreaterThan(0)
    // 回完就摘:第 20 个请求之后和第 1 个之后一样多(漏摘的话 Bun 下每个请求 +1,10-24 实测)
    expect(Math.max(...counts)).toBeLessThanOrEqual(counts[0]!)
    } finally { http.Server.prototype.emit = origEmit }
  })

  it('档位表 admin、不给 operator;schema;错误码都在一张表里', () => {
    expect(minTierFor('POST /v1/cli/say')).toBe('admin')
    expect(minTierFor('GET /v1/cli/say')).toBe('admin')
    const s = REQUEST_SCHEMAS['POST /v1/cli/say']!
    expect(s.safeParse({ code: 'abc123', text: 'x' }).success).toBe(true)
    expect(s.safeParse({ code: 'abc123', text: '' }).success).toBe(false)
    expect(s.safeParse({ code: 'abc123', text: 'x'.repeat(4001) }).success).toBe(false)
    expect(s.safeParse({ code: 'not-hex!', text: 'x' }).success).toBe(false)
    for (const c of ['terminal_say_not_owner', 'terminal_say_not_wired', 'terminal_say_unknown_session', 'terminal_say_ticket_unknown',
      'terminal_say_remote', 'terminal_say_ended', 'terminal_say_turn_open', 'terminal_say_pending']) expect(WORKBENCH_ERRORS[c], c).toBeDefined()
  })
})
