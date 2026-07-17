import { randomUUID } from 'node:crypto'
import { makeJudge } from '../../core/social-judge'
import { makeAnswerIntent } from '../../core/social-answer'
import { makeBroker, type SeekOutcome } from '../../core/social-broker'
import { makeSeekStore } from '../../core/social-seek-store'
import { makeEchoStore } from '../../core/social-echo-store'
import { makePledgeStore } from '../../core/social-pledge-store'
import { makeRevealer, type Revealer, type RevealBeat, type NotifyCtx, type PeerIdentity } from '../../core/social-reveal'
import { makeForwarder } from '../../core/social-forwarder'
import { makeRelayStore } from '../../core/social-relay-store'
import { makeSeenIntentStore } from '../../core/social-seen-intent-store'
import { makeRelayReconciler } from '../../core/social-relay-reveal'
import { intentUrl, revealUrl } from '../../core/a2a-delegate'
import { MatchReceiptSchema } from '../../core/a2a-intent'
import { applyFinishSeek } from './social-finish-seek'
import type { A2AServerOpts } from '../../core/a2a-server'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { A2AClient } from '../../core/a2a-client'
import type { ProviderRegistry } from '../../core/provider-registry'
import type { ProviderId } from '../../core/conversation'
import type { AgentConfig } from '../../lib/agent-config'
import type { Db } from '../../lib/db'
import type { McpStdioSpec } from './mcp-specs'
import type { SendAssistantText } from './fallback-reply'
import type { BootstrapDeps } from './types'

export interface SocialDeps {
  log: BootstrapDeps['log']
  stateDir: string
  db: Db
  configuredAgent: AgentConfig
  registry: ProviderRegistry
  defaultProviderId: ProviderId
  pluginMcp: Record<string, McpStdioSpec>
  currentClaudeModel: () => string
  claudeBin: string | undefined
  resolveOperatorChatId: () => string | null
  sendAssistantText: SendAssistantText | undefined
  a2aRegistry: A2ARegistry
  a2aClient: A2AClient
  /** Lazy read of the a2a server's base url — the server is constructed AFTER
   *  wireSocial runs (it consumes onIntent/onReveal), so selfIdentity reads it
   *  through this thunk. index.ts backs it with its `a2aServer` variable. */
  getServerBaseUrl: () => string | null
}

export interface SocialWiring {
  onIntent: A2AServerOpts['onIntent']
  onReveal: A2AServerOpts['onReveal']
  social?: {
    broker: { seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> }
    seekStore: import('../../core/social-seek-store').SeekStore
    echoStore: import('../../core/social-echo-store').EchoStore
    pledgeStore: import('../../core/social-pledge-store').PledgeStore
    revealer: Revealer
  }
  resumeForaging: () => void
}

export async function wireSocial(deps: SocialDeps): Promise<SocialWiring> {
  const {
    registry, defaultProviderId, pluginMcp, currentClaudeModel, claudeBin,
    configuredAgent, resolveOperatorChatId, sendAssistantText, a2aRegistry,
    a2aClient, getServerBaseUrl,
  } = deps

  // ── Agent-social M1 wiring (async foraging spine) ───────────────────────
  // Gated on BOTH social_enabled and social_disclosure_policy — absent
  // either, the feature stays fully inert: no onIntent/onReveal wired into
  // the a2a server below, no broker constructed, no /v1/social/seek
  // functionality (the route 503s). Wires the row-driven mutual reveal
  // (revealer + inbound onReveal), the non-blocking broker (sow/forage/
  // recordEcho/finishSeek), the answer-side pledge, and boot resume of any
  // seeks still `foraging` after a restart.
  let socialOnIntent: A2AServerOpts['onIntent']
  let socialOnReveal: A2AServerOpts['onReveal']
  let socialBroker: { seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> } | undefined
  let socialForage: ((intentId: string, topic: string, opts?: { city?: string }) => Promise<void>) | undefined
  let socialSeekStore: import('../../core/social-seek-store').SeekStore | undefined
  let socialEchoStore: import('../../core/social-echo-store').EchoStore | undefined
  let socialPledgeStore: import('../../core/social-pledge-store').PledgeStore | undefined
  let socialRevealer: Revealer | undefined

  if (configuredAgent.social_enabled && configuredAgent.social_disclosure_policy) {
    const socialPolicy = configuredAgent.social_disclosure_policy
    const socialCheapEval = registry.getCheapEval()
    if (!socialCheapEval) {
      // Same degrade pattern as the openai provider block above: log and
      // skip rather than throw. No registered provider implements cheapEval
      // is exotic in practice (claude always registers one), but the seam
      // must degrade gracefully like every other optional wiring here.
      deps.log('BOOT', 'social: no cheapEval available from any registered provider — social_enabled is on but wiring is skipped (inert)')
    } else {
      const SOCIAL_SELF_ID = process.env.WECHAT_A2A_SELF_ID || 'wechat-cc'
      const socialOpenaiKey = process.env.WECHAT_OPENAI_API_KEY

      // The judge's runTurn seam (daemon/social/grounded-judge.ts). Provider-
      // specific adapters spawn a one-shot session carrying ONLY the plugin
      // MCP tools — the answerer must never get wechat tools (could
      // send-as-owner) or delegate-mcp (could recurse). Falls back to the
      // registry's cheapEval (no tools at all) when the default provider has
      // no grounded adapter yet — judging still works, just without
      // plugin-grounded facts.
      const { makeGroundedJudgeRunTurn } = await import('../social/grounded-judge')
      const groundedRunTurn = makeGroundedJudgeRunTurn({
        providerId: defaultProviderId,
        pluginMcp,
        stateDir: deps.stateDir,
        log: deps.log,
        openai: (socialOpenaiKey && configuredAgent.openaiBaseUrl && configuredAgent.openaiModel)
          ? { apiKey: socialOpenaiKey, baseUrl: configuredAgent.openaiBaseUrl, model: configuredAgent.openaiModel }
          : undefined,
        claude: { model: () => currentClaudeModel(), ...(claudeBin ? { claudeBin } : {}) },
      })
      const socialRunTurn: (systemPrompt: string, userPrompt: string) => Promise<string> =
        groundedRunTurn ?? (async (systemPrompt, userPrompt) => socialCheapEval(`${systemPrompt}\n\n${userPrompt}`))
      deps.log('BOOT', groundedRunTurn
        ? `social: plugin-grounded judge via ${defaultProviderId} (pluginMcp only, no wechat/delegate)`
        : `social: grounded judging unavailable for provider=${defaultProviderId} — judge falls back to cheapEval (no tools)`)

      const socialJudge = makeJudge({ runTurn: socialRunTurn, policy: socialPolicy })
      const answerIntent = makeAnswerIntent({ judge: socialJudge, policy: socialPolicy, cheapEval: socialCheapEval })

      // Stores.
      const seekStore = makeSeekStore(deps.db)
      const echoStore = makeEchoStore(deps.db)
      const pledgeStore = makePledgeStore(deps.db)
      // spec #2 forwarding: the intermediary's durable relay rows + the
      // loop-prevention seen-intent dedup.
      const relayStore = makeRelayStore(deps.db)
      const seenIntentStore = makeSeenIntentStore(deps.db)
      socialSeekStore = seekStore
      socialEchoStore = echoStore
      socialPledgeStore = pledgeStore

      // Notification beats (克制三拍). One WeChat sender for all three; on the
      // inbound-completed `connected` beat we only hold the peer's agent_id, so
      // resolve its display name from the registry here.
      const notify = (beat: RevealBeat, ctx: NotifyCtx): void => {
        const op = resolveOperatorChatId()
        if (!op || !sendAssistantText) return
        const peerName = ctx.peerName ?? (ctx.peerAgentId ? (a2aRegistry.get(ctx.peerAgentId)?.name ?? null) : null)
        const text = beat === 'first_echo'
          ? '✨ 你的心愿有回声了,去瞧瞧'
          : beat === 'await_reveal'
            ? '👀 有人想和你牵线,去看看'
            : `🤝 牵上线了${peerName ? ' —— 是' + peerName : ''}`
        void sendAssistantText(op, text)
      }

      // This daemon's public identity, handed back on the mutual instant. url is
      // read lazily (a2aServer is constructed further below); name prefers the
      // configured bot name.
      const selfIdentity = (): PeerIdentity => ({
        name: configuredAgent.bot_name ?? SOCIAL_SELF_ID,
        url: getServerBaseUrl() ?? '',
      })

      // Outbound reveal POST to a peer's /a2a/reveal. null on unreachable/unknown.
      // relayToken addresses a 2-hop relay leg (routed to the intermediary).
      const postPeerReveal = async (agentId: string, intentId: string, relayToken?: string): Promise<{ mutual: boolean; identity?: PeerIdentity } | null> => {
        const hand = a2aRegistry.get(agentId)
        if (!hand) return null
        const r = await a2aClient.send({ url: revealUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, intent_id: intentId, ...(relayToken ? { relay_token: relayToken } : {}) } })
        if (!r.ok) return null
        return r.response as { mutual: boolean; identity?: PeerIdentity }
      }

      // Fire-and-forget reveal POST used by the relay reconciler's complete/nudge
      // deps — posts to a peer's /a2a/reveal with arbitrary relay fields. Never
      // throws to the reconciler (fail-closed; the row is durable so a lost post
      // is recoverable by a later retry from either endpoint).
      const postReveal = (agentId: string, body: { intent_id: string; relay_token?: string; peer_name?: string }): void => {
        const hand = a2aRegistry.get(agentId)
        if (!hand) return
        void a2aClient.send({ url: revealUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } })
          .catch(err => deps.log('SOCIAL_REC', `relay reveal post failed intent=${body.intent_id} agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`))
      }

      const revealer = makeRevealer({ echoStore, pledgeStore, seekStore, postPeerReveal, selfIdentity, notify })
      socialRevealer = revealer

      // spec #2: the intermediary's (介绍人 / W) reveal reconciler. Both endpoints
      // reveal TO W; W pivots the two legs on the durable social_relay row and
      // crosses their identities (resolved from W's OWN registry, never sent
      // across a hop). Row-driven → survives a W restart.
      const relayReconciler = makeRelayReconciler({
        relayStore,
        identityOf: (id) => { const a = a2aRegistry.get(id); return a ? { name: a.name, url: a.url } : null },
        completeUpstream: (upstreamId, intentId, relayToken, downstreamIdentity) =>
          postReveal(upstreamId, { intent_id: intentId, relay_token: relayToken, peer_name: downstreamIdentity.name }),
        completeDownstream: (downstreamId, intentId, upstreamIdentity) =>
          postReveal(downstreamId, { intent_id: intentId, peer_name: upstreamIdentity.name }),
        nudge: (agentId, intentId, relayToken) =>
          postReveal(agentId, { intent_id: intentId, ...(relayToken ? { relay_token: relayToken } : {}) }),
        notify3way: (_intentId, _upstream, downstream) => {
          // 介绍人 warmth: only W's own owner is told — telling W leaks nothing
          // extra (W already proxied the reveal). S/Q get their own beats via the
          // complete* posts back to their daemons (which notify their own owners).
          const op = resolveOperatorChatId()
          if (op && sendAssistantText) void sendAssistantText(op, `🎉 你把朋友和${downstream.name}牵上线了`)
        },
      })

      socialOnReveal = async (ev) => {
        // First: is this a relay leg addressed to US as the intermediary? The
        // reconciler resolves via a social_relay row; null ⇒ not ours, fall through.
        const relayResult = relayReconciler.onRelayReveal({ callerAgentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token })
        if (relayResult) return relayResult

        // Otherwise WE are an endpoint: mark our own echo/pledge. A relay inbound
        // (relay_token present, or peer_name handed over on mutual) drives the
        // relay branch of onInboundReveal.
        const result = revealer.onInboundReveal({ agentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token, peerName: ev.peer_name })
        // I1: when THIS side revealed FIRST (the seeker) on a DIRECT echo, mutual
        // completes here in the echo branch, which only holds the peer's agent_id
        // — so the echo's peer_masked would otherwise stay masked ("第 N 度的某人")
        // forever. Swap in the peer's real name from the registry. The relay
        // branch already swapped peer_name in when present, so only swap the
        // DIRECT case (no relay_token/peer_name) to avoid clobbering it with W's
        // name. A registry/store hiccup must never break the reveal response.
        if (result.mutual && !ev.relay_token && !ev.peer_name) {
          try {
            const name = a2aRegistry.get(ev.agent_id)?.name
            if (name) echoStore.setRevealedIdentity(`${ev.intent_id}:${ev.agent_id}`, name)
          } catch (err) {
            deps.log('SOCIAL_REC', `reveal identity swap failed intent=${ev.intent_id} agent=${ev.agent_id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return result
      }

      // Answer path: the spine's judge + pledge-on-yes is the LOCAL answer. The
      // forwarder wraps it with the 2-hop fan-out — judge locally, then (within
      // the hop cap + not-already-seen) forward the hop+1 card to OUR own paired
      // peers (minus the sender), minting a relay per downstream yes and
      // aggregating their degree-2 echoes onto the response.
      const answerLocally = async (event: import('../../core/a2a-server').IntentEvent): Promise<import('../../core/a2a-intent').MatchReceipt> => {
        const receipt = await answerIntent(event)
        if (receipt.match === 'yes') {
          try {
            pledgeStore.create({ id: `${event.card.intent_id}:${event.agent.id}`, intentId: event.card.intent_id, seekerAgentId: event.agent.id, topic: event.card.topic })
          } catch (err) {
            deps.log('SOCIAL_REC', `pledge record failed intent=${event.card.intent_id} agent=${event.agent.id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return receipt
      }
      socialOnIntent = makeForwarder({
        answerLocally,
        // Forward to our OWN paired peers, minus the sender; same cap as discover.
        // Guarded: a registry lookup failure must NOT reject the whole /a2a/intent
        // — W still returns its own local match (fail-closed: forward nothing).
        forwardTargets: (excludeAgentId) => {
          try { return a2aRegistry.list().filter(a => !a.paused && a.id !== excludeAgentId).slice(0, 5) }
          catch (err) {
            deps.log('SOCIAL_REC', `forwardTargets lookup failed exclude=${excludeAgentId}: ${err instanceof Error ? err.message : String(err)}`)
            return []
          }
        },
        forwardSend: async (hand, card) => {
          const r = await a2aClient.send({ url: intentUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, card } })
          return r.ok ? MatchReceiptSchema.parse(r.response) : null
        },
        recordRelay: (intentId, upstreamAgentId, downstreamAgentId) => {
          // upstreamAgentId = the sender (event.agent.id), so W can later resolve
          // S's identity from its own registry. NOT SOCIAL_SELF_ID.
          const relayToken = randomUUID()
          try {
            relayStore.create({ id: `${intentId}:${relayToken}`, intentId, relayToken, upstreamAgentId, downstreamAgentId })
          } catch (err) {
            deps.log('SOCIAL_REC', `relay record failed intent=${intentId} downstream=${downstreamAgentId}: ${err instanceof Error ? err.message : String(err)}`)
          }
          return relayToken
        },
        markSeen: (intentId, expiresAt) => {
          // The forwarder core swallows a markSeen throw (empty catch); log it here
          // so a dedup-write failure is observable at the wiring seam.
          try { seenIntentStore.markSeen({ intentId, expiresAt }) }
          catch (err) { deps.log('SOCIAL_REC', `seen mark failed intent=${intentId}: ${err instanceof Error ? err.message : String(err)}`) }
        },
        hasSeen: (intentId) => { try { return seenIntentStore.hasSeen(intentId) } catch { return false } },
        hopCap: 2,
      })

      const broker = makeBroker({
        policy: socialPolicy,
        cheapEval: socialCheapEval,
        // TODO(v1+): rank candidates via wxgraph closeness/topical relevance
        // instead of "every paired peer, capped".
        discover: async (_topic) => a2aRegistry.list().filter(a => !a.paused).slice(0, 5),
        send: async (hand, card) => {
          const r = await a2aClient.send({ url: intentUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, card } })
          return r.ok ? MatchReceiptSchema.parse(r.response) : null
        },
        sow: (intentId, topic) => {
          try { seekStore.create({ id: intentId, kind: 'seek', topic }) }
          catch (err) { deps.log('SOCIAL_REC', `sow failed intent=${intentId}: ${err instanceof Error ? err.message : String(err)}`) }
        },
        recordEcho: (e) => {
          // M2 — `e.first` is the broker's "first yes of THIS forage run"
          // flag, computed from an in-memory counter local to one forage()
          // call. On a restart-resume re-forage (boot-scan below re-runs
          // forage() for any seek still `foraging`), that counter restarts
          // at 0 even though the echo row may already exist from BEFORE the
          // crash — re-firing the "有回声了" beat for an echo the operator
          // already saw. Ask the durable store instead: this is the seek's
          // first-ever echo iff it currently has zero echo rows, checked
          // BEFORE the (possibly-duplicate) insert below.
          const isSeekFirstEcho = echoStore.listForSeek(e.intentId).length === 0
          // A persistence error must never undo a network action already done.
          // A degree-2 relay echo (peerAgentId null) is keyed by intent:relayVia:
          // relayToken (S may hold several relay echoes per intent); a direct echo
          // by intent:peerAgentId.
          try {
            const id = e.peerAgentId != null ? `${e.intentId}:${e.peerAgentId}` : `${e.intentId}:${e.relayVia}:${e.relayToken}`
            echoStore.create({ id, seekId: e.intentId, peerMasked: e.peerMasked, degree: e.degree, content: e.content, peerAgentId: e.peerAgentId, relayVia: e.relayVia, relayToken: e.relayToken })
          } catch (err) {
            deps.log('SOCIAL_REC', `echo record failed intent=${e.intentId} peer=${e.peerAgentId ?? e.relayVia}: ${err instanceof Error ? err.message : String(err)}`)
          }
          if (isSeekFirstEcho) notify('first_echo', { intentId: e.intentId })
        },
        finishSeek: (intentId, _status, peersAsked) => {
          // M1: authoritative + non-downgrading — ignore the broker-passed
          // status. See applyFinishSeek for why (connected must not downgrade;
          // resume must derive from real echo rows).
          try { applyFinishSeek({ seekStore, echoStore }, intentId, peersAsked) }
          catch (err) { deps.log('SOCIAL_REC', `finishSeek failed intent=${intentId}: ${err instanceof Error ? err.message : String(err)}`) }
        },
      })
      socialBroker = { seek: (topic, opts) => broker.seek(topic, opts) }
      socialForage = (intentId, topic, opts) => broker.forage(intentId, topic, opts)
    }
  }

  // Boot-resume loop, wrapped as a returnable closure. main.ts calls this
  // after the a2a server starts (see index.ts) so a resumed forage's
  // outbound sends can reach peers over a live listener.
  const resumeForaging = (): void => {
    if (socialForage && socialSeekStore) {
      const forage = socialForage
      for (const row of socialSeekStore.list()) {
        if (row.status === 'foraging') {
          // M3: social_seek doesn't persist `city`, so a resumed forage sends
          // without it — safe degradation, city is an optional discovery hint.
          void forage(row.id, row.topic).catch(err => deps.log('SOCIAL_REC', `resume forage failed intent=${row.id}: ${err instanceof Error ? err.message : String(err)}`))
        }
      }
    }
  }

  return {
    onIntent: socialOnIntent,
    onReveal: socialOnReveal,
    ...(socialBroker
      ? { social: { broker: socialBroker, seekStore: socialSeekStore!, echoStore: socialEchoStore!, pledgeStore: socialPledgeStore!, revealer: socialRevealer! } }
      : {}),
    resumeForaging,
  }
}
