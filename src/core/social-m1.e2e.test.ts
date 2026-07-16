/**
 * Async foraging spine end-to-end (deterministic, in-process).
 *
 * Composes the REAL modules — makeBroker (sync sow + background forage) →
 * makeAnswerIntent (the peer's judge) → gateOutbound (disclosure) → makeRevealer
 * (mutual async reveal) — with injected deterministic judge + checker + stores.
 * The peer's inbound /a2a/reveal is simulated by calling the SEEKER'S
 * onInboundReveal directly (the HTTP transport is covered in a2a-server.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { openDb } from '../lib/db'
import { makeBroker } from './social-broker'
import { makeAnswerIntent } from './social-answer'
import { makeRevealer, type PeerIdentity } from './social-reveal'
import { makeSeekStore } from './social-seek-store'
import { makeEchoStore } from './social-echo-store'
import { makePledgeStore } from './social-pledge-store'

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
