import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInternalApi, type InternalApi, type InternalApiDeps } from '../internal-api'
import { makeReplySinks } from '../reply-sinks'
import { makeRoutes, makeMaybePrefix } from './routes'
import { ALL_CHATS, SEND_SCOPED_ROUTES, sendScopeDenial } from './send-scope'
import { minTierFor } from './route-tiers'

/**
 * 发送类路由的 chat 范围门(send-scope.ts)。确认过的安全 bug:这些路由从请求体拿
 * chat_id,从不和调用方会话自己的 chat 比 —— 任何会话(包括 guest)都能以 CC 的
 * 身份给任意 chat 发消息。
 */

describe('sendScopeDenial (pure rule)', () => {
  const guest = { tier: 'guest' as const, origin: 'session' as const, chatId: 'g1', sessionKey: 'claude/a/g1' }
  const trusted = { tier: 'trusted' as const, origin: 'session' as const, chatId: 't1', sessionKey: 'claude/a/t1' }
  const admin = { tier: 'admin' as const, origin: 'session' as const, chatId: 'owner', sessionKey: 'claude/a/owner' }

  it('session callers of every tier may target their own chat', () => {
    expect(sendScopeDenial('g1', guest)).toBeNull()
    expect(sendScopeDenial('t1', trusted)).toBeNull()
    expect(sendScopeDenial('owner', admin)).toBeNull()
  })
  it('session callers of every tier are denied another chat (admin too — no feature relies on it)', () => {
    expect(sendScopeDenial('owner', guest)).toMatch(/chat_scope/)
    expect(sendScopeDenial('owner', trusted)).toMatch(/chat_scope/)
    expect(sendScopeDenial('g1', admin)).toMatch(/chat_scope/)
  })
  it('broadcast: only admin sessions', () => {
    expect(sendScopeDenial(ALL_CHATS, guest)).toMatch(/chat_scope/)
    expect(sendScopeDenial(ALL_CHATS, trusted)).toMatch(/chat_scope/)
    expect(sendScopeDenial(ALL_CHATS, admin)).toBeNull()
  })
  it('a session whose sessionKey yields no chat is denied (fail closed)', () => {
    expect(sendScopeDenial('x', { tier: 'trusted', origin: 'session', chatId: '', sessionKey: 'odd' })).toMatch(/chat_scope/)
    expect(sendScopeDenial('x', { tier: 'admin', origin: 'session' })).toMatch(/chat_scope/)
  })
  it('agy-static (shared across every agy conversation, no own chat) keeps current behaviour', () => {
    const agy = { tier: 'trusted' as const, origin: 'session' as const, chatId: '', sessionKey: 'agy-static' }
    expect(sendScopeDenial('anyone', agy)).toBeNull()
    expect(sendScopeDenial(ALL_CHATS, agy)).toBeNull()
  })
  it('file / operator tokens are unrestricted', () => {
    expect(sendScopeDenial('anyone', { tier: 'trusted', origin: 'file' })).toBeNull()
    expect(sendScopeDenial(ALL_CHATS, { tier: 'trusted', origin: 'file' })).toBeNull()
    expect(sendScopeDenial('anyone', { tier: 'admin', origin: 'operator' })).toBeNull()
  })
  it('a request that names no chat is not gated', () => {
    expect(sendScopeDenial(null, guest)).toBeNull()
  })
})

describe('SEND_SCOPED_ROUTES registry', () => {
  it('every scoped key is a real route', () => {
    const routes = makeRoutes({ deps: { stateDir: '/tmp/x', daemonPid: 1 } as InternalApiDeps, getDelegate: () => null, maybePrefix: makeMaybePrefix({} as InternalApiDeps) })
    for (const key of Object.keys(SEND_SCOPED_ROUTES)) expect(routes[key], key).toBeTypeOf('function')
  })
  it('every route that takes a chat_id and is reachable below admin is scoped (or explicitly exempted)', () => {
    // 以 chat 为目标、guest/trusted 够得着的路由。新加一条往 chat 发消息的路由,
    // 要么进 SEND_SCOPED_ROUTES,要么在这里写明为什么豁免。
    const EXEMPT: Record<string, string> = {
      'POST /v1/user/set_name': '只改显示名记忆,不发消息(trusted)',
      'POST /v1/chat-prefs': '只改 care/split 偏好,不发消息(trusted)',
      'POST /v1/memory/delete': 'chat_id 只用于审计事件;路径由 memoryScopeDenied 管',
      'POST /v1/reminders/schedule': 'routes-reminders.ts 自己按会话 chat 限',
      'POST /v1/reminders/cancel': '同上',
      'GET /v1/reminders/list': '同上',
    }
    const chatRoutes = [
      'POST /v1/wechat/reply', 'POST /v1/wechat/reply_voice', 'POST /v1/wechat/send_file',
      'POST /v1/wechat/edit_message', 'POST /v1/wechat/broadcast', 'POST /v1/wechat/send_sticker',
      'POST /v1/wechat/search_online_sticker', 'POST /v1/wechat/send_online_sticker_candidate',
      'POST /v1/wechat/sticker_feedback', 'POST /v1/share/page', 'POST /v1/conversation/set-mode',
      ...Object.keys(EXEMPT),
    ]
    for (const key of chatRoutes) {
      expect(minTierFor(key) !== 'admin', `${key} is reachable below admin`).toBe(true)
      expect(key in SEND_SCOPED_ROUTES || key in EXEMPT, key).toBe(true)
    }
  })
})

describe('send routes over HTTP — chat scope', () => {
  let stateDir: string
  let api: InternalApi | null = null
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'send-scope-')) })
  afterEach(async () => {
    if (api) await api.stop()
    api = null
    rmSync(stateDir, { recursive: true, force: true })
  })

  function mocks() {
    const sendReply = vi.fn(async (_c: string, _t: string) => ({ msgId: 'm1' }))
    const sendFile = vi.fn(async (_c: string, _p: string) => {})
    const editMessage = vi.fn(async (_c: string, _m: string, _t: string) => {})
    const broadcast = vi.fn(async (_t: string, _a?: string) => ({ ok: 2, failed: 0 }))
    const replyVoice = vi.fn(async (_c: string, _t: string) => ({ ok: true as const, msgId: 'v1' }))
    const stickerResolve = vi.fn((_tag: string, _chat?: string) => '/abs/happy.png')
    const feedbackRate = vi.fn(() => 'happy.png')
    const sharePage = vi.fn(async () => ({ url: 'https://x/p', slug: 'p' }))
    const setMode = vi.fn()
    return { sendReply, sendFile, editMessage, broadcast, replyVoice, stickerResolve, feedbackRate, sharePage, setMode }
  }
  type Mocks = ReturnType<typeof mocks>

  async function boot(m: Mocks, extra: Partial<InternalApiDeps> = {}) {
    api = createInternalApi({
      stateDir, daemonPid: 1,
      ilink: { sendReply: m.sendReply, sendFile: m.sendFile, editMessage: m.editMessage, broadcast: m.broadcast },
      voice: {
        replyVoice: m.replyVoice,
        saveConfig: async () => ({ ok: false, reason: 'unused' }),
        configStatus: () => ({ configured: false }),
        synthesizeSpeech: async () => { throw new Error('unused') },
      },
      stickers: { resolve: m.stickerResolve, save: vi.fn(), list: vi.fn(() => []), allTags: vi.fn(() => ['happy']) },
      stickerFeedback: { rate: m.feedbackRate, remember: vi.fn() },
      sharePage: m.sharePage,
      conversation: { setMode: m.setMode },
      ...extra,
    } as unknown as InternalApiDeps)
    const { port, tokenFilePath } = await api.start()
    return { port, fileToken: readFileSync(tokenFilePath, 'utf8').trim() }
  }

  async function post(port: number, token: string, path: string, body: unknown) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: r.status, body: await r.json() as Record<string, unknown> }
  }

  function nothingSent(m: Mocks) {
    expect(m.sendReply).not.toHaveBeenCalled()
    expect(m.sendFile).not.toHaveBeenCalled()
    expect(m.editMessage).not.toHaveBeenCalled()
    expect(m.broadcast).not.toHaveBeenCalled()
    expect(m.replyVoice).not.toHaveBeenCalled()
    expect(m.feedbackRate).not.toHaveBeenCalled()
    expect(m.sharePage).not.toHaveBeenCalled()
    expect(m.setMode).not.toHaveBeenCalled()
  }

  // 每条被门住的路由,用「别的 chat」与「自己的 chat」各打一次。guest 够得着的路由才用 guest。
  const CASES: Array<{ path: string; tier: 'guest' | 'trusted'; body: (chat: string) => Record<string, unknown> }> = [
    { path: '/v1/wechat/reply', tier: 'guest', body: c => ({ chat_id: c, text: 'hi' }) },
    { path: '/v1/wechat/reply_voice', tier: 'guest', body: c => ({ chat_id: c, text: 'hi' }) },
    { path: '/v1/wechat/send_sticker', tier: 'guest', body: c => ({ chat_id: c, tag: 'happy' }) },
    { path: '/v1/wechat/sticker_feedback', tier: 'guest', body: c => ({ chat_id: c, signal: 'positive' }) },
    { path: '/v1/share/page', tier: 'guest', body: c => ({ title: 't', content: 'c', chat_id: c }) },
    { path: '/v1/wechat/search_online_sticker', tier: 'guest', body: c => ({ chat_id: c, mood: 'happy', query: 'q' }) },
    { path: '/v1/wechat/send_online_sticker_candidate', tier: 'guest', body: c => ({ chat_id: c, mood: 'happy', id: 'x', url: 'https://media.giphy.com/x.gif' }) },
    { path: '/v1/wechat/send_file', tier: 'trusted', body: c => ({ chat_id: c, path: '/abs/x.pdf' }) },
    { path: '/v1/wechat/edit_message', tier: 'trusted', body: c => ({ chat_id: c, msg_id: 'm0', text: 'e' }) },
    { path: '/v1/conversation/set-mode', tier: 'trusted', body: c => ({ chatId: c, mode: { kind: 'solo', provider: 'claude' } }) },
  ]

  for (const tc of CASES) {
    it(`${tc.tier} session → ANOTHER chat on ${tc.path} ⇒ 403 chat_scope, nothing sent, target not echoed`, async () => {
      const m = mocks()
      const { port } = await boot(m)
      const tok = api!.mintSessionToken(tc.tier, 'claude/a/my-chat')
      const r = await post(port, tok, tc.path, tc.body('victim@im.wechat'))
      expect(r.status).toBe(403)
      expect(r.body.error).toBe('chat_scope')
      expect(String(r.body.message)).toMatch(/nothing was sent/)
      expect(JSON.stringify(r.body)).not.toContain('victim')
      nothingSent(m)
    })
  }

  it('the denial is logged (event chat_scope_denied)', async () => {
    const m = mocks()
    const log = vi.fn()
    const { port } = await boot(m, { log })
    const tok = api!.mintSessionToken('guest', 'claude/a/my-chat')
    await post(port, tok, '/v1/wechat/reply', { chat_id: 'victim', text: 'hi' })
    const ev = log.mock.calls.find(c => (c[2] as { event?: string } | undefined)?.event === 'chat_scope_denied')
    expect(ev).toBeTruthy()
    expect(ev![2]).toMatchObject({ path: 'POST /v1/wechat/reply', caller: 'guest', origin: 'session' })
  })

  it('guest session → own chat: reply / reply_voice / send_sticker go through', async () => {
    const m = mocks()
    const { port } = await boot(m)
    const tok = api!.mintSessionToken('guest', 'claude/a/g@im.wechat')
    expect((await post(port, tok, '/v1/wechat/reply', { chat_id: 'g@im.wechat', text: 'hi' })).body).toEqual({ ok: true, msg_id: 'm1' })
    expect(m.sendReply).toHaveBeenCalledWith('g@im.wechat', 'hi')
    expect((await post(port, tok, '/v1/wechat/reply_voice', { chat_id: 'g@im.wechat', text: 'hi' })).status).toBe(200)
    expect(m.replyVoice).toHaveBeenCalledWith('g@im.wechat', 'hi')
    expect((await post(port, tok, '/v1/wechat/send_sticker', { chat_id: 'g@im.wechat', tag: 'happy' })).body).toMatchObject({ ok: true })
    expect(m.sendFile).toHaveBeenCalledWith('g@im.wechat', '/abs/happy.png')
  })

  it('trusted session → own chat: send_file / edit_message / set-mode go through', async () => {
    const m = mocks()
    const { port } = await boot(m)
    const tok = api!.mintSessionToken('trusted', 'codex/a/t@im.wechat')
    expect((await post(port, tok, '/v1/wechat/send_file', { chat_id: 't@im.wechat', path: '/abs/x.pdf' })).body).toEqual({ ok: true })
    expect((await post(port, tok, '/v1/wechat/edit_message', { chat_id: 't@im.wechat', msg_id: 'm0', text: 'e' })).body).toEqual({ ok: true })
    expect((await post(port, tok, '/v1/conversation/set-mode', { chatId: 't@im.wechat', mode: { kind: 'solo', provider: 'claude' }, quiet: true })).body).toEqual({ ok: true })
    expect(m.sendFile).toHaveBeenCalledWith('t@im.wechat', '/abs/x.pdf')
    expect(m.editMessage).toHaveBeenCalledWith('t@im.wechat', 'm0', 'e')
    expect(m.setMode).toHaveBeenCalledTimes(1)
  })

  it('a chatId containing "/" survives the sessionKey split and still matches', async () => {
    const m = mocks()
    const { port } = await boot(m)
    const tok = api!.mintSessionToken('guest', 'claude/a/weird/chat')
    expect((await post(port, tok, '/v1/wechat/reply', { chat_id: 'weird/chat', text: 'hi' })).status).toBe(200)
    expect(m.sendReply).toHaveBeenCalledWith('weird/chat', 'hi')
  })

  it('broadcast: trusted session ⇒ 403; admin session ⇒ allowed (the one admin cross-chat feature)', async () => {
    const m = mocks()
    const { port } = await boot(m)
    const trusted = api!.mintSessionToken('trusted', 'claude/a/t1')
    const denied = await post(port, trusted, '/v1/wechat/broadcast', { text: 'hi all' })
    expect(denied.status).toBe(403)
    expect(denied.body.error).toBe('chat_scope')
    expect(m.broadcast).not.toHaveBeenCalled()
    const admin = api!.mintSessionToken('admin', 'claude/a/owner')
    expect((await post(port, admin, '/v1/wechat/broadcast', { text: 'hi all' })).body).toEqual({ ok: 2, failed: 0 })
    expect(m.broadcast).toHaveBeenCalledWith('hi all', undefined)
  })

  it('admin session → another chat via reply ⇒ 403 (no existing feature sends cross-chat through reply)', async () => {
    const m = mocks()
    const { port } = await boot(m)
    const admin = api!.mintSessionToken('admin', 'claude/a/owner')
    const r = await post(port, admin, '/v1/wechat/reply', { chat_id: 'guest@im.wechat', text: 'hi' })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('chat_scope')
    nothingSent(m)
    expect((await post(port, admin, '/v1/wechat/reply', { chat_id: 'owner', text: 'hi' })).status).toBe(200)
  })

  it('file token (daemon-wide, CLI) keeps current behaviour: any chat + broadcast', async () => {
    const m = mocks()
    const { port, fileToken } = await boot(m)
    expect((await post(port, fileToken, '/v1/wechat/reply', { chat_id: 'anyone', text: 'hi' })).status).toBe(200)
    expect((await post(port, fileToken, '/v1/wechat/send_file', { chat_id: 'anyone', path: '/abs/x' })).status).toBe(200)
    expect((await post(port, fileToken, '/v1/wechat/broadcast', { text: 'all' })).status).toBe(200)
    expect(m.sendReply).toHaveBeenCalledWith('anyone', 'hi')
    expect(m.broadcast).toHaveBeenCalled()
  })

  it('operator token (desktop host) is unchanged: still governed by routeAllow only, not chat scope', async () => {
    const m = mocks()
    await boot(m)
    const { port, operatorTokenFilePath } = { port: api!.port(), operatorTokenFilePath: join(stateDir, 'internal-operator-token') }
    const op = readFileSync(operatorTokenFilePath, 'utf8').trim()
    // reply is not on the operator's allow-list today — same 403 route_not_allowed as before this change.
    const r = await post(port, op, '/v1/wechat/reply', { chat_id: 'anyone', text: 'hi' })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('route_not_allowed')
  })

  it('agy-static (shared trusted token, no own chat) keeps current behaviour', async () => {
    const m = mocks()
    const { port } = await boot(m)
    const agy = api!.mintSessionToken('trusted', 'agy-static')
    expect((await post(port, agy, '/v1/wechat/reply', { chat_id: 'some@im.wechat', text: 'hi' })).status).toBe(200)
    expect(m.sendReply).toHaveBeenCalledWith('some@im.wechat', 'hi')
  })

  it('share_page without chat_id is not gated', async () => {
    const m = mocks()
    const { port } = await boot(m)
    const tok = api!.mintSessionToken('guest', 'claude/a/g1')
    expect((await post(port, tok, '/v1/share/page', { title: 't', content: 'c' })).status).toBe(200)
    expect(m.sharePage).toHaveBeenCalled()
  })

  describe('App reply sink', () => {
    it('a session cannot capture into ANOTHER chat\'s open sink', async () => {
      const m = mocks()
      const replySinks = makeReplySinks()
      const { port } = await boot(m, { replySinks })
      const sink = replySinks.open('owner')
      const guest = api!.mintSessionToken('guest', 'claude/a/g1')
      const r = await post(port, guest, '/v1/wechat/reply', { chat_id: 'owner', text: 'injected' })
      expect(r.status).toBe(403)
      expect(sink.close()).toBe('')
      nothingSent(m)
    })
    it('the owner session still captures into its own sink', async () => {
      const m = mocks()
      const replySinks = makeReplySinks()
      const { port } = await boot(m, { replySinks })
      const sink = replySinks.open('owner')
      const admin = api!.mintSessionToken('admin', 'claude/a/owner')
      expect((await post(port, admin, '/v1/wechat/reply', { chat_id: 'owner', text: 'hello app' })).body).toEqual({ ok: true, captured: true })
      expect(sink.close()).toBe('hello app')
      expect(m.sendReply).not.toHaveBeenCalled()
    })
  })
})
