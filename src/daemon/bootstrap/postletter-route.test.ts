import { describe, it, expect, vi } from 'vitest'
import { makeRoutePostLetter } from './postletter-route'

describe('postLetter routing', () => {
  it('a target WITH a mailbox is sealed+dropped (relay-direct), NOT sent over push', async () => {
    const send = vi.fn(async () => true)
    const push = vi.fn(async () => true)
    const route = makeRoutePostLetter({ mailboxSend: send, pushSend: push, selfId: 'wechat-cc' })
    const ok = await route({ agentId: 'q', relayVia: null, mailbox: { addr: 'A', enc_pub: 'E', relays: ['https://r/'] } }, { channel_id: 'pc', nonce: 'n', ct: 'x', tag: 't' })
    expect(ok).toBe(true); expect(send).toHaveBeenCalledOnce(); expect(push).not.toHaveBeenCalled()
  })
  it('a push-only target (no mailbox) falls through to the Task-9 push/W path', async () => {
    const send = vi.fn(async () => true); const push = vi.fn(async () => true)
    const route = makeRoutePostLetter({ mailboxSend: send, pushSend: push, selfId: 'wechat-cc' })
    await route({ agentId: 'q', relayVia: 'w', mailbox: undefined }, { channel_id: 'pc', nonce: 'n', ct: 'x', tag: 't' })
    expect(push).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled()
  })
})
