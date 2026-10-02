import { describe, expect, it, vi } from 'vitest'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import { mobileReadsRoute, cacheSessions, SESSIONS_DONE_MAX, type MobileSessionsDeps } from './mobile-reads'
import type { ConnectionsSnapshot } from './connections'
import { deriveSharedKey, generateTunnelKeypair, sealFrame } from '../lib/tunnel-crypto'

const SNAP: ConnectionsSnapshot = {
  generatedAt: 1, computers: [{ id: 'home', label: 'Mac', online: true, since: 0, version: '1.7.1' }], recent: [], outputs: [],
  sources: [{ id: 'wechat_history', kind: 'wechat_history', name: 'wxvault', state: 'not_loaded', latestAt: null, syncedAt: null, detail: { reason: 'missing', dir: '/Users/nate/plugins' } }],
}
const run = async (deps: Parameters<typeof mobileReadsRoute>[0], path: string, method = 'GET') => {
  const r = await mobileReadsRoute(deps, new URL('http://x' + path), new Request('http://x' + path, { method }))
  return r && { status: r.status, body: await r.json() as any }
}

describe('GET /m/api/connections', () => {
  it('去掉 detail,过 schema', async () => {
    const r = await run({ connections: () => SNAP }, '/m/api/connections')
    expect(r!.status).toBe(200)
    const text = JSON.stringify(r!.body)
    expect(text).not.toContain('/Users')
    expect(text).not.toContain('missing')
    PHONE_API_SCHEMAS['GET /m/api/connections']!.parse(r!.body)
  })
  it('没接 ⇒ 503;抛 ⇒ 503 unavailable(裁定 7);别的路径 ⇒ null;非 GET ⇒ 405', async () => {
    expect((await run({}, '/m/api/connections'))!.status).toBe(503)
    const thrown = await run({ connections: () => { throw new Error('x') } }, '/m/api/connections')
    expect(thrown!.status).toBe(503)
    expect(thrown!.body).toEqual({ ok: false, error: 'unavailable' })
    expect(await run({}, '/m/api/matters')).toBeNull()
    expect((await run({ connections: () => SNAP }, '/m/api/connections', 'POST'))!.status).toBe(405)
  })
})

const ITEM = { key: 'k1', providerId: 'claude' as const, nativeId: 'n1', title: 'T'.repeat(300), titleSource: 'first_prompt' as const, cwd: '/Users/nate/work/portfolio', updatedAt: 5, remote: false, observedState: 'active' as const }
const sessions = (over: Partial<MobileSessionsDeps> = {}): MobileSessionsDeps => ({
  list: async () => ({ items: [ITEM], nextCursor: 'c2', coverage: 'native_supported_history' }),
  read: async () => ({ session: ITEM, messages: [{ id: 'm1', role: 'user', text: 'x'.repeat(5000), truncated: false }], nextCursor: null, sourceFingerprint: 'f', page: { limit: 20, cursor: null }, truncated: false, managedTaskId: 'deadbeef' }),
  ...over,
})

describe('GET /m/api/sessions、/m/api/session', () => {
  it('列表:只给目录名,不给 cwd / nativeId;标题截 200;过 schema', async () => {
    const r = await run({ sessions: sessions() }, '/m/api/sessions?provider=claude')
    expect(r!.body.items[0]).toEqual({ key: 'k1', provider: 'claude', title: 'T'.repeat(200), project: 'portfolio', updatedAt: 5, active: true })
    expect(JSON.stringify(r!.body)).not.toContain('/Users')
    PHONE_API_SCHEMAS['GET /m/api/sessions']!.parse(r!.body)
  })
  it('读一页:每条截 4000、managed;过 schema', async () => {
    const r = await run({ sessions: sessions() }, '/m/api/session?key=k1')
    expect(r!.body.messages[0]).toMatchObject({ truncated: true }); expect(r!.body.messages[0].text).toHaveLength(4000)
    expect(r!.body.managed).toBe(true)
    expect(r!.body.window).toBe('start')
    expect(JSON.stringify(r!.body)).not.toContain('/Users')
    PHONE_API_SCHEMAS['GET /m/api/session']!.parse(r!.body)
  })
  it('recent only uses the recent reader and retains the phone limits, privacy and managed state', async () => {
    const read=vi.fn(sessions().read),readRecent=vi.fn(sessions().read)
    const r=await run({sessions:sessions({read,readRecent})},'/m/api/session?key=k1&window=recent')
    expect(r!.status).toBe(200);expect(r!.body.window).toBe('recent')
    expect(readRecent).toHaveBeenCalledExactlyOnceWith('k1',{limit:20});expect(read).not.toHaveBeenCalled()
    expect(r!.body.messages[0].text).toHaveLength(4000);expect(r!.body.managed).toBe(true)
    expect(JSON.stringify(r!.body)).not.toContain('/Users')
  })
  it('validates window and refuses an unavailable recent reader without falling back to old history', async () => {
    const read=vi.fn(sessions().read),readRecent=vi.fn(sessions().read),deps={sessions:sessions({read,readRecent})}
    for(const query of ['window=recent&window=recent','window=','window=tail','window=recent&cursor=a'])expect((await run(deps,'/m/api/session?key=k1&'+query))!.status).toBe(400)
    expect(read).not.toHaveBeenCalled();expect(readRecent).not.toHaveBeenCalled()
    const missing=await run({sessions:sessions({read})},'/m/api/session?key=k1&window=recent')
    expect(missing).toEqual({status:503,body:{ok:false,error:'unavailable'}});expect(read).not.toHaveBeenCalled()
    expect((await run(deps,'/m/api/session?key=k1&window=start&cursor=abc'))!.body.window).toBe('start')
    expect(read).toHaveBeenCalledWith('k1',{limit:20,cursor:'abc'})
  })
  it('passes a trimmed search query with the same cursor and 30-row paging, rejecting malformed queries before listing', async () => {
    const list=vi.fn(sessions().list),deps={sessions:sessions({list})}
    await run(deps,'/m/api/sessions?provider=codex&q=%20recent%20&cursor=next')
    expect(list).toHaveBeenCalledExactlyOnceWith('codex',{q:'recent',limit:30,cursor:'next'})
    list.mockClear()
    for(const query of ['q=a&q=b','q='+ 'x'.repeat(201),'q=before%00after'])expect((await run(deps,'/m/api/sessions?provider=claude&'+query))!.status).toBe(400)
    expect(list).not.toHaveBeenCalled()
    await run(deps,'/m/api/sessions?provider=claude&q='+ 'x'.repeat(200))
    expect(list).toHaveBeenCalledWith('claude',{q:'x'.repeat(200),limit:30})
  })
  it('分页大小:列表 30、读 20;cursor 原样', async () => {
    const seen: unknown[] = []
    await run({ sessions: sessions({ list: async (p, i) => { seen.push([p, i]); return { items: [], nextCursor: null, coverage: 'native_supported_history' } } }) }, '/m/api/sessions?provider=codex&cursor=abc')
    expect(seen).toEqual([['codex', { q: '', limit: 30, cursor: 'abc' }]])
  })
  it('坏参数 400;不支持 404;读得慢(超预算)503 —— 隧道 15 秒前一定回', async () => {
    for (const p of ['/m/api/sessions', '/m/api/sessions?provider=gemini', `/m/api/sessions?provider=claude&cursor=${'a'.repeat(2049)}`, '/m/api/sessions?provider=claude&cursor=a&cursor=b', '/m/api/session']) expect((await run({ sessions: sessions() }, p))!.status).toBe(400)
    expect((await run({ sessions: sessions({ list: async () => { throw new Error('native_history_unsupported') } }) }, '/m/api/sessions?provider=codex'))!.body).toEqual({ ok: false, error: 'unsupported' })
    expect((await run({ sessions: sessions({ read: async () => { throw new Error('invalid_cursor') } }) }, '/m/api/session?key=k1'))!.status).toBe(400)
    const slow = sessions({ read: () => new Promise(() => {}) })
    const t0 = Date.now()
    const r = await mobileReadsRoute({ sessions: slow }, new URL('http://x/m/api/session?key=k1'), new Request('http://x/m/api/session?key=k1'), { budgetMs: 30 })
    expect(r!.status).toBe(503); expect(Date.now() - t0).toBeLessThan(1000)
    expect((await run({}, '/m/api/sessions?provider=claude'))!.status).toBe(503)
    expect((await run({ sessions: sessions({ list: async () => { throw new Error('boom') } }) }, '/m/api/sessions?provider=claude'))!.status).toBe(503)
  })
})

describe('cacheSessions(单飞 + 短缓存,裁定 8)', () => {
  it('single-flights and expires recent windows independently of head pages and search queries', async () => {
    let time=0
    const read=vi.fn(sessions().read),readRecent=vi.fn(async(key:string,input:{limit:number})=>{await Promise.resolve();return sessions().read(key,input)}),list=vi.fn(sessions().list)
    const c=cacheSessions(sessions({read,readRecent,list}),{ttlMs:1000,now:()=>time})
    await Promise.all([c.readRecent!('k1',{limit:20}),c.readRecent!('k1',{limit:20}),c.read('k1',{limit:20})])
    expect(readRecent).toHaveBeenCalledTimes(1);expect(read).toHaveBeenCalledTimes(1)
    await c.readRecent!('k1',{limit:20});expect(readRecent).toHaveBeenCalledTimes(1)
    await c.readRecent!('k1',{limit:10});expect(readRecent).toHaveBeenCalledTimes(2)
    await c.list('claude',{q:'one',limit:30});await c.list('claude',{q:'two',limit:30});await c.list('claude',{q:'one',limit:30,cursor:'next'});await c.list('claude',{q:'one',limit:30})
    expect(list).toHaveBeenCalledTimes(3)
    time=1001;await c.readRecent!('k1',{limit:20});expect(readRecent).toHaveBeenCalledTimes(3)
    expect(cacheSessions(sessions()).readRecent).toBeUndefined()
  })
  it('does not cache a failed recent load or consume another inflight slot for its replay', async () => {
    let reject!:(error:Error)=>void
    const readRecent=vi.fn(()=>new Promise<Awaited<ReturnType<MobileSessionsDeps['read']>>>((_resolve,no)=>{reject=no}))
    const c=cacheSessions(sessions({readRecent}),{maxInflight:1})
    const a=c.readRecent!('k1',{limit:20}),b=c.readRecent!('k1',{limit:20})
    expect(readRecent).toHaveBeenCalledTimes(1)
    await expect(c.read('k1',{limit:20})).rejects.toThrow('busy')
    const failures=Promise.all([expect(a).rejects.toThrow('failed'),expect(b).rejects.toThrow('failed')])
    reject(new Error('failed'));await failures
    const retry=c.readRecent!('k1',{limit:20}),failure=expect(retry).rejects.toThrow('failed')
    expect(readRecent).toHaveBeenCalledTimes(2);reject(new Error('failed'));await failure
  })
  it('同键并发只扫一次;TTL 内命中缓存;过期重扫;失败不缓存', async () => {
    let calls = 0, t = 0, fail = false
    const inner = sessions({ list: async () => { calls++; await new Promise(r => setTimeout(r, 10)); if (fail) throw new Error('x'); return { items: [], nextCursor: null, coverage: 'native_supported_history' } } })
    const c = cacheSessions(inner, { ttlMs: 1000, now: () => t })
    await Promise.all([c.list('claude', { q: '', limit: 30 }), c.list('claude', { q: '', limit: 30 })])
    expect(calls).toBe(1)
    await c.list('claude', { q: '', limit: 30 }); expect(calls).toBe(1)
    await c.list('codex', { q: '', limit: 30 }); expect(calls).toBe(2)
    t = 2000; fail = true
    await expect(c.list('claude', { q: '', limit: 30 })).rejects.toThrow(); expect(calls).toBe(3)
    await expect(c.list('claude', { q: '', limit: 30 })).rejects.toThrow(); expect(calls).toBe(4)
  })
  it('结果表有软上限:TTL 内一下来了很多不同的键 ⇒ 挤掉最旧的,不无限长;最近的仍命中', async () => {
    const loads: string[] = []
    const inner = sessions({ read: async key => { loads.push(key); return { session: { key, providerId: 'claude', title: 't', cwd: null, updatedAt: 0, observedState: 'idle' }, messages: [], nextCursor: null } as any } })
    const c = cacheSessions(inner, { ttlMs: 60_000, now: () => 0 })
    for (let i = 0; i < SESSIONS_DONE_MAX + 10; i++) await c.read(`k${i}`, { limit: 20 })
    expect(loads).toHaveLength(SESSIONS_DONE_MAX + 10)
    await c.read(`k${SESSIONS_DONE_MAX + 9}`, { limit: 20 })
    expect(loads).toHaveLength(SESSIONS_DONE_MAX + 10)   // 最近的还在
    await c.read('k0', { limit: 20 })
    expect(loads).toHaveLength(SESSIONS_DONE_MAX + 11)   // 最旧的被挤掉了 ⇒ 重扫
  })
  it('超预算后慢扫仍在跑:再来同键请求加入同一次扫描,不叠新的;总在途有上限', async () => {
    let calls = 0
    const never = sessions({ read: () => { calls++; return new Promise(() => {}) } })
    const c = cacheSessions(never, { maxInflight: 2 })
    void c.read('a', { limit: 20 }).catch(() => {}); void c.read('a', { limit: 20 }).catch(() => {})
    expect(calls).toBe(1)
    void c.read('b', { limit: 20 }).catch(() => {})
    await expect(c.read('c', { limit: 20 })).rejects.toThrow('busy')
    expect(calls).toBe(2)
  })
})

/** 旧中继线上真实大小:tunnel-client 的 {rid,status,body} 再 JSON 一次、封帧(base64url)、套 {stream,frame}。 */
async function legacyWireBytes(status: number, bodyText: string): Promise<number> {
  const a = await generateTunnelKeypair(), b = await generateTunnelKeypair()
  const key = await deriveSharedKey(a.privateKey, b.publicKey, new TextEncoder().encode('t'.repeat(43)))
  const reply = new TextEncoder().encode(JSON.stringify({ rid: 'r'.repeat(64), status, body: bodyText }))
  return Buffer.byteLength(JSON.stringify({ stream: 's'.repeat(64), frame: await sealFrame(key, reply) }), 'utf8')
}
const RELAY_FRAME_MAX = 512 * 1024

describe('旧中继帧大小(终审 M1):会话页 / 会话列表最坏情况也不超 512 KiB,不 413 整页', () => {
  for (const [name, ch] of [['汉字', '汉'], ['控制字符', '\u0001'], ['引号', '"']] as const) {
    it(`读一页 20 条 × 4000 个${name} ⇒ 服务端再截短(truncated),条数不少,线上 < 512 KiB`, async () => {
      const msgs = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, role: 'assistant' as const, text: ch.repeat(4000), truncated: false }))
      const read = async () => ({ session: ITEM, messages: msgs, nextCursor: 'n', sourceFingerprint: 'f', page: { limit: 20, cursor: null }, truncated: false })
      const d = sessions({ read, readRecent:read })
      for(const window of ['start','recent']){
        const url=new URL('http://x/m/api/session?key=k1&window='+window)
        const r = (await mobileReadsRoute({ sessions: d }, url, new Request(url)))!
        expect(r.status).toBe(200)
        const text = await r.text(),body = JSON.parse(text)
        expect(body.messages).toHaveLength(20);expect(body.window).toBe(window)
        expect(body.nextCursor).toBe('n')
        if (ch !== '汉') expect(body.messages.every((m: { truncated: boolean }) => m.truncated)).toBe(true)
        expect(await legacyWireBytes(200, text)).toBeLessThan(RELAY_FRAME_MAX)
        PHONE_API_SCHEMAS['GET /m/api/session']!.parse(body)
      }
    })
    it(`列表 30 行,标题与目录名全是${name} ⇒ 线上 < 512 KiB`, async () => {
      const items = Array.from({ length: 30 }, (_, i) => ({ ...ITEM, key: `k${i}`, title: ch.repeat(300), cwd: '/w/' + ch.repeat(4000) }))
      const d = sessions({ list: async () => ({ items, nextCursor: 'c', coverage: 'native_supported_history' }) })
      const r = (await mobileReadsRoute({ sessions: d }, new URL('http://x/m/api/sessions?provider=claude'), new Request('http://x/m/api/sessions?provider=claude')))!
      expect(r.status).toBe(200)
      const text = await r.text()
      expect(JSON.parse(text).items).toHaveLength(30)
      expect(await legacyWireBytes(200, text)).toBeLessThan(RELAY_FRAME_MAX)
    })
  }
})
