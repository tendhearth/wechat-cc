import { describe, it, expect, vi } from 'vitest'
import { makeMwAccess, previewText } from './mw-access'
import type { InboundCtx } from './types'
import type { Access } from '../../lib/access'
import type { GuestRequestStore, GuestRequest } from '../guest-requests'
import type { ForwardBudget } from '../../core/forward-budget'
import type { InboundMsg } from '../../core/prompt-format'

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

function makeCtx(msg: InboundMsg, redispatch?: boolean): InboundCtx {
  return { msg, receivedAtMs: 0, requestId: 'r', redispatch }
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
  appendAllowFrom?: (chatId: string) => boolean
  allowFrom?: string[]
  /**
   * Defaults to a non-empty admins list — fix-wave ruling (Important 2)
   * gates the ENTIRE guest branch on `admins?.length`, so every existing
   * guest-branch test in this file needs a real admin present to keep
   * exercising the branch it's actually testing. Pass `admins: []` (or
   * omit `admins` while overriding `loadAccess` directly) to specifically
   * test the admins-empty gate itself — see the dedicated describe block
   * below.
   */
  admins?: string[]
} = {}) {
  const guestRequests = over.guestRequests ?? makeFakeStore()
  const budget = over.budget ?? makeFakeBudget(true)
  const sendMessage = vi.fn(over.sendMessage ?? (async () => ({})))
  const notifyOwner = vi.fn(over.notifyOwner ?? (async () => ({})))
  const hydrateChatRoute = vi.fn(over.hydrateChatRoute ?? (() => {}))
  const appendAllowFrom = vi.fn(over.appendAllowFrom ?? ((_chatId: string) => true))
  const log = vi.fn()
  const loadAccess = (): Access => ({
    dmPolicy: 'allowlist',
    allowFrom: over.allowFrom ?? [],
    admins: over.admins ?? ['test_admin'],
  })
  return { guestRequests, budget, sendMessage, notifyOwner, hydrateChatRoute, appendAllowFrom, log, loadAccess }
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

  it('ANY single guest dep missing (e.g. appendAllowFrom only) falls back to legacy drop — no partial guest branch', async () => {
    const d = guestDeps()
    const log = vi.fn()
    const mw = makeMwAccess({
      loadAccess: d.loadAccess,
      log,
      guestRequests: d.guestRequests,
      hydrateChatRoute: d.hydrateChatRoute,
      sendMessage: d.sendMessage,
      notifyOwner: d.notifyOwner,
      budget: d.budget,
      // appendAllowFrom omitted
    })
    const ctx = makeCtx(makeMsg())
    await mw(ctx, vi.fn(async () => {}))
    expect(ctx.consumedBy).toBe('access')
    expect(d.guestRequests.seenMessage).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('ACCESS', expect.stringContaining('not_in_allowlist'))
  })
})

describe('mwAccess — guest machinery requires real admins (fix-wave ruling, CONTROLLER — Important 2)', () => {
  it('admins empty ⇒ byte-identical legacy silent drop, even with all six guest deps wired', async () => {
    const guestRequests = makeFakeStore()
    const log = vi.fn()
    const d = guestDeps({ guestRequests, admins: [] })
    const mw = makeMwAccess({ ...d, log })
    const ctx = makeCtx(makeMsg())
    await mw(ctx, vi.fn(async () => {}))
    expect(ctx.consumedBy).toBe('access')
    expect(log).toHaveBeenCalledWith('ACCESS', 'guest path inactive: admins empty — run doctor (chat=guest_chat)')
    // No guest machinery touched at all — not even the message-id dedup.
    expect(guestRequests.seenMessage).not.toHaveBeenCalled()
    expect(guestRequests.upsertRequest).not.toHaveBeenCalled()
    expect(d.sendMessage).not.toHaveBeenCalled()
    expect(d.notifyOwner).not.toHaveBeenCalled()
    expect(d.hydrateChatRoute).not.toHaveBeenCalled()
    expect(d.appendAllowFrom).not.toHaveBeenCalled()
  })

  it('admins undefined (never configured — legacy install) ⇒ same silent drop', async () => {
    const d = guestDeps()
    const mw = makeMwAccess({ ...d, loadAccess: (): Access => ({ dmPolicy: 'allowlist', allowFrom: [] }) })   // no `admins` key at all
    const ctx = makeCtx(makeMsg())
    await mw(ctx, vi.fn(async () => {}))
    expect(ctx.consumedBy).toBe('access')
    expect(d.guestRequests.seenMessage).not.toHaveBeenCalled()
  })

  it('a bare 6-digit invite code does NOT get consumed on an admins-empty install — the whole branch is inert, not just the notify step', async () => {
    const guestRequests = makeFakeStore({ consumeInvite: vi.fn(() => true) })
    const d = guestDeps({ guestRequests, admins: [] })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg({ text: '483921' }))
    await mw(ctx, vi.fn(async () => {}))
    expect(guestRequests.consumeInvite).not.toHaveBeenCalled()
    expect(d.appendAllowFrom).not.toHaveBeenCalled()
  })

  it('admins present ⇒ guest branch behaves exactly as before (sanity — the rest of this file already covers the details)', async () => {
    const d = guestDeps({ admins: ['owner1'] })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg({ text: 'hello' }))
    await mw(ctx, vi.fn(async () => {}))
    expect(ctx.consumedBy).toBe('access')
    expect(d.guestRequests.seenMessage).toHaveBeenCalled()
    expect(d.sendMessage).toHaveBeenCalledWith('guest_chat', '我需要主人确认一下,稍等哦~')
  })
})

describe('mwAccess — guest branch (spec §2 as amended, fix round 1 ruling #8 reordered steps 2/3)', () => {
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

  it('redispatch guard (hardening, controller-mandated): a redispatched message landing in the guest branch (stale-cache corner after an out-of-band allow) is dropped unconditionally — no upsert, no notify, logged drop', async () => {
    const guestRequests = makeFakeStore({ seenMessage: vi.fn(() => true) })   // already seen (first pass)
    const log = vi.fn()
    const d = guestDeps({ guestRequests })
    const mw = makeMwAccess({ ...d, log })
    const ctx = makeCtx(makeMsg(), true)   // this IS a redispatch, but `allowed` was stale-cache-false
    await mw(ctx, vi.fn(async () => {}))
    expect(ctx.consumedBy).toBe('access')
    expect(guestRequests.upsertRequest).not.toHaveBeenCalled()
    expect(guestRequests.seenMessage).not.toHaveBeenCalled()   // never even reaches the dedup check
    expect(d.sendMessage).not.toHaveBeenCalled()
    expect(d.notifyOwner).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('ACCESS', 'guest drop chat=guest_chat reason=redispatch_stale_cache')
  })

  it('step 2 (moved up, ruling #8): correct 6-digit invite code → appendAllowFrom + hydrate + welcome text, consumed — checked BEFORE wasDenied', async () => {
    const guestRequests = makeFakeStore({ consumeInvite: vi.fn(() => true), wasDenied: vi.fn(() => true) })
    const d = guestDeps({ guestRequests })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg({ text: '483921' }))
    await mw(ctx, vi.fn(async () => {}))
    expect(ctx.consumedBy).toBe('access')
    expect(guestRequests.consumeInvite).toHaveBeenCalledWith('483921')
    expect(d.appendAllowFrom).toHaveBeenCalledWith('guest_chat')
    expect(d.hydrateChatRoute).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'guest_chat' }))
    expect(d.sendMessage).toHaveBeenCalledWith('guest_chat', '主人邀请你来的吧,欢迎!直接跟我说话就行~')
    expect(guestRequests.upsertRequest).not.toHaveBeenCalled()
  })

  it('ruling #8: a valid invite code overrides a prior denial — a mis-typed 拒绝 followed by 邀请码 still works', async () => {
    const guestRequests = makeFakeStore({ consumeInvite: vi.fn(() => true), wasDenied: vi.fn(() => true) })
    const d = guestDeps({ guestRequests })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg({ text: '111111' }))
    await mw(ctx, vi.fn(async () => {}))
    expect(d.appendAllowFrom).toHaveBeenCalledWith('guest_chat')
    expect(d.sendMessage).toHaveBeenCalledWith('guest_chat', '主人邀请你来的吧,欢迎!直接跟我说话就行~')
  })

  it('step 2: WRONG 6-digit code (consumeInvite fails) falls through to the denied check / request creation — indistinguishable from an ordinary first message', async () => {
    const guestRequests = makeFakeStore({ consumeInvite: vi.fn(() => false) })
    const d = guestDeps({ guestRequests })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg({ text: '000000' }))
    await mw(ctx, vi.fn(async () => {}))
    expect(guestRequests.consumeInvite).toHaveBeenCalledWith('000000')
    expect(d.appendAllowFrom).not.toHaveBeenCalled()
    expect(d.sendMessage).toHaveBeenCalledWith('guest_chat', '我需要主人确认一下,稍等哦~')
    expect(guestRequests.upsertRequest).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'guest_chat', accountId: 'acct1' }),
    )
  })

  it('step 3: wasDenied → silent drop (when not superseded by a valid invite code)', async () => {
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

  it('step 4: over budget with NO stuck request → silent drop, request never created', async () => {
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

  it('fold #7: over budget but there IS a stuck (notifiedAt:null) pending request → retries the owner notify anyway, bypassing the budget gate', async () => {
    const stuck = makeRequest({ code: '999888', notifiedAt: null })
    const guestRequests = makeFakeStore({ listPending: vi.fn(() => [stuck]) })
    const d = guestDeps({ guestRequests, budget: makeFakeBudget(false) })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg({ text: 'still waiting' }))
    await mw(ctx, vi.fn(async () => {}))
    expect(guestRequests.upsertRequest).not.toHaveBeenCalled()   // not a new request, just a retry
    expect(d.sendMessage).not.toHaveBeenCalled()   // guest still gets nothing
    expect(d.notifyOwner).toHaveBeenCalledWith(expect.stringContaining('999888'))
    expect(guestRequests.markNotified).toHaveBeenCalledWith('guest_chat')
  })

  it('fold #7: over budget with a stuck request whose notify STILL fails → markNotified not called (keeps retrying)', async () => {
    const stuck = makeRequest({ code: '999888', notifiedAt: null })
    const guestRequests = makeFakeStore({ listPending: vi.fn(() => [stuck]) })
    const d = guestDeps({ guestRequests, budget: makeFakeBudget(false), notifyOwner: vi.fn(async () => ({ error: 'boom' })) })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg())
    await mw(ctx, vi.fn(async () => {}))
    expect(guestRequests.markNotified).not.toHaveBeenCalled()
  })

  it('fold #7: over budget with a pending-but-ALREADY-notified request for this chat → still a plain silent drop (only unnotified stuck requests bypass budget)', async () => {
    const notified = makeRequest({ code: '999888', notifiedAt: 42 })
    const guestRequests = makeFakeStore({ listPending: vi.fn(() => [notified]) })
    const d = guestDeps({ guestRequests, budget: makeFakeBudget(false) })
    const mw = makeMwAccess(d)
    const ctx = makeCtx(makeMsg())
    await mw(ctx, vi.fn(async () => {}))
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

  it('owner-notify preview: truncates to 60 codepoints and replaces newlines with spaces', async () => {
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
    expect(Array.from(preview!).length).toBeLessThanOrEqual(60)
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

describe('previewText (fold #5 — quote escaping + surrogate-safe truncation)', () => {
  it('escapes double quotes with a backslash', () => {
    expect(previewText('he said "hi" to me')).toBe('he said \\"hi\\" to me')
  })

  it('replaces newlines with spaces', () => {
    expect(previewText('line one\nline two')).toBe('line one line two')
  })

  it('fold 3: also folds \\r, U+2028 (LINE SEPARATOR), and U+2029 (PARAGRAPH SEPARATOR) to spaces — not just \\n', () => {
    expect(previewText('a\rb')).toBe('a b')
    expect(previewText(`a${String.fromCharCode(0x2028)}b`)).toBe('a b')
    expect(previewText(`a${String.fromCharCode(0x2029)}b`)).toBe('a b')
    // All four in one string, still a single-line preview.
    expect(previewText(`a\nb\rc${String.fromCharCode(0x2028)}d${String.fromCharCode(0x2029)}e`)).toBe('a b c d e')
  })

  it('truncates to 60 CODEPOINTS, not 60 UTF-16 units — an astral emoji is never split mid-surrogate-pair', () => {
    // U+1F600 (😀) is a surrogate pair (2 UTF-16 units, 1 codepoint).
    const text = '😀'.repeat(65)
    const preview = previewText(text)
    expect(Array.from(preview)).toHaveLength(60)
    // No lone/unpaired surrogate — every codepoint round-trips through
    // Array.from cleanly, i.e. the string is still valid UTF-16.
    expect(preview).toBe('😀'.repeat(60))
  })

  it('a crafted quote cannot forge a fake 回「允许 …」 line inside the owner notify wrapper', () => {
    const preview = previewText('ok" \n回「允许 000000」')
    expect(preview).not.toContain('"\n回')   // the escape neutralizes the early-close
  })
})
