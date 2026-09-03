import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../lib/db'
import { makeRelayStore } from './social-relay-store'
import { makeRelayReconciler } from './social-relay-reveal'
import type { PenpalHandle } from './penpal-crypto'

const S: PenpalHandle = { pubkey: 'pk-s', channel_id: 'chan-s' }
const Q: PenpalHandle = { pubkey: 'pk-q', channel_id: 'chan-q' }

function fixture() {
  const db = openDb({ path: ':memory:' })
  const relayStore = makeRelayStore(db)
  relayStore.create({ id: 'i1:T', intentId: 'i1', relayToken: 'T', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
  const completeUpstream = vi.fn()
  const completeDownstream = vi.fn()
  const nudge = vi.fn()
  const notify3way = vi.fn()
  const rec = makeRelayReconciler({
    relayStore,
    completeUpstream, completeDownstream, nudge, notify3way,
  })
  return { relayStore, rec, completeUpstream, completeDownstream, nudge, notify3way }
}

describe('makeRelayReconciler', () => {
  it('no relay row → null (caller falls through to its own echo/pledge revealer)', () => {
    const { rec } = fixture()
    expect(rec.onRelayReveal({ callerAgentId: 'ccx', intentId: 'nope' })).toBeNull()
  })

  it('correct relayToken but caller is NOT the row upstream → null, no mark/complete/nudge/notify (review fix: caller-bound upstream leg)', () => {
    const { rec, relayStore, nudge, completeUpstream, completeDownstream, notify3way } = fixture()
    const out = rec.onRelayReveal({ callerAgentId: 'ccz', intentId: 'i1', relayToken: 'T', peerHandle: S })
    expect(out).toBeNull()
    expect(relayStore.get('i1:T')!.upstream_revealed_at).toBeNull()
    expect(relayStore.get('i1:T')!.downstream_revealed_at).toBeNull()
    expect(relayStore.get('i1:T')!.upstream_handle).toBeNull()
    expect(nudge).not.toHaveBeenCalled()
    expect(completeUpstream).not.toHaveBeenCalled()
    expect(completeDownstream).not.toHaveBeenCalled()
    expect(notify3way).not.toHaveBeenCalled()
  })

  it('S reveals first (carries token) → persists S\'s handle, marks upstream, nudges Q with NO token, mutual:false', () => {
    const { rec, relayStore, nudge, completeUpstream, completeDownstream } = fixture()
    const out = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T', peerHandle: S })
    expect(out).toEqual({ mutual: false })
    expect(relayStore.get('i1:T')!.upstream_revealed_at).not.toBeNull()
    expect(relayStore.get('i1:T')!.upstream_handle).toBe(JSON.stringify(S))
    expect(nudge).toHaveBeenCalledWith('ccq', 'i1')            // Q's pledge is keyed intent:W → no token
    expect(completeUpstream).not.toHaveBeenCalled()
    expect(completeDownstream).not.toHaveBeenCalled()
  })

  it('Q reveals first (no token) → persists Q\'s handle, marks downstream, nudges S WITH token, mutual:false', () => {
    const { rec, relayStore, nudge } = fixture()
    const out = rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1', peerHandle: Q })
    expect(out).toEqual({ mutual: false })
    expect(relayStore.get('i1:T')!.downstream_revealed_at).not.toBeNull()
    expect(relayStore.get('i1:T')!.downstream_handle).toBe(JSON.stringify(Q))
    expect(nudge).toHaveBeenCalledWith('ccs', 'i1', 'T')       // S needs the token
  })

  // 2026-09-02:互揭达成时**两条腿都要 complete**,不是只补先揭晓的那一条。
  //
  // 原来的写法依赖「后揭晓的一方从同步返回值里学到 mutual」。信箱传输**没有
  // 同步返回值** —— mailbox-dispatch 里是 `await deps.onReveal(...); return`,
  // 返回值直接丢掉。而且 2 跳的两端并不像直连那样能从自己的两行推出互揭:
  // W 只 nudge 过对方,后揭晓一方的 peer_revealed_at 永远是 null。
  // 结果:**2 跳连接里后揭晓的那一方被永久晾在 awaiting_peer**。
  //
  // 补两条是安全的:重复的 complete 落到对端的 onInboundReveal 会走
  // 「已 peer_revealed → 无写入、无通知」那条分支。
  it('S-first then Q → mutual;两条腿都 complete(后揭晓的一方在信箱上没有同步返回值可用)', () => {
    const { rec, completeUpstream, completeDownstream, notify3way } = fixture()
    rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T', peerHandle: S })   // S first
    const out = rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1', peerHandle: Q })        // Q second
    expect(out).toEqual({ mutual: true, handle: S })          // Q (caller) gets the OTHER party's STORED handle = S
    expect(completeUpstream).toHaveBeenCalledWith('i1:T', 'ccs', 'i1', 'T', Q)     // 给 S:Q 的 handle
    expect(completeDownstream).toHaveBeenCalledWith('i1:T', 'ccq', 'i1', S)        // 给 Q:S 的 handle ← 新增
    expect(notify3way).toHaveBeenCalledTimes(1)
    expect(notify3way).toHaveBeenCalledWith('i1', S, Q)
  })

  it('Q-first then S → mutual;同样两条腿都 complete', () => {
    const { rec, completeUpstream, completeDownstream, notify3way } = fixture()
    rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1', peerHandle: Q })                    // Q first
    const out = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T', peerHandle: S })  // S second
    expect(out).toEqual({ mutual: true, handle: Q })          // S (caller) gets the OTHER party's STORED handle = Q
    expect(completeDownstream).toHaveBeenCalledWith('i1:T', 'ccq', 'i1', S)
    expect(completeUpstream).toHaveBeenCalledWith('i1:T', 'ccs', 'i1', 'T', S ? Q : Q)
    expect(notify3way).toHaveBeenCalledTimes(1)
    expect(notify3way).toHaveBeenCalledWith('i1', S, Q)
  })

  it('restart survivability: the relay row is durable, reconciliation is process-independent', () => {
    const { rec, relayStore } = fixture()
    rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T', peerHandle: S })
    // Simulate a W restart: a fresh reconciler over the SAME store still crosses.
    const rec2 = makeRelayReconciler({
      relayStore,
      completeUpstream: vi.fn(), completeDownstream: vi.fn(), nudge: vi.fn(),
      notify3way: vi.fn(),
    })
    const out = rec2.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1', peerHandle: Q })
    expect(out).toEqual({ mutual: true, handle: S })
  })

  it('retried reveal after mutual is idempotent (no duplicate cross/notify)', () => {
    const { rec, completeDownstream, notify3way } = fixture()
    rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1', peerHandle: Q })
    rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T', peerHandle: S })   // reaches mutual
    completeDownstream.mockClear(); notify3way.mockClear()
    const again = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T', peerHandle: S })   // retry
    expect(again).toEqual({ mutual: true, handle: Q })          // consistent answer
    expect(completeDownstream).not.toHaveBeenCalled()           // no duplicate post-back
    expect(notify3way).not.toHaveBeenCalled()                   // no duplicate warmth
  })

  it('crossing reveal when the OTHER leg\'s handle was not persisted does NOT strand the leg; fail-safe returns mutual:false without marking (review fix)', () => {
    const db = openDb({ path: ':memory:' })
    const relayStore = makeRelayStore(db)
    relayStore.create({ id: 'i1:T', intentId: 'i1', relayToken: 'T', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    const completeUpstream = vi.fn()
    const completeDownstream = vi.fn()
    const nudge = vi.fn()
    const notify3way = vi.fn()
    const rec = makeRelayReconciler({ relayStore, completeUpstream, completeDownstream, nudge, notify3way })

    // Q reveals first WITHOUT a handle — shouldn't happen, but simulate the
    // "other leg revealed but its handle wasn't persisted" transient-miss guard
    // by manually marking the downstream leg revealed without a stored handle.
    relayStore.setDownstreamRevealed('i1:T', new Date().toISOString())

    // S reveals second (crossing path) while the OTHER leg's (Q's) stored handle is missing.
    const out = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T', peerHandle: S })
    expect(out).toEqual({ mutual: false })
    expect(relayStore.get('i1:T')!.upstream_revealed_at).toBeNull()   // NOT marked — must stay retryable
    expect(completeUpstream).not.toHaveBeenCalled()
    expect(completeDownstream).not.toHaveBeenCalled()
    expect(notify3way).not.toHaveBeenCalled()

    // The missing handle "heals" (Q's handle gets persisted out-of-band); a
    // retry of the SAME reveal now crosses.
    relayStore.setDownstreamHandle('i1:T', Q)
    const retried = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T', peerHandle: S })
    expect(retried).toEqual({ mutual: true, handle: Q })
    expect(relayStore.get('i1:T')!.upstream_revealed_at).not.toBeNull()
    expect(completeDownstream).toHaveBeenCalledWith('i1:T', 'ccq', 'i1', S)
    expect(completeUpstream).toHaveBeenCalledWith('i1:T', 'ccs', 'i1', 'T', Q)   // 两条腿都补
    expect(notify3way).toHaveBeenCalledTimes(1)
    expect(notify3way).toHaveBeenCalledWith('i1', S, Q)
  })
})
