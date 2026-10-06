import { describe, it, expect } from 'vitest'
import { PHONE_API_SCHEMAS, type ClientOpts, type ProtocolClient, type ProtocolRequest } from '@wechat-cc/protocol'
import { makeLiveBackend } from './live'
import type { Connection } from './types'
import { ID, RUN, REQ, MATTER, DETAIL, OPTIONS, WB_TASK, RECEIPT, DEVICES, STATE, PROGRESS } from './fixtures'
const SAY_REQ = '5a7e0000-0000-4000-8000-000000000001'
const SAY_REQ2 = '5a7e0000-0000-4000-8000-000000000002'

// 真 schema 的夹具在 fixtures.ts(第一条用例先证明它们本身过 PHONE_API_SCHEMAS)。

/** HANG:请求已发出、一直不回;客户端 close() 时按协议客户端的 failAll 以 Error('closed') 拒掉。 */
const HANG = Symbol('hang')
type Reply = { status: number; json: unknown } | Error | typeof HANG
type Handler = (req: { path: string; body: any }) => Reply

/** 假协议客户端:按「METHOD /path」回夹具;每次 makeClient 都是一个新客户端(模拟重连 / 前后台)。 */
function harness(routes: Record<string, Handler | Reply> = {}) {
  const clients: Array<{ opts: ClientOpts; subs: Map<string, (d: unknown) => void>; closed: boolean; hanging: Array<(e: Error) => void> }> = []
  const reqs: Array<{ key: string; path: string; body: any; retry?: boolean; inHook: boolean }> = []
  /** 正在协议客户端的 onStatus 钩子里:这时回头调客户端可能开出第二条连接(Task 1 的已知坑)。 */
  let inHook = false
  const hookCalls: string[] = []
  const makeClient = (opts: ClientOpts): ProtocolClient => {
    const me = { opts, subs: new Map<string, (d: unknown) => void>(), closed: false, hanging: [] as Array<(e: Error) => void> }
    clients.push(me)
    return {
      version: () => 2,
      async request(r: ProtocolRequest) {
        const key = `${r.method} ${r.path.split('?')[0]}`
        const body = typeof r.body === 'string' ? JSON.parse(r.body) : undefined
        reqs.push({ key, path: r.path, body, retry: r.retry, inHook })
        if (inHook) hookCalls.push(`request ${key}`)
        const h = routes[key]
        const out = typeof h === 'function' ? h({ path: r.path, body }) : h
        if (!out) throw new Error('timeout')
        if (out === HANG) return new Promise<never>((_, rej) => { me.hanging.push(rej) })
        if (out instanceof Error) throw out
        const text = JSON.stringify(out.json)
        return { status: out.status, headers: {}, body: new TextEncoder().encode(text), text: () => text, json: <T,>() => JSON.parse(text) as T }
      },
      subscribe(topic, cb) { if (inHook) hookCalls.push(`subscribe ${topic}`); me.subs.set(topic, d => cb(d, { epoch: 'e', seq: 1 })); return () => { me.subs.delete(topic) } },
      close() {
        if (inHook) hookCalls.push('close')
        me.closed = true
        for (const rej of me.hanging.splice(0)) rej(new Error('closed'))
      },
    }
  }
  const last = () => clients.at(-1)!
  const logs: string[] = []
  const b = makeLiveBackend({ open: () => { throw new Error('unused') }, token: 'd-secret-token', makeClient, now: () => 1_000_000, log: l => logs.push(l) })
  const status = (s: 'connecting' | 'ready' | 'down' | 'auth_failed') => {
    inHook = true
    try { last().opts.onStatus?.(s) } finally { inHook = false }
  }
  return { b, clients, last, reqs, logs, hookCalls, status }
}
const ok = (json: unknown, status = 200): Reply => ({ status, json })

describe('夹具本身是真形状', () => {
  it.each([
    ['GET /m/api/matters', { ok: true, matters: [MATTER] }],
    ['GET /m/api/matter', { ok: true, ...DETAIL }],
    ['GET /m/api/matter/insight', { ok: true, explanations: {}, progress: PROGRESS }],
    ['GET /m/api/matter/changes', { ok: true, turn: null }],
    ['GET /m/api/entry/options', { ok: true, ...OPTIONS }],
    ['POST /m/api/matter/create', { ok: true, receipt: RECEIPT, task: WB_TASK }],
    ['GET /set/api/state', STATE],
  ])('%s', (key, json) => { expect(PHONE_API_SCHEMAS[key]!.safeParse(json).success).toBe(true) })
})

describe('LiveBackend 读', () => {
  it('列表 / 详情 / 说明(带 lang)/ 改动 / 交办选项:路径对、返回去掉 ok', async () => {
    const { b, reqs } = harness({
      'GET /m/api/matters': ok({ ok: true, matters: [MATTER] }),
      'GET /m/api/matter': ok({ ok: true, ...DETAIL }),
      'GET /m/api/matter/insight': ok({ ok: true, explanations: {}, progress: PROGRESS }),
      'GET /m/api/matter/changes': ok({ ok: true, turn: null }),
      'GET /m/api/entry/options': ok({ ok: true, ...OPTIONS }),
    })
    expect(await b.matters('en')).toEqual([MATTER])
    expect(await b.matter(ID, 'en')).toEqual(DETAIL)
    expect(await b.insight(ID, 'zh-Hans')).toEqual({ explanations: {}, progress: PROGRESS })
    expect(await b.changes(ID)).toBeNull()
    expect(await b.entryOptions('en')).toEqual(OPTIONS)
    expect(reqs.map(r => r.path)).toEqual(['/m/api/matters', `/m/api/matter?id=${ID}`, `/m/api/matter/insight?id=${ID}&lang=zh-Hans`, `/m/api/matter/changes?id=${ID}`, '/m/api/entry/options'])
  })
  it('返回不合 schema ⇒ BackendError(unknown),记日志(不含令牌)', async () => {
    const { b, logs } = harness({ 'GET /m/api/matters': ok({ ok: true, matters: [{ id: 1 }] }) })
    await expect(b.matters('en')).rejects.toMatchObject({ code: 'unknown' })
    expect(logs.join('\n')).toContain('GET /m/api/matters')
    expect(logs.join('\n')).not.toContain('d-secret-token')
  })
  it('成功的读更新最近同步时间', async () => {
    const { b } = harness({ 'GET /m/api/matters': ok({ ok: true, matters: [] }) })
    expect(b.connection().lastSyncedAt).toBeNull()
    await b.matters('en')
    expect(b.connection().lastSyncedAt).toBe(1_000_000)
  })
  it('传输错误:daemon_offline ⇒ offline;timeout ⇒ timeout', async () => {
    const h = harness({ 'GET /m/api/matters': new Error('daemon_offline'), 'GET /m/api/matter': new Error('timeout') })
    await expect(h.b.matters('en')).rejects.toMatchObject({ code: 'offline' })
    await expect(h.b.matter(ID, 'en')).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('LiveBackend 提交', () => {
  it('运行中补充带固定 runId,返回执行者的真实回执,旧聊天三参数调用仍兼容', async () => {
    const input = { id: SAY_REQ, taskId: ID, runId: RUN, text: '**补充**', status: 'pending' }
    const { b, reqs } = harness({ 'POST /m/api/matter/say': ({ body }) => body.runId ? ok({ ok: true, result: { kind: 'task', task: WB_TASK, input } }) : ok({ ok: true, result: { kind: 'chat', reply: 'reply' } }) })
    expect(await b.say(ID, '**补充**', SAY_REQ, { runId: RUN })).toMatchObject({ kind: 'task', task: { id: ID, status: 'queued' }, input })
    expect(reqs[0]).toMatchObject({ body: { id: ID, runId: RUN, text: '**补充**', requestId: SAY_REQ }, retry: false })
    expect(reqs[0]!.body).not.toHaveProperty('mode')
    expect(await b.say(ID, 'hi', SAY_REQ2)).toEqual({ kind: 'chat', reply: 'reply' })
    expect(reqs[1]!.body).not.toHaveProperty('runId')
  })
  it.each(['input_stale', 'input_conflict'])('补充 %s 不是普通 busy,页面能如实区分', async code => {
    const { b } = harness({ 'POST /m/api/matter/say': ok({ ok: false, error: code }, 409) })
    await expect(b.say(ID, 'go', SAY_REQ, { runId: RUN })).rejects.toMatchObject({ code })
  })
  it('批准:正文形状对、不自动重试;已被处理 ⇒ stale', async () => {
    let n = 0
    const { b, reqs } = harness({ 'POST /m/api/matter/permission': () => (n++ === 0 ? ok({ ok: true }) : ok({ ok: false, error: 'permission_stale' }, 409)) })
    const p = { id: ID, runId: RUN, requestId: REQ, decision: 'allow' as const }
    await b.decide(p)
    await expect(b.decide(p)).rejects.toMatchObject({ code: 'stale' })
    expect(reqs[0]).toMatchObject({ body: p, retry: undefined })
  })
  it('回答:JSON 超过 20 000 字 ⇒ invalid,请求根本不发', async () => {
    const { b, reqs } = harness({ 'POST /m/api/matter/answer': ok({ ok: true }) })
    await expect(b.answer({ id: ID, runId: RUN, requestId: REQ, answers: { q: ['x'.repeat(20_000)] } })).rejects.toMatchObject({ code: 'invalid' })
    expect(reqs).toHaveLength(0)
    await b.answer({ id: ID, runId: RUN, requestId: REQ, answers: { q: ['short'] } })
    expect(reqs[0]?.body).toEqual({ id: ID, runId: RUN, requestId: REQ, answers: { q: ['short'] } })
  })
  it('说一句:带调用方给的 requestId(同一份草稿重发同一个,daemon 去重)、可重试;超长 ⇒ invalid 不发', async () => {
    const { b, reqs } = harness({ 'POST /m/api/matter/say': ok({ ok: true, result: { kind: 'chat', reply: 'ok' } }) })
    await b.say(ID, 'hi', SAY_REQ)
    await b.say(ID, 'hi', SAY_REQ)
    expect(reqs[0]).toMatchObject({ body: { id: ID, text: 'hi', requestId: SAY_REQ }, retry: false })
    expect(reqs[1]?.body.requestId).toBe(SAY_REQ)
    await expect(b.say(ID, 'x'.repeat(20_001), SAY_REQ)).rejects.toMatchObject({ code: 'invalid' })
    expect(reqs).toHaveLength(2)
  })
  it('交办:有项目 ⇒ target project;没有 ⇒ managed;返回回执里的 matterId', async () => {
    const { b, reqs } = harness({ 'POST /m/api/matter/create': ok({ ok: true, receipt: RECEIPT, task: WB_TASK }, 202) })
    expect(await b.create({ requestId: REQ, text: 't', projectId: 'p-0123456789abcdef0123', providerId: 'claude' })).toEqual({ matterId: ID })
    await b.create({ requestId: REQ, text: 't' })
    expect(reqs[0]).toMatchObject({ retry: true, body: { requestId: REQ, text: 't', target: { kind: 'project', projectId: 'p-0123456789abcdef0123' }, providerId: 'claude' } })
    expect(reqs[1]?.body.target).toEqual({ kind: 'managed' })
  })
  it('交办超时 ⇒ 按 requestId 查一次回执:查到当成功,查不到仍是 timeout', async () => {
    const found = harness({ 'POST /m/api/matter/create': new Error('timeout'), 'GET /m/api/matter/create-receipt': ok({ ok: true, receipt: RECEIPT, task: WB_TASK }) })
    expect(await found.b.create({ requestId: REQ, text: 't' })).toEqual({ matterId: ID })
    expect(found.reqs[1]?.path).toBe(`/m/api/matter/create-receipt?requestId=${REQ}`)
    const missing = harness({ 'POST /m/api/matter/create': new Error('timeout'), 'GET /m/api/matter/create-receipt': ok({ ok: false, error: 'matter_not_found' }, 404) })
    await expect(missing.b.create({ requestId: REQ, text: 't' })).rejects.toMatchObject({ code: 'timeout' })
  })
  it('交办超时后查回执时发现被撤销 ⇒ revoked(不被超时盖掉)', async () => {
    const h = harness({ 'POST /m/api/matter/create': new Error('timeout'), 'GET /m/api/matter/create-receipt': ok({ error: 'unauthorized' }, 401) })
    await expect(h.b.create({ requestId: REQ, text: 't' })).rejects.toMatchObject({ code: 'revoked' })
    expect(h.b.connection().state).toBe('revoked')
  })
})

describe('LiveBackend 自己关掉连接时还在飞的提交', () => {
  const PERM = { id: ID, runId: RUN, requestId: REQ, decision: 'allow' as const }
  it('批准已发出、App 进后台(setActive(false))⇒ timeout(store 译成「不确定」),不是 offline', async () => {
    const h = harness({ 'POST /m/api/matter/permission': HANG })
    h.status('ready')
    const p = h.b.decide(PERM)
    await new Promise(r => setTimeout(r, 0))
    expect(h.reqs).toHaveLength(1)
    h.b.setActive(false)
    await expect(p).rejects.toMatchObject({ code: 'timeout' })
  })
  it('说一句已发出、后端被 dispose ⇒ timeout', async () => {
    const h = harness({ 'POST /m/api/matter/say': HANG })
    const p = h.b.say(ID, 'hi', SAY_REQ)
    await new Promise(r => setTimeout(r, 0))
    h.b.dispose()
    await expect(p).rejects.toMatchObject({ code: 'timeout' })
  })
  it('批准在飞时另一条请求撞上撤销 ⇒ 在飞的这条也是 revoked', async () => {
    const h = harness({ 'POST /m/api/matter/permission': HANG, 'GET /m/api/matters': new Error('auth_failed') })
    const p = h.b.decide(PERM)
    await new Promise(r => setTimeout(r, 0))
    await expect(h.b.matters('en')).rejects.toMatchObject({ code: 'revoked' })
    await expect(p).rejects.toMatchObject({ code: 'revoked' })
  })
  it('交办在飞时进后台 ⇒ 查回执也没连接,结果仍是 timeout(不确定)', async () => {
    const h = harness({ 'POST /m/api/matter/create': HANG })
    const p = h.b.create({ requestId: REQ, text: 't' })
    await new Promise(r => setTimeout(r, 0))
    h.b.setActive(false)
    await expect(p).rejects.toMatchObject({ code: 'timeout' })
  })
  it('不是自己关的(电脑那边断了,daemon_offline)⇒ 仍是 offline', async () => {
    const h = harness({ 'POST /m/api/matter/permission': new Error('daemon_offline') })
    await expect(h.b.decide(PERM)).rejects.toMatchObject({ code: 'offline' })
  })
})

describe('LiveBackend 撤销', () => {
  it('提交途中被撤销(auth_failed)⇒ 这次是 revoked,连接变 revoked,客户端关掉,之后一条请求都不发', async () => {
    const h = harness({ 'POST /m/api/matter/permission': new Error('auth_failed') })
    await expect(h.b.decide({ id: ID, runId: RUN, requestId: REQ, decision: 'allow' })).rejects.toMatchObject({ code: 'revoked' })
    expect(h.b.connection().state).toBe('revoked')
    expect(h.last().closed).toBe(true)
    const n = h.reqs.length
    await expect(h.b.matters('en')).rejects.toMatchObject({ code: 'revoked' })
    await expect(h.b.say(ID, 'x', SAY_REQ)).rejects.toMatchObject({ code: 'revoked' })
    expect(h.reqs.length).toBe(n)
  })
  it('协议客户端报 auth_failed 状态 ⇒ revoked;HTTP 401 ⇒ revoked', async () => {
    const a = harness()
    a.status('auth_failed')
    expect(a.b.connection().state).toBe('revoked')
    const c = harness({ 'GET /m/api/matters': ok({ error: 'unauthorized' }, 401) })
    await expect(c.b.matters('en')).rejects.toMatchObject({ code: 'revoked' })
    expect(c.b.connection().state).toBe('revoked')
  })
  it('订阅被拒 auth_failed ⇒ revoked,客户端关掉', async () => {
    const h = harness()
    h.last().opts.onSubscriptionError?.('approvals', 'auth_failed')
    expect(h.b.connection().state).toBe('revoked')
    await Promise.resolve()
    expect(h.last().closed).toBe(true)
  })
  it('一个连接监听者抛错,撤销照样完成、其他监听者照样收到', async () => {
    const h = harness()
    const seen: string[] = []
    h.b.onConnection(c => { if (c.state === 'revoked') throw new Error('boom') })
    h.b.onConnection(c => { seen.push(c.state) })
    expect(() => h.status('auth_failed')).not.toThrow()
    expect(h.b.connection().state).toBe('revoked')
    expect(seen.at(-1)).toBe('revoked')
    await Promise.resolve()
    expect(h.last().closed).toBe(true)
  })
  it('revoked 之后 setActive(true) 不再连', () => {
    const h = harness()
    h.status('auth_failed')
    const n = h.clients.length
    h.b.setActive(false); h.b.setActive(true)
    expect(h.clients.length).toBe(n)
  })
})

describe('LiveBackend 连接与订阅', () => {
  it('onConnection 立刻回调当前值;ready ⇒ online epoch 1;down ⇒ offline', () => {
    const h = harness()
    const seen: Connection[] = []
    h.b.onConnection(c => seen.push(c))
    expect(seen[0]?.state).toBe('connecting')
    h.status('ready'); h.status('down')
    expect(seen.map(c => c.state)).toEqual(['connecting', 'online', 'offline'])
    expect(seen[1]?.epoch).toBe(1)
  })
  it('构造即常驻订阅 approvals(让协议客户端一直连着,状态机才知道电脑在不在)', () => {
    const h = harness()
    expect([...h.last().subs.keys()]).toEqual(['approvals'])
  })
  it('主题事件过 schema 才转交;坏的丢掉;后来的订阅者立刻拿到最近一份', () => {
    const h = harness()
    const got: unknown[] = []
    h.b.subscribe('agents', d => got.push(d))
    h.last().subs.get('agents')!({ running: 'many' })
    h.last().subs.get('agents')!({ running: 1, waiting: 0, tasks: [] })
    expect(got).toEqual([{ running: 1, waiting: 0, tasks: [] }])
    const late: unknown[] = []
    h.b.subscribe('agents', d => late.push(d))
    expect(late).toEqual([{ running: 1, waiting: 0, tasks: [] }])
  })
  it('最后一个订阅者退订 ⇒ 退订协议客户端;常驻的 approvals 不退', () => {
    const h = harness()
    const off1 = h.b.subscribe('agents', () => {}), off2 = h.b.subscribe('approvals', () => {})
    off1(); off2()
    expect([...h.last().subs.keys()]).toEqual(['approvals'])
  })
  it('后台 setActive(false) 关连接;回前台 setActive(true) 新客户端、全部主题重挂、旧客户端的状态被忽略', () => {
    const h = harness()
    h.b.subscribe('agents', () => {})
    const first = h.last()
    h.b.setActive(false)
    expect(first.closed).toBe(true)
    h.b.setActive(true)
    expect(h.clients.length).toBe(2)
    expect([...h.last().subs.keys()].sort()).toEqual(['agents', 'approvals'])
    first.opts.onStatus?.('down')
    expect(h.b.connection().state).toBe('connecting')
    h.status('ready')
    expect(h.b.connection()).toMatchObject({ state: 'online', epoch: 1 })
  })
  it('重连只重挂订阅,不重发任何提交(之前一句成功、一句超时,重连后都不会被自动重发)', async () => {
    let n = 0
    const h = harness({ 'POST /m/api/matter/say': () => (n++ === 0 ? ok({ ok: true, result: { kind: 'chat', reply: 'ok' } }) : new Error('timeout')) })
    h.status('ready')
    await h.b.say(ID, 'first', SAY_REQ)
    await expect(h.b.say(ID, 'second', SAY_REQ2)).rejects.toMatchObject({ code: 'timeout' })
    const posts = () => h.reqs.filter(r => r.key.startsWith('POST')).length
    expect(posts()).toBe(2)
    h.status('down')
    h.b.setActive(false); h.b.setActive(true); h.status('ready')
    await new Promise(r => setTimeout(r, 0))
    expect(h.b.connection()).toMatchObject({ state: 'online', epoch: 2 })
    expect(posts()).toBe(2)
    expect(h.clients).toHaveLength(2)
  })
  it('订阅因非授权原因被拒:这一连接里不重挂;回前台新连接时重挂', async () => {
    const h = harness()
    h.b.subscribe('agents', () => {})
    const first = h.last()
    first.subs.delete('agents')
    first.opts.onSubscriptionError?.('agents', 'forbidden')
    await Promise.resolve()
    expect(h.b.connection().state).not.toBe('revoked')
    expect(h.logs.join('\n')).toContain('topic agents: forbidden')
    h.b.subscribe('agents', () => {})
    await Promise.resolve()
    expect(first.subs.has('agents')).toBe(false)
    h.b.setActive(false); h.b.setActive(true)
    await Promise.resolve()
    expect(h.clients).toHaveLength(2)
    expect([...h.last().subs.keys()].sort()).toEqual(['agents', 'approvals'])
  })
  it('onStatus 钩子里从不同步回调协议客户端:监听者在钩子里读 / 订阅,推到微任务之后才发', async () => {
    const h = harness({ 'GET /m/api/matters': ok({ ok: true, matters: [] }) })
    const reads: Array<Promise<unknown>> = []
    let prev = h.b.connection().state
    h.b.onConnection(c => {
      const changed = c.state !== prev
      prev = c.state
      if (changed && (c.state === 'online' || c.state === 'offline')) {
        reads.push(h.b.matters('en').catch(() => null))
        h.b.subscribe(`matter/${ID}`, () => {})
      }
    })
    h.status('ready')
    h.status('down')
    h.status('connecting')
    expect(h.hookCalls).toEqual([])
    await Promise.all(reads)
    await new Promise(r => setTimeout(r, 0))
    expect(h.hookCalls).toEqual([])
    expect(h.reqs.filter(r => r.key === 'GET /m/api/matters')).toHaveLength(2)
    expect([...h.last().subs.keys()].sort()).toEqual(['approvals', `matter/${ID}`])
  })
  it('钩子报 auth_failed:状态立刻 revoked,关客户端推到钩子之后', async () => {
    const h = harness()
    h.status('auth_failed')
    expect(h.b.connection().state).toBe('revoked')
    expect(h.hookCalls).toEqual([])
    await Promise.resolve()
    expect(h.last().closed).toBe(true)
    expect(h.hookCalls).toEqual([])
  })
})

describe('LiveBackend 设备', () => {
  it('列表来自 /set/api/state;给本机改名用 current 那台的 id', async () => {
    const { b, reqs } = harness({ 'GET /set/api/state': ok(STATE), 'POST /set/api/apply': ok({ ok: true }) })
    expect(await b.devices()).toEqual(DEVICES)
    await b.renameDevice('My phone')
    expect(reqs.at(-1)?.body).toEqual({ op: 'label_device', id: 'aa11bb22', label: 'My phone' })
  })
  it('改名被拒(ok:false invalid_value)⇒ invalid', async () => {
    const { b } = harness({ 'GET /set/api/state': ok(STATE), 'POST /set/api/apply': ok({ ok: false, error: 'invalid_value' }) })
    await expect(b.renameDevice('')).rejects.toMatchObject({ code: 'invalid' })
  })
  it('解除配对:发 unpair_self,成功后关连接', async () => {
    const h = harness({ 'POST /set/api/apply': ok({ ok: true }) })
    await h.b.unpair()
    expect(h.reqs[0]?.body).toEqual({ op: 'unpair_self' })
    expect(h.last().closed).toBe(true)
    await expect(h.b.matters('en')).rejects.toMatchObject({ code: 'offline' })
  })
})

describe('推送登记 / 测试通知', () => {
  it('registerPush 发 POST /m/api/push/register {platform, token};testPush 返回 daemon 的结果', async () => {
    const { b, reqs, logs } = harness({
      'POST /m/api/push/register': ok({ ok: true }),
      'POST /m/api/push/test': ok({ ok: true, result: { ok: false, code: 'relay_offline' } }),
    })
    await b.registerPush('apns_sandbox', 'a1'.repeat(32))
    expect(reqs.find(r => r.key === 'POST /m/api/push/register')?.body).toEqual({ platform: 'apns_sandbox', token: 'a1'.repeat(32) })
    expect(await b.testPush()).toEqual({ ok: false, code: 'relay_offline' })
    expect(logs.join('\n')).not.toContain('a1'.repeat(32))
  })
  it('daemon 没接推送 ⇒ BackendError(unavailable)', async () => {
    const { b } = harness({ 'POST /m/api/push/register': ok({ ok: false, error: 'push_not_wired' }, 503) })
    await expect(b.registerPush('fcm', 'x'.repeat(40))).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('跟 CC 说 / 连接 / 原生会话', () => {
  it('会话搜索q编码并贯穿追加页;窗口参数与旧调用保持独立', async () => {
    const row = { key: 'a/b', provider: 'codex', title: '按钮', project: 'p', updatedAt: 1, active: false }
    const { b, reqs } = harness({
      'GET /m/api/sessions': ok({ ok: true, items: [row], nextCursor: null }),
      'GET /m/api/session': ({ path }) => ok({ ok: true, session: row, messages: [], nextCursor: null, managed: false, ...(path.includes('window=') ? { window: path.includes('recent') ? 'recent' : 'start' } : {}) }),
    })
    await b.sessions('codex', 'page 2', ' 按钮 & view ')
    expect(reqs.at(-1)!.path).toBe('/m/api/sessions?provider=codex&cursor=page%202&q=%E6%8C%89%E9%92%AE%20%26%20view')
    expect((await b.session('a/b', undefined, 'recent')).window).toBe('recent')
    expect(reqs.at(-1)!.path).toBe('/m/api/session?key=a%2Fb&window=recent')
    expect((await b.session('a/b', 'next', 'start')).window).toBe('start')
    expect(reqs.at(-1)!.path).toBe('/m/api/session?key=a%2Fb&cursor=next&window=start')
    expect((await b.session('a/b')).window).toBeUndefined()
    expect(reqs.at(-1)!.path).toBe('/m/api/session?key=a%2Fb')
  })
  it('搜索超过200字或包含NUL、近期窗口带cursor,在手机侧拦下且不发请求', async () => {
    const { b, reqs } = harness()
    await expect(b.sessions('claude', undefined, 'x'.repeat(201))).rejects.toMatchObject({ code: 'invalid' })
    await expect(b.sessions('claude', undefined, 'a\0b')).rejects.toMatchObject({ code: 'invalid' })
    await expect(b.session('k', 'page', 'recent')).rejects.toMatchObject({ code: 'invalid' })
    expect(reqs).toHaveLength(0)
  })
  const PAGE = { ok: true, matterId: 'c0ffee01', title: '聊天', messages: [], hasMore: false, nextBefore: null, pending: null, failed: null }
  it('chat:before / limit 拼进查询串;返回过 schema、去掉 ok', async () => {
    const { b, reqs } = harness({ 'GET /m/api/chat': ok(PAGE) })
    const page = await b.chat({ before: '2026-09-30T00:00:05.000Z', limit: 10 })
    expect(page.matterId).toBe('c0ffee01')
    expect('ok' in page).toBe(false)
    expect(reqs.at(-1)!.path).toBe('/m/api/chat?before=2026-09-30T00%3A00%3A05.000Z&limit=10')
    await b.chat({}); expect(reqs.at(-1)!.path).toBe('/m/api/chat')
    // limit: 0 不能被当成「没给」悄悄丢掉:原样带上,由 daemon 判 400 invalid
    await b.chat({ limit: 0 }); expect(reqs.at(-1)!.path).toBe('/m/api/chat?limit=0')
  })
  it('chat:还没有主人对话(404 no_owner_chat)⇒ not_found', async () => {
    const { b } = harness({ 'GET /m/api/chat': ok({ ok: false, error: 'no_owner_chat' }, 404) })
    await expect(b.chat({})).rejects.toMatchObject({ code: 'not_found' })
  })
  it('chatSay:超长在手机上就拦;正常带 requestId,retry 打开;上一句在等 ⇒ busy', async () => {
    const { b, reqs } = harness({ 'POST /m/api/chat/say': ok({ ok: true, matterId: 'c0ffee01', job: { requestId: SAY_REQ, text: 'hi', status: 'pending', since: 1 } }, 202) })
    await expect(b.chatSay('x'.repeat(20_001), SAY_REQ)).rejects.toMatchObject({ code: 'invalid' })
    expect(reqs).toHaveLength(0)
    expect((await b.chatSay('hi', SAY_REQ)).status).toBe('pending')
    expect(reqs.at(-1)).toMatchObject({ body: { requestId: SAY_REQ, text: 'hi' }, retry: true })
    const busy = harness({ 'POST /m/api/chat/say': ok({ ok: false, error: 'chat_busy' }, 409) })
    await expect(busy.b.chatSay('hi', SAY_REQ2)).rejects.toMatchObject({ code: 'busy' })
    const down = harness({ 'POST /m/api/chat/say': ok({ ok: false, error: 'unavailable' }, 503) })
    await expect(down.b.chatSay('hi', SAY_REQ2)).rejects.toMatchObject({ code: 'unavailable' })
  })
  it('chatSay 带图(2026-10-06):draftId + attachmentIds 进正文;电脑上图不在了 ⇒ images_gone;老电脑 ⇒ images_unsupported', async () => {
    const D = '11111111-1111-4111-8111-111111111111', A = '22222222-2222-4222-8222-222222222222'
    const { b, reqs } = harness({ 'POST /m/api/chat/say': ok({ ok: true, matterId: 'c0ffee01', job: { requestId: SAY_REQ, text: '', status: 'pending', since: 1 } }, 202) })
    await b.chatSay('', SAY_REQ, { draftId: D, attachmentIds: [A] })
    expect(reqs.at(-1)).toMatchObject({ body: { requestId: SAY_REQ, text: '', draftId: D, attachmentIds: [A] } })
    const gone = harness({ 'POST /m/api/chat/say': ok({ ok: false, error: 'invalid_attachment' }, 409) })
    await expect(gone.b.chatSay('', SAY_REQ, { draftId: D, attachmentIds: [A] })).rejects.toMatchObject({ code: 'images_gone' })
    const old = harness({ 'POST /m/api/chat/say': ok({ ok: false, error: 'images_not_supported' }, 409) })
    await expect(old.b.chatSay('', SAY_REQ, { draftId: D, attachmentIds: [A] })).rejects.toMatchObject({ code: 'images_unsupported' })
  })
  it('材料分块上传 / 查进度 / 丢弃 走对应路由;交办带上 draftId + attachmentIds', async () => {
    const D = '11111111-1111-4111-8111-111111111111', A = '22222222-2222-4222-8222-222222222222'
    const state = { id: A, draftId: D, taskId: null, size: 3, sha256: 'a'.repeat(64), nextOffset: 3, status: 'ready' }
    const { b, reqs } = harness({
      'POST /m/api/attachment/chunk': ok({ ok: true, ...state }),
      'GET /m/api/attachment/upload': ok({ ok: true, ...state }),
      'POST /m/api/attachment/discard': ok({ ok: true }),
      'POST /m/api/matter/create': ok({ ok: true, receipt: RECEIPT, task: WB_TASK }, 202),
    })
    expect((await b.uploadChunk({ id: A, draftId: D, name: 'a.png', mime: 'image/png', size: 3, sha256: 'a'.repeat(64), offset: 0, contentBase64: 'AAAA' })).status).toBe('ready')
    expect((await b.uploadStatus(A, D)).nextOffset).toBe(3)
    expect(reqs.at(-1)!.path).toBe(`/m/api/attachment/upload?id=${A}&draftId=${D}`)
    await b.discardUpload(A, D)
    expect(reqs.at(-1)).toMatchObject({ body: { id: A, draftId: D } })
    await b.create({ requestId: SAY_REQ, text: '看图', draftId: D, attachmentIds: [A] })
    expect(reqs.at(-1)).toMatchObject({ body: { requestId: SAY_REQ, text: '看图', draftId: D, attachmentIds: [A] } })
  })
  it('交办选模型(2026-10-06):entryModels 只带执行者与项目目录 id;create 带 execution', async () => {
    const CAT = { source: 'native', defaultModel: 'gpt-5.6', models: [{ id: 'gpt-5.6', displayName: 'GPT-5.6', reasoningEfforts: ['low', 'high'] }] }
    const { b, reqs } = harness({
      'GET /m/api/entry/models': ok({ ok: true, catalog: CAT }),
      'POST /m/api/matter/create': ok({ ok: true, receipt: RECEIPT, task: WB_TASK }, 202),
    })
    expect((await b.entryModels('codex', 'p-0123456789abcdef0123')).models[0]!.id).toBe('gpt-5.6')
    expect(reqs.at(-1)!.path).toBe('/m/api/entry/models?providerId=codex&projectId=p-0123456789abcdef0123')
    await b.create({ requestId: SAY_REQ, text: '整理一下', providerId: 'codex', execution: { model: 'gpt-5.6', reasoningEffort: 'high' } })
    expect(reqs.at(-1)).toMatchObject({ body: { execution: { model: 'gpt-5.6', reasoningEffort: 'high' } } })
    await b.create({ requestId: SAY_REQ, text: '整理一下', execution: {} })
    expect(reqs.at(-1)!.body).not.toHaveProperty('execution')
  })
  it('CC 记得你(2026-10-06):读记忆、逐条纠错走对应路由;不在了 ⇒ not_found', async () => {
    const VIEW = { ok: true, updated_at: null, when_label: null, mood: 'steady', failures: 0, changes: [], sections: [] }
    const { b, reqs } = harness({ 'GET /m/api/memory': ok(VIEW), 'POST /m/api/memory/correct': ok({ ok: true }) })
    expect((await b.memory()).mood).toBe('steady')
    await b.correctMemory('abc123', 'outdated')
    expect(reqs.at(-1)).toMatchObject({ body: { id: 'abc123', verdict: 'outdated' } })
    const gone = harness({ 'POST /m/api/memory/correct': ok({ ok: false, error: 'not_found' }, 404) })
    await expect(gone.b.correctMemory('abc123', 'wrong')).rejects.toMatchObject({ code: 'not_found' })
  })
  it('connections / sessions / session 走对应路由', async () => {
    const CONN = { ok: true, generatedAt: 1, sources: [{ id: 'wxvault', kind: 'plugin', name: 'wxvault', state: 'ready', latestAt: null, syncedAt: null }], computers: [], recent: [], outputs: [] }
    const ROW = { key: 'k', provider: 'codex', title: 't', project: 'p', updatedAt: 1, active: false }
    const { b, reqs } = harness({
      'GET /m/api/connections': ok(CONN),
      'GET /m/api/sessions': ok({ ok: true, items: [ROW], nextCursor: 'n' }),
      'GET /m/api/session': ({ path }) => path.includes('key=gone') ? ok({ ok: false, error: 'unsupported' }, 404) : ok({ ok: true, session: ROW, messages: [], nextCursor: null, managed: false }),
    })
    expect((await b.connections()).sources[0]!.state).toBe('ready')
    expect(reqs.at(-1)!.path).toBe('/m/api/connections')
    expect(await b.sessions('codex', 'c 1')).toEqual({ items: [ROW], nextCursor: 'n' })
    expect(reqs.at(-1)!.path).toBe('/m/api/sessions?provider=codex&cursor=c%201')
    await b.sessions('claude'); expect(reqs.at(-1)!.path).toBe('/m/api/sessions?provider=claude')
    expect((await b.session('a/b', 'x y')).session.key).toBe('k')
    expect(reqs.at(-1)!.path).toBe('/m/api/session?key=a%2Fb&cursor=x%20y')
    await expect(b.session('gone')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('接着做:continuePreview / continueSession 走 /m/api/session/continue(POST 幂等可重发);会话忙 ⇒ session_busy', async () => {
    const PRE = { ok: true, state: 'ready', provider: 'claude', project: 'proj', mode: 'native_resume', matterId: null }
    const { b, reqs } = harness({
      'GET /m/api/session/continue': ok(PRE),
      'POST /m/api/session/continue': ({ body }) => body.key === 'busy' ? ok({ ok: false, error: 'native_session_busy' }, 409) : ok({ ok: true, matterId: 'deadbeef', created: true }),
    })
    expect(await b.continuePreview('a/b')).toEqual({ state: 'ready', provider: 'claude', project: 'proj', mode: 'native_resume', matterId: null })
    expect(reqs.at(-1)!.path).toBe('/m/api/session/continue?key=a%2Fb')
    expect(await b.continueSession('k')).toEqual({ matterId: 'deadbeef' })
    expect(reqs.at(-1)).toMatchObject({ key: 'POST /m/api/session/continue', body: { key: 'k' }, retry: true })
    await expect(b.continueSession('busy')).rejects.toMatchObject({ code: 'session_busy' })
  })

  it('交给另一位继续:POST /m/api/matter/handoff(三键、幂等可重发);情况变了 ⇒ handoff_changed', async () => {
    const REQ = '5a7e0000-0000-4000-8000-000000000001'
    const { b, reqs } = harness({
      'POST /m/api/matter/handoff': ({ body }) => body.providerId === 'codex' ? ok({ ok: true, matterId: 'deadbeef', created: true }) : ok({ ok: false, error: 'quota_handoff_changed' }, 409),
    })
    expect(await b.handoff({ id: 'cafebabe', requestId: REQ, providerId: 'codex' })).toEqual({ matterId: 'deadbeef' })
    expect(reqs.at(-1)).toMatchObject({ key: 'POST /m/api/matter/handoff', path: '/m/api/matter/handoff', body: { id: 'cafebabe', requestId: REQ, providerId: 'codex' }, retry: true })
    await expect(b.handoff({ id: 'cafebabe', requestId: REQ, providerId: 'gemini' })).rejects.toMatchObject({ code: 'handoff_changed' })
  })
})

describe('durable single input receipt', () => {
  it('queries the exact task/request with GET only, retaining optional reason and old-server missing semantics', async () => {
    const input = { id: SAY_REQ, taskId: ID, runId: RUN, text: '保留原文', status: 'held', error: 'process_closed' }
    const found = harness({ 'GET /m/api/matter/input-receipt': ok({ ok: true, input }) })
    expect(await found.b.matterInputReceipt(ID, SAY_REQ)).toEqual(input)
    expect(found.reqs).toEqual([expect.objectContaining({ key: 'GET /m/api/matter/input-receipt', path: `/m/api/matter/input-receipt?id=${ID}&requestId=${SAY_REQ}`, body: undefined })])
    for (const error of ['not_found', 'unsupported']) {
      const missing = harness({ 'GET /m/api/matter/input-receipt': ok({ ok: false, error }, 404) })
      expect(await missing.b.matterInputReceipt(ID, SAY_REQ)).toBeNull()
      expect(missing.reqs.every(r => r.key.startsWith('GET '))).toBe(true)
    }
  })
  it('a malformed receipt is never confirmation; revoke still closes the backend', async () => {
    const malformed = harness({ 'GET /m/api/matter/input-receipt': ok({ ok: true, input: { id: SAY_REQ } }) })
    await expect(malformed.b.matterInputReceipt(ID, SAY_REQ)).rejects.toMatchObject({ code: 'unknown' })
    const revoked = harness({ 'GET /m/api/matter/input-receipt': ok({ ok: false, error: 'unauthorized' }, 401) })
    await expect(revoked.b.matterInputReceipt(ID, SAY_REQ)).rejects.toMatchObject({ code: 'revoked' })
    expect(revoked.b.connection().state).toBe('revoked')
  })
})
