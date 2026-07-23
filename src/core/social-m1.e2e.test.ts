/**
 * Async foraging spine end-to-end (deterministic, in-process).
 *
 * Composes the REAL modules — makeBroker (propose→派/confirm + background forage) →
 * makeAnswerIntent (the peer's judge) → gateOutbound (disclosure) → makeRevealer
 * (mutual async reveal) — with injected deterministic judge + checker + stores.
 * The peer's SECOND reveal is simulated by stubbing the seeker's
 * postPeerReveal response ({ mutual: true, handle }) — the seeker never calls
 * its own onInboundReveal here (that entry point is covered directly in
 * social-reveal.test.ts; the HTTP transport is covered in a2a-server.test.ts).
 *
 * Reveal crosses a per-connection PenpalHandle (X25519 pubkey + channel id),
 * never real identity — the masked label (第 N 度的某人) is PERMANENT. Each
 * side's ChannelPort here is backed by a real makeChannelStore over its own
 * in-memory db, mirroring wire-social.ts's ChannelPort exactly (mint on
 * openLocal, persist the peer's handle on finalize).
 *
 * This file also covers the 2-hop forwarding-hop S→W→Q path (real broker +
 * forwarder + relay reconciler + two revealers, wired end-to-end across three
 * in-memory dbs) and spec-#1 backward-compat (old-shaped IntentCard/MatchReceipt
 * parsing unaffected by the new hop/forwarded fields).
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import z from 'zod'
import { openDb } from '../lib/db'
import { makeBroker } from './social-broker'
import { makeAnswerIntent } from './social-answer'
import { makeRevealer, type ChannelPort } from './social-reveal'
import { makeSeekStore } from './social-seek-store'
import { makeEchoStore } from './social-echo-store'
import { makePledgeStore } from './social-pledge-store'
import { makeAsyncResponder } from './social-async-responder'
import { makeEchoIntake } from './social-echo-intake'
import { makeEchoHandler } from './social-echo-relay'
import { makeRelayStore } from './social-relay-store'
import { makeSeenIntentStore } from './social-seen-intent-store'
import { makeRelayReconciler } from './social-relay-reveal'
import { makeChannelStore, type ChannelStore } from './penpal-channel-store'
import { generateKeypair, type PenpalHandle } from './penpal-crypto'
import { IntentCardSchema, MatchReceiptSchema } from './a2a-intent'

const POLICY = '可透露兴趣/城市;不透露住址门牌、第三方。'
const recB = { id: 'ccb', name: '小B', url: 'http://b/a2a', outbound_api_key: 'k' } as any

/** A ChannelPort backed by a real makeChannelStore — mirrors wire-social.ts's
 *  ChannelPort exactly: idempotent mint on openLocal, persist-the-peer's-
 *  handle-and-open on finalize. */
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

const passingCheck = async (prompt: string) => {
  const m = prompt.match(/"""([\s\S]*?)"""/)
  const reviewed = m?.[1] ?? ''
  const leak = /兰园路|门牌|老陈/.test(reviewed)
  return JSON.stringify(leak ? { violation: true, redacted: '', reasons: ['leak'] } : { violation: false, redacted: reviewed })
}

describe('async foraging spine e2e', () => {
  it('propose → 派/confirm → background echo → desktop reveal → peer reveals back → connected + channel opens, mask never lifts', async () => {
    const db = openDb({ path: ':memory:' })
    const seekStore = makeSeekStore(db)
    const echoStore = makeEchoStore(db)
    const pledgeStore = makePledgeStore(db)
    const channelStore = makeChannelStore(db)
    const channel = makeTestChannelPort(channelStore)

    // The peer's answering handler (match yes with a clean blurb).
    const answerB = makeAnswerIntent({ judge: async () => ({ match: 'yes', blurb: '南京摄影爱好者,周末想出门拍照' }), policy: POLICY, cheapEval: passingCheck })

    // A deferred scheduler so we can assert the seek returned BEFORE any echo.
    const jobs: Array<() => Promise<void>> = []
    const broker = makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [recB],
      // v2: send is fast-ack fire-and-forget (bool). The echo itself now
      // arrives later, out of band, via /a2a/echo → social-echo-intake.ts —
      // simulated here inline (this file's full async rebuild is Task 9) by
      // having the stub do what intake will do: land the echo + flip the
      // seek to `echoed` on a match.
      send: async (hand, card) => {
        const r = await answerB({ agent: { id: 'cca' } as any, card })
        if (r.match === 'yes') {
          echoStore.create({ id: `${card.intent_id}:${hand.id}`, seekId: card.intent_id, peerMasked: '第 1 度的某人', degree: 1, content: r.blurb ?? '', peerAgentId: hand.id })
          seekStore.update(card.intent_id, { status: 'echoed' })
        }
        return r.match === 'yes'
      },
      proposeRow: (id, r) => seekStore.propose({ id, kind: 'seek', topic: r.topic, redactedTopic: r.redactedTopic, ...(r.redactedCity ? { redactedCity: r.redactedCity } : {}) }),
      readSeek: (id) => seekStore.get(id),
      markStatus: (id, status) => seekStore.update(id, { status }),
      markForaged: (id, peersAsked) => seekStore.update(id, { peersAsked }),
      schedule: (fn) => { jobs.push(fn) },
    })

    // 1) Propose (creates a `proposed` row, exposes nothing) then 派/confirm —
    //    flips to `foraging` + schedules the (deferred) forage; no echo yet.
    const proposed = await broker.propose('找周末拍照搭子', { city: '南京' })
    expect(proposed.ok).toBe(true)
    const intent_id = (proposed as { ok: true; intent_id: string }).intent_id
    expect(seekStore.get(intent_id)!.status).toBe('proposed')
    expect(jobs).toHaveLength(0)                               // propose scheduled NOTHING
    broker.confirmSeek(intent_id)
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
      channel,
      notify: () => {},
    })
    const first = await seekerRevealer.revealEcho(echoId)
    expect(first).toEqual({ state: 'awaiting_peer' })
    expect(echoStore.get(echoId)!.self_revealed_at).not.toBeNull()
    expect(seekStore.get(intent_id)!.status).toBe('echoed')     // not yet connected

    // My own channel row now exists (pending — the peer hasn't presented a handle yet).
    const pendingChannel = channelStore.get(echoId)!
    expect(pendingChannel.status).toBe('pending')
    expect(pendingChannel.peer_pubkey).toBeNull()

    // 4) Peer reveals back — simulate their /a2a/reveal callback carrying their
    //    PenpalHandle (their pubkey never crosses via anything but this field).
    const peerHandle: PenpalHandle = { pubkey: generateKeypair().publicKey, channel_id: randomUUID() }
    const seekerRevealer2 = makeRevealer({
      echoStore, pledgeStore, seekStore,
      postPeerReveal: async () => ({ mutual: true, handle: peerHandle }),
      channel,
      notify: () => {},
    })
    const connected = await seekerRevealer2.revealEcho(echoId)

    // 5) Assert connected + the channel (not the mask) carries the crossing.
    expect(connected).toEqual({ state: 'connected' })
    const finalEcho = echoStore.get(echoId)!
    expect(finalEcho.status).toBe('revealed')
    expect(finalEcho.self_revealed_at).not.toBeNull()
    expect(finalEcho.peer_revealed_at).not.toBeNull()
    expect(finalEcho.peer_masked).toBe('第 1 度的某人')          // STILL masked — no identity crossing
    expect(seekStore.get(intent_id)!.status).toBe('connected')

    const openChannel = channelStore.get(echoId)!
    expect(openChannel.status).toBe('open')
    expect(openChannel.peer_pubkey).toBe(peerHandle.pubkey)
    expect(openChannel.peer_channel_id).toBe(peerHandle.channel_id)
  })

  it('派心愿 full chain: propose stores the redacted wording, 派/confirm broadcasts THAT stored string verbatim (WYSIWYG), a cancelled row never forages', async () => {
    const db = openDb({ path: ':memory:' })
    const seekStore = makeSeekStore(db)
    const echoStore = makeEchoStore(db)
    const answerB = makeAnswerIntent({ judge: async () => ({ match: 'yes', blurb: '南京摄影同好' }), policy: POLICY, cheapEval: passingCheck })
    const jobs: Array<() => Promise<void>> = []
    let sentCard: any = null
    const broker = makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [recB],
      // v2 fast-ack — see the first test's comment for why this stub inlines
      // the intake-equivalent echo landing (full rebuild deferred to Task 9).
      send: async (hand, card) => {
        sentCard = card
        const r = await answerB({ agent: { id: 'cca' } as any, card })
        if (r.match === 'yes') {
          echoStore.create({ id: `${card.intent_id}:${hand.id}`, seekId: card.intent_id, peerMasked: '第 1 度的某人', degree: 1, content: r.blurb ?? '', peerAgentId: hand.id })
          seekStore.update(card.intent_id, { status: 'echoed' })
        }
        return r.match === 'yes'
      },
      proposeRow: (id, r) => seekStore.propose({ id, kind: 'seek', topic: r.topic, redactedTopic: r.redactedTopic, ...(r.redactedCity ? { redactedCity: r.redactedCity } : {}) }),
      readSeek: (id) => seekStore.get(id),
      markStatus: (id, status) => seekStore.update(id, { status }),
      markForaged: (id, peersAsked) => seekStore.update(id, { peersAsked }),
      schedule: (fn) => { jobs.push(fn) },
    })

    // 1) Propose — a `proposed` row with a persisted redacted_topic; the peer is
    //    NEVER contacted and nothing is scheduled (GATE-EVERY-BROADCAST: propose
    //    exposes zero, 派 is the only thing that forages).
    const proposed = await broker.propose('找周末拍照搭子', { city: '南京' })
    expect(proposed.ok).toBe(true)
    const intent_id = (proposed as { ok: true; intent_id: string }).intent_id
    const proposedRow = seekStore.get(intent_id)!
    expect(proposedRow.status).toBe('proposed')
    expect(proposedRow.redacted_topic).toBe('找周末拍照搭子')   // owner-approved wording persisted
    expect(echoStore.listForSeek(intent_id)).toHaveLength(0)
    expect(jobs).toHaveLength(0)          // NO peer contacted at propose time
    expect(sentCard).toBeNull()

    // 2) 派/confirm — flips to `foraging` + schedules the forage of the STORED
    //    redacted string (no re-gate). Then run the deferred forage.
    const confirmed = broker.confirmSeek(intent_id)
    expect(confirmed).toEqual({ ok: true, intent_id })
    expect(seekStore.get(intent_id)!.status).toBe('foraging')
    await Promise.all(jobs.map(j => j()))

    // 3) The echo landed AND the peer's captured card carries the BYTE-IDENTICAL
    //    stored string (topic + city) — WYSIWYG end-to-end.
    const echoes = echoStore.listForSeek(intent_id)
    expect(echoes).toHaveLength(1)
    expect(sentCard.topic).toBe(proposedRow.redacted_topic)
    expect(sentCard.city).toBe(proposedRow.redacted_city)
    expect(seekStore.get(intent_id)!.status).toBe('echoed')

    // 4) A fresh `proposed` row that is cancelled NEVER forages — cancel schedules
    //    nothing and a later confirm of a cancelled row is rejected.
    const jobsBefore = jobs.length
    const p2 = await broker.propose('找露营搭子')
    const id2 = (p2 as { ok: true; intent_id: string }).intent_id
    expect(broker.cancelSeek(id2)).toEqual({ ok: true })
    expect(seekStore.get(id2)!.status).toBe('cancelled')
    expect(jobs).toHaveLength(jobsBefore)                 // cancel scheduled no forage
    expect(broker.confirmSeek(id2)).toEqual({ ok: false, reason: 'not_proposed' })
    expect(jobs).toHaveLength(jobsBefore)                 // rejected confirm still forages nothing
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
      // v2 fast-ack: the leaky blurb never even gets far enough to be a
      // "would-be echo" — answerLeaky's own gateOutbound downgrades it to
      // match:'no' before it leaves the peer, so there's nothing to land.
      send: async (_h, card) => {
        const r = await answerLeaky({ agent: { id: 'cca' } as any, card })
        return r.match === 'yes'
      },
      proposeRow: (id, r) => seekStore.propose({ id, kind: 'seek', topic: r.topic, redactedTopic: r.redactedTopic, ...(r.redactedCity ? { redactedCity: r.redactedCity } : {}) }),
      readSeek: (id) => seekStore.get(id),
      markStatus: (id, status) => seekStore.update(id, { status }),
      markForaged: (id, peersAsked) => seekStore.update(id, { peersAsked }),
      schedule: (fn) => { jobs.push(fn) },
    })
    const proposed = await broker.propose('找周末拍照搭子')
    const intent_id = (proposed as { ok: true; intent_id: string }).intent_id
    broker.confirmSeek(intent_id)
    await Promise.all(jobs.map(j => j()))
    expect(echoStore.listForSeek(intent_id)).toHaveLength(0)     // leaky blurb downgraded to match:no
    expect(seekStore.get(intent_id)!.status).toBe('foraging')    // v2: forage never auto-closes, stays foraging
  })
})

describe('forwarding hop e2e (S → W → Q)', () => {
  it('2-hop forage → async fast-ack forward → async echo relay back → proxied mutual reveal → handle crossing, mask never lifts', async () => {
    // Three dbs (three daemons).
    const sDb = openDb({ path: ':memory:' }); const wDb = openDb({ path: ':memory:' }); const qDb = openDb({ path: ':memory:' })
    const sSeek = makeSeekStore(sDb); const sEcho = makeEchoStore(sDb); const sPledge = makePledgeStore(sDb)
    const sChannelStore = makeChannelStore(sDb)
    const sChannel = makeTestChannelPort(sChannelStore)
    const wRelay = makeRelayStore(wDb); const wSeen = makeSeenIntentStore(wDb)
    const qEcho = makeEchoStore(qDb); const qPledge = makePledgeStore(qDb); const qSeek = makeSeekStore(qDb)
    const qChannelStore = makeChannelStore(qDb)
    const qChannel = makeTestChannelPort(qChannelStore)

    const S = { id: 'ccs', name: '小S', url: 'http://s/a2a' }
    const W = { id: 'ccw', name: '小W', url: 'http://w/a2a' }
    const Q = { id: 'ccq', name: '小Q', url: 'http://q/a2a' }

    // Q's answer: matches. W's answer: no-match (forces the forward).
    const qAnswer = makeAnswerIntent({ judge: async () => ({ match: 'yes', blurb: '我主人认识个摄影师' }), policy: POLICY, cheapEval: passingCheck })
    const wAnswerLocal = makeAnswerIntent({ judge: async () => ({ match: 'no' }), policy: POLICY, cheapEval: passingCheck })
    // Q's local answer wraps the judge with pledge-on-yes — the seeker, as Q
    // sees it, is whoever posted the (already hop+1) card to Q: W.
    const qAnswerLocally = async (event: any) => {
      const r = await qAnswer(event)
      if (r.match === 'yes') qPledge.create({ id: `${event.card.intent_id}:${event.agent.id}`, intentId: event.card.intent_id, seekerAgentId: event.agent.id, topic: event.card.topic })
      return r
    }

    // Each daemon's async responder schedules its background judge/echo/
    // forward leg onto its OWN job queue (mirrors wire-social.ts's default
    // fire-and-forget `schedule`, deferred here so the test can drive each
    // hop deterministically instead of racing real timers).
    const sJobs: Array<() => Promise<void>> = []
    const wJobs: Array<() => Promise<void>> = []
    const qJobs: Array<() => Promise<void>> = []

    // S's own /a2a/echo handler — S is the ORIGIN of this intent, so intake
    // always resolves it as "my own seek" (echoIntake); S never relays.
    const sEchoIntake = makeEchoIntake({
      seekStatus: (id) => sSeek.get(id)?.status ?? null,
      recordEcho: (e) => {
        const id = e.peerAgentId != null ? `${e.intentId}:${e.peerAgentId}` : `${e.intentId}:${e.relayVia}:${e.relayToken}`
        sEcho.create({ id, seekId: e.intentId, peerMasked: e.peerMasked, degree: e.degree, content: e.content, peerAgentId: e.peerAgentId, relayVia: e.relayVia, relayToken: e.relayToken })
      },
      markEchoed: (id) => { const cur = sSeek.get(id); if (cur?.status === 'foraging') sSeek.update(id, { status: 'echoed' }) },
    })
    const sOnEcho = (senderAgentId: string, msg: any) => makeEchoHandler({
      intake: sEchoIntake,
      originOf: () => null,                 // S never relays — it's always the origin
      recordRelay: () => { throw new Error('S should never relay') },
      postEcho: async () => { throw new Error('S should never post further') },
    })(senderAgentId, msg)

    // W's /a2a/echo handler — W has no seeks of its own; every echo it
    // receives is a downstream reply to an intent it forwarded, resolved via
    // its own seen-intent origin record (written by wOnIntent's markSeen).
    const wOnEcho = (senderAgentId: string, msg: any) => makeEchoHandler({
      intake: () => 'unknown' as const,
      originOf: (intentId) => wSeen.originOf(intentId),
      recordRelay: (intentId, upstreamAgentId, downstreamAgentId) => {
        const tok = 'TOK'
        wRelay.create({ id: `${intentId}:${tok}`, intentId, relayToken: tok, upstreamAgentId, downstreamAgentId })
        return tok
      },
      // Only one target (S) in this test — always the relay leg's origin.
      postEcho: async (_to, m) => { const r = await sOnEcho('ccw', m); return r.ok },
    })(senderAgentId, msg)

    // Q's /a2a/intent — v2 async responder: judge locally, echo the sender
    // (W, as Q sees it) via wOnEcho. Q never forwards further (empty targets).
    const qOnIntent = makeAsyncResponder({
      answerLocally: qAnswerLocally,
      postEcho: async (_to, m) => { const r = await wOnEcho('ccq', m); return r.ok },
      forwardTargets: () => [],
      forwardSend: async () => false,
      markSeen: () => {}, hasSeen: () => false,
      schedule: (fn) => { qJobs.push(fn) },
    })

    // W's /a2a/intent — v2 async responder: judges locally (always no here),
    // fans out hop+1 to Q. markSeen records the ORIGIN (S) so wOnEcho's
    // originOf can resolve who a downstream echo relays back to.
    const wOnIntent = makeAsyncResponder({
      answerLocally: wAnswerLocal,
      postEcho: async () => false,   // W never matches locally in this test
      forwardTargets: (exclude) => [Q].filter(t => t.id !== exclude),
      forwardSend: async (target, card) => {
        if (target.id !== Q.id) return false
        await qOnIntent({ agent: W as any, card })   // fast-ack only; Q's own job lands in qJobs
        return true
      },
      markSeen: (intentId, expiresAt, origin) => wSeen.markSeen({ intentId, expiresAt, originAgentId: origin }),
      hasSeen: (intentId) => wSeen.hasSeen(intentId),
      hopCap: 2,
      schedule: (fn) => { wJobs.push(fn) },
    })

    // S's broker: forwards a seek to W. v2 fast-ack — `send` only proves
    // delivery was accepted; the degree-2 relay echo lands later, out of
    // band, via S's OWN /a2a/echo (sOnEcho), driven below by draining each
    // daemon's job queue in hop order (S → W → Q).
    const sBroker = makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [W as any],
      send: async (_hand, card) => { try { await wOnIntent({ agent: S as any, card }); return true } catch { return false } },
      proposeRow: (id, r) => sSeek.propose({ id, kind: 'seek', topic: r.topic, redactedTopic: r.redactedTopic, ...(r.redactedCity ? { redactedCity: r.redactedCity } : {}) }),
      readSeek: (id) => sSeek.get(id),
      markStatus: (id, status) => sSeek.update(id, { status }),
      markForaged: (id, peersAsked) => sSeek.update(id, { peersAsked }),
      schedule: (fn) => { sJobs.push(fn) },
    })

    // 1) Propose + 派/confirm + forage: S's send reaches W synchronously
    //    (fast-ack), which only SCHEDULES its own background judge+forward job.
    const proposed = await sBroker.propose('找周末拍照搭子')
    const intent_id = (proposed as { ok: true; intent_id: string }).intent_id
    sBroker.confirmSeek(intent_id)
    await Promise.all(sJobs.splice(0).map(j => j()))
    // 2) Drain W's background leg: judges locally (no), forwards to Q — which
    //    itself only schedules its OWN background leg (fast-ack), not runs it.
    await Promise.all(wJobs.splice(0).map(j => j()))
    // 3) Drain Q's background leg: judges yes, pledges, echoes W — which mints
    //    the relay leg and posts the relayed echo onward to S's own /a2a/echo.
    await Promise.all(qJobs.splice(0).map(j => j()))

    const echoes = sEcho.listForSeek(intent_id)
    expect(echoes).toHaveLength(1)
    expect(echoes[0]!.degree).toBe(2)
    expect(echoes[0]!.relay_via).toBe('ccw')
    expect(echoes[0]!.peer_masked).toBe('第 2 度的某人')     // anonymous until mutual
    const relayEchoId = echoes[0]!.id

    // Reconciler on W + revealers on S and Q, wired to route reveals through W.
    // W stays content-blind: it only ever crosses the two endpoints' ephemeral
    // PenpalHandles, resolved from the durable social_relay row — never a
    // registry lookup, never a real name.
    let w3way = 0
    const wReconciler = makeRelayReconciler({
      relayStore: wRelay,
      completeUpstream: (up, i, tok, dHandle) => { void sOnReveal({ agent_id: 'ccw', intent_id: i, relay_token: tok, peer_handle: dHandle }) },
      completeDownstream: (down, i, uHandle) => { void qOnReveal({ agent_id: 'ccw', intent_id: i, peer_handle: uHandle }) },
      nudge: (agentId, i, tok) => { if (agentId === 'ccq') void qOnReveal({ agent_id: 'ccw', intent_id: i }); else void sOnReveal({ agent_id: 'ccw', intent_id: i, relay_token: tok }) },
      notify3way: (..._a) => { w3way++ },
    })
    // W's inbound reveal handler = reconciler-first.
    const wOnReveal = (ev: any) => wReconciler.onRelayReveal({ callerAgentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token, peerHandle: ev.peer_handle }) ?? { mutual: false }

    // Each side's postPeerReveal carries ITS OWN just-minted handle (read back
    // from its own channel row, exactly like wire-social.ts's postPeerReveal
    // reconstructs rowId to read `myHandle` before POSTing) so W has something
    // to cross.
    const sRevealer = makeRevealer({
      echoStore: sEcho, pledgeStore: sPledge, seekStore: sSeek,
      postPeerReveal: async (agentId, i, tok) => {
        const rowId = tok ? `${i}:${agentId}:${tok}` : `${i}:${agentId}`
        const ch = sChannelStore.get(rowId)
        const myHandle = ch ? { pubkey: ch.my_pubkey, channel_id: ch.my_channel_id } : undefined
        return wOnReveal({ agent_id: 'ccs', intent_id: i, relay_token: tok, ...(myHandle ? { peer_handle: myHandle } : {}) })
      },
      channel: sChannel, notify: () => {},
    })
    const qNotify = vi.fn()
    const qRevealer = makeRevealer({
      echoStore: qEcho, pledgeStore: qPledge, seekStore: qSeek,
      postPeerReveal: async (agentId, i) => {
        const rowId = `${i}:${agentId}`
        const ch = qChannelStore.get(rowId)
        const myHandle = ch ? { pubkey: ch.my_pubkey, channel_id: ch.my_channel_id } : undefined
        return wOnReveal({ agent_id: 'ccq', intent_id: i, ...(myHandle ? { peer_handle: myHandle } : {}) })
      },
      channel: qChannel, notify: qNotify,
    })
    // S/Q inbound reveal handlers (endpoint side; W posts back to them).
    const sOnReveal = (ev: any) => sRevealer.onInboundReveal({ agentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token, peerHandle: ev.peer_handle })
    const qOnReveal = (ev: any) => qRevealer.onInboundReveal({ agentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token, peerHandle: ev.peer_handle })

    // 2) S reveals first → awaiting (W nudges Q).
    const sFirst = await sRevealer.revealEcho(relayEchoId)
    expect(sFirst).toEqual({ state: 'awaiting_peer' })

    // 3) Q reveals → mutual. Q learns S synchronously; W posts back to complete S.
    const qPledgeId = qPledge.list()[0]!.id
    const qOut = await qRevealer.revealPledge(qPledgeId)
    expect(qOut).toEqual({ state: 'connected' })

    // 4) Assert both connected + channels opened (handle crossing) + 3-way warmth,
    //    and that the mask NEVER lifts — S never learns Q's (or W's) real name.
    expect(sEcho.get(relayEchoId)!.peer_masked).toBe('第 2 度的某人')   // still masked
    expect(sSeek.get(intent_id)!.status).toBe('connected')
    expect(qPledge.get(qPledgeId)!.peer_revealed_at).not.toBeNull()   // Q connected too
    expect(w3way).toBe(1)   // W's owner gets a SINGLE 3-way warmth ping

    const sChannelRow = sChannelStore.get(relayEchoId)!
    expect(sChannelRow.status).toBe('open')
    expect(sChannelRow.peer_pubkey).not.toBeNull()
    expect(sChannelRow.peer_channel_id).not.toBeNull()

    const qChannelRow = qChannelStore.get(qPledgeId)!
    expect(qChannelRow.status).toBe('open')
    expect(qChannelRow.peer_pubkey).not.toBeNull()
    expect(qChannelRow.peer_channel_id).not.toBeNull()
    // The two sides' crossed pubkeys are each other's — never a name.
    expect(sChannelRow.peer_pubkey).toBe(qChannelRow.my_pubkey)
    expect(qChannelRow.peer_pubkey).toBe(sChannelRow.my_pubkey)

    // Q's connected beat is content-free — no peer name, ever (W never had one to give).
    expect(qNotify).toHaveBeenCalledWith('connected', { intentId: intent_id })
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
