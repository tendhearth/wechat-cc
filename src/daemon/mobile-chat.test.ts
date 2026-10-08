import { describe, expect, it, vi } from 'vitest'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import { makePhoneChatId, makePhoneOwner, mobileChatRoute, type MobileChatDeps } from './mobile-chat'
import { deriveSharedKey, generateTunnelKeypair, sealFrame } from '../lib/tunnel-crypto'
import type { MessageRecord } from '../lib/messages-store'
import { openTestDb } from '../lib/db'
import { makeMatterStore } from '../core/matters/store'

const RID = '00000000-0000-4000-8000-000000000001'
const rec = (i: number, over: Partial<MessageRecord> = {}): MessageRecord => ({ id: `m${i}`, chatId: 'wx', ts: new Date(Date.UTC(2026, 8, 30, 0, 0, i)).toISOString(), direction: i % 2 ? 'out' : 'in', kind: 'text', text: `t${i}`, source: 'live', ...over })
function deps(over: Partial<MobileChatDeps> = {}): MobileChatDeps {
  return {
    owner: () => ({ matterId: 'c0ffee01', chatId: 'wx', title: '聊天' }),
    history: vi.fn(async (_c, o) => Array.from({ length: o.limit }, (_, i) => rec(i))),
    chat: { say: vi.fn(() => ({ requestId: RID, matterId: 'c0ffee01', text: 'hi', status: 'pending' as const, since: 1 })), state: () => ({ pending: null, failed: null }), pendingMatter: () => null },
    ...over,
  }
}
const get = (q = '') => new Request(`http://x/m/api/chat${q}`)
const post = (body: unknown) => new Request('http://x/m/api/chat/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const call = async (d: MobileChatDeps | undefined, r: Request) => { const res = await mobileChatRoute(d, new URL(r.url), r); return { status: res!.status, body: await res!.json() as any } }

describe('mobileChatRoute', () => {
  it('不是这两条路径 ⇒ null', async () => {
    expect(await mobileChatRoute(deps(), new URL('http://x/m/api/matters'), get())).toBeNull()
  })
  it('一页 30 条:多取一条判 hasMore,nextBefore 是本页最旧一条的原始 ts;过 schema', async () => {
    const d = deps()
    const r = await call(d, get())
    expect(d.history).toHaveBeenCalledWith('wx', { limit: 31 })
    expect(r.body.messages).toHaveLength(30)
    expect(r.body.hasMore).toBe(true)
    expect(r.body.nextBefore).toBe(rec(1).ts)
    expect(r.body.messages[0]).toMatchObject({ id: 'm1', role: 'cc', source: 'wechat', truncated: false })
    PHONE_API_SCHEMAS['GET /m/api/chat']!.parse(r.body)
  })
  it('before 原样传下去;不够一页 ⇒ hasMore false、nextBefore null', async () => {
    const d = deps({ history: vi.fn(async () => [rec(0), rec(1)]) })
    const r = await call(d, get('?before=2026-09-30T00%3A00%3A05.000Z&limit=10'))
    expect(d.history).toHaveBeenCalledWith('wx', { beforeTs: '2026-09-30T00:00:05.000Z', limit: 11 })
    expect(r.body).toMatchObject({ hasMore: false, nextBefore: null })
  })
  it('超长正文截到 4000 字并标 truncated;来源映射', async () => {
    const r = await call(deps({ history: async () => [rec(0, { text: 'x'.repeat(5000), source: 'phone' }), rec(1, { source: 'desktop' })] }), get())
    expect(r.body.messages[0].text).toHaveLength(4000)
    expect(r.body.messages[0]).toMatchObject({ truncated: true, source: 'phone', role: 'me' })
    expect(r.body.messages[1].source).toBe('desktop')
  })
  it('pending / failed 带出来但不带 matterId', async () => {
    const job = { requestId: RID, matterId: 'c0ffee01', text: 'hi', since: 1 }
    const r = await call(deps({ chat: { ...deps().chat, state: () => ({ pending: { ...job, status: 'pending' }, failed: { ...job, status: 'failed', error: 'busy' } }) } }), get())
    expect(r.body.pending).toEqual({ requestId: RID, text: 'hi', status: 'pending', since: 1 })
    expect(r.body.failed).toEqual({ requestId: RID, text: 'hi', status: 'failed', since: 1, error: 'busy' })
    PHONE_API_SCHEMAS['GET /m/api/chat']!.parse(r.body)
  })
  it('坏参数 ⇒ 400;没接 ⇒ 503;没主人 ⇒ 404;读历史失败 ⇒ 503', async () => {
    for (const q of ['?limit=0', '?limit=31', '?limit=x', '?before=nope', `?before=${'9'.repeat(70)}`]) expect((await call(deps(), get(q))).status).toBe(400)
    expect((await call(undefined, get())).status).toBe(503)
    expect((await call(deps({ owner: () => null }), get())).body).toEqual({ ok: false, error: 'no_owner_chat' })
    expect((await call(deps({ history: async () => { throw new Error('disk') } }), get())).status).toBe(503)
    expect((await call(deps(), new Request('http://x/m/api/chat', { method: 'POST' }))).status).toBe(405)
  })
  it('say:收下即回 job,过 schema;各种坏输入 400;chat_busy 409;GET 405', async () => {
    const d = deps()
    const ok = await call(d, post({ requestId: RID, text: 'hi' }))
    expect(ok.status).toBe(200)
    expect(d.chat.say).toHaveBeenCalledWith(RID, 'hi', undefined)
    PHONE_API_SCHEMAS['POST /m/api/chat/say']!.parse(ok.body)
    expect(ok.body.matterId).toBe('c0ffee01')
    expect(ok.body.job).not.toHaveProperty('matterId')
    for (const b of [{ requestId: 'x', text: 'hi' }, { requestId: RID, text: '  ' }, { requestId: RID, text: 'x'.repeat(20_001) }, { requestId: RID, text: 'hi', extra: 1 }, null, [], 'hi']) expect((await call(d, post(b))).status).toBe(400)
    const busy = deps({ chat: { ...deps().chat, say: () => { throw new Error('chat_busy') } } })
    expect((await call(busy, post({ requestId: RID, text: 'hi' }))).status).toBe(409)
    const conflict = await call(deps({ chat: { ...deps().chat, say: () => { throw new Error('input_conflict') } } }), post({ requestId: RID, text: 'hi' }))
    expect(conflict.status).toBe(409)
    expect(conflict.body.error).toBe('input_conflict')
    expect((await call(d, new Request('http://x/m/api/chat/say'))).status).toBe(405)
  })
  it('say 带图(2026-10-06):draftId + attachmentIds 传下去;有图时文字可空;坏引用 400;取图失败 409 invalid_attachment', async () => {
    const D = '11111111-1111-4111-8111-111111111111', A = '22222222-2222-4222-8222-22222222222A'
    const d = deps()
    expect((await call(d, post({ requestId: RID, text: '', draftId: D, attachmentIds: [A] }))).status).toBe(200)
    expect(d.chat.say).toHaveBeenCalledWith(RID, '', { draftId: D, attachmentIds: [A.toLowerCase()] })
    for (const b of [
      { requestId: RID, text: '', draftId: D, attachmentIds: [] },
      { requestId: RID, text: 'hi', attachmentIds: [A] },
      { requestId: RID, text: 'hi', draftId: D },
      { requestId: RID, text: 'hi', draftId: 'x', attachmentIds: [A] },
      { requestId: RID, text: 'hi', draftId: D, attachmentIds: ['nope'] },
      { requestId: RID, text: 'hi', draftId: D, attachmentIds: [A, A] },
      { requestId: RID, text: 'hi', draftId: D, attachmentIds: Array.from({ length: 5 }, (_, i) => `22222222-2222-4222-8222-00000000000${i}`) },
    ]) expect((await call(d, post(b))).status, JSON.stringify(b)).toBe(400)
    const gone = await call(deps({ chat: { ...deps().chat, say: () => { throw new Error('attachment_scope') } } }), post({ requestId: RID, text: 'hi', draftId: D, attachmentIds: [A] }))
    expect(gone).toEqual({ status: 409, body: { ok: false, error: 'invalid_attachment' } })
  })
  it('say:没主人 404;没接 503;内部意外 ⇒ 503 unavailable(Ruling 7,不是 500)', async () => {
    const noOwner = deps({ chat: { ...deps().chat, say: () => { throw new Error('no_owner_chat') } } })
    expect((await call(noOwner, post({ requestId: RID, text: 'hi' }))).status).toBe(404)
    expect((await call(undefined, post({ requestId: RID, text: 'hi' }))).status).toBe(503)
    const boom = await call(deps({ chat: { ...deps().chat, say: () => { throw new Error('disk on fire') } } }), post({ requestId: RID, text: 'hi' }))
    expect(boom).toEqual({ status: 503, body: { ok: false, error: 'unavailable' } })
  })
})

describe('makePhoneOwner(Ruling 3:读只查不写,说才登记)', () => {
  it('peek 只读:没有 chat matter ⇒ null 且不建;有 ⇒ 返回,不刷新任何露面时间', () => {
    let clock = 1_000
    const store = makeMatterStore(openTestDb(), () => clock)
    const owner = makePhoneOwner({ ownerChatId: () => 'wx', matters: store })
    expect(owner.peek()).toBeNull()
    expect(store.list()).toEqual([])
    const m = store.ensureChat('wx'); clock = 5_000
    expect(owner.peek()).toEqual({ matterId: m.id, chatId: 'wx', title: m.title })
    expect(store.bindings(m.id)).toEqual([{ matterId: m.id, surface: 'wechat', surfaceKey: 'wx', lastSeenAt: 1_000 }])
  })
  it('ensure 建 / 找 chat matter 并登记手机露面;没主人 ⇒ null', () => {
    const store = makeMatterStore(openTestDb(), () => 7)
    expect(makePhoneOwner({ ownerChatId: () => null, matters: store }).ensure()).toBeNull()
    const id = makePhoneOwner({ ownerChatId: () => 'wx', matters: store }).ensure()!
    expect(store.bindings(id).map(b => b.surface).sort()).toEqual(['phone', 'wechat'])
  })
})

/** 旧中继线上真实大小:tunnel-client 的 {rid,status,body} 再 JSON 一次、封帧(base64url)、套 {stream,frame}。 */
async function legacyWireBytes(res: Response): Promise<number> {
  const a = await generateTunnelKeypair(), b = await generateTunnelKeypair()
  const key = await deriveSharedKey(a.privateKey, b.publicKey, new TextEncoder().encode('t'.repeat(43)))
  const reply = new TextEncoder().encode(JSON.stringify({ rid: 'r'.repeat(64), status: res.status, body: await res.text() }))
  return Buffer.byteLength(JSON.stringify({ stream: 's'.repeat(64), frame: await sealFrame(key, reply) }), 'utf8')
}
const RELAY_FRAME_MAX = 512 * 1024

describe('旧中继帧大小(终审 M1):一页整页不能超过 512 KiB,也不能 413 整页', () => {
  const worst = (text: string) => vi.fn(async (_c: string, o: { limit: number }) => Array.from({ length: o.limit }, (_, i) => rec(i, { text })))
  for (const [name, text] of [['4000 个汉字', '汉'.repeat(4000)], ['控制字符(转义两次最胀)', '\u0001'.repeat(4000)], ['引号', '"'.repeat(4000)]] as const) {
    it(`每条 ${name} ⇒ 少给几条(hasMore、nextBefore 指向本页最旧那条),线上 < 512 KiB`, async () => {
      const d = deps({ history: worst(text) })
      const res = (await mobileChatRoute(d, new URL('http://x/m/api/chat'), get()))!
      expect(res.status).toBe(200)
      const body = await res.clone().json() as any
      expect(body.messages.length).toBeGreaterThan(0)
      expect(body.messages.length).toBeLessThan(30)
      expect(body.hasMore).toBe(true)
      // 下一页从本页最旧那条往前接:不留洞
      expect(body.nextBefore).toBe(rec(31 - body.messages.length).ts)
      expect(body.messages[0].id).toBe(`m${31 - body.messages.length}`)
      expect(await legacyWireBytes(res)).toBeLessThan(RELAY_FRAME_MAX)
      PHONE_API_SCHEMAS['GET /m/api/chat']!.parse(body)
    })
  }
  it('普通大小的一页照旧 30 条', async () => {
    const r = await call(deps(), get())
    expect(r.body.messages).toHaveLength(30)
  })
})

describe('makePhoneChatId(Task 4:default_chat_id 不是主人 ⇒ 手机对话停用,且日志说一声)', () => {
  it('不一致 ⇒ null,只在状态切换时各记一行', () => {
    const logs: string[] = []
    let conv: string | null = 'other'
    const id = makePhoneChatId({ ownerChatId: () => 'wx', converseChatId: () => conv, log: (_t, l) => logs.push(l) })
    expect(id()).toBeNull(); expect(id()).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('default_chat_id')
    expect(logs[0]).not.toContain('other')   // 不记 chat id
    conv = 'wx'
    expect(id()).toBe('wx'); expect(id()).toBe('wx')
    expect(logs).toHaveLength(2)
    conv = null
    expect(id()).toBe('wx')
    expect(logs).toHaveLength(2)
    conv = 'other'
    expect(id()).toBeNull()
    expect(logs).toHaveLength(3)
  })
  it('没主人 ⇒ null,不记日志', () => {
    const logs: string[] = []
    expect(makePhoneChatId({ ownerChatId: () => null, converseChatId: () => 'x', log: (_t, l) => logs.push(l) })()).toBeNull()
    expect(logs).toEqual([])
  })
})

describe('GET /m/api/chat/search (2026-10-06)', () => {
  it('searches the owner chat, trims long hits for one frame, and passes the schema', async () => {
    const long = 'x'.repeat(700)
    const search = vi.fn(async () => [rec(1, { text: long }), rec(2, { text: '季度报告' })])
    const r = await call(deps({ search }), get('/search?q=%20%E5%AD%A3%E5%BA%A6%20'))
    expect(search).toHaveBeenCalledWith('wx', '季度', 30)
    expect(r.status).toBe(200)
    expect(r.body.hits[0]).toMatchObject({ id: 'm1', role: 'cc', truncated: true })
    expect(r.body.hits[0].text).toHaveLength(600)
    expect(r.body.hits[1]).toMatchObject({ role: 'me', text: '季度报告', truncated: false })
    PHONE_API_SCHEMAS['GET /m/api/chat/search']!.parse(r.body)
  })
  it('empty / huge / repeated q ⇒ 400; no owner ⇒ 404; not wired ⇒ 503', async () => {
    const search = vi.fn(async () => [])
    for (const q of ['', '?q=', '?q=%20', `?q=${'x'.repeat(201)}`, '?q=a&q=b']) expect((await call(deps({ search }), get('/search' + q))).status).toBe(400)
    expect((await call(deps({ search, owner: () => null }), get('/search?q=a'))).status).toBe(404)
    expect((await call(deps(), get('/search?q=a'))).status).toBe(503)
    expect(search).not.toHaveBeenCalled()
  })
})

describe('GET /m/api/chat/file (2026-10-06)', () => {
  it('serves a file CC attached to its own reply, in 128 KiB chunks with a whole-file sha256; never a path from the phone', async () => {
    const { mkdtempSync, writeFileSync, symlinkSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createHash } = await import('node:crypto')
    const dir = mkdtempSync(join(tmpdir(), 'chat-file-'))
    const bytes = Buffer.alloc(200 * 1024, 7); const path = join(dir, '报告.pdf'); writeFileSync(path, bytes)
    const link = join(dir, 'link.pdf'); symlinkSync(path, link)
    const extras = (p: string) => JSON.stringify({ attachments: [{ kind: 'voice', text: 'x' }, { kind: 'file', name: '报告.pdf', path: p }], narration: [] })
    const rows: Record<string, MessageRecord> = {
      out: rec(1, { id: 'out', direction: 'out', extras: extras(path) } as never),
      mine: rec(2, { id: 'mine', direction: 'in', extras: extras(path) } as never),
      linked: rec(3, { id: 'linked', direction: 'out', extras: extras(link) } as never),
    }
    const d = deps({ message: async (_c: string, id: string) => rows[id] ?? null })
    const first = await call(d, get('/file?id=out&i=1'))
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ name: '报告.pdf', mime: 'application/pdf', size: bytes.length, offset: 0, nextOffset: 128 * 1024, sha256: createHash('sha256').update(bytes).digest('hex') })
    PHONE_API_SCHEMAS['GET /m/api/chat/file']!.parse(first.body)
    const second = await call(d, get(`/file?id=out&i=1&offset=${128 * 1024}`))
    expect(second.body.nextOffset).toBe(bytes.length)
    expect(Buffer.from(first.body.contentBase64 + '', 'base64').length + Buffer.from(second.body.contentBase64, 'base64').length).toBe(bytes.length)
    expect((await call(d, get('/file?id=out&i=0'))).status).toBe(404)      // 第 0 个是语音,不是文件
    expect((await call(d, get('/file?id=mine&i=1'))).status).toBe(404)     // 不是 CC 发的那一行
    expect((await call(d, get('/file?id=linked&i=1'))).status).toBe(404)   // 符号链接不跟
    for (const q of ['/file?id=out', '/file?id=out&i=x', '/file?id=out&i=1&offset=-1', `/file?id=out&i=1&offset=${bytes.length + 1}`]) expect((await call(d, get(q))).status).toBe(400)
  })
})

describe('/m/api/chat/model (2026-10-06)', () => {
  const postModel = (body: unknown) => new Request('http://x/m/api/chat/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  function modelDeps() {
    let pin: { provider: string; model: string | null } | null = null
    const calls: Array<[string, string, string | null]> = []
    const d = deps({ model: {
      current: () => ({ mode: 'solo', provider: pin?.provider ?? 'claude', model: pin?.model ?? null, globalModel: 'claude-opus-5-5', providers: [{ id: 'claude', name: 'Claude' }, { id: 'openai', name: 'API' }] }),
      set: (chatId, provider, model) => { calls.push([chatId, provider, model]); pin = { provider, model } },
    } })
    return { d, calls }
  }
  it('reads the owner chat model and pins provider + model for that chat only', async () => {
    const { d, calls } = modelDeps()
    const read = await call(d, get('/model'))
    expect(read.status).toBe(200)
    PHONE_API_SCHEMAS['GET /m/api/chat/model']!.parse(read.body)
    expect(read.body).toMatchObject({ provider: 'claude', model: null, globalModel: 'claude-opus-5-5' })
    const set = await call(d, postModel({ provider: 'openai', model: 'DeepSeek-V4' }))
    expect(set.status).toBe(200)
    expect(set.body).toMatchObject({ provider: 'openai', model: 'DeepSeek-V4' })
    PHONE_API_SCHEMAS['POST /m/api/chat/model']!.parse(set.body)
    expect(calls.at(-1)![1]).toBe('openai')
    await call(d, postModel({ provider: 'claude', model: null }))
    expect(calls.at(-1)!.slice(1)).toEqual(['claude', null])
    expect((await call(d, postModel({ provider: 'claude', model: 'claude-opus-5-5[1m]' }))).status).toBe(200)
  })
  it('rejects unknown providers, bad model names and extra fields; 503 when not wired', async () => {
    const { d, calls } = modelDeps()
    expect((await call(d, postModel({ provider: 'nope' }))).body).toMatchObject({ error: 'unknown_provider' })
    for (const body of [{ provider: 'claude', model: 'has space' }, { provider: 'claude', model: '' }, { provider: 'claude', model: 'x'.repeat(121) }, { provider: 'claude', extra: 1 }, { model: 'm1' }])
      expect((await call(d, postModel(body))).status).toBe(400)
    expect(calls).toEqual([])
    expect((await call(deps(), get('/model'))).status).toBe(503)
  })
})
