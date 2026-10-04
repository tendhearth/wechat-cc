import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInternalApi, type InternalApi, type InternalApiDeps } from '../internal-api'
import { makeReplySinks } from '../reply-sinks'
import { makeRoutes, makeMaybePrefix } from './routes'
import { ADMIN_CHAT_SCOPE_MESSAGE, ALL_CHATS, CHAT_SCOPE_MESSAGE, CROSS_CHAT_ROUTE, SEND_SCOPED_ROUTES, sendScopeDecision, sharedTokenTurn } from './send-scope'
import { makeReplyDeliveryRuntime } from '../reply-delivery'
import { setReplyDeliveryOverrides } from '../../core/capability-matrix'
import { onTestFinished } from 'vitest'
import { minTierFor } from './route-tiers'

/**
 * 发送类路由的 chat 范围门(send-scope.ts)。确认过的安全 bug:这些路由从请求体拿
 * chat_id,从不和调用方会话自己的 chat 比 —— 任何会话(包括 guest)都能以 CC 的
 * 身份给任意 chat 发消息。
 */

describe('sendScopeDecision (pure rule)', () => {
  const guest = { tier: 'guest' as const, origin: 'session' as const, chatId: 'g1', sessionKey: 'claude/a/g1' }
  const trusted = { tier: 'trusted' as const, origin: 'session' as const, chatId: 't1', sessionKey: 'claude/a/t1' }
  const admin = { tier: 'admin' as const, origin: 'session' as const, chatId: 'owner', sessionKey: 'claude/a/owner' }
  const kind = (t: Parameters<typeof sendScopeDecision>[0], c: Parameters<typeof sendScopeDecision>[1]) => sendScopeDecision(t, c).kind

  it('session callers of every tier may target their own chat', () => {
    expect(kind('g1', guest)).toBe('allow')
    expect(kind('t1', trusted)).toBe('allow')
    expect(kind('owner', admin)).toBe('allow')
  })
  it('guest / trusted sessions are denied another chat, with an honest message', () => {
    const d = sendScopeDecision('owner', guest)
    expect(d).toEqual({ kind: 'deny', message: expect.stringMatching(/chat_scope.*nothing was sent/) })
    expect(kind('owner', trusted)).toBe('deny')
  })
  it('admin session → another chat via reply 族 / share / set-mode ⇒ denied (2026-10-04 收紧), 403 text points at `message`', () => {
    // #199 起暂时放行 + 记 chat_scope_admin_cross;`message` 在五家 daemon 执行者里都有了 ⇒ 按计划收紧。
    for (const route of ['POST /v1/wechat/reply', 'POST /v1/wechat/send_file', 'POST /v1/share/page', 'POST /v1/conversation/set-mode', undefined]) {
      const d = sendScopeDecision('g1', admin, route)
      expect(d).toEqual({ kind: 'deny', message: ADMIN_CHAT_SCOPE_MESSAGE })
    }
    expect(ADMIN_CHAT_SCOPE_MESSAGE).toMatch(/nothing was sent.*`message` tool/)
    expect(kind('x', { tier: 'admin', origin: 'session' })).toBe('deny')
    // 非 admin 的拒绝文案不提 message(它们根本没有这个工具)
    expect(sendScopeDecision('owner', guest, 'POST /v1/wechat/reply')).toEqual({ kind: 'deny', message: CHAT_SCOPE_MESSAGE })
  })
  it('admin session → another chat via `message` (CROSS_CHAT_ROUTE) ⇒ admin_cross (allowed, logged)', () => {
    expect(sendScopeDecision('g1', admin, CROSS_CHAT_ROUTE).kind).toBe('admin_cross')
    expect(sendScopeDecision('owner', admin, CROSS_CHAT_ROUTE).kind).toBe('allow') // 本 chat:路由自己报 message_to_own_chat
    expect(sendScopeDecision('owner', trusted, CROSS_CHAT_ROUTE).kind).toBe('deny') // 走不到这里(路由是 admin 级),兜底也拒
  })
  it('broadcast: only admin sessions (plain allow, not admin_cross)', () => {
    expect(kind(ALL_CHATS, guest)).toBe('deny')
    expect(kind(ALL_CHATS, trusted)).toBe('deny')
    expect(kind(ALL_CHATS, admin)).toBe('allow')
  })
  it('a non-admin session whose sessionKey yields no chat is denied (fail closed)', () => {
    expect(kind('x', { tier: 'trusted', origin: 'session', chatId: '', sessionKey: 'odd' })).toBe('deny')
    expect(kind('x', { tier: 'guest', origin: 'session' })).toBe('deny')
  })
  it('agy-static (shared across every agy conversation, no own chat) keeps current behaviour', () => {
    const agy = { tier: 'trusted' as const, origin: 'session' as const, chatId: '', sessionKey: 'agy-static' }
    expect(kind('anyone', agy)).toBe('allow')
    expect(kind(ALL_CHATS, agy)).toBe('allow')
  })
  it('agy-static bound to its turn (agy in daemon delivery): own turn chat only, no broadcast, no turn ⇒ deny', () => {
    // 回复交付第 2 步:agy 不再按 chat_id 发东西,共享令牌的豁免取消;「自己的 chat」= 此刻在跑的那一轮。
    const bound = { tier: 'trusted' as const, origin: 'session' as const, chatId: 'owner', sessionKey: 'agy-static', sharedTokenBound: true }
    expect(kind('owner', bound)).toBe('allow')
    expect(kind('someone-else', bound)).toBe('deny')
    expect(kind(ALL_CHATS, bound)).toBe('deny')
    expect(kind('owner', { ...bound, chatId: undefined })).toBe('deny')
  })
  it('sharedTokenTurn: only agy-static, only when agy is in daemon delivery', () => {
    const turnChatFor = (p: string) => p === 'agy' ? { kind: 'bound' as const, chatId: 'owner' } : { kind: 'none' as const }
    const agy = { origin: 'session' as const, sessionKey: 'agy-static' }
    expect(sharedTokenTurn(agy, { agyDaemon: false, turnChatFor })).toBeUndefined()
    expect(sharedTokenTurn({ origin: 'session', sessionKey: 'claude/a/owner' }, { agyDaemon: true, turnChatFor })).toBeUndefined()
    expect(sharedTokenTurn({ origin: 'file' }, { agyDaemon: true, turnChatFor })).toBeUndefined()
    expect(sharedTokenTurn(agy, { agyDaemon: true, turnChatFor })).toEqual({ kind: 'bound', chatId: 'owner' })
    expect(sharedTokenTurn(agy, { agyDaemon: true, turnChatFor: () => ({ kind: 'ambiguous', count: 2 }) })).toEqual({ kind: 'ambiguous' })
    expect(sharedTokenTurn(agy, { agyDaemon: true })).toEqual({ kind: 'none' })
  })
  it('file / operator tokens are unrestricted', () => {
    expect(kind('anyone', { tier: 'trusted', origin: 'file' })).toBe('allow')
    expect(kind(ALL_CHATS, { tier: 'trusted', origin: 'file' })).toBe('allow')
    expect(kind('anyone', { tier: 'admin', origin: 'operator' })).toBe('allow')
  })
  it('a request that names no chat is not gated', () => {
    expect(kind(null, guest)).toBe('allow')
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

  it('broadcast: trusted session ⇒ 403; admin session ⇒ allowed', async () => {
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

  // 2026-10-04 收紧(#199 的计划):admin 会话也只能发本 chat;跨 chat 只走 `message`。
  for (const tc of CASES) {
    it(`admin session → ANOTHER chat on ${tc.path} ⇒ 403 chat_scope telling it to use \`message\`, nothing sent`, async () => {
      const m = mocks()
      const log = vi.fn()
      const { port } = await boot(m, { log })
      const tok = api!.mintSessionToken('admin', 'claude/a/owner')
      const r = await post(port, tok, tc.path, tc.body('victim@im.wechat'))
      expect(r.status).toBe(403)
      expect(r.body.error).toBe('chat_scope')
      expect(String(r.body.message)).toMatch(/nothing was sent.*`message` tool/)
      expect(JSON.stringify(r.body)).not.toContain('victim')
      nothingSent(m)
      expect(log.mock.calls.find(c => (c[2] as { event?: string } | undefined)?.event === 'chat_scope_denied')![2]).toMatchObject({ caller: 'admin', callerChat: 'owner' })
      expect(log.mock.calls.some(c => (c[2] as { event?: string } | undefined)?.event === 'chat_scope_admin_cross')).toBe(false)
    })
  }

  it('admin session → own chat on reply still goes through (no admin_cross line)', async () => {
    const m = mocks()
    const log = vi.fn()
    const { port } = await boot(m, { log })
    const admin = api!.mintSessionToken('admin', 'claude/a/owner')
    expect((await post(port, admin, '/v1/wechat/reply', { chat_id: 'owner', text: 'hi' })).body).toEqual({ ok: true, msg_id: 'm1' })
    expect(m.sendReply).toHaveBeenCalledWith('owner', 'hi')
    expect(log.mock.calls.some(c => (c[2] as { event?: string } | undefined)?.event === 'chat_scope_admin_cross')).toBe(false)
  })

  it('admin session → another chat via `message` ⇒ sent, logged chat_scope_admin_cross (the one cross-chat path)', async () => {
    const m = mocks()
    const log = vi.fn()
    const { port } = await boot(m, { log })
    const admin = api!.mintSessionToken('admin', 'claude/a/owner')
    const r = await post(port, admin, '/v1/wechat/message', { to: 'guest@im.wechat', text: '主人让我告诉你' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, msg_id: 'm1' })
    expect(m.sendReply).toHaveBeenCalledWith('guest@im.wechat', '主人让我告诉你')
    const ev = log.mock.calls.find(c => (c[2] as { event?: string } | undefined)?.event === 'chat_scope_admin_cross')
    expect(ev![2]).toMatchObject({ path: 'POST /v1/wechat/message', callerChat: 'owner', target: 'guest@im.wechat' })
    // trusted 会话够不着 message(路由是 admin 级)
    const trusted = api!.mintSessionToken('trusted', 'claude/a/t1')
    expect((await post(port, trusted, '/v1/wechat/message', { to: 'guest@im.wechat', text: 'x' })).status).toBe(403)
    expect(m.sendReply).toHaveBeenCalledTimes(1)
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

  it('agy-static (shared trusted token, no own chat) keeps current behaviour while agy is legacy / shadow', async () => {
    // 2026-10-03 起 agy 缺省是 daemon;这条钉的是回滚到 legacy 时共享令牌的豁免还在。
    setReplyDeliveryOverrides({ agy: 'legacy' })
    onTestFinished(() => setReplyDeliveryOverrides(undefined))
    const m = mocks()
    const { port } = await boot(m)
    const agy = api!.mintSessionToken('trusted', 'agy-static')
    expect((await post(port, agy, '/v1/wechat/reply', { chat_id: 'some@im.wechat', text: 'hi' })).status).toBe(200)
    expect(m.sendReply).toHaveBeenCalledWith('some@im.wechat', 'hi')
  })

  describe('agy-static under daemon delivery (回复交付第 2 步:附件绑到本轮,共享令牌不再豁免)', () => {
    afterEach(() => setReplyDeliveryOverrides(undefined))
    const rtFor = (m: Mocks) => makeReplyDeliveryRuntime({ sendText: async (c, t) => m.sendReply(c, t), sleep: async () => {}, log: () => {} })

    it('no agy turn in flight ⇒ chat-targeted sends 403 and attach reports no turn', async () => {
      setReplyDeliveryOverrides({ agy: 'daemon' })
      const m = mocks()
      const replyDelivery = rtFor(m)
      const { port } = await boot(m, { replyDelivery })
      const agy = api!.mintSessionToken('trusted', 'agy-static')
      const r = await post(port, agy, '/v1/wechat/reply', { chat_id: 'some@im.wechat', text: 'hi' })
      expect(r.status).toBe(403)
      expect(r.body.error).toBe('chat_scope')
      const a = await post(port, agy, '/v1/turn/attach', { kind: 'voice', text: '晚安' })
      expect(a.body).toMatchObject({ ok: false, error: expect.stringMatching(/^no_turn_in_progress/) })
      nothingSent(m)
    })

    it('one agy turn in flight ⇒ attach binds to that chat; sends to its chat pass, to any other chat 403', async () => {
      setReplyDeliveryOverrides({ agy: 'daemon' })
      const m = mocks()
      const replyDelivery = rtFor(m)
      const { port } = await boot(m, { replyDelivery })
      const agy = api!.mintSessionToken('trusted', 'agy-static')
      const turn = replyDelivery.begin('owner@im.wechat', { mode: 'daemon', context: 'dm', providerId: 'agy', textStrategy: 'all_segments' })
      expect((await post(port, agy, '/v1/turn/attach', { kind: 'voice', text: '晚安' })).body).toEqual({ ok: true, attached: true })
      expect((await post(port, agy, '/v1/wechat/sticker_feedback', { chat_id: 'owner@im.wechat', signal: 'positive' })).status).toBe(200)
      const other = await post(port, agy, '/v1/wechat/sticker_feedback', { chat_id: 'victim@im.wechat', signal: 'positive' })
      expect(other.status).toBe(403)
      expect(JSON.stringify(other.body)).not.toContain('victim')
      const report = await turn.deliver({ finalText: '', narration: [] })
      expect(report).toMatchObject({ delivery: 'attachments_only', attachmentsSent: 1 })
      expect(m.replyVoice).toHaveBeenCalledWith('owner@im.wechat', '晚安')
    })

    it('two agy turns in flight (two chats) ⇒ attach refuses as ambiguous instead of guessing', async () => {
      setReplyDeliveryOverrides({ agy: 'daemon' })
      const m = mocks()
      const replyDelivery = rtFor(m)
      const { port } = await boot(m, { replyDelivery })
      const agy = api!.mintSessionToken('trusted', 'agy-static')
      const t1 = replyDelivery.begin('owner@im.wechat', { mode: 'daemon', context: 'dm', providerId: 'agy' })
      const t2 = replyDelivery.begin('friend@im.wechat', { mode: 'daemon', context: 'dm', providerId: 'agy' })
      const a = await post(port, agy, '/v1/turn/attach', { kind: 'voice', text: '晚安' })
      expect(a.body).toMatchObject({ ok: false, error: expect.stringMatching(/^ambiguous_turn/) })
      expect((await post(port, agy, '/v1/wechat/sticker_feedback', { chat_id: 'owner@im.wechat', signal: 'positive' })).status).toBe(403)
      t1.abandon('test'); t2.abandon('test')
      nothingSent(m)
    })

    it('a claude turn in flight does not bind agy-static (binding is per provider)', async () => {
      setReplyDeliveryOverrides({ agy: 'daemon', claude: 'daemon' })
      const m = mocks()
      const replyDelivery = rtFor(m)
      const { port } = await boot(m, { replyDelivery })
      const agy = api!.mintSessionToken('trusted', 'agy-static')
      const t = replyDelivery.begin('owner@im.wechat', { mode: 'daemon', context: 'dm', providerId: 'claude' })
      expect((await post(port, agy, '/v1/turn/attach', { kind: 'voice', text: '晚安' })).body).toMatchObject({ ok: false, error: expect.stringMatching(/^no_turn_in_progress/) })
      t.abandon('test')
    })
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
