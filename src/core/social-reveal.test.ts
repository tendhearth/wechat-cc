import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../lib/db'
import { makeEchoStore } from './social-echo-store'
import { makePledgeStore } from './social-pledge-store'
import { makeSeekStore } from './social-seek-store'
import { makeRevealer } from './social-reveal'
import type { PenpalHandle, ChannelPort } from './social-reveal'   // ChannelPort re-exported from here

const SELF_HANDLE: PenpalHandle = { pubkey: 'SELF_PUB', channel_id: 'self-chan' }
const PEER_HANDLE: PenpalHandle = { pubkey: 'PEER_PUB', channel_id: 'peer-chan' }

function fixture(postPeerReveal: any) {
  const db = openDb({ path: ':memory:' })
  const echoStore = makeEchoStore(db)
  const pledgeStore = makePledgeStore(db)
  const seekStore = makeSeekStore(db)
  const notify = vi.fn()
  const opened: string[] = []; const finalized: Array<[string, PenpalHandle | undefined]> = []
  const stashed: Array<[string, PenpalHandle]> = []
  const channel: ChannelPort = {
    openLocal: (rowId) => { opened.push(rowId); return SELF_HANDLE },
    finalize: (rowId, h) => { finalized.push([rowId, h]) },
    stashPeer: (rowId, h) => { stashed.push([rowId, h]) },
  }
  const revealer = makeRevealer({ echoStore, pledgeStore, seekStore, postPeerReveal, channel, notify })
  return { db, echoStore, pledgeStore, seekStore, notify, revealer, opened, finalized, stashed }
}

describe('makeRevealer — echo side (I reveal first)', () => {
  it('I reveal, peer already consented → mutual: echo revealed, seek connected, handle crossed, beat #3', async () => {
    const post = vi.fn(async () => ({ mutual: true, handle: PEER_HANDLE }))
    const { echoStore, seekStore, notify, revealer, opened, finalized } = fixture(post)
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const out = await revealer.revealEcho('i1:ccb')

    expect(out).toEqual({ state: 'connected' })
    expect(post).toHaveBeenCalledWith('ccb', 'i1')
    const echo = echoStore.get('i1:ccb')!
    expect(echo.status).toBe('revealed')
    expect(echo.self_revealed_at).not.toBeNull()
    expect(echo.peer_revealed_at).not.toBeNull()
    expect(echo.peer_masked).toBe('第 1 度的某人')            // masked stays masked — real identity never crosses
    expect(opened).toContain('i1:ccb')
    expect(finalized).toContainEqual(['i1:ccb', PEER_HANDLE])
    expect(seekStore.get('i1')!.status).toBe('connected')
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i1' }))
    expect(notify.mock.calls.find((c) => c[0] === 'connected')![1]).not.toHaveProperty('peerName')
  })

  it('I reveal, peer has NOT → awaiting_peer, my consent persisted, no connected beat', async () => {
    const post = vi.fn(async () => ({ mutual: false }))
    const { echoStore, seekStore, notify, revealer } = fixture(post)
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const out = await revealer.revealEcho('i1:ccb')

    expect(out).toEqual({ state: 'awaiting_peer' })
    expect(echoStore.get('i1:ccb')!.self_revealed_at).not.toBeNull()
    expect(echoStore.get('i1:ccb')!.peer_revealed_at).toBeNull()
    expect(seekStore.get('i1')!.status).toBe('foraging')
    expect(notify).not.toHaveBeenCalledWith('connected', expect.anything())
  })

  it('peer unreachable → peer_unreachable, my consent is NOT lost, retryable', async () => {
    const post = vi.fn(async () => null)
    const { echoStore, revealer } = fixture(post)
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const out = await revealer.revealEcho('i1:ccb')

    expect(out).toEqual({ state: 'peer_unreachable' })
    expect(echoStore.get('i1:ccb')!.self_revealed_at).not.toBeNull()
  })

  it('double reveal after connected is a no-op (idempotent)', async () => {
    const post = vi.fn(async () => ({ mutual: true, handle: PEER_HANDLE }))
    const { echoStore, revealer } = fixture(post)
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    await revealer.revealEcho('i1:ccb')
    post.mockClear()
    const out = await revealer.revealEcho('i1:ccb')
    expect(out).toEqual({ state: 'connected' })
    expect(post).not.toHaveBeenCalled()                     // already mutual → no second outbound call
  })

  it('returns null when the echo id does not exist', async () => {
    const { revealer } = fixture(vi.fn(async () => null))
    expect(await revealer.revealEcho('nope:ccb')).toBeNull()
  })
})

describe('makeRevealer — inbound (peer reveals first)', () => {
  it('peer reveals before me → mutual:false, beat #2 (await_reveal) fires; peerHandle stashed but channel NOT opened', () => {
    const { echoStore, notify, revealer, stashed } = fixture(vi.fn())
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const resp = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1', peerHandle: PEER_HANDLE })

    expect(resp).toEqual({ mutual: false })
    expect(echoStore.get('i1:ccb')!.peer_revealed_at).not.toBeNull()
    expect(notify).toHaveBeenCalledWith('await_reveal', expect.objectContaining({ intentId: 'i1', peerAgentId: 'ccb' }))
    // 2026-08-30:handle 现在【立刻落盘】。旧行为是丢弃、靠我后揭晓时的同步
    // mutual 响应补送 —— 信箱传输没有同步响应,那样会让后揭晓的一方永远停在
    // pending 通道上(见下面的异步 describe)。提前铸行是纯本地动作,我的
    // handle 在我真正同意之前不会送出去。
    expect(stashed).toContainEqual(['i1:ccb', PEER_HANDLE])
  })

  it('second revealer gets mutual synchronously with our handle (I revealed first, peer calls in)', () => {
    const { echoStore, seekStore, notify, revealer, finalized } = fixture(vi.fn())
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    echoStore.setSelfRevealed('i1:ccb', '2026-07-15T00:00:00.000Z')  // I already revealed

    const resp = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1', peerHandle: PEER_HANDLE })

    expect(resp).toEqual({ mutual: true, handle: SELF_HANDLE })
    expect(echoStore.get('i1:ccb')!.status).toBe('revealed')
    expect(echoStore.get('i1:ccb')!.peer_masked).toBe('第 1 度的某人')   // masked stays masked
    expect(seekStore.get('i1')!.status).toBe('connected')
    expect(finalized).toContainEqual(['i1:ccb', PEER_HANDLE])
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i1', peerAgentId: 'ccb' }))
  })

  it('resolves against a pledge when there is no echo (I answered THEIR wish)', () => {
    const { pledgeStore, notify, revealer } = fixture(vi.fn())
    pledgeStore.create({ id: 'i2:cca', intentId: 'i2', seekerAgentId: 'cca', topic: 't' })

    const resp = revealer.onInboundReveal({ agentId: 'cca', intentId: 'i2', peerHandle: PEER_HANDLE })

    expect(resp).toEqual({ mutual: false })
    expect(pledgeStore.get('i2:cca')!.peer_revealed_at).not.toBeNull()
    expect(notify).toHaveBeenCalledWith('await_reveal', expect.objectContaining({ intentId: 'i2', peerAgentId: 'cca' }))
  })

  it('no matching row → mutual:false, no throw', () => {
    const { revealer } = fixture(vi.fn())
    expect(revealer.onInboundReveal({ agentId: 'zzz', intentId: 'nope' })).toEqual({ mutual: false })
  })

  it('duplicate inbound reveal before I reveal → await_reveal notify fires exactly once', () => {
    const { echoStore, notify, revealer } = fixture(vi.fn())
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const first = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })
    const second = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })

    expect(first).toEqual({ mutual: false })
    expect(second).toEqual({ mutual: false })
    expect(notify.mock.calls.filter((c) => c[0] === 'await_reveal').length).toBe(1)
  })

  it('duplicate inbound reveal after connected → connected notify fires exactly once, second call still returns mutual', () => {
    const { echoStore, seekStore, notify, revealer } = fixture(vi.fn())
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    echoStore.setSelfRevealed('i1:ccb', '2026-07-15T00:00:00.000Z')  // I already revealed

    const first = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })
    const second = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })

    expect(first).toEqual({ mutual: true, handle: SELF_HANDLE })
    expect(second).toEqual({ mutual: true, handle: SELF_HANDLE })
    expect(notify.mock.calls.filter((c) => c[0] === 'connected').length).toBe(1)
  })
})

describe('makeRevealer — pledge side (I reveal my answer)', () => {
  it('revealPledge mutual → connected beat, timestamps set, handle crossed via channel', async () => {
    const post = vi.fn(async () => ({ mutual: true, handle: PEER_HANDLE }))
    const { pledgeStore, notify, revealer, finalized } = fixture(post)
    pledgeStore.create({ id: 'i2:cca', intentId: 'i2', seekerAgentId: 'cca', topic: 't' })

    const out = await revealer.revealPledge('i2:cca')

    expect(out).toEqual({ state: 'connected' })
    expect(post).toHaveBeenCalledWith('cca', 'i2')
    expect(pledgeStore.get('i2:cca')!.self_revealed_at).not.toBeNull()
    expect(pledgeStore.get('i2:cca')!.peer_revealed_at).not.toBeNull()
    expect(finalized).toContainEqual(['i2:cca', PEER_HANDLE])
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i2' }))
    expect(notify.mock.calls.find((c) => c[0] === 'connected')![1]).not.toHaveProperty('peerName')
  })

  it('identity never leaks before reveal — masked placeholder intact, inbound returns no handle', () => {
    const { echoStore, revealer } = fixture(vi.fn())
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    // Before any reveal, the masked placeholder is intact and no identity is exposed.
    expect(echoStore.get('i1:ccb')!.peer_masked).toBe('第 1 度的某人')
    // An inbound reveal we have NOT matched with our own consent returns no handle.
    expect(revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })).toEqual({ mutual: false })
  })
})

describe('makeRevealer — relay branch (2-hop, spec #2)', () => {
  it('revealEcho on a relay echo posts to relay_via carrying the relay_token', async () => {
    const post = vi.fn(async () => ({ mutual: false }))
    const { echoStore, revealer, opened } = fixture(post)
    // Relay echo: peer_agent_id null, relay_via = W, relay_token = T, id = intent:W:T.
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    const out = await revealer.revealEcho('i1:ccw:T')
    expect(out).toEqual({ state: 'awaiting_peer' })
    expect(post).toHaveBeenCalledWith('ccw', 'i1', 'T')   // addressed to W, carries the token
    expect(echoStore.get('i1:ccw:T')!.self_revealed_at).not.toBeNull()
    expect(opened).toContain('i1:ccw:T')
  })

  it('relay revealEcho mutual → connected, handle crossed via channel finalize (masked stays masked)', async () => {
    const post = vi.fn(async () => ({ mutual: true, handle: PEER_HANDLE }))   // W returns Q's handle
    const { echoStore, seekStore, revealer, finalized } = fixture(post)
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    const out = await revealer.revealEcho('i1:ccw:T')
    expect(out).toEqual({ state: 'connected' })
    expect(echoStore.get('i1:ccw:T')!.peer_masked).toBe('第 2 度的某人')
    expect(finalized).toContainEqual(['i1:ccw:T', PEER_HANDLE])
    expect(seekStore.get('i1')!.status).toBe('connected')
  })

  it('inbound relay reveal (carries relay_token) resolves the relay echo, not the direct key', () => {
    const { echoStore, notify, revealer, stashed } = fixture(vi.fn())
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    const resp = revealer.onInboundReveal({ agentId: 'ccw', intentId: 'i1', relayToken: 'T', peerHandle: PEER_HANDLE })
    expect(resp).toEqual({ mutual: false })
    expect(echoStore.get('i1:ccw:T')!.peer_revealed_at).not.toBeNull()
    expect(notify).toHaveBeenCalledWith('await_reveal', expect.objectContaining({ intentId: 'i1' }))
    // 2026-08-30:与 direct 分支一致,提前落盘并按【中继腿的 rowId】归位
    // (中继腿恰恰是最需要它的场景 —— 两端都在 NAT 后、只能走信箱)。
    expect(stashed).toEqual([['i1:ccw:T', PEER_HANDLE]])
  })

  it('inbound relay reveal completing me → mutual, crosses handle via channel, content-free notify', () => {
    const { echoStore, seekStore, notify, revealer, finalized } = fixture(vi.fn())
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    echoStore.setSelfRevealed('i1:ccw:T', '2026-07-15T00:00:00.000Z')   // I revealed first
    const resp = revealer.onInboundReveal({ agentId: 'ccw', intentId: 'i1', relayToken: 'T', peerHandle: PEER_HANDLE })
    expect(resp).toEqual({ mutual: true, handle: SELF_HANDLE })
    expect(echoStore.get('i1:ccw:T')!.peer_masked).toBe('第 2 度的某人')          // masked stays masked
    expect(finalized).toContainEqual(['i1:ccw:T', PEER_HANDLE])
    expect(seekStore.get('i1')!.status).toBe('connected')
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i1' }))
    expect(notify.mock.calls.find((c) => c[0] === 'connected')![1]).not.toHaveProperty('peerName')
  })

  it('retried relay inbound after mutual is idempotent (no duplicate connected beat)', () => {
    const { echoStore, seekStore, notify, revealer } = fixture(vi.fn())
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    echoStore.setSelfRevealed('i1:ccw:T', '2026-07-15T00:00:00.000Z')
    const first = revealer.onInboundReveal({ agentId: 'ccw', intentId: 'i1', relayToken: 'T', peerHandle: PEER_HANDLE })
    const second = revealer.onInboundReveal({ agentId: 'ccw', intentId: 'i1', relayToken: 'T', peerHandle: PEER_HANDLE })
    expect(first).toEqual({ mutual: true, handle: SELF_HANDLE })
    expect(second).toEqual({ mutual: true, handle: SELF_HANDLE })
    expect(notify.mock.calls.filter((c: any[]) => c[0] === 'connected').length).toBe(1)
  })
})

// 2026-08-30 —— 信箱(异步)传输下的互揭收口。
// 信箱是「投递即返回」:成功投出只能报 {mutual:false},没有同步响应可以
// 回递对方的 handle。互揭这件事本来就被设计成「两台机器各自两行、都标记即
// 成立」,所以判定必须从本地行推出,而不是依赖传输层的答复。
describe('makeRevealer — 异步传输(信箱)下的互揭', () => {
  it('对端先揭晓、我后揭晓,传输层给不出 mutual → 我仍然 connected 且握有对方 handle', async () => {
    const post = vi.fn(async () => ({ mutual: false }))   // 信箱投递成功的唯一可能答复
    const { echoStore, seekStore, notify, revealer, stashed } = fixture(post)
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    // ① 对端先揭晓:我尚未同意,但对方的 handle 必须留住(没有第二次机会)
    revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1', peerHandle: PEER_HANDLE })
    expect(stashed).toContainEqual(['i1:ccb', PEER_HANDLE])

    // ② 我后揭晓:本地两行都已标记 ⇒ 已连上,不该停在 awaiting_peer
    const outcome = await revealer.revealEcho('i1:ccb')
    expect(outcome).toEqual({ state: 'connected' })
    expect(echoStore.get('i1:ccb')!.status).toBe('revealed')
    expect(seekStore.get('i1')!.status).toBe('connected')
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i1' }))
  })

  it('pledge 侧同理:对端先揭晓后我后揭晓,异步也能连上', async () => {
    const post = vi.fn(async () => ({ mutual: false }))
    const { pledgeStore, revealer, stashed } = fixture(post)
    pledgeStore.create({ id: 'i2:ccs', intentId: 'i2', seekerAgentId: 'ccs', topic: 't' })

    revealer.onInboundReveal({ agentId: 'ccs', intentId: 'i2', peerHandle: PEER_HANDLE })
    expect(stashed).toContainEqual(['i2:ccs', PEER_HANDLE])

    expect(await revealer.revealPledge('i2:ccs')).toEqual({ state: 'connected' })
    expect(pledgeStore.get('i2:ccs')!.peer_revealed_at).not.toBeNull()
  })

  it('对端根本没揭晓过 → 异步投递后仍是 awaiting_peer(不能假装连上)', async () => {
    const post = vi.fn(async () => ({ mutual: false }))
    const { echoStore, seekStore, revealer, notify } = fixture(post)
    seekStore.create({ id: 'i3', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i3:ccb', seekId: 'i3', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    expect(await revealer.revealEcho('i3:ccb')).toEqual({ state: 'awaiting_peer' })
    expect(echoStore.get('i3:ccb')!.status).not.toBe('revealed')
    expect(notify).not.toHaveBeenCalledWith('connected', expect.anything())
  })
})

// 2026-09-01 真机 bug:Windows 07:45 揭晓 → 本地写下 self_revealed_at → 信箱
// 投递失败(那会儿它掉网了)→ 返回 peer_unreachable。07:47 Mac 的揭晓到达,
// 把 peer_revealed_at 也写上了。08:46 我在 Windows 上重试揭晓,函数看见两个
// 时间戳都在,直接短路返回 connected —— **一次都没重发**。Mac 那边永远停在
// awaiting_peer,而两台机器都不会再说一句话。
//
// 根因:`peer_revealed_at` 只证明「对方的揭晓到了我这」,完全不证明「我的
// 揭晓到了对方那」。后者是一个独立的事实,以前没有任何地方记它,于是投递
// 失败会**永久毒化**这次揭晓,重试还理直气壮地报「已连接」。
describe('makeRevealer — 投递失败不能毒化揭晓(self_reveal_delivered_at)', () => {
  it('pledge:投递失败后对方揭晓到达,重试必须重发而不是短路报 connected', async () => {
    const post = vi.fn<any>(async () => null)                 // 信箱掉线
    const { pledgeStore, revealer } = fixture(post)
    pledgeStore.create({ id: 'i9:cca', intentId: 'i9', seekerAgentId: 'cca', topic: 't' })

    expect(await revealer.revealPledge('i9:cca')).toEqual({ state: 'peer_unreachable' })

    // 对方的揭晓随后落到我的信箱里 —— 现在本地两个时间戳都有了
    revealer.onInboundReveal({ agentId: 'cca', intentId: 'i9', peerHandle: PEER_HANDLE })
    const row = pledgeStore.get('i9:cca')!
    expect(row.self_revealed_at).not.toBeNull()
    expect(row.peer_revealed_at).not.toBeNull()

    post.mockClear()
    post.mockImplementation(async () => ({ mutual: false }))  // 网络恢复
    const out = await revealer.revealPledge('i9:cca')

    expect(post).toHaveBeenCalledWith('cca', 'i9')            // ← 必须重发
    expect(out).toEqual({ state: 'connected' })
  })

  it('echo:同样的形状 —— 投递失败 + 对方先到,重试要重发', async () => {
    const post = vi.fn<any>(async () => null)
    const { echoStore, seekStore, revealer } = fixture(post)
    seekStore.create({ id: 'i9', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i9:ccb', seekId: 'i9', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    expect(await revealer.revealEcho('i9:ccb')).toEqual({ state: 'peer_unreachable' })
    revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i9', peerHandle: PEER_HANDLE })

    post.mockClear()
    post.mockImplementation(async () => ({ mutual: false }))
    const out = await revealer.revealEcho('i9:ccb')

    expect(post).toHaveBeenCalledWith('ccb', 'i9')
    expect(out).toEqual({ state: 'connected' })
  })

  it('投递成功过就不再重发(短路仍然成立,不是把幂等改坏了)', async () => {
    const post = vi.fn<any>(async () => ({ mutual: true, handle: PEER_HANDLE }))
    const { pledgeStore, revealer } = fixture(post)
    pledgeStore.create({ id: 'i8:cca', intentId: 'i8', seekerAgentId: 'cca', topic: 't' })

    expect(await revealer.revealPledge('i8:cca')).toEqual({ state: 'connected' })
    post.mockClear()
    expect(await revealer.revealPledge('i8:cca')).toEqual({ state: 'connected' })
    expect(post).not.toHaveBeenCalled()
  })

  it('投递成功但对方还没揭晓(awaiting_peer)也算已送达 —— 重试不重发', async () => {
    const post = vi.fn<any>(async () => ({ mutual: false }))
    const { pledgeStore, revealer } = fixture(post)
    pledgeStore.create({ id: 'i7:cca', intentId: 'i7', seekerAgentId: 'cca', topic: 't' })

    expect(await revealer.revealPledge('i7:cca')).toEqual({ state: 'awaiting_peer' })
    // 对方的揭晓到达
    revealer.onInboundReveal({ agentId: 'cca', intentId: 'i7', peerHandle: PEER_HANDLE })
    post.mockClear()
    expect(await revealer.revealPledge('i7:cca')).toEqual({ state: 'connected' })
    expect(post).not.toHaveBeenCalled()
  })
})

// 光能重试还不够:出问题的那次,owner 看到的是「已连接」,他没有任何理由
// 再点一次。所以未送达的揭晓必须有人**自动**去补 —— 挂在信箱轮询同一拍上
// (它本来就是网络恢复后第一个动的东西)。
describe('makeRevealer.retryUndelivered — 自动补投', () => {
  it('把所有「我已同意但没送出去」的行重投一遍,成功的标记为已送达', async () => {
    const post = vi.fn<any>(async () => null)
    const { pledgeStore, echoStore, seekStore, revealer } = fixture(post)
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    pledgeStore.create({ id: 'i2:cca', intentId: 'i2', seekerAgentId: 'cca', topic: 't' })
    await revealer.revealEcho('i1:ccb')
    await revealer.revealPledge('i2:cca')

    post.mockClear()
    post.mockImplementation(async () => ({ mutual: false }))
    const n = await revealer.retryUndelivered()

    expect(n).toBe(2)
    expect(post).toHaveBeenCalledWith('ccb', 'i1')
    expect(post).toHaveBeenCalledWith('cca', 'i2')

    // 补投成功后就安静了 —— 不能每 2 分钟永远重发下去
    post.mockClear()
    expect(await revealer.retryUndelivered()).toBe(0)
    expect(post).not.toHaveBeenCalled()
  })

  it('超过 14 天还没送到的行就不再重投 —— 补投必须有界(no-retry-storm)', async () => {
    const post = vi.fn<any>(async () => ({ mutual: false }))
    const { pledgeStore, revealer } = fixture(post)
    pledgeStore.create({ id: 'i4:cca', intentId: 'i4', seekerAgentId: 'cca', topic: 't' })
    pledgeStore.setSelfRevealed('i4:cca', new Date(Date.now() - 15 * 864e5).toISOString())

    expect(await revealer.retryUndelivered()).toBe(0)
    expect(post).not.toHaveBeenCalled()
    // 放弃重投不等于抹掉同意 —— owner 手动再点一次揭晓仍然必须重发
    expect(pledgeStore.get('i4:cca')!.self_revealed_at).not.toBeNull()
    expect(await revealer.revealPledge('i4:cca')).toEqual({ state: 'awaiting_peer' })
    expect(post).toHaveBeenCalledWith('cca', 'i4')
  })

  it('没同意过的行不碰(补投只补「已同意、没送到」,绝不代替 owner 同意)', async () => {
    const post = vi.fn<any>(async () => ({ mutual: false }))
    const { pledgeStore, revealer } = fixture(post)
    pledgeStore.create({ id: 'i3:cca', intentId: 'i3', seekerAgentId: 'cca', topic: 't' })

    expect(await revealer.retryUndelivered()).toBe(0)
    expect(post).not.toHaveBeenCalled()
    expect(pledgeStore.get('i3:cca')!.self_revealed_at).toBeNull()
  })
})
