/**
 * social-async.e2e.test.ts — the three-topology end-to-end suite for the
 * fully-async discovery flow (Task 9, spec 2026-07-22-async-discovery).
 * Composes the REAL modules — makeBroker, makeAsyncResponder, makeEchoIntake,
 * makeEchoHandler, makeEnvelopeDispatch, mailbox-crypto seal/open +
 * generateMailboxIdentity, makeRelayReconciler, the real sqlite-backed
 * stores — with injected deterministic judges/checks and stub registries.
 * The "transport seam" is always either (a) wiring one side's postX function
 * DIRECTLY onto the other side's inbound handler (push), or (b) a fake
 * in-memory mailbox drop-queue that only ever holds sealed bytes (mailbox) —
 * never a real socket, never relay/server.ts.
 *
 * Replaces social-m1.e2e.test.ts (deleted). That file's non-discovery
 * coverage now lives elsewhere:
 *   - propose/confirm/cancel/WYSIWYG/forage-v2 fan-out → social-broker.test.ts
 *   - the full mutual-reveal dance (echo/pledge/relay branches)            → social-reveal.test.ts
 *   - the leaky-blurb-downgrade gate ("DOWNGRADES to no...")               → social-answer.test.ts
 *   - the mock-level echoHandler/echoIntake unit matrix                     → social-echo-relay.test.ts / social-echo-intake.test.ts
 * This file only owns the async discovery TOPOLOGY end-to-end (real modules
 * wired together across real per-daemon dbs), which none of those cover in
 * composition. The IntentCard/MatchReceipt backward-compat schema spot-
 * checks are carried over verbatim at the bottom (unique to this file).
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import z from 'zod'
import { openTestDb } from '../lib/db'
import { makeBroker } from './social-broker'
import { makeAnswerIntent } from './social-answer'
import { makeSeekStore } from './social-seek-store'
import { makeEchoStore } from './social-echo-store'
import { makePledgeStore } from './social-pledge-store'
import { makeAsyncResponder } from './social-async-responder'
import { makeEchoIntake } from './social-echo-intake'
import { makeEchoHandler } from './social-echo-relay'
import { makeRelayStore } from './social-relay-store'
import { makeSeenIntentStore } from './social-seen-intent-store'
import { makeRelayReconciler } from './social-relay-reveal'
import { makeEnvelopeDispatch, type EnvelopeDispatch } from './mailbox-dispatch'
import { generateMailboxIdentity, sealEnvelope, openEnvelope, type Envelope } from './mailbox-crypto'
import type { A2ARegistry } from './a2a-registry'
import type { EchoRecord } from './social-broker'
import { IntentCardSchema, MatchReceiptSchema } from './a2a-intent'

const POLICY = '可透露兴趣/城市;不透露门牌、第三方。'
const passingCheck = async (prompt: string) => {
  const m = prompt.match(/"""([\s\S]*?)"""/)
  const reviewed = m?.[1] ?? ''
  return JSON.stringify({ violation: false, redacted: reviewed })
}

/** Mirrors wire-social.ts's real `recordEcho` closure verbatim (see Task 8's
 *  wire-social.ts): durable first-echo detection asked of the store itself
 *  BEFORE the insert (so a redelivery never re-fires the beat), and a
 *  swallowed duplicate-PK insert (social_echo.id is PRIMARY KEY — the
 *  idempotent landing IS the thrown-and-caught constraint error). */
function makeRecordEcho(echoStore: ReturnType<typeof makeEchoStore>, notify: (kind: string, payload: { intentId: string }) => void) {
  return (e: EchoRecord): void => {
    const isFirst = echoStore.listForSeek(e.intentId).length === 0
    try {
      const id = e.peerAgentId != null ? `${e.intentId}:${e.peerAgentId}` : `${e.intentId}:${e.relayVia}:${e.relayToken}`
      echoStore.create({ id, seekId: e.intentId, peerMasked: e.peerMasked, degree: e.degree, content: e.content, peerAgentId: e.peerAgentId, relayVia: e.relayVia, relayToken: e.relayToken })
    } catch { /* duplicate id (PK) — already landed; idempotent no-op */ }
    if (isFirst) notify('first_echo', { intentId: e.intentId })
  }
}
/** Mirrors wire-social.ts's real `markEchoed` closure: flip foraging→echoed
 *  only — never downgrade `connected`, never touch anything else. */
function makeMarkEchoed(seekStore: ReturnType<typeof makeSeekStore>) {
  return (intentId: string): void => {
    const cur = seekStore.get(intentId)
    if (cur?.status === 'foraging') seekStore.update(intentId, { status: 'echoed' })
  }
}

describe('async discovery e2e — topology 1: full push', () => {
  it('S forages; R fast-acks before its deliberately-slow judge resolves; once the judge lands a match, R posts the echo → S intake lands it (id=intent:R), seek foraging→echoed, first-echo notify exactly once', async () => {
    const sDb = openTestDb()
    const sSeek = makeSeekStore(sDb); const sEcho = makeEchoStore(sDb)
    const notify = vi.fn()
    const sEchoIntake = makeEchoIntake({ seekStatus: (id) => sSeek.get(id)?.status ?? null, recordEcho: makeRecordEcho(sEcho, notify), markEchoed: makeMarkEchoed(sSeek) })
    const sOnEcho = (senderAgentId: string, msg: any) => makeEchoHandler({
      intake: sEchoIntake,
      originOf: () => null,                        // S never relays — always the origin
      recordRelay: () => { throw new Error('S should never relay') },
      postEcho: async () => { throw new Error('S should never post further') },
    })(senderAgentId, msg)

    // R's judge is DELIBERATELY slow — a manually-controlled gate that only
    // resolves when the test calls resolveJudge(), so we can assert the
    // fast-ack returned BEFORE it ever settles.
    let resolveJudge!: (v: { match: 'yes' | 'no'; blurb?: string }) => void
    let judgeResolved = false
    const judgeGate = new Promise<{ match: 'yes' | 'no'; blurb?: string }>(res => { resolveJudge = (v) => { judgeResolved = true; res(v) } })
    const rAnswer = makeAnswerIntent({ judge: async () => judgeGate, policy: POLICY, cheapEval: passingCheck })

    // Captures the background job's own promise (NOT awaited by the
    // responder itself) so the test can await it deterministically once the
    // judge is released.
    let bgDone: Promise<void> | null = null
    const rOnIntent = makeAsyncResponder({
      answerLocally: rAnswer,
      postEcho: async (_to, m) => { const r = await sOnEcho('ccr', m); return r.ok },
      forwardTargets: () => [],
      forwardSend: async () => false,
      markSeen: () => {}, hasSeen: () => false,
      schedule: (fn) => { bgDone = fn() },
    })

    const R = { id: 'ccr', name: '小R', url: 'http://r/a2a', outbound_api_key: 'k' } as any
    const sJobs: Array<() => Promise<void>> = []
    const broker = makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [R],
      // The transport seam: S's send is wired DIRECTLY onto R's onIntent handler.
      send: async (_hand, card) => { const r = await rOnIntent({ agent: { id: 'ccs' } as any, card }); return r.async === true },
      proposeRow: (id, r) => sSeek.propose({ id, kind: 'seek', topic: r.topic, redactedTopic: r.redactedTopic }),
      readSeek: (id) => sSeek.get(id),
      markStatus: (id, status) => sSeek.update(id, { status }),
      markForaged: (id, peersAsked) => sSeek.update(id, { peersAsked }),
      schedule: (fn) => { sJobs.push(fn) },
    })

    const proposed = await broker.propose('找周末拍照搭子')
    const intentId = (proposed as { ok: true; intent_id: string }).intent_id
    broker.confirmSeek(intentId)
    // Drain S's own forage job — this calls send() → rOnIntent(...), which
    // fast-acks synchronously WITHOUT ever awaiting the slow judge.
    await Promise.all(sJobs.splice(0).map(j => j()))
    expect(judgeResolved).toBe(false)                            // forage returned — judge still hasn't
    expect(sSeek.get(intentId)!.status).toBe('foraging')         // no echo landed yet
    expect(sEcho.listForSeek(intentId)).toHaveLength(0)

    // Now let the judge complete — R's background leg resumes and posts the echo.
    resolveJudge({ match: 'yes', blurb: '南京摄影爱好者,周末想出门拍照' })
    await bgDone

    const echoes = sEcho.listForSeek(intentId)
    expect(echoes).toHaveLength(1)
    expect(echoes[0]!.id).toBe(`${intentId}:ccr`)
    expect(echoes[0]!.peer_agent_id).toBe('ccr')
    expect(echoes[0]!.degree).toBe(1)
    expect(sSeek.get(intentId)!.status).toBe('echoed')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('first_echo', { intentId })
  })
})

describe('async discovery e2e — topology 2: mailbox round-trip', () => {
  it('S/R both mailbox-only: a sealed intent envelope drops into R\'s queue → R dispatches it (real makeEnvelopeDispatch) → background judge yes → a sealed echo envelope drops into S\'s queue → S dispatches it → intake lands the row; both queues only ever held sealed bytes', async () => {
    const S_ID = 'ccs'; const R_ID = 'ccr'
    const sMailbox = generateMailboxIdentity()   // {addr, addr_priv, enc_pub, enc_priv}
    const rMailbox = generateMailboxIdentity()
    const STOR = 'stor-bearer-0000000000000'     // S presents this bearer when calling R
    const RTOS = 'rtos-bearer-0000000000000'     // R presents this bearer when calling S

    // Fake relay: a plain in-memory drop queue per mailbox address (the
    // in-process-fake idiom of pairing.integration.test.ts's relay stand-in,
    // minus the HTTP/store layer — the queue only ever holds whatever
    // sealEnvelope produced, so it's structurally content-blind).
    const queues = new Map<string, string[]>()
    const drop = (to: string, envelope: string) => { const q = queues.get(to) ?? []; q.push(envelope); queues.set(to, q) }
    const drain = (addr: string): string[] => { const q = queues.get(addr) ?? []; queues.set(addr, []); return q }
    const poll = async (myEncPriv: string, addr: string, dispatch: EnvelopeDispatch) => {
      for (const raw of drain(addr)) {
        const env = JSON.parse(raw) as Envelope
        const inner = openEnvelope(myEncPriv, env)
        if (inner) await dispatch.dispatch(inner)
      }
    }

    function memRegistry(trust: Record<string, string>): A2ARegistry {   // agentId -> the bearer we accept
      return {
        list: () => [], get: () => null,
        verifyBearer: (agentId, bearer) => (trust[agentId] === bearer ? ({ id: agentId } as any) : null),
        add: () => {}, remove: () => {}, setPaused: () => {}, update: () => { throw new Error('unused in this fixture') },
      }
    }
    const rRegistry = memRegistry({ [S_ID]: STOR })
    const sRegistry = memRegistry({ [R_ID]: RTOS })

    // ---- S side: stores + intake (S is always the origin of its own seek).
    const sDb = openTestDb()
    const sSeek = makeSeekStore(sDb); const sEcho = makeEchoStore(sDb)
    const notify = vi.fn()
    const sEchoIntake = makeEchoIntake({ seekStatus: (id) => sSeek.get(id)?.status ?? null, recordEcho: makeRecordEcho(sEcho, notify), markEchoed: makeMarkEchoed(sSeek) })
    const sOnEcho = (senderAgentId: string, msg: any) => makeEchoHandler({
      intake: sEchoIntake, originOf: () => null,
      recordRelay: () => { throw new Error('S should never relay') },
      postEcho: async () => { throw new Error('S should never post further') },
    })(senderAgentId, msg)
    const sDispatch = makeEnvelopeDispatch({ registry: sRegistry, onReveal: undefined, onLetter: undefined, onIntent: undefined, onEcho: async ({ agent, msg }) => sOnEcho(agent.id, msg), log: () => {} })

    // ---- R side: the real async responder, echoing back by sealing+dropping.
    const rAnswer = makeAnswerIntent({ judge: async () => ({ match: 'yes', blurb: '我认识一位摄影师' }), policy: POLICY, cheapEval: passingCheck })
    const rJobs: Array<() => Promise<void>> = []
    const rOnIntent = makeAsyncResponder({
      answerLocally: rAnswer,
      postEcho: async (_to, m) => {
        drop(sMailbox.addr, JSON.stringify(sealEnvelope({ path: '/a2a/echo', bearer: RTOS, body: { agent_id: R_ID, ...m } }, sMailbox.enc_pub)))
        return true
      },
      forwardTargets: () => [], forwardSend: async () => false,
      markSeen: () => {}, hasSeen: () => false,
      schedule: (fn) => { rJobs.push(fn) },
    })
    const rDispatch = makeEnvelopeDispatch({ registry: rRegistry, onReveal: undefined, onLetter: undefined, onIntent: rOnIntent, onEcho: undefined, log: () => {} })

    // ---- S's broker: R is a mailbox-only peer (no url) — v2 discover now
    // surfaces mailbox peers first-class for degree-1 intents (spec §1);
    // send seals + drops into R's queue.
    const R_PEER = { id: R_ID, name: 'R', outbound_api_key: STOR, transport: 'mailbox', mailbox_addr: rMailbox.addr, mailbox_enc_pub: rMailbox.enc_pub, relays: ['fake://relay'] } as any
    const sJobs: Array<() => Promise<void>> = []
    const broker = makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [R_PEER],
      send: async (hand, card) => {
        drop(hand.mailbox_addr!, JSON.stringify(sealEnvelope({ path: '/a2a/intent', bearer: hand.outbound_api_key, body: { agent_id: S_ID, card } }, hand.mailbox_enc_pub!)))
        return true
      },
      proposeRow: (id, r) => sSeek.propose({ id, kind: 'seek', topic: r.topic, redactedTopic: r.redactedTopic }),
      readSeek: (id) => sSeek.get(id),
      markStatus: (id, status) => sSeek.update(id, { status }),
      markForaged: (id, peersAsked) => sSeek.update(id, { peersAsked }),
      schedule: (fn) => { sJobs.push(fn) },
    })

    const proposed = await broker.propose('找周末拍照搭子')
    const intentId = (proposed as { ok: true; intent_id: string }).intent_id
    broker.confirmSeek(intentId)
    await Promise.all(sJobs.splice(0).map(j => j()))   // seals + drops the intent envelope into R's queue

    const rQueueRaw = queues.get(rMailbox.addr) ?? []
    expect(rQueueRaw).toHaveLength(1)
    expect(rQueueRaw[0]).not.toContain('找周末拍照搭子')
    expect(rQueueRaw[0]).not.toContain(S_ID)
    expect(rQueueRaw[0]).not.toContain(STOR)

    // R dispatches (the REAL makeEnvelopeDispatch) — fast-acks, schedules
    // its own background judge+echo leg.
    await poll(rMailbox.enc_priv, rMailbox.addr, rDispatch)
    await Promise.all(rJobs.splice(0).map(j => j()))

    const sQueueRaw = queues.get(sMailbox.addr) ?? []
    expect(sQueueRaw).toHaveLength(1)
    expect(sQueueRaw[0]).not.toContain('我认识一位摄影师')
    expect(sQueueRaw[0]).not.toContain(R_ID)
    expect(sQueueRaw[0]).not.toContain(RTOS)

    // S dispatches — intake lands the echo.
    await poll(sMailbox.enc_priv, sMailbox.addr, sDispatch)

    const echoes = sEcho.listForSeek(intentId)
    expect(echoes).toHaveLength(1)
    expect(echoes[0]!.id).toBe(`${intentId}:${R_ID}`)
    expect(sSeek.get(intentId)!.status).toBe('echoed')
    expect(notify).toHaveBeenCalledTimes(1)

    // Both drop queues are empty now — they only ever held sealed bytes
    // (asserted above, before each poll drained them).
    expect(queues.get(rMailbox.addr)).toEqual([])
    expect(queues.get(sMailbox.addr)).toEqual([])
  })
})

describe('async discovery e2e — topology 3: 2-hop per-echo relay', () => {
  it('S→W (W judges no, forwards to Q) → Q judges yes → Q.onEcho reaches W (not a seek W owns; originOf resolves S) → W mints the relay row (upstream=S, downstream=Q) + token → S records a relay echo (peerAgentId null, relayVia=W, relayToken, degree 2); feeding the minted row through the existing relay-reveal reconciler crosses both legs — reveal never special-cases an async-origin relay row', async () => {
    const sDb = openTestDb(); const wDb = openTestDb(); const qDb = openTestDb()
    const sSeek = makeSeekStore(sDb); const sEcho = makeEchoStore(sDb)
    const wRelay = makeRelayStore(wDb); const wSeen = makeSeenIntentStore(wDb)
    const qPledge = makePledgeStore(qDb)

    const S = { id: 'ccs', name: '小S', url: 'http://s/a2a' }
    const W = { id: 'ccw', name: '小W', url: 'http://w/a2a' }
    const Q = { id: 'ccq', name: '小Q', url: 'http://q/a2a' }

    const notify = vi.fn()
    const sEchoIntake = makeEchoIntake({ seekStatus: (id) => sSeek.get(id)?.status ?? null, recordEcho: makeRecordEcho(sEcho, notify), markEchoed: makeMarkEchoed(sSeek) })
    const sOnEcho = (senderAgentId: string, msg: any) => makeEchoHandler({
      intake: sEchoIntake, originOf: () => null,
      recordRelay: () => { throw new Error('S should never relay') },
      postEcho: async () => { throw new Error('S should never post further') },
    })(senderAgentId, msg)

    // W has no seeks of its own — every echo it receives is a downstream
    // reply to an intent it forwarded, resolved by its own seen-intent
    // origin record (written by wOnIntent's markSeen below).
    let mintedToken: string | null = null
    const wOnEcho = (senderAgentId: string, msg: any) => makeEchoHandler({
      intake: () => 'unknown' as const,
      originOf: (intentId) => wSeen.originOf(intentId),
      recordRelay: (intentId, upstreamAgentId, downstreamAgentId) => {
        const tok = randomUUID()
        wRelay.create({ id: `${intentId}:${tok}`, intentId, relayToken: tok, upstreamAgentId, downstreamAgentId })
        mintedToken = tok
        return tok
      },
      postEcho: async (_to, m) => { const r = await sOnEcho('ccw', m); return r.ok },
    })(senderAgentId, msg)

    // Q's local answer wraps the judge with pledge-on-yes.
    const qAnswer = makeAnswerIntent({ judge: async () => ({ match: 'yes', blurb: '我主人认识个摄影师' }), policy: POLICY, cheapEval: passingCheck })
    const qAnswerLocally = async (event: any) => {
      const r = await qAnswer(event)
      if (r.match === 'yes') qPledge.create({ id: `${event.card.intent_id}:${event.agent.id}`, intentId: event.card.intent_id, seekerAgentId: event.agent.id, topic: event.card.topic })
      return r
    }
    const qJobs: Array<() => Promise<void>> = []
    const qOnIntent = makeAsyncResponder({
      answerLocally: qAnswerLocally,
      postEcho: async (_to, m) => { const r = await wOnEcho('ccq', m); return r.ok },
      forwardTargets: () => [], forwardSend: async () => false,
      markSeen: () => {}, hasSeen: () => false,
      schedule: (fn) => { qJobs.push(fn) },
    })

    const wAnswerLocal = makeAnswerIntent({ judge: async () => ({ match: 'no' }), policy: POLICY, cheapEval: passingCheck })
    const wJobs: Array<() => Promise<void>> = []
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

    const sJobs: Array<() => Promise<void>> = []
    const sBroker = makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [W as any],
      send: async (_hand, card) => { const r = await wOnIntent({ agent: S as any, card }); return r.async === true },
      proposeRow: (id, r) => sSeek.propose({ id, kind: 'seek', topic: r.topic, redactedTopic: r.redactedTopic }),
      readSeek: (id) => sSeek.get(id),
      markStatus: (id, status) => sSeek.update(id, { status }),
      markForaged: (id, peersAsked) => sSeek.update(id, { peersAsked }),
      schedule: (fn) => { sJobs.push(fn) },
    })

    const proposed = await sBroker.propose('找周末拍照搭子')
    const intentId = (proposed as { ok: true; intent_id: string }).intent_id
    sBroker.confirmSeek(intentId)
    await Promise.all(sJobs.splice(0).map(j => j()))   // S → W (fast-ack)
    await Promise.all(wJobs.splice(0).map(j => j()))   // W judges no, forwards to Q (fast-ack)
    await Promise.all(qJobs.splice(0).map(j => j()))   // Q judges yes, pledges, echoes W → W mints relay + relays to S

    // W is not a seek holder for this intent — originOf resolves it via its
    // own seen-intent record, and W is the one who minted the relay leg.
    expect(wSeen.originOf(intentId)).toBe('ccs')
    expect(mintedToken).not.toBeNull()
    const relayRow = wRelay.get(`${intentId}:${mintedToken}`)!
    expect(relayRow.upstream_agent_id).toBe('ccs')
    expect(relayRow.downstream_agent_id).toBe('ccq')

    const echoes = sEcho.listForSeek(intentId)
    expect(echoes).toHaveLength(1)
    const relayEcho = echoes[0]!
    expect(relayEcho.peer_agent_id).toBeNull()
    expect(relayEcho.relay_via).toBe('ccw')
    expect(relayEcho.relay_token).toBe(mintedToken)
    expect(relayEcho.degree).toBe(2)
    expect(relayEcho.peer_masked).toBe('第 2 度的某人')       // anonymous until mutual
    expect(sSeek.get(intentId)!.status).toBe('echoed')
    expect(notify).toHaveBeenCalledTimes(1)

    // Reveal is none the wiser: feed the SAME minted relay row (produced
    // entirely by the async chain above — no reveal special-casing anywhere
    // in it) through the existing relay-reveal reconciler, the minimal
    // fixture pattern from reveal-crossing.mailbox.test.ts's 2-hop case, and
    // confirm it crosses both legs' handles exactly as it would for a
    // sync-era relay row.
    const forwarded: Array<{ to: string; handle: unknown }> = []
    let notified3way = 0
    const reconciler = makeRelayReconciler({
      relayStore: wRelay,
      completeUpstream: (up, _i, _tok, handle) => { forwarded.push({ to: up, handle }) },
      completeDownstream: (down, _i, handle) => { forwarded.push({ to: down, handle }) },
      nudge: () => {},
      notify3way: () => { notified3way++ },
    })
    const sHandle = { pubkey: 'S_PUBKEY', channel_id: 'S_CHANNEL' }
    const qHandle = { pubkey: 'Q_PUBKEY', channel_id: 'Q_CHANNEL' }
    const sReveal = reconciler.onRelayReveal({ callerAgentId: 'ccs', intentId, relayToken: mintedToken!, peerHandle: sHandle })
    expect(sReveal).toEqual({ mutual: false })                  // only S's leg in so far — Q gets nudged
    const qReveal = reconciler.onRelayReveal({ callerAgentId: 'ccq', intentId, peerHandle: qHandle })
    expect(qReveal).toEqual({ mutual: true, handle: sHandle })  // Q (second) learns S's handle synchronously
    expect(forwarded).toEqual([{ to: 'ccs', handle: qHandle }]) // S (first) learns Q's handle via post-back
    expect(notified3way).toBe(1)
  })
})

describe('async discovery e2e — topology 4: idempotency & staleness', () => {
  it('the same echo message delivered twice lands exactly one row and fires first-echo notify exactly once', async () => {
    const sDb = openTestDb()
    const sSeek = makeSeekStore(sDb); const sEcho = makeEchoStore(sDb)
    sSeek.create({ id: 'i1', kind: 'seek', topic: 't' })   // lands `foraging`
    const notify = vi.fn()
    const sEchoIntake = makeEchoIntake({ seekStatus: (id) => sSeek.get(id)?.status ?? null, recordEcho: makeRecordEcho(sEcho, notify), markEchoed: makeMarkEchoed(sSeek) })
    const sOnEcho = (senderAgentId: string, msg: any) => makeEchoHandler({
      intake: sEchoIntake, originOf: () => null,
      recordRelay: () => { throw new Error('never') }, postEcho: async () => { throw new Error('never') },
    })(senderAgentId, msg)

    const msg = { agent_id: 'ccr', intent_id: 'i1', echo: { blurb: '南京摄影爱好者', degree: 1 } }
    expect(await sOnEcho('ccr', msg)).toEqual({ ok: true })
    expect(await sOnEcho('ccr', msg)).toEqual({ ok: true })   // exact redelivery — same PK

    expect(sEcho.listForSeek('i1')).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('an echo arriving after the seek was closed is a stale swallow — zero rows, no notify', async () => {
    const sDb = openTestDb()
    const sSeek = makeSeekStore(sDb); const sEcho = makeEchoStore(sDb)
    sSeek.create({ id: 'i2', kind: 'seek', topic: 't' })
    sSeek.update('i2', { status: 'closed' })
    const notify = vi.fn()
    const sEchoIntake = makeEchoIntake({ seekStatus: (id) => sSeek.get(id)?.status ?? null, recordEcho: makeRecordEcho(sEcho, notify), markEchoed: makeMarkEchoed(sSeek) })
    const sOnEcho = (senderAgentId: string, msg: any) => makeEchoHandler({
      intake: sEchoIntake, originOf: () => null,
      recordRelay: () => { throw new Error('never') }, postEcho: async () => { throw new Error('never') },
    })(senderAgentId, msg)

    const msg = { agent_id: 'ccr', intent_id: 'i2', echo: { blurb: 'x', degree: 1 } }
    expect(await sOnEcho('ccr', msg)).toEqual({ ok: true })   // swallowed — no probe surface for a peer
    expect(sEcho.listForSeek('i2')).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('a downstream echo for an origin-null (pre-v25) seen row is dropped — no relay minted', async () => {
    const wDb = openTestDb()
    const wSeen = makeSeenIntentStore(wDb)
    const wRelay = makeRelayStore(wDb)
    // Pre-v25 row: markSeen WITHOUT an originAgentId — origin_agent_id stays
    // NULL, exactly what a row written before the v25 migration looks like.
    wSeen.markSeen({ intentId: 'i3', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    expect(wSeen.originOf('i3')).toBeNull()

    const wOnEcho = (senderAgentId: string, msg: any) => makeEchoHandler({
      intake: () => 'unknown' as const,
      originOf: (intentId) => wSeen.originOf(intentId),
      recordRelay: () => { throw new Error('must not mint a relay for an unresolvable origin') },
      postEcho: async () => { throw new Error('must not post') },
    })(senderAgentId, msg)

    const msg = { agent_id: 'ccq', intent_id: 'i3', echo: { blurb: 'x', degree: 2 } }
    expect(await wOnEcho('ccq', msg)).toEqual({ ok: false })
    expect(wRelay.list()).toHaveLength(0)
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
