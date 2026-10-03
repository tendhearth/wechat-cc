import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { turnRoutes } from './routes-turn'
import { minTierFor } from './route-tiers'
import { SEND_SCOPED_ROUTES, ALL_CHATS } from './send-scope'
import { makeReplyDeliveryRuntime } from '../reply-delivery'
import type { InternalApiDeps, RouteTable } from './types'

const q = new URLSearchParams()
const admin = (chatId = 'owner') => ({ tier: 'admin' as const, origin: 'session' as const, chatId })
const guest = (chatId = 'g1') => ({ tier: 'guest' as const, origin: 'session' as const, chatId })

function setup(over: Partial<InternalApiDeps> = {}, table: RouteTable = {}) {
  const sent: Array<[string, string]> = []
  const rt = makeReplyDeliveryRuntime({
    sendText: async (c, t) => { sent.push([c, t]); return { msgId: `m${sent.length}` } },
    sleep: async () => {},
    log: () => {},
  })
  const deps = {
    replyDelivery: rt,
    ilink: {
      sendReply: vi.fn(async (_c: string, _t: string) => ({ msgId: 'sent:1' })),
      sendFile: vi.fn(async () => {}),
      editMessage: vi.fn(async () => {}),
      broadcast: vi.fn(async () => ({ ok: true, sent: 3 })),
    },
    voice: { replyVoice: vi.fn(async () => ({ ok: true as const, msgId: 'v1' })) },
    stickers: { resolve: (tag: string) => tag === '庆祝' ? '/lib/庆祝.gif' : null, allTags: () => ['庆祝'] },
    resolveAdminChatId: () => 'owner',
    ...over,
  } as unknown as InternalApiDeps
  const routes = turnRoutes(deps, () => table)
  return { routes, rt, sent, deps }
}

describe('POST /v1/turn/attach — 附件登记到本轮(spec §4.5)', () => {
  it('route tier:guest 可用(语音 / 表情和 reply 同级;文件在 handler 里再收紧)', () => {
    expect(minTierFor('POST /v1/turn/attach')).toBe('guest')
  })

  it('没有开着的轮 ⇒ ok:false,明说什么都没附上', async () => {
    const t = setup()
    const r = await t.routes['POST /v1/turn/attach']!(q, { kind: 'voice', text: '晚安' }, admin())
    expect(r.body).toMatchObject({ ok: false })
    expect(JSON.stringify(r.body)).toContain('no_turn_in_progress')
  })

  it('目标永远是本轮的聊天(会话令牌里的 chat),不收 chat_id', async () => {
    const t = setup()
    const h = t.rt.begin('owner', { mode: 'daemon', context: 'dm', providerId: 'openai' })
    const r = await t.routes['POST /v1/turn/attach']!(q, { kind: 'voice', text: '晚安' }, admin('owner'))
    expect(r.body).toEqual({ ok: true, attached: true })
    await h.deliver({ finalText: '', narration: [] })
    expect((t.deps.voice as any).replyVoice).toHaveBeenCalledWith('owner', '晚安')
  })

  it('不是会话令牌(读不出 chat)⇒ 400', async () => {
    const t = setup()
    const r = await t.routes['POST /v1/turn/attach']!(q, { kind: 'voice', text: 'x' }, { tier: 'admin', origin: 'file' })
    expect(r.status).toBe(400)
  })

  it('语音 > 500 字 ⇒ 当场拒(too_long),不登记', async () => {
    const t = setup()
    t.rt.begin('owner', { mode: 'daemon', context: 'dm', providerId: 'openai' })
    const r = await t.routes['POST /v1/turn/attach']!(q, { kind: 'voice', text: 'a'.repeat(501) }, admin())
    expect(r.body).toMatchObject({ ok: false, reason: 'too_long', limit: 500 })
  })

  it('本地表情 tag 不存在 ⇒ 当场拒并给出可用 tags', async () => {
    const t = setup()
    t.rt.begin('owner', { mode: 'daemon', context: 'dm', providerId: 'openai' })
    const r = await t.routes['POST /v1/turn/attach']!(q, { kind: 'sticker', tag: '不存在' }, admin())
    expect(r.body).toMatchObject({ ok: false, reason: 'no_sticker_for_tag', tags: ['庆祝'] })
  })

  it('表情在交付时走原来的 send_sticker 路由(冷却 / 记偏好原样复用)', async () => {
    const sendSticker = vi.fn(async () => ({ status: 200, body: { ok: true, file: '庆祝.gif' } }))
    const t = setup({}, { 'POST /v1/wechat/send_sticker': sendSticker })
    const h = t.rt.begin('owner', { mode: 'daemon', context: 'dm', providerId: 'openai' })
    expect((await t.routes['POST /v1/turn/attach']!(q, { kind: 'sticker', tag: '庆祝' }, admin())).body).toEqual({ ok: true, attached: true })
    const report = await h.deliver({ finalText: '恭喜恭喜上线成功', narration: [] })
    expect(sendSticker).toHaveBeenCalledWith(expect.anything(), { chat_id: 'owner', tag: '庆祝' }, undefined)
    expect(report.attachmentsSent).toBe(1)
  })

  it('联网候选(mood + url)走 send_online_sticker_candidate;mood + query 走 search_online_sticker', async () => {
    const cand = vi.fn(async () => ({ status: 200, body: { ok: true } }))
    const search = vi.fn(async () => ({ status: 200, body: { ok: true } }))
    const t = setup({}, { 'POST /v1/wechat/send_online_sticker_candidate': cand, 'POST /v1/wechat/search_online_sticker': search })
    const h = t.rt.begin('owner', { mode: 'daemon', context: 'dm', providerId: 'openai' })
    await t.routes['POST /v1/turn/attach']!(q, { kind: 'sticker', mood: '开心', id: 'g1', url: 'https://media.giphy.com/x.gif' }, admin())
    await t.routes['POST /v1/turn/attach']!(q, { kind: 'sticker', mood: '开心', query: 'happy dance' }, admin())
    await h.deliver({ finalText: '', narration: [] })
    expect(cand).toHaveBeenCalledWith(expect.anything(), { chat_id: 'owner', mood: '开心', id: 'g1', url: 'https://media.giphy.com/x.gif' }, undefined)
    expect(search).toHaveBeenCalledWith(expect.anything(), { chat_id: 'owner', mood: '开心', query: 'happy dance' }, undefined)
  })

  it('文件:guest 不行(与 send_file 的 trusted 门同级);trusted+ 可以,交付时 sendFile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-attach-'))
    try {
      const f = join(dir, 'a.pdf'); writeFileSync(f, 'x')
      const t = setup()
      t.rt.begin('g1', { mode: 'daemon', context: 'dm', providerId: 'openai' })
      expect((await t.routes['POST /v1/turn/attach']!(q, { kind: 'file', path: f }, guest())).body).toMatchObject({ ok: false, error: 'forbidden' })
      const h = t.rt.begin('owner', { mode: 'daemon', context: 'dm', providerId: 'openai' })
      expect((await t.routes['POST /v1/turn/attach']!(q, { kind: 'file', path: f }, admin())).body).toEqual({ ok: true, attached: true })
      await h.deliver({ finalText: '文件在这里了请查收', narration: [] })
      expect((t.deps.ilink as any).sendFile).toHaveBeenCalledWith('owner', f)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('文件不存在 / 不是绝对路径 ⇒ 当场拒', async () => {
    const t = setup()
    t.rt.begin('owner', { mode: 'daemon', context: 'dm', providerId: 'openai' })
    expect((await t.routes['POST /v1/turn/attach']!(q, { kind: 'file', path: 'rel.txt' }, admin())).body).toMatchObject({ ok: false })
    expect((await t.routes['POST /v1/turn/attach']!(q, { kind: 'file', path: '/no/such/file' }, admin())).body).toMatchObject({ ok: false })
  })

  it('kind 不认识 ⇒ 400', async () => {
    const t = setup()
    expect((await t.routes['POST /v1/turn/attach']!(q, { kind: 'video' }, admin())).status).toBe(400)
  })
})

describe('POST /v1/wechat/message — admin 往别处发(spec §4.6)', () => {
  it('route tier:admin;发送范围门按 to 判(broadcast = 所有人)', () => {
    expect(minTierFor('POST /v1/wechat/message')).toBe('admin')
    const scope = SEND_SCOPED_ROUTES['POST /v1/wechat/message']!
    expect(scope({ to: 'broadcast', text: 'x' })).toBe(ALL_CHATS)
    expect(scope({ to: 'c9', text: 'x' })).toBe('c9')
    expect(scope({ to: 'owner', text: 'x' })).toBe(null)
  })

  it('发给别的 chat', async () => {
    const t = setup()
    const r = await t.routes['POST /v1/wechat/message']!(q, { to: 'guest-1', text: '主人让我告诉你:明天见' }, admin('owner'))
    expect(r.body).toMatchObject({ ok: true })
    expect((t.deps.ilink as any).sendReply).toHaveBeenCalledWith('guest-1', '主人让我告诉你:明天见')
  })

  it('to 等于本轮聊天 ⇒ 报错:本轮要说的话直接写在最后', async () => {
    const t = setup()
    const r = await t.routes['POST /v1/wechat/message']!(q, { to: 'owner', text: '你好' }, admin('owner'))
    expect(r.body).toMatchObject({ ok: false })
    expect(JSON.stringify(r.body)).toContain('message_to_own_chat')
    expect((t.deps.ilink as any).sendReply).not.toHaveBeenCalled()
  })

  it("to='owner' 解析成主人的聊天;发给主人的话记一笔给交付去重", async () => {
    const t = setup()
    const h = t.rt.begin('other-chat', { mode: 'daemon', context: 'dm', providerId: 'openai' })
    await t.routes['POST /v1/wechat/message']!(q, { to: 'owner', text: '会议改到明天下午三点' }, admin('other-chat'))
    expect((t.deps.ilink as any).sendReply).toHaveBeenCalledWith('owner', '会议改到明天下午三点')
    const report = await h.deliver({ finalText: '会议改到明天下午三点', narration: [] })
    expect(report.deduped).toBe(true)
  })

  it("to='broadcast' ⇒ 群发", async () => {
    const t = setup()
    await t.routes['POST /v1/wechat/message']!(q, { to: 'broadcast', text: '维护通知', account_id: 'a1' }, admin('owner'))
    expect((t.deps.ilink as any).broadcast).toHaveBeenCalledWith('维护通知', 'a1')
  })

  it('空文字 ⇒ ok:false,什么都没发', async () => {
    const t = setup()
    const r = await t.routes['POST /v1/wechat/message']!(q, { to: 'c9', text: '  ' }, admin('owner'))
    expect(r.body).toMatchObject({ ok: false })
  })
})
