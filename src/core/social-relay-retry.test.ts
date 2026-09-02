import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../lib/db'
import { makeRelayStore } from './social-relay-store'
import { makeRelayRetry } from './social-relay-retry'
import type { PenpalHandle } from './penpal-crypto'

const S: PenpalHandle = { pubkey: 'pk-s', channel_id: 'chan-s' }
const Q: PenpalHandle = { pubkey: 'pk-q', channel_id: 'chan-q' }

function fixture(postEcho: any, postReveal: any) {
  const db = openDb({ path: ':memory:' })
  const relayStore = makeRelayStore(db)
  relayStore.create({ id: 'i1:T', intentId: 'i1', relayToken: 'T', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
  const logs: string[] = []
  const retry = makeRelayRetry({ relayStore, postEcho, postReveal, log: (_t, l) => logs.push(l) })
  return { relayStore, retry, logs }
}

// 介绍人(W)替两端跑腿,而它的每一条外发都是 fire-and-forget。掉了之后:
// Q 以为自己答过了、S 什么都没收到;或者互揭达成了但某一端永久停在
// awaiting_peer,而 W 的行说「两条腿都揭晓了」,重试走 legAlready 直接返回。
// 跟 v32 是同一个形状,只是发生在 W 身上。
describe('makeRelayRetry —— 转发明信片的欠账', () => {
  it('记了要转、没送到 → 重投;成功后销账', async () => {
    const postEcho = vi.fn<any>(async () => true)
    const { relayStore, retry } = fixture(postEcho, vi.fn())
    relayStore.setOwedEcho('i1:T', '我认识一位修相机的师傅', 2, new Date().toISOString())

    expect(await retry.retryRelay()).toEqual({ echoes: 1, completions: 0 })
    expect(postEcho).toHaveBeenCalledWith('ccs', { intent_id: 'i1', echo: { blurb: '我认识一位修相机的师傅', degree: 2, relay_token: 'T' } })
    expect(relayStore.get('i1:T')!.echo_delivered_at).not.toBeNull()

    postEcho.mockClear()
    expect(await retry.retryRelay()).toEqual({ echoes: 0, completions: 0 })
    expect(postEcho).not.toHaveBeenCalled()
  })

  it('还是不通 → 不销账,下一拍再来', async () => {
    const postEcho = vi.fn<any>(async () => false)
    const { relayStore, retry } = fixture(postEcho, vi.fn())
    relayStore.setOwedEcho('i1:T', 'b', 2, new Date().toISOString())
    expect(await retry.retryRelay()).toEqual({ echoes: 0, completions: 0 })
    expect(relayStore.get('i1:T')!.echo_delivered_at).toBeNull()
  })

  it('没记过明信片的 relay 行不碰', async () => {
    const postEcho = vi.fn<any>(async () => true)
    const { retry } = fixture(postEcho, vi.fn())
    expect(await retry.retryRelay()).toEqual({ echoes: 0, completions: 0 })
    expect(postEcho).not.toHaveBeenCalled()
  })
})

describe('makeRelayRetry —— complete 回投的欠账', () => {
  function bothRevealed(relayStore: ReturnType<typeof makeRelayStore>) {
    relayStore.setUpstreamHandle('i1:T', S)
    relayStore.setDownstreamHandle('i1:T', Q)
    relayStore.setUpstreamRevealed('i1:T', '2026-09-02T00:00:00.000Z')
    relayStore.setDownstreamRevealed('i1:T', '2026-09-02T00:00:01.000Z')
  }

  it('两条腿都揭晓、两端都没 complete → 各补一次,方向与 handle 都对', async () => {
    const postReveal = vi.fn<any>(async () => true)
    const { relayStore, retry } = fixture(vi.fn(), postReveal)
    bothRevealed(relayStore)

    expect(await retry.retryRelay()).toEqual({ echoes: 0, completions: 2 })
    // 给 S 的那条带 relay_token,并交叉 Q 的 handle
    expect(postReveal).toHaveBeenCalledWith('ccs', { intent_id: 'i1', relay_token: 'T', peer_handle: Q })
    // 给 Q 的那条不带 token,交叉 S 的 handle
    expect(postReveal).toHaveBeenCalledWith('ccq', { intent_id: 'i1', peer_handle: S })
    const r = relayStore.get('i1:T')!
    expect(r.upstream_completed_at).not.toBeNull()
    expect(r.downstream_completed_at).not.toBeNull()
  })

  it('只欠一端就只补一端', async () => {
    const postReveal = vi.fn<any>(async () => true)
    const { relayStore, retry } = fixture(vi.fn(), postReveal)
    bothRevealed(relayStore)
    relayStore.setUpstreamCompleted('i1:T', '2026-09-02T00:00:02.000Z')

    expect(await retry.retryRelay()).toEqual({ echoes: 0, completions: 1 })
    expect(postReveal).toHaveBeenCalledTimes(1)
    expect(postReveal).toHaveBeenCalledWith('ccq', { intent_id: 'i1', peer_handle: S })
  })

  it('只有一条腿揭晓 → 什么都不补(还没到互揭,complete 无从谈起)', async () => {
    const postReveal = vi.fn<any>(async () => true)
    const { relayStore, retry } = fixture(vi.fn(), postReveal)
    relayStore.setUpstreamHandle('i1:T', S)
    relayStore.setUpstreamRevealed('i1:T', '2026-09-02T00:00:00.000Z')
    expect(await retry.retryRelay()).toEqual({ echoes: 0, completions: 0 })
    expect(postReveal).not.toHaveBeenCalled()
  })

  it('handle 没存全 → 不补,也不销账(交叉一个空 handle 比不交叉更糟)', async () => {
    const postReveal = vi.fn<any>(async () => true)
    const { relayStore, retry } = fixture(vi.fn(), postReveal)
    relayStore.setUpstreamRevealed('i1:T', '2026-09-02T00:00:00.000Z')
    relayStore.setDownstreamRevealed('i1:T', '2026-09-02T00:00:01.000Z')
    expect(await retry.retryRelay()).toEqual({ echoes: 0, completions: 0 })
    expect(postReveal).not.toHaveBeenCalled()
    expect(relayStore.get('i1:T')!.upstream_completed_at).toBeNull()
  })

  it('超过 14 天不再自动补 —— 与揭晓/明信片同一条 no-retry-storm 界', async () => {
    const postReveal = vi.fn<any>(async () => true)
    const postEcho = vi.fn<any>(async () => true)
    const { relayStore, retry } = fixture(postEcho, postReveal)
    bothRevealed(relayStore)
    relayStore.setOwedEcho('i1:T', 'b', 2, new Date(Date.now() - 15 * 864e5).toISOString())
    // created_at 是 relay 建行时间;把 revealed 时刻也推老
    relayStore.setUpstreamRevealed('i1:T', new Date(Date.now() - 15 * 864e5).toISOString())
    relayStore.setDownstreamRevealed('i1:T', new Date(Date.now() - 15 * 864e5).toISOString())

    expect(await retry.retryRelay()).toEqual({ echoes: 0, completions: 0 })
    expect(postEcho).not.toHaveBeenCalled()
    expect(postReveal).not.toHaveBeenCalled()
  })

  it('投递抛异常不外泄,只留日志', async () => {
    const postReveal = vi.fn<any>(async () => { throw new Error('boom') })
    const { relayStore, retry, logs } = fixture(vi.fn(), postReveal)
    bothRevealed(relayStore)
    expect(await retry.retryRelay()).toEqual({ echoes: 0, completions: 0 })
    expect(logs.join()).toContain('boom')
  })
})
