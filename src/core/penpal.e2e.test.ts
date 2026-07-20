/**
 * Anonymous pen-pal channel end-to-end (deterministic, in-process).
 *
 * Composes the REAL modules — penpal-crypto + penpal-channel-store +
 * penpal-letter-store + social-reveal (makeRevealer) + social-relay-reveal
 * (makeRelayReconciler) + penpal-correspondent (makeCorrespondent) +
 * penpal-relay-letter (makeLetterRelay) — across multiple in-memory dbs,
 * mirroring the multi-daemon harness idiom of social-m1.e2e.test.ts. No
 * production code is touched; every wiring seam here mirrors
 * src/daemon/bootstrap/wire-social.ts's real postPeerReveal/postLetter shape
 * exactly (same rowId reconstruction, same relay-vs-direct branching), just
 * with an in-process function call standing in for the a2a HTTP hop.
 *
 * Direct (1-hop): A is a seeker (echoStore/revealEcho), B is an answerer
 * (pledgeStore/revealPledge) — no intermediary. Proves I2 (both channels
 * open with non-null, mutually-crossed peer_pubkey/peer_channel_id), the
 * mask never lifts, and the wire letter body never carries plaintext.
 *
 * Relay (2-hop): S and Q connect via intermediary W. W is content-blind by
 * construction here — it gets ONLY a relayStore + makeLetterRelay, never a
 * channelStore or letterStore of its own, so it is structurally incapable of
 * decrypting or persisting a letter thread. Proves I2 across the relay leg,
 * that W forwards ciphertext byte-identical, and that W's own db never
 * accumulates a penpal_letter row.
 */
import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../lib/db'
import { makeSeekStore } from './social-seek-store'
import { makeEchoStore } from './social-echo-store'
import { makePledgeStore } from './social-pledge-store'
import { makeRevealer, type ChannelPort } from './social-reveal'
import { makeRelayStore } from './social-relay-store'
import { makeRelayReconciler } from './social-relay-reveal'
import { makeChannelStore, type ChannelStore } from './penpal-channel-store'
import { makeLetterStore } from './penpal-letter-store'
import { makeCorrespondent, type Correspondent } from './penpal-correspondent'
import { makeLetterRelay } from './penpal-relay-letter'
import { generateKeypair, type PenpalHandle } from './penpal-crypto'
import { randomUUID } from 'node:crypto'

/** A ChannelPort backed by a real makeChannelStore — mirrors wire-social.ts's
 *  ChannelPort exactly (idempotent mint on openLocal, persist-the-peer's-
 *  handle-and-open on finalize). Identical helper to social-m1.e2e.test.ts. */
function makeTestChannelPort(store: ChannelStore): ChannelPort {
  return {
    openLocal(rowId, ctx) {
      const existing = store.get(rowId)
      if (existing) return { pubkey: existing.my_pubkey, channel_id: existing.my_channel_id }
      const kp = generateKeypair()
      const myChannelId = randomUUID()
      store.create({ id: rowId, seekId: ctx.seekId, myPrivkey: kp.privateKey, myPubkey: kp.publicKey, myChannelId, degree: ctx.degree, relayVia: ctx.relayVia ?? null, peerAgentId: ctx.peerAgentId ?? null })
      return { pubkey: kp.publicKey, channel_id: myChannelId }
    },
    finalize(rowId, peerHandle) { store.setPeerHandle(rowId, peerHandle) },
  }
}

describe('penpal channel e2e — direct (1-hop)', () => {
  it('mutual reveal opens both channels (I2), then S<->Q exchange sealed letters with the exact plaintext, wire body never carries plaintext', async () => {
    const A_ID = 'cca'
    const B_ID = 'ccb'
    const intentId = 'seek-direct-1'

    // Two independent daemons: A (seeker) and B (answerer), each its own db.
    const aDb = openDb({ path: ':memory:' })
    const aSeek = makeSeekStore(aDb)
    const aEcho = makeEchoStore(aDb)
    const aPledge = makePledgeStore(aDb) // unused by the seeker path, required by RevealerDeps
    const aChannelStore = makeChannelStore(aDb)
    const aChannel = makeTestChannelPort(aChannelStore)
    const aLetterStore = makeLetterStore(aDb)

    const bDb = openDb({ path: ':memory:' })
    const bSeek = makeSeekStore(bDb) // unused by the answerer path, required by RevealerDeps
    const bEcho = makeEchoStore(bDb) // unused by the answerer path, required by RevealerDeps
    const bPledge = makePledgeStore(bDb)
    const bChannelStore = makeChannelStore(bDb)
    const bChannel = makeTestChannelPort(bChannelStore)
    const bLetterStore = makeLetterStore(bDb)

    // Seed the pre-reveal state: A sowed a seek and got B's echo; B answered
    // yes and holds a pledge back to A. Row ids follow wire-social.ts's
    // convention exactly (`${intentId}:${peerAgentId}`).
    aSeek.create({ id: intentId, kind: 'seek', topic: '找周末拍照搭子' })
    const echoId = `${intentId}:${B_ID}`
    aEcho.create({ id: echoId, seekId: intentId, peerMasked: '第 1 度的某人', degree: 1, content: '南京摄影爱好者', peerAgentId: B_ID })
    const pledgeId = `${intentId}:${A_ID}`
    bPledge.create({ id: pledgeId, intentId, seekerAgentId: A_ID, topic: '找周末拍照搭子' })

    // Wire each side's inbound reveal handler + outbound postPeerReveal as a
    // direct in-process call — the SAME rowId reconstruction wire-social.ts
    // uses to look up "my just-minted handle" before POSTing it.
    let aRevealer: ReturnType<typeof makeRevealer>
    let bRevealer: ReturnType<typeof makeRevealer>

    aRevealer = makeRevealer({
      echoStore: aEcho, pledgeStore: aPledge, seekStore: aSeek,
      postPeerReveal: async (agentId, i, tok) => {
        const rowId = tok ? `${i}:${agentId}:${tok}` : `${i}:${agentId}`
        const ch = aChannelStore.get(rowId)
        const myHandle = ch ? { pubkey: ch.my_pubkey, channel_id: ch.my_channel_id } : undefined
        return bRevealer.onInboundReveal({ agentId: A_ID, intentId: i, relayToken: tok, ...(myHandle ? { peerHandle: myHandle } : {}) })
      },
      channel: aChannel, notify: () => {},
    })
    bRevealer = makeRevealer({
      echoStore: bEcho, pledgeStore: bPledge, seekStore: bSeek,
      postPeerReveal: async (agentId, i) => {
        const rowId = `${i}:${agentId}`
        const ch = bChannelStore.get(rowId)
        const myHandle = ch ? { pubkey: ch.my_pubkey, channel_id: ch.my_channel_id } : undefined
        return aRevealer.onInboundReveal({ agentId: B_ID, intentId: i, ...(myHandle ? { peerHandle: myHandle } : {}) })
      },
      channel: bChannel, notify: () => {},
    })

    // 1) A reveals first — opens A's channel, POSTs A's handle. B hasn't
    //    revealed yet, so B answers { mutual: false } and does NOT finalize.
    const aFirst = await aRevealer.revealEcho(echoId)
    expect(aFirst).toEqual({ state: 'awaiting_peer' })
    const aPendingChannel = aChannelStore.get(echoId)!
    expect(aPendingChannel.status).toBe('pending')
    expect(aPendingChannel.peer_pubkey).toBeNull()
    const bPendingPledge = bPledge.get(pledgeId)!
    expect(bPendingPledge.peer_revealed_at).not.toBeNull()   // A's reveal landed on B
    expect(bPendingPledge.self_revealed_at).toBeNull()       // B hasn't revealed — no finalize yet
    expect(bChannelStore.get(pledgeId)).toBeNull()           // B's channel doesn't exist yet

    // 2) B reveals back — opens B's channel, POSTs B's handle. A's onInboundReveal
    //    fires synchronously inside this call and learns mutual too.
    const bOut = await bRevealer.revealPledge(pledgeId)
    expect(bOut).toEqual({ state: 'connected' })

    // 3) I2 — BOTH channels open with non-null, mutually-crossed handles.
    const aChannelRow = aChannelStore.get(echoId)!
    const bChannelRow = bChannelStore.get(pledgeId)!
    expect(aChannelRow.status).toBe('open')
    expect(bChannelRow.status).toBe('open')
    expect(aChannelRow.peer_pubkey).not.toBeNull()
    expect(aChannelRow.peer_channel_id).not.toBeNull()
    expect(bChannelRow.peer_pubkey).not.toBeNull()
    expect(bChannelRow.peer_channel_id).not.toBeNull()
    expect(aChannelRow.peer_pubkey).toBe(bChannelRow.my_pubkey)
    expect(aChannelRow.peer_channel_id).toBe(bChannelRow.my_channel_id)
    expect(bChannelRow.peer_pubkey).toBe(aChannelRow.my_pubkey)
    expect(bChannelRow.peer_channel_id).toBe(aChannelRow.my_channel_id)

    // The mask never lifts — anonymity is permanent by design.
    expect(aEcho.get(echoId)!.peer_masked).toBe('第 1 度的某人')

    // 4) Correspondents, cross-wired directly (no HTTP transport in-process —
    //    covered separately by a2a-server.test.ts). Real identity NEVER
    //    appears anywhere in this wiring: only agentId strings (opaque a2a
    //    ids) and PenpalHandle pubkeys/channel_ids cross.
    let correspondentA: Correspondent
    let correspondentB: Correspondent
    const notifyA = vi.fn()
    const notifyB = vi.fn()
    const postLetterFromA = vi.fn(async (_target: unknown, body: { channel_id: string; nonce: string; ct: string; tag: string }) => correspondentB.receiveLetter(body).ok)
    const postLetterFromB = vi.fn(async (_target: unknown, body: { channel_id: string; nonce: string; ct: string; tag: string }) => correspondentA.receiveLetter(body).ok)
    correspondentA = makeCorrespondent({ channelStore: aChannelStore, letterStore: aLetterStore, postLetter: postLetterFromA, notifyInbound: notifyA })
    correspondentB = makeCorrespondent({ channelStore: bChannelStore, letterStore: bLetterStore, postLetter: postLetterFromB, notifyInbound: notifyB })

    // 5) A -> B: seal, route, decrypt.
    const outResult = await correspondentA.sendLetter(echoId, '你好')
    expect(outResult).toEqual({ ok: true })
    expect(postLetterFromA).toHaveBeenCalledTimes(1)
    const [aTarget, aWireBody] = postLetterFromA.mock.calls[0]!
    expect(aTarget).toEqual({ agentId: B_ID, relayVia: null })
    expect(aWireBody.channel_id).toBe(bChannelRow.my_channel_id) // addressed to B's own inbound address
    // Privacy invariant: plaintext NEVER appears on the wire.
    expect(aWireBody.ct).not.toBe('你好')
    expect(JSON.stringify(aWireBody)).not.toContain('你好')

    const bInRows = bLetterStore.listForChannel(pledgeId)
    expect(bInRows).toHaveLength(1)
    expect(bInRows[0]!.direction).toBe('in')
    expect(bInRows[0]!.plaintext).toBe('你好')                 // B decrypts the EXACT plaintext
    expect(notifyB).toHaveBeenCalledWith(pledgeId, '你好')      // B's owner notified

    // 6) The reverse direction: B -> A.
    const backResult = await correspondentB.sendLetter(pledgeId, '见字如面')
    expect(backResult).toEqual({ ok: true })
    const [bTarget, bWireBody] = postLetterFromB.mock.calls[0]!
    expect(bTarget).toEqual({ agentId: A_ID, relayVia: null })
    expect(bWireBody.channel_id).toBe(aChannelRow.my_channel_id)
    expect(bWireBody.ct).not.toBe('见字如面')
    expect(JSON.stringify(bWireBody)).not.toContain('见字如面')

    // A's channel now has both its own OUT letter and B's IN reply.
    const aInRows = aLetterStore.listForChannel(echoId).filter(r => r.direction === 'in')
    expect(aInRows).toHaveLength(1)
    expect(aInRows[0]!.plaintext).toBe('见字如面')
    expect(notifyA).toHaveBeenCalledWith(echoId, '见字如面')
  })
})

describe('penpal channel e2e — relay (2-hop, content-blind)', () => {
  it('S and Q connect through intermediary W (handles crossed, real identity never crosses); a letter routes S -> W -> Q byte-identical, W never decrypts or persists', async () => {
    const S_ID = 'ccs'
    const W_ID = 'ccw'
    const Q_ID = 'ccq'
    const intentId = 'seek-relay-1'
    const relayToken = 'TOK'

    // Three daemons: S (seeker), W (intermediary / 介绍人), Q (final answerer).
    const sDb = openDb({ path: ':memory:' })
    const sSeek = makeSeekStore(sDb)
    const sEcho = makeEchoStore(sDb)
    const sPledge = makePledgeStore(sDb) // unused, required by RevealerDeps
    const sChannelStore = makeChannelStore(sDb)
    const sChannel = makeTestChannelPort(sChannelStore)
    const sLetterStore = makeLetterStore(sDb)

    const wDb = openDb({ path: ':memory:' })
    const wRelay = makeRelayStore(wDb)
    // W deliberately gets NO channelStore and NO letterStore — it is
    // structurally content-blind: it holds no key and has nowhere to persist
    // a decrypted letter even if it tried.

    const qDb = openDb({ path: ':memory:' })
    const qSeek = makeSeekStore(qDb) // unused, required by RevealerDeps
    const qPledge = makePledgeStore(qDb)
    const qChannelStore = makeChannelStore(qDb)
    const qChannel = makeTestChannelPort(qChannelStore)
    const qLetterStore = makeLetterStore(qDb)

    // Seed pre-reveal state: S holds a degree-2 relay echo (relay_via=W,
    // relay_token set); W holds the durable relay leg linking S<->Q; Q holds
    // a pledge back to W (Q only ever learns W's agent id, never S's).
    sSeek.create({ id: intentId, kind: 'seek', topic: '找周末拍照搭子' })
    const sEchoId = `${intentId}:${W_ID}:${relayToken}`
    sEcho.create({ id: sEchoId, seekId: intentId, peerMasked: '第 2 度的某人', degree: 2, content: '我主人认识个摄影师', peerAgentId: null, relayVia: W_ID, relayToken })
    wRelay.create({ id: `${intentId}:${relayToken}`, intentId, relayToken, upstreamAgentId: S_ID, downstreamAgentId: Q_ID })
    const qPledgeId = `${intentId}:${W_ID}`
    qPledge.create({ id: qPledgeId, intentId, seekerAgentId: W_ID, topic: '找周末拍照搭子' })

    // W's reveal reconciler — crosses the two endpoints' EPHEMERAL
    // PenpalHandles via the durable social_relay row, never a registry
    // lookup, never a real identity.
    let w3wayCalls: Array<{ intentId: string; upstream: PenpalHandle; downstream: PenpalHandle }> = []
    let sRevealer: ReturnType<typeof makeRevealer>
    let qRevealer: ReturnType<typeof makeRevealer>
    const wReconciler = makeRelayReconciler({
      relayStore: wRelay,
      completeUpstream: (_up, i, tok, dHandle) => { void sRevealer.onInboundReveal({ agentId: W_ID, intentId: i, relayToken: tok, peerHandle: dHandle }) },
      completeDownstream: (_down, i, uHandle) => { void qRevealer.onInboundReveal({ agentId: W_ID, intentId: i, peerHandle: uHandle }) },
      nudge: (agentId, i, tok) => {
        if (agentId === Q_ID) void qRevealer.onInboundReveal({ agentId: W_ID, intentId: i })
        else void sRevealer.onInboundReveal({ agentId: W_ID, intentId: i, relayToken: tok })
      },
      notify3way: (i, upstream, downstream) => { w3wayCalls.push({ intentId: i, upstream, downstream }) },
    })
    const wOnReveal = (ev: { agent_id: string; intent_id: string; relay_token?: string; peer_handle?: PenpalHandle }) =>
      wReconciler.onRelayReveal({ callerAgentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token, peerHandle: ev.peer_handle }) ?? { mutual: false }

    sRevealer = makeRevealer({
      echoStore: sEcho, pledgeStore: sPledge, seekStore: sSeek,
      postPeerReveal: async (agentId, i, tok) => {
        const rowId = tok ? `${i}:${agentId}:${tok}` : `${i}:${agentId}`
        const ch = sChannelStore.get(rowId)
        const myHandle = ch ? { pubkey: ch.my_pubkey, channel_id: ch.my_channel_id } : undefined
        return wOnReveal({ agent_id: S_ID, intent_id: i, relay_token: tok, ...(myHandle ? { peer_handle: myHandle } : {}) })
      },
      channel: sChannel, notify: () => {},
    })
    const qNotify = vi.fn()
    qRevealer = makeRevealer({
      echoStore: makeEchoStore(qDb), pledgeStore: qPledge, seekStore: qSeek,
      postPeerReveal: async (agentId, i) => {
        const rowId = `${i}:${agentId}`
        const ch = qChannelStore.get(rowId)
        const myHandle = ch ? { pubkey: ch.my_pubkey, channel_id: ch.my_channel_id } : undefined
        return wOnReveal({ agent_id: Q_ID, intent_id: i, ...(myHandle ? { peer_handle: myHandle } : {}) })
      },
      channel: qChannel, notify: qNotify,
    })

    // 1) S reveals first -> awaiting (W nudges Q; Q's owner beat fires, no writes yet).
    const sFirst = await sRevealer.revealEcho(sEchoId)
    expect(sFirst).toEqual({ state: 'awaiting_peer' })

    // 2) Q reveals -> mutual synchronously; W posts back to complete S.
    const qOut = await qRevealer.revealPledge(qPledgeId)
    expect(qOut).toEqual({ state: 'connected' })

    // 3) I2 across the relay leg — BOTH S's and Q's channels open, non-null,
    //    mutually-crossed handles. Neither S nor Q ever sees the other's
    //    real identity — only the ephemeral pubkey/channel_id handle W crossed.
    const sChannelRow = sChannelStore.get(sEchoId)!
    const qChannelRow = qChannelStore.get(qPledgeId)!
    expect(sChannelRow.status).toBe('open')
    expect(qChannelRow.status).toBe('open')
    expect(sChannelRow.peer_pubkey).not.toBeNull()
    expect(sChannelRow.peer_channel_id).not.toBeNull()
    expect(qChannelRow.peer_pubkey).not.toBeNull()
    expect(qChannelRow.peer_channel_id).not.toBeNull()
    expect(sChannelRow.peer_pubkey).toBe(qChannelRow.my_pubkey)
    expect(sChannelRow.peer_channel_id).toBe(qChannelRow.my_channel_id)
    expect(qChannelRow.peer_pubkey).toBe(sChannelRow.my_pubkey)
    expect(qChannelRow.peer_channel_id).toBe(sChannelRow.my_channel_id)
    // S and Q only ever addressed W (S_ID/Q_ID never appear on each other's
    // channel rows — the only agent id S's row carries is W's).
    expect(sChannelRow.relay_via).toBe(W_ID)
    expect(sChannelRow.peer_agent_id).toBeNull()

    expect(sEcho.get(sEchoId)!.peer_masked).toBe('第 2 度的某人')   // still masked
    expect(w3wayCalls).toHaveLength(1)                              // W's owner gets a SINGLE 3-way ping
    expect(qNotify).toHaveBeenCalledWith('connected', { intentId })  // content-free — no peer name, ever

    // 4) Letter relay. W gets ONLY relayStore + makeLetterRelay — no crypto
    //    import, no key, structurally unable to decrypt.
    let correspondentS: Correspondent
    let correspondentQ: Correspondent
    const postLetterFromW = vi.fn(async (target: { agentId: string; relayVia: string | null }, body: { channel_id: string; nonce: string; ct: string; tag: string }) => {
      if (target.agentId === Q_ID) return correspondentQ.receiveLetter(body).ok
      if (target.agentId === S_ID) return correspondentS.receiveLetter(body).ok
      return false
    })
    const letterRelay = makeLetterRelay({ relayStore: wRelay, postLetter: postLetterFromW })
    const postLetterFromS = vi.fn(async (_target: unknown, body: { channel_id: string; nonce: string; ct: string; tag: string }) => (await letterRelay.routeLetter({ agent_id: S_ID, ...body })).ok)
    const postLetterFromQ = vi.fn(async (_target: unknown, body: { channel_id: string; nonce: string; ct: string; tag: string }) => (await letterRelay.routeLetter({ agent_id: Q_ID, ...body })).ok)
    const notifyS = vi.fn()
    const notifyQ = vi.fn()
    correspondentS = makeCorrespondent({ channelStore: sChannelStore, letterStore: sLetterStore, postLetter: postLetterFromS, notifyInbound: notifyS })
    correspondentQ = makeCorrespondent({ channelStore: qChannelStore, letterStore: qLetterStore, postLetter: postLetterFromQ, notifyInbound: notifyQ })

    // 5) S -> W -> Q: content-blind forward, byte-identical ciphertext.
    const sendResult = await correspondentS.sendLetter(sEchoId, '你好,愿闻其详')
    expect(sendResult).toEqual({ ok: true })

    // S posted to the INTERMEDIARY (relay_via), not directly to Q.
    expect(postLetterFromS).toHaveBeenCalledTimes(1)
    const [sTarget, sWireBody] = postLetterFromS.mock.calls[0]!
    expect(sTarget).toEqual({ agentId: W_ID, relayVia: W_ID })
    expect(JSON.stringify(sWireBody)).not.toContain('你好')   // plaintext never on the wire

    // W re-posted the SAME sealed bytes onward, unopened.
    expect(postLetterFromW).toHaveBeenCalledTimes(1)
    const [wTarget, wWireBody] = postLetterFromW.mock.calls[0]!
    expect(wTarget).toEqual({ agentId: Q_ID, relayVia: null })
    expect(wWireBody).toEqual(sWireBody)   // byte-identical passthrough — W held no key, changed nothing

    // Q decrypts the exact plaintext.
    const qInRows = qLetterStore.listForChannel(qPledgeId)
    expect(qInRows).toHaveLength(1)
    expect(qInRows[0]!.direction).toBe('in')
    expect(qInRows[0]!.plaintext).toBe('你好,愿闻其详')
    expect(notifyQ).toHaveBeenCalledWith(qPledgeId, '你好,愿闻其详')

    // Privacy invariant: W never has the key and never decrypts — W's own db
    // never accumulates a penpal_letter row, and W never even constructed a
    // letterStore capable of writing one.
    const wLetterCount = wDb.query<{ c: number }, []>('SELECT COUNT(*) as c FROM penpal_letter').get()!
    expect(wLetterCount.c).toBe(0)

    // 6) The reverse direction: Q -> W -> S, same invariants.
    const backResult = await correspondentQ.sendLetter(qPledgeId, '摄影师朋友,幸会')
    expect(backResult).toEqual({ ok: true })
    const [qTarget, qWireBody] = postLetterFromQ.mock.calls[0]!
    // Q's own channel row has relay_via=null, peer_agent_id=W_ID (Q's local
    // record of "the peer" IS W's agent id — Q answered W's forwarded intent
    // and never learns it's talking to an intermediary rather than the real
    // endpoint), so Q addresses W the same way a direct peer would be addressed.
    expect(qTarget).toEqual({ agentId: W_ID, relayVia: null })
    expect(JSON.stringify(qWireBody)).not.toContain('摄影师朋友')

    const [wBackTarget, wBackWireBody] = postLetterFromW.mock.calls[1]!
    expect(wBackTarget).toEqual({ agentId: S_ID, relayVia: null })
    expect(wBackWireBody).toEqual(qWireBody)

    // S's channel now has both its own OUT letter and Q's IN reply.
    const sInRows = sLetterStore.listForChannel(sEchoId).filter(r => r.direction === 'in')
    expect(sInRows).toHaveLength(1)
    expect(sInRows[0]!.plaintext).toBe('摄影师朋友,幸会')
    expect(notifyS).toHaveBeenCalledWith(sEchoId, '摄影师朋友,幸会')

    const wLetterCountAfter = wDb.query<{ c: number }, []>('SELECT COUNT(*) as c FROM penpal_letter').get()!
    expect(wLetterCountAfter.c).toBe(0)   // still zero after both directions
  })
})
