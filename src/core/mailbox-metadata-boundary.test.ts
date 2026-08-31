/**
 * 元数据边界的特征测试(characterization test)。
 *
 * relay 是【内容盲】不是【元数据盲】—— 设计文档与 relay/README 都诚实记了
 * 这笔账,但全仓没有任何测试钉住"到底泄露了哪些元数据"。于是这条边界只
 * 存在于散文里:谁哪天往 /drop 的 body 里多加一个 from / intent_id /
 * channel_id,或者往信封外层多塞一个字段,都不会有任何东西响。
 *
 * 这里不试图把元数据变盲(那需要 sealed-sender / 混淆流量,是另一个项目),
 * 只把【当前暴露面】逐字钉死:任何让 relay 看见更多的改动都会撞红这里,
 * 逼作者显式地重新做这个权衡。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateMailboxIdentity, sealEnvelope, type PeerMailbox } from './mailbox-crypto'
import { makeMailboxClient } from './mailbox-client'
import { makeMailboxSender } from './mailbox-sender'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('信箱投递:relay 能看见什么、不能看见什么', () => {
  it('投递请求只暴露【收件地址】和【密文信封】—— 没有发件人、没有路由、没有业务 id', async () => {
    const peerId = generateMailboxIdentity()
    const peer: PeerMailbox = { addr: peerId.addr, enc_pub: peerId.enc_pub, relays: ['https://relay.example/'] }
    const seen: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (vi.fn(async (u: any, i: any) => {
      seen.push({ url: String(u), body: JSON.parse(String(i.body)) })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown) as typeof fetch

    await makeMailboxSender({ client: makeMailboxClient() }).send({
      path: '/a2a/reveal',
      bearer: 'SECRET-BEARER',
      body: { agent_id: 'cc-me', intent_id: 'i-42', peer_handle: { pubkey: 'PUB', channel_id: 'chan-7' } },
    }, peer)

    expect(seen).toHaveLength(1)
    const { url, body } = seen[0]!
    expect(url).toBe('https://relay.example/drop')

    // ① 请求体的键集必须恰好是这两个 —— 多一个都是新的元数据泄露
    expect(Object.keys(body).sort()).toEqual(['envelope', 'to'])
    expect(body.to).toBe(peer.addr)

    // ② 信封外层的键集必须恰好是这四个(全是密文/一次性公钥)
    const env = JSON.parse(String(body.envelope)) as Record<string, unknown>
    expect(Object.keys(env).sort()).toEqual(['ct', 'eph_pub', 'nonce', 'tag'])

    // ③ 整个上线字节里不得出现任何内层信息:路由 path、bearer、业务 id、handle
    const wire = JSON.stringify(body)
    for (const secret of ['/a2a/reveal', 'SECRET-BEARER', 'cc-me', 'i-42', 'chan-7', 'PUB']) {
      expect(wire).not.toContain(secret)
    }
  })

  it('同一份内容投两次,上线字节不同(一次性发信钥 ⇒ relay 不能靠比对密文关联)', async () => {
    const peerId = generateMailboxIdentity()
    const inner = { path: '/a2a/letter', bearer: 'b', body: { channel_id: 'c', nonce: 'n', ct: 'x', tag: 't' } }
    const a = JSON.stringify(sealEnvelope(inner, peerId.enc_pub))
    const b = JSON.stringify(sealEnvelope(inner, peerId.enc_pub))
    expect(a).not.toBe(b)
  })

  it('已知且刻意接受的暴露:收件地址、投递时刻、信封长度 —— 这三项 relay 看得见', () => {
    const peerId = generateMailboxIdentity()
    const env = sealEnvelope({ path: '/a2a/intent', bearer: 'b', body: { card: { topic: '找摄影搭子' } } }, peerId.enc_pub)
    // 收件地址是"地址即能力"的寻址基础,长度随明文增长 —— 都是 v0 已记账的
    // 妥协(relay/README §M2、设计文档 §11)。此处仅确认它们确实【只有】这些:
    // 密文长度随明文变化,但内容本身不可读。
    expect(env.ct.length).toBeGreaterThan(0)
    expect(JSON.stringify(env)).not.toContain('摄影')
  })
})
