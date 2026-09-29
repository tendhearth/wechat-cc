/**
 * client.test.ts — 协议客户端对着进程内假后台跑。假后台只用协议包自己的
 * 加密(x25519 + v1 / v2 密封),行为照 src/daemon/tunnel-client.ts:收
 * `{hs}` 回 `{hs}`(v2 后台多带 `v:2`),凭设备令牌推的密钥认人,认不出就
 * 明文回 `{error:'auth_failed'}`。
 *
 * 一律假时钟,消息经 queueMicrotask 递送(模拟 WebSocket 的异步回调)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeProtocolClient } from './client'
import type { ProtocolSocket, ClientOpts } from './client'
import { b64uDecode, b64uEncode } from './b64u'
import { b64Encode, b64Decode } from './messages'
import { x25519KeyPair, x25519Shared } from './x25519'
import { deriveV1Key, sealV1, openV1 } from './v1'
import { deriveV2Keys, makeV2Channel } from './v2'
import type { V2Channel } from './v2'

const TOKEN = 'device-token-abc'
const enc = new TextEncoder()
const dec = new TextDecoder()

interface ReqSeen { t?: string; rid: string; method: string; path: string; headers?: Record<string, string>; body?: string; bodyEncoding?: string }

interface Conn {
  closed: boolean
  hellos: unknown[]
  version: 1 | 2 | null
  v1Key?: Uint8Array
  chan?: V2Channel
  subs: Map<string, { topic: string; since?: { epoch: string; seq: number } }>
  toClient(obj: unknown): void
  raw(s: string): void
  msgCb?: (s: string) => void
  closeCb?: () => void
  openCb?: () => void
  /** 真 WebSocket 那样:open 之前 send 会抛。 */
  opened: boolean
  fireOpen(): void
  /** 黑洞:收什么都不回,也不关(换网络后没收到 TCP 关闭的死连接)。 */
  blackhole: boolean
  serverClose(): void
}

function makeFakeDaemon(opts: { version: 1 | 2; token?: string; offline?: boolean; manualOpen?: boolean }) {
  const token = opts.token ?? TOKEN
  const conns: Conn[] = []
  const reqs: ReqSeen[] = []
  const subMsgs: Array<{ sid: string; topic: string; since?: { epoch: string; seq: number } }> = []
  const unsubs: string[] = []
  const d = {
    conns,
    reqs,
    subMsgs,
    unsubs,
    offline: opts.offline ?? false,
    dropNextReqs: 0,
    /** 接下来这么多条连接收到 hs 后一声不吭。 */
    silentHellos: 0,
    /** 接下来这么多条连接回一个畸形 hello。 */
    badHellos: 0,
    /** 每个请求回两遍(第二遍 status 500)。 */
    dupReplies: false,
    onSub: undefined as undefined | ((conn: Conn, sid: string, topic: string, since?: { epoch: string; seq: number }) => void),
    handler: (r: ReqSeen): { status: number; headers: Record<string, string>; body: string; bodyEncoding: 'utf8' | 'base64' } => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: r.path, method: r.method }),
      bodyEncoding: 'utf8',
    }),
    open(): ProtocolSocket {
      const conn: Conn = {
        closed: false,
        hellos: [],
        version: null,
        subs: new Map(),
        opened: false,
        blackhole: false,
        fireOpen() { if (conn.opened || conn.closed) return; conn.opened = true; conn.openCb?.() },
        toClient(obj) { conn.raw(JSON.stringify(obj)) },
        raw(s) { queueMicrotask(() => { if (!conn.closed) conn.msgCb?.(s) }) },
        serverClose() {
          if (conn.closed) return
          conn.closed = true
          queueMicrotask(() => conn.closeCb?.())
        },
      }
      conns.push(conn)
      if (d.offline) conn.serverClose()
      else if (!opts.manualOpen) queueMicrotask(() => conn.fireOpen())
      return {
        send(s: string) {
          if (!conn.opened) throw new Error('InvalidStateError: still CONNECTING')
          queueMicrotask(() => { if (!conn.closed && !conn.blackhole) handle(conn, s) })
        },
        onOpen(cb) { conn.openCb = cb },
        close() { conn.serverClose() },
        onMessage(cb) { conn.msgCb = cb },
        onClose(cb) { conn.closeCb = cb },
      }
    },
    /** 给订阅了 topic 的所有活连接推一条 ev。 */
    emit(topic: string, epoch: string, seq: number, data: unknown) {
      for (const c of conns) {
        if (c.closed || !c.chan) continue
        for (const [sid, s] of c.subs) if (s.topic === topic) sendV2(c, { t: 'ev', sid, epoch, seq, data })
      }
    },
    live(): Conn { const c = conns.filter(x => !x.closed).at(-1); if (!c) throw new Error('no live conn'); return c },
  }

  function sendV2(conn: Conn, msg: unknown) {
    conn.toClient(conn.chan!.seal(enc.encode(JSON.stringify(msg))))
  }

  function handle(conn: Conn, s: string) {
    const f = JSON.parse(s) as Record<string, unknown>
    if (typeof f.hs === 'string') {
      conn.hellos.push(f)
      if (d.silentHellos > 0) { d.silentHellos--; return }
      if (d.badHellos > 0) { d.badHellos--; conn.toClient({ hs: 42, v: 2 }); return }
      const kp = x25519KeyPair()
      const shared = x25519Shared(kp.priv, b64uDecode(f.hs))
      if (opts.version === 2 && Array.isArray(f.v) && f.v.includes(2)) {
        conn.version = 2
        conn.chan = makeV2Channel(deriveV2Keys(shared, token), 'server')
        conn.toClient({ hs: b64uEncode(kp.pub), v: 2 })
      } else {
        conn.version = 1
        conn.v1Key = deriveV1Key(shared, token)
        conn.toClient({ hs: b64uEncode(kp.pub) })
      }
      return
    }
    if (conn.version === 1) {
      let pt: Uint8Array
      try { pt = openV1(conn.v1Key!, f as { iv: string; ct: string }) } catch { conn.toClient({ error: 'auth_failed' }); return }
      const r = JSON.parse(dec.decode(pt)) as ReqSeen
      reqs.push(r)
      if (d.dropNextReqs > 0) { d.dropNextReqs--; return }
      const reply = { rid: r.rid, status: 200, body: JSON.stringify({ path: r.path, method: r.method, body: r.body }) }
      conn.toClient(sealV1(conn.v1Key!, enc.encode(JSON.stringify(reply))))
      return
    }
    let pt: Uint8Array
    try { pt = conn.chan!.open(f as { c: string; ct: string }) } catch { conn.toClient({ error: 'auth_failed' }); return }
    const m = JSON.parse(dec.decode(pt)) as Record<string, unknown>
    if (m.t === 'req') {
      const r = m as unknown as ReqSeen
      reqs.push(r)
      if (d.dropNextReqs > 0) { d.dropNextReqs--; return }
      sendV2(conn, { t: 'res', rid: r.rid, ...d.handler(r) })
      if (d.dupReplies) sendV2(conn, { t: 'res', rid: r.rid, ...d.handler(r), status: 500 })
    } else if (m.t === 'sub') {
      const sm = m as { sid: string; topic: string; since?: { epoch: string; seq: number } }
      subMsgs.push({ sid: sm.sid, topic: sm.topic, since: sm.since })
      conn.subs.set(sm.sid, { topic: sm.topic, since: sm.since })
      d.onSub?.(conn, sm.sid, sm.topic, sm.since)
    } else if (m.t === 'unsub') {
      unsubs.push(m.sid as string)
      conn.subs.delete(m.sid as string)
    }
  }

  return { d, sendV2 }
}

type FakeDaemon = ReturnType<typeof makeFakeDaemon>

function client(daemon: FakeDaemon, extra: Partial<ClientOpts> = {}) {
  const open = vi.fn(() => daemon.d.open())
  const c = makeProtocolClient({ open, token: TOKEN, requestTimeoutMs: 1000, ...extra })
  return { c, open }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('握手协商', () => {
  it('v2 后台 ⇒ version()===2,握手带 v:[1,2],请求走 v2 帧', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const { c } = client(daemon)
    expect(c.version()).toBeNull()
    const res = await c.request({ method: 'GET', path: '/v1/health' })
    expect(c.version()).toBe(2)
    expect(daemon.d.conns[0]!.hellos[0]).toMatchObject({ v: [1, 2] })
    expect(daemon.d.reqs[0]).toMatchObject({ t: 'req', method: 'GET', path: '/v1/health' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/json')
    expect(res.json<{ path: string }>().path).toBe('/v1/health')
    c.close()
  })

  it('老后台只回 {hs} ⇒ version()===1,请求走 v1 帧,subscribe 抛 subscriptions_need_v2', async () => {
    const daemon = makeFakeDaemon({ version: 1 })
    const { c } = client(daemon)
    const res = await c.request({ method: 'POST', path: '/v1/x', body: '{"a":1}' })
    expect(c.version()).toBe(1)
    expect(daemon.d.reqs[0]).toEqual({ path: '/v1/x', method: 'POST', body: '{"a":1}', rid: expect.any(String) })
    expect(res.status).toBe(200)
    expect(res.headers).toEqual({})
    expect(res.json<{ body: string }>().body).toBe('{"a":1}')
    expect(() => c.subscribe('now', () => {})).toThrow('subscriptions_need_v2')
    c.close()
  })

  it('v1 下二进制请求体 ⇒ 拒绝 binary_body_needs_v2', async () => {
    const daemon = makeFakeDaemon({ version: 1 })
    const { c } = client(daemon)
    await c.request({ method: 'GET', path: '/a' })
    await expect(c.request({ method: 'POST', path: '/b', body: new Uint8Array([1]) })).rejects.toThrow('binary_body_needs_v2')
    c.close()
  })

  it('握手前就订阅、结果是老后台 ⇒ onSubscriptionError 报 subscriptions_need_v2', async () => {
    const daemon = makeFakeDaemon({ version: 1 })
    const onSubscriptionError = vi.fn()
    const { c } = client(daemon, { onSubscriptionError })
    c.subscribe('now', () => {})
    await flush()
    expect(c.version()).toBe(1)
    expect(onSubscriptionError).toHaveBeenCalledWith('now', 'subscriptions_need_v2')
    c.close()
  })
})

describe('请求 / 响应', () => {
  it('base64 二进制请求体与响应体、请求头都原样过去', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.handler = r => ({ status: 201, headers: { 'x-echo': r.headers?.['x-a'] ?? '' }, body: r.body ?? '', bodyEncoding: 'base64' })
    const { c } = client(daemon)
    const bytes = new Uint8Array([0, 255, 1, 2, 250, 62, 63])
    const res = await c.request({ method: 'PUT', path: '/bin', headers: { 'x-a': '1' }, body: bytes })
    expect(daemon.d.reqs[0]).toMatchObject({ bodyEncoding: 'base64', body: b64Encode(bytes), headers: { 'x-a': '1' } })
    expect(res.status).toBe(201)
    expect(res.headers).toEqual({ 'x-echo': '1' })
    expect(Array.from(res.body)).toEqual(Array.from(bytes))
    c.close()
  })

  it('字符串请求体 ⇒ utf8', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const { c } = client(daemon)
    await c.request({ method: 'POST', path: '/t', body: '你好' })
    expect(daemon.d.reqs[0]).toMatchObject({ body: '你好', bodyEncoding: 'utf8' })
    c.close()
  })

  it('标准 base64 往返,且拒收 base64url 字符', () => {
    const b = new Uint8Array([251, 255, 191])
    expect(b64Encode(b)).toBe('+/+/')
    expect(Array.from(b64Decode('+/+/'))).toEqual([251, 255, 191])
    expect(b64Encode(new Uint8Array([1]))).toBe('AQ==')
    expect(() => b64Decode('-_-_')).toThrow()
  })

  it('GET 被吞 ⇒ 超时后以同一 rid 重发(连接上什么都没收到 ⇒ 先换新连接)并成功', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.dropNextReqs = 1
    const { c } = client(daemon)
    const p = c.request({ method: 'GET', path: '/slow' })
    await flush()
    expect(daemon.d.reqs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000 + 500)
    const res = await p
    expect(res.status).toBe(200)
    expect(daemon.d.reqs).toHaveLength(2)
    expect(daemon.d.reqs[1]!.rid).toBe(daemon.d.reqs[0]!.rid)
    c.close()
  })

  it('POST 缺省不重试 ⇒ 第一次超时就以 timeout 拒绝', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.dropNextReqs = 1
    const { c } = client(daemon)
    const p = c.request({ method: 'POST', path: '/do', body: 'x' })
    const assertion = expect(p).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    await vi.advanceTimersByTimeAsync(5000)
    expect(daemon.d.reqs).toHaveLength(1)
    c.close()
  })

  it('POST 显式 retry:true ⇒ 以同一 rid 重发(后台可去重)', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.dropNextReqs = 1
    const { c } = client(daemon)
    const p = c.request({ method: 'POST', path: '/do', body: 'x', retry: true })
    await vi.advanceTimersByTimeAsync(1000 + 500)
    expect((await p).status).toBe(200)
    expect(daemon.d.reqs).toHaveLength(2)
    expect(daemon.d.reqs[1]!.rid).toBe(daemon.d.reqs[0]!.rid)
    c.close()
  })

  it('GET 显式 retry:false ⇒ 不重试', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.dropNextReqs = 1
    const { c } = client(daemon)
    const p = c.request({ method: 'GET', path: '/x', retry: false })
    const assertion = expect(p).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    c.close()
  })

  it('同一 rid 的回复到两遍 ⇒ 只按第一遍 resolve,第二遍静默忽略', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.dupReplies = true
    const onProtocolError = vi.fn()
    const { c } = client(daemon, { onProtocolError })
    const res = await c.request({ method: 'GET', path: '/x' })
    await flush()
    expect(res.status).toBe(200)
    expect(onProtocolError).not.toHaveBeenCalled()
    const res2 = await c.request({ method: 'GET', path: '/y' })
    expect(res2.status).toBe(200)
    c.close()
  })

  it('重试用完 ⇒ 以 timeout 拒绝', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.dropNextReqs = 5
    const { c } = client(daemon, { retries: 1 })
    const p = c.request({ method: 'GET', path: '/slow' })
    const assertion = expect(p).rejects.toThrow('timeout')
    // 0 发出、1000 超时丢连接、1500 重连后重发、2500 再超时
    await vi.advanceTimersByTimeAsync(2500)
    await assertion
    expect(daemon.d.reqs).toHaveLength(2)
    c.close()
  })

  it('后台回 err{rid} ⇒ 请求以该 code 拒绝', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.dropNextReqs = 1
    const { c } = client(daemon)
    const p = c.request({ method: 'GET', path: '/x' })
    const assertion = expect(p).rejects.toThrow('not_found')
    await flush()
    daemon.sendV2(daemon.d.live(), { t: 'err', rid: daemon.d.reqs[0]!.rid, code: 'not_found' })
    await flush()
    await assertion
    c.close()
  })
})

describe('订阅', () => {
  it('收 ev;同 epoch 下 seq 不更新的丢掉;新 epoch 接受', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const { c } = client(daemon)
    const got: Array<[unknown, string, number]> = []
    c.subscribe('now', (data, m) => got.push([data, m.epoch, m.seq]))
    await flush()
    expect(daemon.d.subMsgs[0]).toMatchObject({ topic: 'now' })
    expect(daemon.d.subMsgs[0]!.since).toBeUndefined()
    daemon.d.emit('now', 'e1', 1, 'a')
    daemon.d.emit('now', 'e1', 1, 'dup')
    daemon.d.emit('now', 'e1', 3, 'b')
    daemon.d.emit('now', 'e1', 2, 'old')
    daemon.d.emit('now', 'e2', 0, 'restart')
    await flush()
    expect(got).toEqual([['a', 'e1', 1], ['b', 'e1', 3], ['restart', 'e2', 0]])
    c.close()
  })

  it('断线重连:新握手(新公钥)后带最后的 {epoch, seq} 重新 sub,旧的不重放', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.onSub = (conn, sid, _topic, since) => {
      // 后台只回当前状态:有 since 的话先补一条重复的(客户端必须去重)再给新的
      if (since) {
        daemon.sendV2(conn, { t: 'ev', sid, epoch: 'e1', seq: since.seq, data: 'dup' })
        daemon.sendV2(conn, { t: 'ev', sid, epoch: 'e1', seq: since.seq + 1, data: 'current' })
      }
    }
    const { c, open } = client(daemon)
    const got: unknown[] = []
    c.subscribe('now', d => got.push(d))
    await flush()
    daemon.d.emit('now', 'e1', 1, 'x')
    daemon.d.emit('now', 'e1', 2, 'y')
    await flush()
    const firstHello = daemon.d.conns[0]!.hellos[0] as { hs: string }
    daemon.d.conns[0]!.serverClose()
    await flush()
    expect(open).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(open).toHaveBeenCalledTimes(2)
    const secondHello = daemon.d.conns[1]!.hellos[0] as { hs: string }
    expect(secondHello.hs).not.toBe(firstHello.hs)
    expect(daemon.d.subMsgs[1]).toMatchObject({ topic: 'now', since: { epoch: 'e1', seq: 2 } })
    expect(got).toEqual(['x', 'y', 'current'])
    c.close()
  })

  it('取消订阅 ⇒ 发一次 unsub,之后的 ev 不再回调', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const { c } = client(daemon)
    const cb = vi.fn()
    const off = c.subscribe('now', cb)
    await flush()
    const sid = daemon.d.subMsgs[0]!.sid
    off()
    off() // 幂等
    await flush()
    expect(daemon.d.unsubs).toEqual([sid])
    daemon.sendV2(daemon.d.live(), { t: 'ev', sid, epoch: 'e', seq: 1, data: 1 })
    await flush()
    expect(cb).not.toHaveBeenCalled()
    c.close()
  })

  it('后台回 err{sid} ⇒ onSubscriptionError,订阅作废', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const onSubscriptionError = vi.fn()
    const { c } = client(daemon, { onSubscriptionError })
    const cb = vi.fn()
    c.subscribe('nope', cb)
    await flush()
    const sid = daemon.d.subMsgs[0]!.sid
    daemon.sendV2(daemon.d.live(), { t: 'err', sid, code: 'unknown_topic' })
    await flush()
    daemon.sendV2(daemon.d.live(), { t: 'ev', sid, epoch: 'e', seq: 1, data: 1 })
    await flush()
    expect(onSubscriptionError).toHaveBeenCalledWith('nope', 'unknown_topic')
    expect(cb).not.toHaveBeenCalled()
    c.close()
  })
})

describe('断线、退避与致命错误', () => {
  it('auth_failed ⇒ 挂起请求以 auth_failed 拒绝,且不再重连', async () => {
    const daemon = makeFakeDaemon({ version: 2, token: 'some-other-token' })
    const { c, open } = client(daemon)
    const p = c.request({ method: 'GET', path: '/x' })
    const assertion = expect(p).rejects.toThrow('auth_failed')
    c.subscribe('now', () => {})
    await flush()
    await assertion
    await vi.advanceTimersByTimeAsync(120_000)
    expect(open).toHaveBeenCalledTimes(1)
    await expect(c.request({ method: 'GET', path: '/y' })).rejects.toThrow('auth_failed')
    c.close()
  })

  it('中继明文 daemon_offline ⇒ 挂起请求以它拒绝;有订阅就退避重连', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const { c, open } = client(daemon)
    c.subscribe('now', () => {})
    daemon.d.dropNextReqs = 1
    const p = c.request({ method: 'GET', path: '/x' })
    const assertion = expect(p).rejects.toThrow('daemon_offline')
    await flush()
    daemon.d.live().raw(JSON.stringify({ error: 'daemon_offline' }))
    await flush()
    await assertion
    expect(open).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(open).toHaveBeenCalledTimes(2)
    c.close()
  })

  it('指数退避封顶 15 s', async () => {
    const daemon = makeFakeDaemon({ version: 2, offline: true })
    const { c, open } = client(daemon)
    c.subscribe('now', () => {})
    await flush()
    const times: number[] = []
    let t = 0
    let last = open.mock.calls.length
    for (let i = 0; i < 400; i++) {
      await vi.advanceTimersByTimeAsync(250)
      t += 250
      if (open.mock.calls.length !== last) { times.push(t); last = open.mock.calls.length }
    }
    const gaps = times.map((x, i) => x - (i === 0 ? 0 : times[i - 1]!))
    expect(gaps.slice(0, 7)).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000])
    c.close()
  })

  it('连接稳定 ≥ 10 s(按注入的 now)才把退避清零;抖动的连接退避照涨', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    let fakeNow = 0
    const { c, open } = client(daemon, { now: () => fakeNow })
    c.subscribe('now', () => {})
    await flush()
    daemon.d.conns[0]!.serverClose()
    await vi.advanceTimersByTimeAsync(500)
    expect(open).toHaveBeenCalledTimes(2)
    daemon.d.conns[1]!.serverClose()
    await vi.advanceTimersByTimeAsync(999)
    expect(open).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(open).toHaveBeenCalledTimes(3)
    fakeNow += 10_000
    daemon.d.conns[2]!.serverClose()
    await vi.advanceTimersByTimeAsync(500)
    expect(open).toHaveBeenCalledTimes(4)
    c.close()
  })

  it('请求在途时断线 ⇒ 不立刻重发,超时后以同一 rid 在新连接上重发', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.dropNextReqs = 1
    const { c } = client(daemon)
    const p = c.request({ method: 'GET', path: '/once' })
    await flush()
    daemon.d.conns[0]!.serverClose()
    await vi.advanceTimersByTimeAsync(500)
    expect(daemon.d.conns).toHaveLength(2)
    expect(daemon.d.reqs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    expect((await p).status).toBe(200)
    expect(daemon.d.reqs).toHaveLength(2)
    expect(daemon.d.reqs[1]!.rid).toBe(daemon.d.reqs[0]!.rid)
    c.close()
  })

  it('后台收到 hs 却一直不回 ⇒ 握手期限(= requestTimeoutMs)到就断开,退避后新握手(新公钥)', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.silentHellos = 1
    const { c } = client(daemon, { retries: 0, requestDeadlineMs: 1000 })
    const p = c.request({ method: 'GET', path: '/x' })
    const assertion = expect(p).rejects.toThrow('unreachable')
    await vi.advanceTimersByTimeAsync(999)
    expect(daemon.d.conns).toHaveLength(1)
    expect(daemon.d.conns[0]!.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(daemon.d.conns[0]!.closed).toBe(true)
    await assertion
    c.subscribe('now', () => {})
    await vi.advanceTimersByTimeAsync(500)
    expect(daemon.d.conns).toHaveLength(2)
    const h0 = daemon.d.conns[0]!.hellos[0] as { hs: string }
    const h1 = daemon.d.conns[1]!.hellos[0] as { hs: string }
    expect(h1.hs).not.toBe(h0.hs)
    expect(c.version()).toBe(2)
    c.close()
  })

  it('缺省选项:后台不理第一次 hello ⇒ 等连接的时间不耗重试次数,真正的那次重试照样可用', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.silentHellos = 1
    daemon.d.dropNextReqs = 1
    const { c } = client(daemon) // requestTimeoutMs 1000;retries、handshakeTimeoutMs 都用缺省
    const p = c.request({ method: 'GET', path: '/x' })
    // 1000:握手期限到 ⇒ 断开;1500:重连并发出第一次(被吞);2500:超时 ⇒ 丢死连接;
    // 3500:第二次重连(退避已涨到 1 s)并重试
    await vi.advanceTimersByTimeAsync(3500)
    expect((await p).status).toBe(200)
    expect(daemon.d.reqs).toHaveLength(2)
    expect(daemon.d.reqs[1]!.rid).toBe(daemon.d.reqs[0]!.rid)
    c.close()
  })

  it('一直连不上 ⇒ 到缺省总期限((timeout + 握手 + 15 s) × (retries + 1))以 unreachable 拒绝;close 后不留计时器', async () => {
    const daemon = makeFakeDaemon({ version: 2, offline: true })
    const { c } = client(daemon)
    const p = c.request({ method: 'GET', path: '/x' })
    let settled = false
    const assertion = expect(p.finally(() => { settled = true })).rejects.toThrow('unreachable')
    await vi.advanceTimersByTimeAsync((1000 + 1000 + 15_000) * 2 - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await assertion
    c.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('总期限到时请求在途 ⇒ 不再重试,本次超时即以 timeout 拒绝', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.silentHellos = 1
    daemon.d.dropNextReqs = 5
    const { c } = client(daemon, { requestDeadlineMs: 2000 })
    const p = c.request({ method: 'GET', path: '/x' })
    const assertion = expect(p).rejects.toThrow('timeout')
    // 1000 握手期限断开、1500 重连后发出、2000 总期限(在途 ⇒ 不再重试)、2500 超时
    await vi.advanceTimersByTimeAsync(2500)
    await assertion
    expect(daemon.d.reqs).toHaveLength(1)
    c.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('后台不回 hs、请求可重试 ⇒ 重试在新连接的新握手上成功', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.silentHellos = 1
    const { c } = client(daemon, { requestTimeoutMs: 3000, handshakeTimeoutMs: 1000 })
    const p = c.request({ method: 'GET', path: '/x' })
    await vi.advanceTimersByTimeAsync(1000 + 500)
    expect((await p).status).toBe(200)
    expect(daemon.d.conns).toHaveLength(2)
    c.close()
  })

  it('畸形 hello ⇒ 记协议错误并断开,退避后重连成功', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.badHellos = 1
    const onProtocolError = vi.fn()
    const { c } = client(daemon, { onProtocolError, requestTimeoutMs: 3000 })
    const p = c.request({ method: 'GET', path: '/x' })
    await flush()
    expect(onProtocolError).toHaveBeenCalledWith('bad_hello', expect.anything())
    expect(daemon.d.conns[0]!.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect((await p).status).toBe(200)
    expect(daemon.d.conns).toHaveLength(2)
    c.close()
  })

  it('已建立的连接悄悄死掉(不回也不关)⇒ 超时的请求先丢掉这条连接,重试走新连接', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const { c } = client(daemon)
    await c.request({ method: 'GET', path: '/warm' })
    daemon.d.conns[0]!.blackhole = true
    const p = c.request({ method: 'GET', path: '/x' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(daemon.d.conns[0]!.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect((await p).status).toBe(200)
    expect(daemon.d.conns).toHaveLength(2)
    c.close()
  })

  it('open 之前 send 会抛的 socket ⇒ 等 onOpen 才发 hello,握手照常完成', async () => {
    const daemon = makeFakeDaemon({ version: 2, manualOpen: true })
    const onProtocolError = vi.fn()
    const { c } = client(daemon, { onProtocolError })
    const p = c.request({ method: 'GET', path: '/x' })
    await flush()
    expect(daemon.d.conns[0]!.hellos).toHaveLength(0)
    daemon.d.conns[0]!.fireOpen()
    await flush()
    expect((await p).status).toBe(200)
    expect(onProtocolError).not.toHaveBeenCalled()
    c.close()
  })

  it('没有挂起请求也没有订阅时断线 ⇒ 不重连;下次请求才连', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const { c, open } = client(daemon)
    await c.request({ method: 'GET', path: '/a' })
    daemon.d.conns[0]!.serverClose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(open).toHaveBeenCalledTimes(1)
    const p = c.request({ method: 'GET', path: '/b' })
    await vi.advanceTimersByTimeAsync(500)
    expect((await p).status).toBe(200)
    expect(open).toHaveBeenCalledTimes(2)
    c.close()
  })

  it('close() ⇒ 挂起请求以 closed 拒绝,不再重连', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    daemon.d.dropNextReqs = 5
    const { c, open } = client(daemon)
    const p = c.request({ method: 'GET', path: '/x' })
    const assertion = expect(p).rejects.toThrow('closed')
    await flush()
    c.close()
    await assertion
    await vi.advanceTimersByTimeAsync(60_000)
    expect(open).toHaveBeenCalledTimes(1)
  })
})

describe('畸形消息', () => {
  it('zod 拒收的消息丢弃、记为协议错误,不往外抛,之后照常工作', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const onProtocolError = vi.fn()
    const { c } = client(daemon, { onProtocolError })
    await c.request({ method: 'GET', path: '/warm' })
    const conn = daemon.d.live()
    const deliver = (s: string) => expect(() => conn.msgCb!(s)).not.toThrow()
    deliver('not json {')
    deliver(JSON.stringify({ what: 1 }))
    deliver(JSON.stringify({ c: 0, ct: 'x' }))
    deliver(JSON.stringify({ c: '99', ct: 'AAAA' }))
    const sealed = (m: unknown) => JSON.stringify(conn.chan!.seal(enc.encode(JSON.stringify(m))))
    deliver(sealed({ t: 'res', rid: 'r1', status: 'x', headers: {}, body: '', bodyEncoding: 'utf8' }))
    deliver(sealed({ t: 'nope' }))
    deliver(sealed({ t: 'ev', sid: 's1', epoch: 'e', seq: -1, data: 1 }))
    deliver(JSON.stringify(conn.chan!.seal(enc.encode('not json'))))
    expect(onProtocolError.mock.calls.length).toBeGreaterThanOrEqual(8)
    const res = await c.request({ method: 'GET', path: '/after' })
    expect(res.status).toBe(200)
    c.close()
  })

  it('没有 onProtocolError 也不抛', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const { c } = client(daemon)
    await c.request({ method: 'GET', path: '/warm' })
    expect(() => daemon.d.live().msgCb!('garbage')).not.toThrow()
    c.close()
  })
})
