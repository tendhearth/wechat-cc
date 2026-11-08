import { describe, it, expect } from 'vitest'
import { makeRoutes } from './routes'
import type { InternalApiDelegateDep } from './types'

// 话题 T3:主人自己的会话(admin)发起的咨询带话题简报、回答写回;别的档位不带、不写;简报出错照常咨询。
function setup(brief: NonNullable<InternalApiDelegateDep['topics']>['brief']) {
  const sent: string[] = [], written: unknown[][] = []
  const d: InternalApiDelegateDep = {
    knownPeers: () => ['codex'],
    dispatchOneShot: async (_p, prompt) => { sent.push(prompt); return { ok: true, response: '用 hysteria2' } },
    topics: { brief, writeBack: async (...a) => { written.push(a) } },
  }
  const routes = makeRoutes({ deps: {} as never, getDelegate: () => d, maybePrefix: (_c, t) => t })
  const post = (caller: unknown) => routes['POST /v1/delegate']!(new URLSearchParams(), { peer: 'codex', prompt: 'bx 的 UDP 怎么配' }, caller as never)
  return { sent, written, post }
}

describe('POST /v1/delegate · 话题简报', () => {
  it('admin:简报接在 prompt 后面,回答写回碰到的话题', async () => {
    const seen: Array<[string | undefined, string]> = []
    const s = setup(async (chatId, prompt) => { seen.push([chatId, prompt]); return { text: 'CC 记得的相关背景:\n- UDP 走 hysteria2', topicIds: ['thr_bx'] } })
    const r = await s.post({ tier: 'admin', origin: 'session', chatId: 'owner' })
    expect(r.status).toBe(200)
    expect(seen[0]![0]).toBe('owner')
    expect(s.sent[0]).toBe('bx 的 UDP 怎么配\n\nCC 记得的相关背景:\n- UDP 走 hysteria2')
    expect(s.written).toEqual([[['thr_bx'], 'codex', 'bx 的 UDP 怎么配', '用 hysteria2']])
  })
  it('不是 admin / 没有调用方 ⇒ 不问简报、不写回', async () => {
    let asked = 0
    const s = setup(async () => { asked++; return { text: 'x', topicIds: ['t'] } })
    await s.post({ tier: 'trusted', origin: 'session', chatId: 'owner' })
    await s.post(undefined)
    expect(asked).toBe(0)
    expect(s.sent).toEqual(['bx 的 UDP 怎么配', 'bx 的 UDP 怎么配'])
    expect(s.written).toEqual([])
  })
  it('简报抛错 ⇒ 照常咨询', async () => {
    const s = setup(async () => { throw new Error('boom') })
    const r = await s.post({ tier: 'admin', origin: 'session', chatId: 'owner' })
    expect(r.body).toMatchObject({ ok: true })
    expect(s.sent).toEqual(['bx 的 UDP 怎么配'])
  })
})
