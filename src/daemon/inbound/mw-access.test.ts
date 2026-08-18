import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeMwAccess } from './mw-access'
import type { InboundCtx } from './types'
import type { Access } from '../../lib/access'
import type { GuestRequestStore, GuestRequest } from '../guest-requests'
import type { ForwardBudget } from '../../core/forward-budget'
import type { InboundMsg } from '../../core/prompt-format'

// appendAllowFrom writes to disk (src/lib/access.ts) — mocked out so these
// unit tests never touch the filesystem. Verified as its own call in the
// invite-accept test below.
const appendAllowFrom = vi.fn((_userId: string) => true)
vi.mock('../../lib/access', () => ({
  appendAllowFrom: (userId: string) => appendAllowFrom(userId),
}))

beforeEach(() => {
  appendAllowFrom.mockClear()
})

function makeMsg(overrides: Partial<InboundMsg> = {}): InboundMsg {
  return {
    chatId: 'guest_chat',
    userId: 'guest_chat',
    text: '你好',
    msgType: 'text',
    createTimeMs: 1_000,
    accountId: 'acct1',
    ...overrides,
  }
}

function makeCtx(msg: InboundMsg): InboundCtx {
  return { msg, receivedAtMs: 0, requestId: 'r' }
}

function makeRequest(overrides: Partial<GuestRequest> = {}): GuestRequest {
  return {
    chatId: 'guest_chat',
    firstMsg: makeMsg(),
    contextToken: 'tok',
    accountId: 'acct1',
    code: '111111',
    createdAt: 0,
    notifiedAt: null,
    status: 'pending',
    ...overrides,
  }
}

/** Fully-controllable fake GuestRequestStore — every method is a vi.fn
 *  defaulting to the "nothing special going on" answer, overridable per test. */
function makeFakeStore(overrides: Partial<Record<keyof GuestRequestStore, unknown>> = {}) {
  const store = {
    upsertRequest: vi.fn(() => ({ request: makeRequest(), fresh: true })),
    findByCode: vi.fn(() => null),
    resolve: vi.fn(() => null),
    listPending: vi.fn(() => []),
    createInvite: vi.fn(() => ({ code: '222222', createdAt: 0 })),
    consumeInvite: vi.fn(() => false),
    wasDenied: vi.fn(() => false),
    markNotified: vi.fn(),
    seenMessage: vi.fn(() => false),
    ...overrides,
  } as unknown as GuestRequestStore
  return store
}

function makeFakeBudget(withinBudget = true): ForwardBudget {
  return { withinBudget: vi.fn(() => withinBudget) }
}

function guestDeps(over: {
  guestRequests?: GuestRequestStore
  budget?: ForwardBudget
  sendMessage?: (chatId: string, text: string) => Promise<{ error?: string }>
  notifyOwner?: (text: string) => Promise<{ error?: string }>
  hydrateChatRoute?: (msg: InboundMsg) => void
  allowFrom?: string[]
} = {}) {
  const guestRequests = over.guestRequests ?? makeFakeStore()
  const budget = over.budget ?? makeFakeBudget(true)
  const sendMessage = vi.fn(over.sendMessage ?? (async () => ({})))
  const notifyOwner = vi.fn(over.notifyOwner ?? (async () => ({})))
  const hydrateChatRoute = vi.fn(over.hydrateChatRoute ?? (() => {}))
  const log = vi.fn()
  const loadAccess = (): Access => ({ dmPolicy: 'allowlist', allowFrom: over.allowFrom ?? [] })
  return { guestRequests, budget, sendMessage, notifyOwner, hydrateChatRoute, log, loadAccess }
}

describe('mwAccess — allowlist gate (unchanged)', () => {
  it('passes through allowlisted chat', async () => {
    const mw = makeMwAccess({
      loadAccess: (): Access => ({ dmPolicy: 'allowlist', allowFrom: ['ok'] }),
      log: () => {},
    })
    const ctx = makeCtx(makeMsg({ chatId: 'ok', userId: 'ok' }))
    const next = vi.fn(async () => {})
    await mw(ctx, next)
    expect(next).toHaveBeenCalledOnce()
    expect(ctx.consumedBy).toBeUndefined()
  })

  it('drops everything when dmPolicy=disabled (even allowlisted chats, even with guest deps wired)', async () => {
    const d = guestDeps({ allowFrom: ['guest_chat'] })
    const mw = makeMwAccess({ ...d, loadAccess: (): Access => ({ dmPolicy: 'disabled', allowFrom: ['guest_chat'] }) })
    const ctx = makeCtx(makeMsg())
    const next = vi.fn(async () => {})
    await mw(ctx, next)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.consumedBy).toBe('access')
    expect(d.guestRequests.seenMessage).not.toHaveBeenCalled()
  })

  it("'*' wildcard in allowFrom matches every chat (e2e harness default)", async () => {
    const mw = makeMwAccess({
      loadAccess: (): Access => ({ dmPolicy: 'allowlist', allowFrom: ['*'] }),
      log: () => {},
    })
    const ctx = makeCtx(makeMsg({ chatId: 'anyone', userId: 'anyone' }))
    const next = vi.fn(async () => {})
    await mw(ctx, next)
    expect(next).toHaveBeenCalledOnce()
    expect(ctx.consumedBy).toBeUndefined()
  })
})

describe('mwAccess — guest deps absent ⇒ byte-identical legacy silent drop', () => {
  it('drops non-allowlisted chat with consumedBy=access, exact legacy log line, no guest machinery touched', async () => {
    const log = vi.fn()
    const mw = makeMwAccess({
      loadAccess: (): Access => ({ dmPolicy: 'allowlist', allowFrom: ['ok'] }),
      log,
    })
    const ctx = makeCtx(makeMsg({ chatId: 'blocked', userId: 'blocked' }))
    const next = vi.fn(async () => {})
    await mw(ctx, next)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.consumedBy).toBe('access')
    expect(log).toHaveBeenCalledWith('ACCESS', 'drop chat=blocked reason=not_in_allowlist allowFrom_count=1')
  })

  it('drops when allowFrom is empty (first-run / no access.json setup)', async () => {
    const mw = makeMwAccess({
      loadAccess: (): Access => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      log: () => {},
    })
    const ctx = makeCtx(makeMsg({ chatId: 'anyone', userId: 'anyone' }))
    const next = vi.fn(async () => {})
    await mw(ctx, next)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.consumedBy).toBe('access')
  })

  it('ANY single guest dep missing (e.g. budget only) falls back to legacy drop — no partial guest branch', async () => {
    const d = guestDeps()
    const log = vi.fn()
    const mw = makeMwAccess({
      loadAccess: d.loadAccess,
      log,
      guestRequests: d.guestRequests,
      hydrateChatRoute: d.hydrateChatRoute,
      sendMessage: d.sendMessage,
      notifyOwner: d.notifyOwner,
      // budget omitted
    })
    const ctx = makeCtx(makeMsg())
    await mw(ctx, vi.fn(async () => {}))
    expect(ctx.consumedBy).toBe('access')
    expect(d.guestRequests.seenMessage).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('ACCESS', expect.stringContaining('not_in_allowlist'))
  })
})

describe('mwAccess — guest branch (spec §2, five steps)', () => {
  it('step 1: redelivered message id → silent drop, nothing else touched', async () => {
    const guestRequests = makeFakeStore({ seenMessage: vi.fn(() => true) })
    const d = guestDeps({ guestRequests })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg())
    await mw(ctx, vi.fn(async () => {}))
    expect(ctx.consumedBy).toBe('access')
    expect(guestRequests.wasDenied).not.toHaveBeenCalled()
    expect(d.sendMessage).not.toHaveBeenCalled()
    expect(d.notifyOwner).not.toHaveBeenCalled()
    expect(d.hydrateChatRoute).not.toHaveBeenCalled()
  })

  it('step 2: wasDenied → silent drop', async () => {
    const guestRequests = makeFakeStore({ wasDenied: vi.fn(() => true) })
    const d = guestDeps({ guestRequests })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg())
    await mw(ctx, vi.fn(async () => {}))
    expect(ctx.consumedBy).toBe('access')
    expect(guestRequests.upsertRequest).not.toHaveBeenCalled()
    expect(d.sendMessage).not.toHaveBeenCalled()
    expect(d.notifyOwner).not.toHaveBeenCalled()
  })

  it('step 3: correct 6-digit invite code → appendAllowFrom + hydrate + welcome text, consumed', async () => {
    const guestRequests = makeFakeStore({ consumeInvite: vi.fn(() => true) })
    const d = guestDeps({ guestRequests })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg({ text: '483921' }))
    await mw(ctx, vi.fn(async () => {}))
    expect(ctx.consumedBy).toBe('access')
    expect(guestRequests.consumeInvite).toHaveBeenCalledWith('483921')
    expect(appendAllowFrom).toHaveBeenCalledWith('guest_chat')
    expect(d.hydrateChatRoute).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'guest_chat' }))
    expect(d.sendMessage).toHaveBeenCalledWith('guest_chat', '主人邀请你来的吧,欢迎!直接跟我说话就行~')
    expect(guestRequests.upsertRequest).not.toHaveBeenCalled()
  })

  it('step 3: WRONG 6-digit code (consumeInvite fails) falls through to request creation — indistinguishable from an ordinary first message', async () => {
    const guestRequests = makeFakeStore({ consumeInvite: vi.fn(() => false) })
    const d = guestDeps({ guestRequests })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg({ text: '000000' }))
    await mw(ctx, vi.fn(async () => {}))
    expect(guestRequests.consumeInvite).toHaveBeenCalledWith('000000')
    expect(appendAllowFrom).not.toHaveBeenCalled()
    expect(d.sendMessage).toHaveBeenCalledWith('guest_chat', '我需要主人确认一下,稍等哦~')
    expect(guestRequests.upsertRequest).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'guest_chat', accountId: 'acct1' }),
    )
  })

  it('step 4: over budget → silent drop, request never created', async () => {
    const guestRequests = makeFakeStore()
    const d = guestDeps({ guestRequests, budget: makeFakeBudget(false) })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg())
    await mw(ctx, vi.fn(async () => {}))
    expect(ctx.consumedBy).toBe('access')
    expect(guestRequests.upsertRequest).not.toHaveBeenCalled()
    expect(d.sendMessage).not.toHaveBeenCalled()
    expect(d.notifyOwner).not.toHaveBeenCalled()
  })

  it('step 5 fresh: hydrate + neutral reply to guest + owner notify with preview+code, then markNotified on success', async () => {
    const request = makeRequest({ code: '654321' })
    const guestRequests = makeFakeStore({ upsertRequest: vi.fn(() => ({ request, fresh: true })) })
    const d = guestDeps({ guestRequests })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg({ text: '我想聊聊' }))
    await mw(ctx, vi.fn(async () => {}))

    expect(d.hydrateChatRoute).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'guest_chat' }))
    expect(d.sendMessage).toHaveBeenCalledWith('guest_chat', '我需要主人确认一下,稍等哦~')
    expect(d.notifyOwner).toHaveBeenCalledWith(
      '👋 guest_chat 想和我聊天,ta 说:"我想聊聊"\n回「允许 654321」或「拒绝 654321」(48 小时内有效)',
    )
    expect(guestRequests.markNotified).toHaveBeenCalledWith('guest_chat')
  })

  it('owner-notify preview: truncates to 60 chars and replaces newlines with spaces', async () => {
    const longText = 'a\nb'.repeat(30)   // well over 60 raw chars, contains newlines
    const request = makeRequest({ code: '654321' })
    const guestRequests = makeFakeStore({ upsertRequest: vi.fn(() => ({ request, fresh: true })) })
    const d = guestDeps({ guestRequests })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg({ text: longText }))
    await mw(ctx, vi.fn(async () => {}))

    const [sentText] = d.notifyOwner.mock.calls[0] as [string]
    expect(sentText).not.toContain('\n\n')   // no literal source newline survives inside the quote
    const preview = /ta 说:"(.*)"\n回/s.exec(sentText)?.[1]
    expect(preview).toBeDefined()
    expect(preview!.length).toBeLessThanOrEqual(60)
    expect(preview).not.toContain('\n')
  })

  it('step 5 repeat, already notified (notifiedAt set): totally silent — no hydrate, no guest reply, no owner notify', async () => {
    const request = makeRequest({ notifiedAt: 500 })
    const guestRequests = makeFakeStore({ upsertRequest: vi.fn(() => ({ request, fresh: false })) })
    const d = guestDeps({ guestRequests })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg())
    await mw(ctx, vi.fn(async () => {}))

    expect(d.hydrateChatRoute).not.toHaveBeenCalled()
    expect(d.sendMessage).not.toHaveBeenCalled()
    expect(d.notifyOwner).not.toHaveBeenCalled()
    expect(guestRequests.markNotified).not.toHaveBeenCalled()
  })

  it('step 5 retry contract: existing (non-fresh) request with notifiedAt still null retries the owner notify, but stays silent to the guest', async () => {
    const request = makeRequest({ notifiedAt: null, code: '111222' })
    const guestRequests = makeFakeStore({ upsertRequest: vi.fn(() => ({ request, fresh: false })) })
    const d = guestDeps({ guestRequests })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg())
    await mw(ctx, vi.fn(async () => {}))

    expect(d.hydrateChatRoute).not.toHaveBeenCalled()
    expect(d.sendMessage).not.toHaveBeenCalled()   // guest gets nothing on a repeat
    expect(d.notifyOwner).toHaveBeenCalledTimes(1)   // owner notify retried
    expect(guestRequests.markNotified).toHaveBeenCalledWith('guest_chat')
  })

  it('owner notify send fails (.error) → markNotified NOT called, so the NEXT message retries again', async () => {
    const request = makeRequest()
    const guestRequests = makeFakeStore({ upsertRequest: vi.fn(() => ({ request, fresh: true })) })
    const d = guestDeps({ guestRequests, notifyOwner: vi.fn(async () => ({ error: 'send_failed' })) })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg())
    await mw(ctx, vi.fn(async () => {}))

    expect(d.notifyOwner).toHaveBeenCalledTimes(1)
    expect(guestRequests.markNotified).not.toHaveBeenCalled()
  })
})
