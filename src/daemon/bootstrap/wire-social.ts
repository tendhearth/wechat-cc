import { randomUUID } from 'node:crypto'
import { makeJudge } from '../../core/social-judge'
import { makeAnswerIntent } from '../../core/social-answer'
import { makeBroker, type SeekOutcome } from '../../core/social-broker'
import { makeSeekStore } from '../../core/social-seek-store'
import { makeEchoStore } from '../../core/social-echo-store'
import { makePledgeStore } from '../../core/social-pledge-store'
import { makeRevealer, type Revealer, type RevealBeat, type NotifyCtx, type ChannelPort } from '../../core/social-reveal'
import { makeForwarder } from '../../core/social-forwarder'
import { makeRelayStore } from '../../core/social-relay-store'
import { makeSeenIntentStore } from '../../core/social-seen-intent-store'
import { makeRelayReconciler } from '../../core/social-relay-reveal'
import { makeChannelStore } from '../../core/penpal-channel-store'
import { makeLetterStore } from '../../core/penpal-letter-store'
import { makeCorrespondent } from '../../core/penpal-correspondent'
import { makeLetterRelay } from '../../core/penpal-relay-letter'
import { generateKeypair, type PenpalHandle } from '../../core/penpal-crypto'
import { intentUrl, revealUrl, letterUrl } from '../../core/a2a-delegate'
import { MatchReceiptSchema } from '../../core/a2a-intent'
import { applyFinishSeek } from './social-finish-seek'
import { makeMailboxSender } from '../../core/mailbox-sender'
import { makeMailboxClient } from '../../core/mailbox-client'
import { loadMailboxIdentity } from '../../core/mailbox-crypto'
import { peerMailboxOf, buildCrossedHandle } from './mailbox-dispatch-seam'
import { makeMailboxLetterHandler } from './mailbox-letter-handler'
import { makeRoutePostLetter } from './postletter-route'
import { buildSharedForwardBudget } from './forward-budget-seam'
import type { PeerMailbox } from '../../core/mailbox-crypto'
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
   *  wireSocial runs (it consumes onIntent/onReveal). Currently unused by the
   *  penpal-repointed wiring (reveal crosses pubkey handles, not URLs/names);
   *  kept on the interface for index.ts's existing wiring + any future use. */
  getServerBaseUrl: () => string | null
}

export interface SocialWiring {
  onIntent: A2AServerOpts['onIntent']
  onReveal: A2AServerOpts['onReveal']
  onLetter: A2AServerOpts['onLetter']
  /**
   * I1 — the own-channel-ONLY letter handler for the mailbox poller (Task 8).
   * MUST be used instead of `onLetter` when replaying a decrypted mailbox
   * envelope: a mailbox drop carries no verified bearer, so it must never be
   * able to make this daemon forward junk via `letterRelay.routeLetter`
   * (which `onLetter` falls through to for non-own channels). Undefined
   * whenever social wiring itself is inert, same gate as `onLetter`.
   */
  onMailboxLetter?: A2AServerOpts['onLetter']
  social?: {
    broker: { seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> }
    seekStore: import('../../core/social-seek-store').SeekStore
    echoStore: import('../../core/social-echo-store').EchoStore
    pledgeStore: import('../../core/social-pledge-store').PledgeStore
    revealer: Revealer
    penpal: { sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string }> }
  }
  resumeForaging: () => void
}

export async function wireSocial(deps: SocialDeps): Promise<SocialWiring> {
  const {
    registry, defaultProviderId, pluginMcp, currentClaudeModel, claudeBin,
    configuredAgent, resolveOperatorChatId, sendAssistantText, a2aRegistry,
    a2aClient,
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
  let socialOnLetter: A2AServerOpts['onLetter']
  let socialOnMailboxLetter: A2AServerOpts['onLetter']
  let socialBroker: { seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> } | undefined
  let socialForage: ((intentId: string, topic: string, opts?: { city?: string }) => Promise<void>) | undefined
  let socialSeekStore: import('../../core/social-seek-store').SeekStore | undefined
  let socialEchoStore: import('../../core/social-echo-store').EchoStore | undefined
  let socialPledgeStore: import('../../core/social-pledge-store').PledgeStore | undefined
  let socialRevealer: Revealer | undefined
  let socialPenpal: { sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string }> } | undefined

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
      // Mailbox transport (sub-project B): the third dispatch arm alongside
      // push (a2aClient). Constructed once and reused by postReveal (and, per
      // Task 11, postLetter's peer-mailbox branch).
      const mailboxSender = makeMailboxSender({ client: makeMailboxClient() })
      // C1 (Task 10): THIS daemon's own mailbox routing, loaded once. Used to
      // enrich the crossing PenpalHandle AT ITS SOURCE (postPeerReveal,
      // postReveal's forwarded peer_handle, and channel.openLocal's return) —
      // NOT derived from the bare channel row, which never holds it. undefined
      // when this daemon has no mailbox_relays configured, so the crossed
      // handle omits `mailbox` entirely — byte-identical to a push-only peer's
      // handle today (additive, backward-compatible). Gated (Task 10 review
      // Minor): loadMailboxIdentity generates+persists mailbox-key.json as a
      // side effect, so it must not run at all for a push-only daemon (no
      // mailbox_relays configured) — only called when the identity is
      // actually going to be used below.
      const myMailbox: PeerMailbox | undefined = configuredAgent.mailbox_relays?.length
        ? (() => {
            const mailboxIdentity = loadMailboxIdentity(deps.stateDir)
            return { addr: mailboxIdentity.addr, enc_pub: mailboxIdentity.enc_pub, relays: configuredAgent.mailbox_relays! }
          })()
        : undefined

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
      // A3 (anonymous pen-pal channel): the per-connection channel row — mints
      // an X25519 keypair + channel id per row, holds the peer's crossed
      // PenpalHandle once mutual. Real identity NEVER crosses this daemon's
      // boundary; only these ephemeral handles do.
      const channelStore = makeChannelStore(deps.db)
      socialSeekStore = seekStore
      socialEchoStore = echoStore
      socialPledgeStore = pledgeStore

      // A3 (anonymous pen-pal channel, Task 11): the correspondent handles
      // THIS daemon's own open channels (seal/persist outbound, open/persist+
      // notify inbound); the letter relay handles the content-blind 2-hop
      // forward for channels where WE are the introducer (介绍人), never the
      // endpoint. Shared `postLetter` — relayVia routes through the
      // intermediary's own a2a address when set, else straight to the peer.
      const letterStore = makeLetterStore(deps.db)
      // Task 11: a target carrying a `mailbox` (the peer crossed one at
      // reveal — Task 10) goes relay-direct — sealed+dropped straight to the
      // peer's own mailbox, W never sees it. A push-only target (no mailbox)
      // falls through to A's existing Task-9 push/W-forward path unchanged.
      const postLetter = makeRoutePostLetter({
        mailboxSend: (inner, peer) => mailboxSender.send(inner, peer),
        pushSend: async (target, body) => {
          const hand = a2aRegistry.get(target.relayVia ?? target.agentId)
          if (!hand) return false
          const r = await a2aClient.send({ url: letterUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } })
          return r.ok
        },
        selfId: SOCIAL_SELF_ID,
      })
      // Sub-project C: ONE shared per-sender forward budget, injected into BOTH
      // consume points below (letterRelay + the seek forwarder further down) —
      // see forward-budget-seam.ts for why this must be a single instance.
      const withinForwardBudget = buildSharedForwardBudget(configuredAgent, deps.log)
      const notifyInbound = (rowId: string, preview: string): void => {
        const op = resolveOperatorChatId()
        if (!op || !sendAssistantText) return
        const ch = channelStore.get(rowId)
        const mask = ch ? `第 ${ch.degree} 度的某人` : '某人'
        void sendAssistantText(op, `📬 ${mask}给你写信了:${preview}\n(回信 ${rowId} <你的话>)`)
      }
      const correspondent = makeCorrespondent({ channelStore, letterStore, postLetter, notifyInbound })
      const letterRelay = makeLetterRelay({ relayStore, postLetter, withinBudget: withinForwardBudget })
      // Dispatch order matters (Task 9 review flag): try OUR OWN endpoint
      // first (getByMyChannelId / receiveLetter) — only when that channel_id
      // is NOT one of this daemon's own open channels does it fall through
      // to the relay forward. Never both; never relay-first.
      socialOnLetter = async (ev) => {
        const mine = channelStore.getByMyChannelId(ev.channel_id)
        return mine ? correspondent.receiveLetter(ev) : letterRelay.routeLetter(ev)
      }
      // I1 (Task 8) — the mailbox-poller-safe variant: own-channel ONLY, NEVER
      // falls through to letterRelay.routeLetter. A mailbox drop carries no
      // verified bearer (unlike the HTTP /a2a/letter route, which at least
      // authenticates the caller as a registered peer before onLetter runs
      // at all) — an un-bearer'd mailbox drop must not make this daemon
      // forward junk into a relay leg on some stranger's behalf.
      socialOnMailboxLetter = makeMailboxLetterHandler({
        getByMyChannelId: (c) => channelStore.getByMyChannelId(c),
        receiveLetter: (ev) => correspondent.receiveLetter(ev),
      })
      socialPenpal = { sendLetter: (channel, text) => correspondent.sendLetter(channel, text) }

      // Notification beats (克制三拍). Content-free by design — reveal crosses
      // pubkey handles, never a real name or url, so no beat text may carry one.
      const notify = (beat: RevealBeat, _ctx: NotifyCtx): void => {
        const op = resolveOperatorChatId()
        if (!op || !sendAssistantText) return
        const text = beat === 'first_echo'
          ? '✨ 你的心愿有回声了,去瞧瞧'
          : beat === 'await_reveal'
            ? '👀 有人想和你牵线,去看看'
            : '🤝 你俩接上头了~ 可以写信了'
        void sendAssistantText(op, text)
      }

      // The ChannelPort: mints/persists the per-connection PenpalHandle, backed
      // by the durable channel store so it survives a restart. openLocal is
      // idempotent — an existing row just returns its already-minted handle.
      const channel: ChannelPort = {
        openLocal(rowId, ctx) {
          const existing = channelStore.get(rowId)
          if (existing) return buildCrossedHandle({ my_pubkey: existing.my_pubkey, my_channel_id: existing.my_channel_id }, myMailbox)
          const kp = generateKeypair()
          const myChannelId = randomUUID()
          channelStore.create({ id: rowId, seekId: ctx.seekId, myPrivkey: kp.privateKey, myPubkey: kp.publicKey, myChannelId, degree: ctx.degree, relayVia: ctx.relayVia ?? null, peerAgentId: ctx.peerAgentId ?? null })
          return buildCrossedHandle({ my_pubkey: kp.publicKey, my_channel_id: myChannelId }, myMailbox)
        },
        finalize(rowId, peerHandle) { channelStore.setPeerHandle(rowId, peerHandle) },
      }

      // Outbound reveal POST to a peer's /a2a/reveal. null on unreachable/unknown.
      // relayToken addresses a 2-hop relay leg (routed to the intermediary).
      // Carries THIS side's already-minted PenpalHandle so the peer can finalize
      // it (I2 — the rowId reconstruction below MUST exactly match how
      // `channel.openLocal` was keyed inside revealEcho/revealPledge (direct
      // echo/pledge: `${intentId}:${agentId}`; relay echo:
      // `${intentId}:${agentId}:${relayToken}`) and onInboundReveal's rowId — a
      // mismatch silently means channelStore.get(rowId) misses, myHandle stays
      // undefined, the peer never finalizes, and no letter can ever send).
      const postPeerReveal = async (agentId: string, intentId: string, relayToken?: string): Promise<{ mutual: boolean; handle?: PenpalHandle } | null> => {
        const hand = a2aRegistry.get(agentId)
        if (!hand) return null
        const rowId = relayToken ? `${intentId}:${agentId}:${relayToken}` : `${intentId}:${agentId}`
        const ch = channelStore.get(rowId)
        const myHandle = ch ? buildCrossedHandle({ my_pubkey: ch.my_pubkey, my_channel_id: ch.my_channel_id }, myMailbox) : undefined
        const r = await a2aClient.send({
          url: revealUrl(hand.url), bearer: hand.outbound_api_key,
          body: { agent_id: SOCIAL_SELF_ID, intent_id: intentId, ...(relayToken ? { relay_token: relayToken } : {}), ...(myHandle ? { peer_handle: myHandle } : {}) },
        })
        if (!r.ok) return null
        return r.response as { mutual: boolean; handle?: PenpalHandle }
      }

      // Fire-and-forget reveal POST used by the relay reconciler's complete/nudge
      // deps — posts to a peer's /a2a/reveal with arbitrary relay fields. Never
      // throws to the reconciler (fail-closed; the row is durable so a lost post
      // is recoverable by a later retry from either endpoint).
      const postReveal = (agentId: string, body: { intent_id: string; relay_token?: string; peer_handle?: PenpalHandle }): void => {
        const hand = a2aRegistry.get(agentId)
        if (!hand) return
        const peer = peerMailboxOf(hand)
        if (peer) {
          void mailboxSender.send({ path: '/a2a/reveal', bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } }, peer)
            .catch(err => deps.log('SOCIAL_REC', `mailbox reveal drop failed intent=${body.intent_id} agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`))
          return
        }
        void a2aClient.send({ url: revealUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } })
          .catch(err => deps.log('SOCIAL_REC', `relay reveal post failed intent=${body.intent_id} agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`))
      }

      const revealer = makeRevealer({ echoStore, pledgeStore, seekStore, postPeerReveal, channel, notify })
      socialRevealer = revealer

      // spec #2: the intermediary's (介绍人 / W) reveal reconciler. Both endpoints
      // reveal TO W; W pivots the two legs on the durable social_relay row and
      // crosses their EPHEMERAL PenpalHandles — W stays content-blind, it never
      // resolves or forwards a real identity, only the pubkey handles each leg
      // presented. Row-driven → survives a W restart.
      const relayReconciler = makeRelayReconciler({
        relayStore,
        completeUpstream: (upstreamId, intentId, relayToken, downstreamHandle) =>
          postReveal(upstreamId, { intent_id: intentId, relay_token: relayToken, peer_handle: downstreamHandle }),
        completeDownstream: (downstreamId, intentId, upstreamHandle) =>
          postReveal(downstreamId, { intent_id: intentId, peer_handle: upstreamHandle }),
        nudge: (agentId, intentId, relayToken) =>
          postReveal(agentId, { intent_id: intentId, ...(relayToken ? { relay_token: relayToken } : {}) }),
        notify3way: (_intentId, _upstream, _downstream) => {
          // 介绍人 warmth: only W's own owner is told, content-free — W never had
          // either endpoint's real identity, only their ephemeral handles. S/Q
          // get their own beats via the complete* posts back to their daemons
          // (which notify their own owners).
          const op = resolveOperatorChatId()
          if (op && sendAssistantText) void sendAssistantText(op, '🎉 你把两位笔友牵上线了')
        },
      })

      socialOnReveal = async (ev) => {
        // First: is this a relay leg addressed to US as the intermediary? The
        // reconciler resolves via a social_relay row; null ⇒ not ours, fall through.
        const relayResult = relayReconciler.onRelayReveal({ callerAgentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token, peerHandle: ev.peer_handle })
        if (relayResult) return relayResult

        // Otherwise WE are an endpoint: mark our own echo/pledge. The mutual
        // instant finalizes the channel with the peer's presented handle
        // entirely inside the revealer (channel.finalize) — there is no
        // identity-crossing side path here anymore; the masked placeholder is
        // permanent.
        return revealer.onInboundReveal({ agentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token, peerHandle: ev.peer_handle })
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
        withinBudget: withinForwardBudget,
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

  // Boot-resume loop, wrapped as a returnable closure. index.ts's
  // buildBootstrap calls this after wireA2aServer starts the server, so a
  // resumed forage's outbound sends can reach peers over a live listener.
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
    onLetter: socialOnLetter,
    onMailboxLetter: socialOnMailboxLetter,
    ...(socialBroker
      ? { social: { broker: socialBroker, seekStore: socialSeekStore!, echoStore: socialEchoStore!, pledgeStore: socialPledgeStore!, revealer: socialRevealer!, penpal: socialPenpal! } }
      : {}),
    resumeForaging,
  }
}
