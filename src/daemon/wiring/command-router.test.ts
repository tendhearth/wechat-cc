import { describe, expect, it, vi } from 'vitest'
import { makeCommandRouter, type CommandRouterDeps } from './command-router'
import type { InboundMsg } from '../../core/prompt-format'

function msg(text: string, chatId = 'owner@im.wechat'): InboundMsg {
  return { chatId, userId: chatId, text, msgType: 'text', createTimeMs: 0, accountId: 'acct' }
}

function baseDeps(over: Partial<CommandRouterDeps> = {}): CommandRouterDeps {
  return {
    isAdmin: () => true,
    loadAccess: () => ({ admins: ['owner@im.wechat'] }),
    appendAllowFrom: vi.fn(),
    sendAssistantText: vi.fn(),
    guestRequests: {
      resolve: vi.fn(() => null),
      listPending: vi.fn(() => []),
      createInvite: vi.fn(() => ({ code: '999999', expiresAt: 0 })),
    } as never,
    hydrateRoute: vi.fn(),
    sendMessage: vi.fn(async () => ({})),
    redispatch: vi.fn(async () => {}),
    log: vi.fn(),
    now: () => 1_000_000,
    ...over,
  }
}

describe('command-router', () => {
  it('a non-admin chat handles nothing (falls through)', async () => {
    const r = makeCommandRouter(baseDeps({ isAdmin: () => false }))
    expect(await r.tryHandle(msg('允许 123456'))).toBe(false)
    expect(await r.tryHandle(msg('揭晓 abc'))).toBe(false)
  })

  it('a plain message (no command) falls through', async () => {
    const r = makeCommandRouter(baseDeps())
    expect(await r.tryHandle(msg('今天天气不错'))).toBe(false)
  })

  it('揭晓 is handled only when boot.social is wired', async () => {
    const revealEcho = vi.fn(async () => 'ok')
    const social = { revealer: { revealEcho, revealPledge: vi.fn(async () => null) } } as never
    const withSocial = makeCommandRouter(baseDeps({ social }))
    expect(await withSocial.tryHandle(msg('揭晓 a1b2c3'))).toBe(true)
    expect(revealEcho).toHaveBeenCalledWith('a1b2c3')
    // without social wired → inert, falls through
    const noSocial = makeCommandRouter(baseDeps({ social: undefined }))
    expect(await noSocial.tryHandle(msg('揭晓 a1b2c3'))).toBe(false)
  })

  it('回信 sends a letter via boot.penpal', async () => {
    const sendLetter = vi.fn(async () => ({ ok: true }))
    const r = makeCommandRouter(baseDeps({ penpal: { sendLetter } }))
    expect(await r.tryHandle(msg('回信 ch1 你好呀'))).toBe(true)
    expect(sendLetter).toHaveBeenCalledWith('ch1', '你好呀')
  })

  it('guest 允许 resolves the code, allowlists, hydrates, welcomes, redispatches', async () => {
    const resolve = vi.fn(() => ({ chatId: 'guest@im.wechat', accountId: 'acct', contextToken: 'ctx', firstMsg: msg('在吗', 'guest@im.wechat') }))
    const appendAllowFrom = vi.fn()
    const hydrateRoute = vi.fn()
    const sendMessage = vi.fn(async () => ({}))
    const redispatch = vi.fn(async () => {})
    const deps = baseDeps({
      guestRequests: { resolve, listPending: vi.fn(() => []), createInvite: vi.fn() } as never,
      appendAllowFrom, hydrateRoute, sendMessage, redispatch,
    })
    const r = makeCommandRouter(deps)
    expect(await r.tryHandle(msg('允许 123456'))).toBe(true)
    expect(resolve).toHaveBeenCalledWith('123456', 'allowed')
    expect(appendAllowFrom).toHaveBeenCalledWith('guest@im.wechat')
    expect(hydrateRoute).toHaveBeenCalledWith('guest@im.wechat', 'acct', 'ctx')
    expect(sendMessage).toHaveBeenCalledWith('guest@im.wechat', '主人同意啦!')
    expect(redispatch).toHaveBeenCalledTimes(1)
  })

  it('guest path is closed on an admins-empty install (escalation guard)', async () => {
    // legacy install: admins empty → isAdmin may be true via allowFrom, but
    // the guest-command block must NOT fire (an approved guest could else
    // mint invites / approve others). Falls through instead.
    const resolve = vi.fn(() => null)
    const r = makeCommandRouter(baseDeps({
      loadAccess: () => ({ admins: [] }),
      guestRequests: { resolve, listPending: vi.fn(() => []), createInvite: vi.fn() } as never,
    }))
    expect(await r.tryHandle(msg('允许 123456'))).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('待批准 lists pending requests', async () => {
    const send = vi.fn()
    const r = makeCommandRouter(baseDeps({
      sendAssistantText: send,
      guestRequests: {
        resolve: vi.fn(), createInvite: vi.fn(),
        listPending: vi.fn(() => [{ code: '111111', chatId: 'g@im.wechat', firstMsg: msg('借钱', 'g@im.wechat'), createdAt: 1_000_000 }]),
      } as never,
    }))
    expect(await r.tryHandle(msg('待批准'))).toBe(true)
    expect(send).toHaveBeenCalled()
    expect(String(send.mock.calls[0]![1])).toContain('111111')
  })
})
