/**
 * Async foraging spine end-to-end (deterministic, in-process).
 *
 * Composes the REAL modules — makeBroker (sync sow + background forage) →
 * makeAnswerIntent (the peer's judge) → gateOutbound (disclosure) → makeRevealer
 * (mutual async reveal) — with injected deterministic judge + checker + stores.
 * The peer's SECOND reveal is simulated by stubbing the seeker's
 * postPeerReveal response ({ mutual: true, identity }) — the seeker never calls
 * its own onInboundReveal here (that entry point is covered directly in
 * social-reveal.test.ts; the HTTP transport is covered in a2a-server.test.ts).
 *
 * This file also covers the 2-hop forwarding-hop S→W→Q path (real broker +
 * forwarder + relay reconciler + two revealers, wired end-to-end across three
 * in-memory dbs) and spec-#1 backward-compat (old-shaped IntentCard/MatchReceipt
 * parsing unaffected by the new hop/forwarded fields).
 */
import { describe, expect, it, vi } from 'vitest'
import z from 'zod'
import { openDb } from '../lib/db'
import { makeBroker } from './social-broker'
import { makeAnswerIntent } from './social-answer'
import { makeRevealer, type PeerIdentity } from './social-reveal'
import { makeSeekStore } from './social-seek-store'
import { makeEchoStore } from './social-echo-store'
import { makePledgeStore } from './social-pledge-store'
import { makeForwarder } from './social-forwarder'
import { makeRelayStore } from './social-relay-store'
import { makeSeenIntentStore } from './social-seen-intent-store'
import { makeRelayReconciler } from './social-relay-reveal'
import { IntentCardSchema, MatchReceiptSchema } from './a2a-intent'

const POLICY = '可透露兴趣/城市;不透露住址门牌、第三方。'
const recB = { id: 'ccb', name: '小B', url: 'http://b/a2a', outbound_api_key: 'k' } as any
const IDENTITY_B: PeerIdentity = { name: '小B', url: 'http://b/a2a' }

const passingCheck = async (prompt: string) => {
  const m = prompt.match(/"""([\s\S]*?)"""/)
  const reviewed = m?.[1] ?? ''
  const leak = /兰园路|门牌|老陈/.test(reviewed)
  return JSON.stringify(leak ? { violation: true, redacted: '', reasons: ['leak'] } : { violation: false, redacted: reviewed })
}

describe('async foraging spine e2e', () => {
  it('sow → background echo → desktop reveal → peer reveals back → connected + identity, seek never blocks', async () => {
    const db = openDb({ path: ':memory:' })
    const seekStore = makeSeekStore(db)
    const echoStore = makeEchoStore(db)
    const pledgeStore = makePledgeStore(db)

    // The peer's answering handler (match yes with a clean blurb).
    const answerB = makeAnswerIntent({ judge: async () => ({ match: 'yes', blurb: '南京摄影爱好者,周末想出门拍照' }), policy: POLICY, cheapEval: passingCheck })

    // A deferred scheduler so we can assert the seek returned BEFORE any echo.
    const jobs: Array<() => Promise<void>> = []
    const broker = makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [recB],
      send: async (_hand, card) => answerB({ agent: { id: 'cca' } as any, card }),
      sow: (id, topic) => seekStore.create({ id, kind: 'seek', topic }),
      recordEcho: (e) => echoStore.create({ id: `${e.intentId}:${e.peerAgentId}`, seekId: e.intentId, peerMasked: e.peerMasked, degree: e.degree, content: e.content, peerAgentId: e.peerAgentId }),
      finishSeek: (id, status, peersAsked) => seekStore.update(id, { status, peersAsked }),
      schedule: (fn) => { jobs.push(fn) },
    })

    // 1) Sow — returns immediately; no echo yet (background not run).
    const { intent_id } = await broker.seek('找周末拍照搭子', { city: '南京' })
    expect(seekStore.get(intent_id)!.status).toBe('foraging')
    expect(echoStore.listForSeek(intent_id)).toHaveLength(0)   // did NOT block on the peer

    // 2) Forage — the background leg lands one pending echo.
    await Promise.all(jobs.map(j => j()))
    const echoes = echoStore.listForSeek(intent_id)
    expect(echoes).toHaveLength(1)
    expect(echoes[0]!.status).toBe('pending')
    expect(echoes[0]!.peer_masked).toBe('第 1 度的某人')       // masked before reveal
    expect(seekStore.get(intent_id)!.status).toBe('echoed')
    const echoId = echoes[0]!.id

    // 3) Desktop reveal (revealEcho). The peer answers our outbound /a2a/reveal
    //    with mutual:false first (they haven't revealed yet).
    const seekerRevealer = makeRevealer({
      echoStore, pledgeStore, seekStore,
      postPeerReveal: async () => ({ mutual: false }),
      selfIdentity: () => ({ name: '我方', url: 'http://a/a2a' }),
      notify: () => {},
    })
    const first = await seekerRevealer.revealEcho(echoId)
    expect(first).toEqual({ state: 'awaiting_peer' })
    expect(echoStore.get(echoId)!.self_revealed_at).not.toBeNull()
    expect(seekStore.get(intent_id)!.status).toBe('echoed')     // not yet connected

    // 4) Peer reveals back — simulate their /a2a/reveal callback into OUR
    //    onInboundReveal (they carry their identity in the outbound response we
    //    already recorded; here the mutual instant sets connected).
    //    We swap the seeker revealer's postPeerReveal to return the peer identity
    //    so a re-reveal completes the connection with identity swap.
    const seekerRevealer2 = makeRevealer({
      echoStore, pledgeStore, seekStore,
      postPeerReveal: async () => ({ mutual: true, identity: IDENTITY_B }),
      selfIdentity: () => ({ name: '我方', url: 'http://a/a2a' }),
      notify: () => {},
    })
    const connected = await seekerRevealer2.revealEcho(echoId)

    // 5) Assert connected + identity present.
    expect(connected).toEqual({ state: 'connected' })
    const finalEcho = echoStore.get(echoId)!
    expect(finalEcho.status).toBe('revealed')
    expect(finalEcho.self_revealed_at).not.toBeNull()
    expect(finalEcho.peer_revealed_at).not.toBeNull()
    expect(finalEcho.peer_masked).toBe('小B')                   // identity revealed
    expect(seekStore.get(intent_id)!.status).toBe('connected')
  })

  it('the disclosure gate still downgrades a leaky blurb (never recorded as an echo)', async () => {
    const db = openDb({ path: ':memory:' })
    const seekStore = makeSeekStore(db)
    const echoStore = makeEchoStore(db)
    const answerLeaky = makeAnswerIntent({ judge: async () => ({ match: 'yes', blurb: '住南京玄武区兰园路7号302,爱摄影' }), policy: POLICY, cheapEval: passingCheck })
    const jobs: Array<() => Promise<void>> = []
    const broker = makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [recB],
      send: async (_h, card) => answerLeaky({ agent: { id: 'cca' } as any, card }),
      sow: (id, topic) => seekStore.create({ id, kind: 'seek', topic }),
      recordEcho: (e) => echoStore.create({ id: `${e.intentId}:${e.peerAgentId}`, seekId: e.intentId, peerMasked: e.peerMasked, degree: e.degree, content: e.content, peerAgentId: e.peerAgentId }),
      finishSeek: (id, status, peersAsked) => seekStore.update(id, { status, peersAsked }),
      schedule: (fn) => { jobs.push(fn) },
    })
    const { intent_id } = await broker.seek('找周末拍照搭子')
    await Promise.all(jobs.map(j => j()))
    expect(echoStore.listForSeek(intent_id)).toHaveLength(0)     // leaky blurb downgraded to match:no
    expect(seekStore.get(intent_id)!.status).toBe('closed')
  })
})

describe('forwarding hop e2e (S → W → Q)', () => {
  it('2-hop forage → relay echo → proxied mutual reveal → identity crossing, anonymous until mutual', async () => {
    // Three dbs (three daemons).
    const sDb = openDb({ path: ':memory:' }); const wDb = openDb({ path: ':memory:' }); const qDb = openDb({ path: ':memory:' })
    const sSeek = makeSeekStore(sDb); const sEcho = makeEchoStore(sDb); const sPledge = makePledgeStore(sDb)
    const wRelay = makeRelayStore(wDb); const wSeen = makeSeenIntentStore(wDb)
    const qEcho = makeEchoStore(qDb); const qPledge = makePledgeStore(qDb); const qSeek = makeSeekStore(qDb)

    const S = { id: 'ccs', name: '小S', url: 'http://s/a2a' }
    const W = { id: 'ccw', name: '小W', url: 'http://w/a2a' }
    const Q = { id: 'ccq', name: '小Q', url: 'http://q/a2a' }

    // Q's answer: matches. W's answer: no-match (forces the forward).
    const qAnswer = makeAnswerIntent({ judge: async () => ({ match: 'yes', blurb: '我主人认识个摄影师' }), policy: POLICY, cheapEval: passingCheck })
    const wAnswerLocal = makeAnswerIntent({ judge: async () => ({ match: 'no' }), policy: POLICY, cheapEval: passingCheck })

    // Q's /a2a/intent — records a pledge on yes (seeker, as Q sees it, is W).
    const qOnIntent = async (event: any) => {
      const r = await qAnswer(event)
      if (r.match === 'yes') qPledge.create({ id: `${event.card.intent_id}:${event.agent.id}`, intentId: event.card.intent_id, seekerAgentId: event.agent.id, topic: event.card.topic })
      return r
    }
    // W's forwarder: forwards to Q, mints a relay row.
    const wForwarder = makeForwarder({
      answerLocally: wAnswerLocal,
      forwardTargets: (exclude) => [Q].filter(t => t.id !== exclude),
      forwardSend: async (target, card) => target.id === Q.id ? qOnIntent({ agent: W, card }) : null,
      recordRelay: (intentId, upstreamAgentId, downstreamAgentId) => {
        const tok = 'TOK'
        wRelay.create({ id: `${intentId}:${tok}`, intentId, relayToken: tok, upstreamAgentId, downstreamAgentId })
        return tok
      },
      markSeen: (i, e) => wSeen.markSeen({ intentId: i, expiresAt: e }),
      hasSeen: (i) => wSeen.hasSeen(i),
      hopCap: 2,
    })

    // S's broker: forwards a seek to W, records the degree-2 relay echo.
    const jobs: Array<() => Promise<void>> = []
    const sBroker = makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [W as any],
      send: async (_hand, card) => wForwarder({ agent: S as any, card }),
      sow: (id, topic) => sSeek.create({ id, kind: 'seek', topic }),
      recordEcho: (e) => {
        const id = e.peerAgentId != null ? `${e.intentId}:${e.peerAgentId}` : `${e.intentId}:${e.relayVia}:${e.relayToken}`
        sEcho.create({ id, seekId: e.intentId, peerMasked: e.peerMasked, degree: e.degree, content: e.content, peerAgentId: e.peerAgentId, relayVia: e.relayVia, relayToken: e.relayToken })
      },
      finishSeek: (id, status, n) => sSeek.update(id, { status, peersAsked: n }),
      schedule: (fn) => { jobs.push(fn) },
    })

    // 1) Sow + forage: S ends with ONE degree-2 relay echo, still masked.
    const { intent_id } = await sBroker.seek('找周末拍照搭子')
    await Promise.all(jobs.map(j => j()))
    const echoes = sEcho.listForSeek(intent_id)
    expect(echoes).toHaveLength(1)
    expect(echoes[0]!.degree).toBe(2)
    expect(echoes[0]!.relay_via).toBe('ccw')
    expect(echoes[0]!.peer_masked).toBe('第 2 度的某人')     // anonymous until mutual
    const relayEchoId = echoes[0]!.id

    // Reconciler on W + revealers on S and Q, wired to route reveals through W.
    const idOf = (id: string): PeerIdentity | null => ({ ccs: S, ccw: W, ccq: Q } as any)[id] ?? null
    let w3way = 0
    const wReconciler = makeRelayReconciler({
      relayStore: wRelay, identityOf: idOf,
      completeUpstream: (up, i, tok, dIdent) => { void sOnReveal({ agent_id: 'ccw', intent_id: i, relay_token: tok, peer_name: dIdent.name }) },
      completeDownstream: (down, i, uIdent) => { void qOnReveal({ agent_id: 'ccw', intent_id: i, peer_name: uIdent.name }) },
      nudge: (agentId, i, tok) => { if (agentId === 'ccq') void qOnReveal({ agent_id: 'ccw', intent_id: i }); else void sOnReveal({ agent_id: 'ccw', intent_id: i, relay_token: tok }) },
      notify3way: (..._a) => { w3way++ },
    })
    // W's inbound reveal handler = reconciler-first.
    const wOnReveal = (ev: any) => wReconciler.onRelayReveal({ callerAgentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token }) ?? { mutual: false }

    const sRevealer = makeRevealer({ echoStore: sEcho, pledgeStore: sPledge, seekStore: sSeek, postPeerReveal: async (_agentId, i, tok) => wOnReveal({ agent_id: 'ccs', intent_id: i, relay_token: tok }), selfIdentity: () => S, notify: () => {} })
    const qNotify = vi.fn()
    const qRevealer = makeRevealer({ echoStore: qEcho, pledgeStore: qPledge, seekStore: qSeek, postPeerReveal: async (_agentId, i) => wOnReveal({ agent_id: 'ccq', intent_id: i }), selfIdentity: () => Q, notify: qNotify })
    // S/Q inbound reveal handlers (endpoint side; W posts back to them).
    const sOnReveal = (ev: any) => sRevealer.onInboundReveal({ agentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token, peerName: ev.peer_name })
    const qOnReveal = (ev: any) => qRevealer.onInboundReveal({ agentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token, peerName: ev.peer_name })

    // 2) S reveals first → awaiting (W nudges Q).
    const sFirst = await sRevealer.revealEcho(relayEchoId)
    expect(sFirst).toEqual({ state: 'awaiting_peer' })

    // 3) Q reveals → mutual. Q learns S synchronously; W posts back to complete S.
    const qPledgeId = qPledge.list()[0]!.id
    const qOut = await qRevealer.revealPledge(qPledgeId)
    expect(qOut).toEqual({ state: 'connected' })

    // 4) Assert both connected + identity crossing + 3-way warmth.
    expect(sEcho.get(relayEchoId)!.peer_masked).toBe('小Q')   // S now sees Q
    expect(sSeek.get(intent_id)!.status).toBe('connected')
    expect(qPledge.get(qPledgeId)!.peer_revealed_at).not.toBeNull()   // Q connected too
    expect(w3way).toBe(1)   // W's owner gets a SINGLE 3-way warmth ping
    // Q's connected beat carried S's REAL name (crossed via W's registry, not W's own name).
    expect(qNotify).toHaveBeenCalledWith('connected', expect.objectContaining({ peerName: '小S' }))
  })
})

describe('forwarding hop — spec-#1 compatibility', () => {
  it('an old-style MatchReceipt (no forwarded) parses fine', () => {
    const r = MatchReceiptSchema.parse({ intent_id: 'i1', match: 'yes', blurb: 'x' })
    expect(r.forwarded).toBeUndefined()
  })
  it('an old IntentCard (no hop) safeParses and lands hop=1', () => {
    const p = IntentCardSchema.safeParse({ intent_id: 'i1', kind: 'seek', topic: 't', expires_at: '2026-07-15T01:00:00.000Z' })
    expect(p.success).toBe(true)
    expect(p.success && p.data.hop).toBe(1)
  })
  it('a forwarded field is stripped by the OLD MatchReceipt shape (no error)', () => {
    // Simulate an old seeker: parse with a schema that omits `forwarded`.
    const OldReceipt = z.object({ intent_id: z.string(), match: z.enum(['yes', 'no']), blurb: z.string().optional() })
    const r = OldReceipt.parse({ intent_id: 'i1', match: 'yes', blurb: 'x', forwarded: [{ blurb: 'y', degree: 2, relay_token: 'T' }] })
    expect((r as any).forwarded).toBeUndefined()
  })
})
