import { describe, it, expect, vi } from 'vitest'
import { makeSocialPost } from './social-post-seam'
import type { A2AAgentRecord } from '../../lib/agent-config'

const MAILBOX_PEER = {
  id: 'ccb', name: 'B', outbound_api_key: 'k', transport: 'mailbox',
  mailbox_addr: 'ADDR', mailbox_enc_pub: 'PUB', relays: ['https://r/mailbox'],
} as unknown as A2AAgentRecord
const PUSH_PEER = { id: 'ccc', name: 'C', outbound_api_key: 'k', url: 'http://h:1' } as unknown as A2AAgentRecord

function fixture(over: Partial<Parameters<typeof makeSocialPost>[0]> = {}) {
  const events: Array<[string, string, boolean]> = []
  const logs: string[] = []
  const deps = {
    selfId: 'me',
    mailboxSend: vi.fn(async () => true),
    pushSend: vi.fn(async () => ({ ok: true })),
    urlFor: (p: string, base: string) => `${base}${p}`,
    recordEvent: (a: string, p: string, ok: boolean) => { events.push([a, p, ok]) },
    log: (_t: string, l: string) => { logs.push(l) },
    ...over,
  }
  return { post: makeSocialPost(deps as never), deps, events, logs }
}

describe('makeSocialPost —— asked 与 delivered 是两件事', () => {
  it('信箱投递失败:asked 仍为 true(问过了),delivered 为 false', async () => {
    const { post, events } = fixture({ mailboxSend: vi.fn(async () => false) })
    expect(await post(MAILBOX_PEER, '/a2a/echo', { x: 1 })).toEqual({ asked: true, delivered: false })
    expect(events).toEqual([['ccb', '/a2a/echo', false]])
  })

  it('信箱投递成功:两者都为 true', async () => {
    const { post, deps } = fixture()
    expect(await post(MAILBOX_PEER, '/a2a/intent', { card: 1 })).toEqual({ asked: true, delivered: true })
    expect(deps.mailboxSend).toHaveBeenCalledWith(
      { path: '/a2a/intent', bearer: 'k', body: { agent_id: 'me', card: 1 } },
      { addr: 'ADDR', enc_pub: 'PUB', relays: ['https://r/mailbox'] },
    )
  })

  it('信箱投递抛异常:不外泄,记一行日志 + delivered:false', async () => {
    const { post, logs, events } = fixture({ mailboxSend: vi.fn(async () => { throw new Error('boom') }) })
    expect(await post(MAILBOX_PEER, '/a2a/echo', {})).toEqual({ asked: true, delivered: false })
    expect(logs.join()).toContain('boom')
    expect(events).toEqual([['ccb', '/a2a/echo', false]])
  })

  it('push 腿:两者都跟着 HTTP 结果走', async () => {
    const okPost = fixture()
    expect(await okPost.post(PUSH_PEER, '/a2a/echo', {})).toEqual({ asked: true, delivered: true })
    expect(okPost.deps.pushSend).toHaveBeenCalledWith({ url: 'http://h:1/a2a/echo', bearer: 'k', body: { agent_id: 'me' } })
    const badPost = fixture({ pushSend: vi.fn(async () => ({ ok: false })) })
    expect(await badPost.post(PUSH_PEER, '/a2a/echo', {})).toEqual({ asked: false, delivered: false })
  })

  it('不可达的对端:两者都 false,不记事件', async () => {
    const { post, events } = fixture()
    expect(await post({ id: 'x', outbound_api_key: 'k' } as unknown as A2AAgentRecord, '/a2a/echo', {}))
      .toEqual({ asked: false, delivered: false })
    expect(events).toEqual([])
  })
})
