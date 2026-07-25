/**
 * C1 regression guard (Task 10) — the mailbox address must actually CROSS on
 * a real reveal, not just round-trip through the channel-store column (Task
 * 9 proved the column; this proves the crossing). The crossing handle is
 * built at its SOURCE — postPeerReveal/postReveal (outbound) and
 * channel.openLocal's return (the sync mutual-response path) — via
 * buildCrossedHandle, NOT from the bare channel row (which never held the
 * mailbox). See mailbox-dispatch-seam.ts and wire-social.ts.
 *
 * 1-hop: two real makeRevealer instances (S & Q), each over its own real
 * makeChannelStore/db, cross a mutual reveal exactly like wire-social wires
 * it — asserts BOTH sides' channel rows carry the OTHER side's mailbox.
 * 2-hop: a real makeRelayReconciler proves W forwards each endpoint's
 * enriched handle to the other verbatim (content-blind — W never opens it).
 */
import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeChannelStore } from '../../core/penpal-channel-store'
import { makeEchoStore } from '../../core/social-echo-store'
import { makePledgeStore } from '../../core/social-pledge-store'
import { makeSeekStore } from '../../core/social-seek-store'
import { makeRelayStore } from '../../core/social-relay-store'
import { makeRevealer } from '../../core/social-reveal'
import { makeRelayReconciler } from '../../core/social-relay-reveal'
import { generateKeypair } from '../../core/penpal-crypto'
import { randomUUID } from 'node:crypto'
import { buildCrossedHandle } from './mailbox-dispatch-seam'

const S_MBX = { addr: 'S_ADDR', enc_pub: 'S_ENC', relays: ['https://rs/'] }
const Q_MBX = { addr: 'Q_ADDR', enc_pub: 'Q_ENC', relays: ['https://rq/'] }

// A channel port over a real store whose openLocal enriches with `myMbx` via buildCrossedHandle.
function port(store: ReturnType<typeof makeChannelStore>, myMbx: typeof S_MBX) {
  return {
    openLocal(rowId: string, ctx: { seekId: string; degree: number; peerAgentId?: string | null; relayVia?: string | null }) {
      const existing = store.get(rowId)
      if (existing) return buildCrossedHandle({ my_pubkey: existing.my_pubkey, my_channel_id: existing.my_channel_id }, myMbx)
      const kp = generateKeypair(); const mcid = randomUUID()
      store.create({ id: rowId, seekId: ctx.seekId, myPrivkey: kp.privateKey, myPubkey: kp.publicKey, myChannelId: mcid, degree: ctx.degree, relayVia: ctx.relayVia ?? null, peerAgentId: ctx.peerAgentId ?? null })
      return buildCrossedHandle({ my_pubkey: kp.publicKey, my_channel_id: mcid }, myMbx)
    },
    finalize(rowId: string, peerHandle: any) { store.setPeerHandle(rowId, peerHandle) },
  }
}

describe('C1 — the mailbox address actually crosses on a real reveal', () => {
  it('1-hop: after mutual reveal, BOTH channel rows carry the peer mailbox', async () => {
    const sDb = openTestDb(), qDb = openTestDb()
    const sCh = makeChannelStore(sDb), qCh = makeChannelStore(qDb)
    const intentId = 'i1'

    // Q side: an echo where Q already self-revealed and is waiting for S.
    const qEchoes = makeEchoStore(qDb), qPledges = makePledgeStore(qDb), qSeeks = makeSeekStore(qDb)
    qSeeks.create({ id: intentId, kind: 'seek', topic: 't' })
    qEchoes.create({ id: `${intentId}:s`, seekId: intentId, peerMasked: '某人', degree: 1, content: 'c', peerAgentId: 's' })
    qEchoes.setSelfRevealed(`${intentId}:s`, new Date().toISOString())
    const qPort = port(qCh, Q_MBX)
    qPort.openLocal(`${intentId}:s`, { seekId: intentId, degree: 1, peerAgentId: 's' })   // Q minted its channel at self-reveal
    const qRevealer = makeRevealer({ echoStore: qEchoes, pledgeStore: qPledges, seekStore: qSeeks, channel: qPort as any, notify: () => {}, postPeerReveal: async () => null })

    // S side: an echo toward Q; S reveals second, posting its enriched handle to Q's inbound.
    const sEchoes = makeEchoStore(sDb), sPledges = makePledgeStore(sDb), sSeeks = makeSeekStore(sDb)
    sSeeks.create({ id: intentId, kind: 'seek', topic: 't' })
    sEchoes.create({ id: `${intentId}:q`, seekId: intentId, peerMasked: '某人', degree: 1, content: 'c', peerAgentId: 'q' })
    const sPort = port(sCh, S_MBX)
    const sRevealer = makeRevealer({
      echoStore: sEchoes, pledgeStore: sPledges, seekStore: sSeeks, channel: sPort as any, notify: () => {},
      // THE C1 PATH: S's crossing handle is built from S's row + S's mailbox (buildCrossedHandle inside sPort.openLocal
      // is discarded on the outbound path — the wire handle is rebuilt here from the row, exactly like wire-social).
      postPeerReveal: async (_agentId, iid) => {
        const row = sCh.get(`${intentId}:q`)!
        const sHandle = buildCrossedHandle({ my_pubkey: row.my_pubkey, my_channel_id: row.my_channel_id }, S_MBX)
        return qRevealer.onInboundReveal({ agentId: 's', intentId: iid, peerHandle: sHandle })
      },
    })

    const out = await sRevealer.revealEcho(`${intentId}:q`)
    expect(out).toEqual({ state: 'connected' })
    expect(JSON.parse(sCh.get(`${intentId}:q`)!.peer_mailbox!)).toEqual(Q_MBX)   // S learned Q's mailbox
    expect(JSON.parse(qCh.get(`${intentId}:s`)!.peer_mailbox!)).toEqual(S_MBX)   // Q learned S's mailbox
  })

  it('2-hop: W crosses the enriched handle to the far endpoint verbatim (content-blind)', () => {
    const wDb = openTestDb(); const relayStore = makeRelayStore(wDb)
    const relayToken = 'rt'; const intentId = 'i2'
    relayStore.create({ id: `${intentId}:${relayToken}`, intentId, relayToken, upstreamAgentId: 's', downstreamAgentId: 'q' })
    const forwarded: any[] = []
    const reconciler = makeRelayReconciler({
      relayStore,
      completeUpstream: (id, iid, rt, h) => forwarded.push({ to: id, handle: h }),
      completeDownstream: (id, iid, h) => forwarded.push({ to: id, handle: h }),
      nudge: () => {}, notify3way: () => {},
    })
    // S reveals to W carrying its enriched handle first (only this leg in ⇒
    // nudge only, no crossing yet). Q reveals second — this is the leg that
    // completes the cross: Q learns S's handle SYNCHRONOUSLY as the return
    // value of its own onRelayReveal call (mirrors the HTTP response to Q's
    // own /a2a/reveal POST); S — who revealed first — learns Q's handle via
    // the ASYNC post-back (completeUpstream), captured here in `forwarded`.
    reconciler.onRelayReveal({ callerAgentId: 's', intentId, relayToken, peerHandle: buildCrossedHandle({ my_pubkey: 'sp', my_channel_id: 'sc' }, S_MBX) })
    // No relayToken on Q's leg — Q is the downstream, resolved by (intentId, callerAgentId).
    const qResp = reconciler.onRelayReveal({ callerAgentId: 'q', intentId, peerHandle: buildCrossedHandle({ my_pubkey: 'qp', my_channel_id: 'qc' }, Q_MBX) })
    // Q (revealed second) learns S's mailbox synchronously — W crossed it verbatim.
    expect(qResp!.handle!.mailbox).toEqual(S_MBX)
    // S (revealed first) learns Q's mailbox via W's async post-back — mailbox intact (W never opened it).
    expect(forwarded.find(f => f.to === 's')!.handle.mailbox).toEqual(Q_MBX)
  })
})
