import { randomUUID } from 'node:crypto'
import { makeJudge } from '../../core/social-judge'
import { makeAnswerIntent } from '../../core/social-answer'
import { makeBroker } from '../../core/social-broker'
import { makeSeekStore } from '../../core/social-seek-store'
import { makeEchoStore } from '../../core/social-echo-store'
import { makePledgeStore } from '../../core/social-pledge-store'
import { makeRevealer, type Revealer, type RevealBeat, type NotifyCtx, type ChannelPort } from '../../core/social-reveal'
import { makeAsyncResponder } from '../../core/social-async-responder'
import { A2A_PROTO_VERSION } from '../../core/a2a-intent'
import { makeEchoIntake } from '../../core/social-echo-intake'
import { makeEchoHandler } from '../../core/social-echo-relay'
import { makeRelayStore } from '../../core/social-relay-store'
import { makeSeenIntentStore } from '../../core/social-seen-intent-store'
import { makeRelayReconciler } from '../../core/social-relay-reveal'
import { makeChannelStore } from '../../core/penpal-channel-store'
import { makeLetterStore } from '../../core/penpal-letter-store'
import { makeCorrespondent } from '../../core/penpal-correspondent'
import { makeLetterRelay } from '../../core/penpal-relay-letter'
import { generateKeypair, type PenpalHandle } from '../../core/penpal-crypto'
import { intentUrl, revealUrl, letterUrl, echoUrl } from '../../core/a2a-delegate'
import { gateOutbound } from '../../core/a2a-disclosure'
import { rankPeersByCloseness } from '../../core/peer-closeness'
import { makeMailboxSender } from '../../core/mailbox-sender'
import { makeMailboxClient } from '../../core/mailbox-client'
import { loadMailboxIdentity } from '../../core/mailbox-crypto'
import { peerMailboxOf, chooseTransport, buildCrossedHandle } from './mailbox-dispatch-seam'
import { makeSocialPost, type PostOutcome } from './social-post-seam'
import { makeEchoRetry } from '../../core/social-echo-retry'
import { makeMailboxLetterHandler } from './mailbox-letter-handler'
import { makeRoutePostLetter } from './postletter-route'
import { buildSharedForwardBudget } from './forward-budget-seam'
import type { PeerMailbox } from '../../core/mailbox-crypto'
import type { A2AServerOpts } from '../../core/a2a-server'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { A2AClient } from '../../core/a2a-client'
import type { A2AAgentRecord } from '../../lib/agent-config'
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
  /** Resolved ONCE by bootstrap/index.ts (resolveSelfAgentId) — spec §2's
   *  stable-unique slug, shared with wirePairing + pipeline-deps' delegate
   *  path so every outbound seam self-reports the identical agent_id.
   *  Replaces the old per-call `resolveSelfAgentId(configuredAgent,
   *  deps.stateDir)` here (never re-resolve; see wire-pairing.ts's header). */
  selfId: string
  registry: ProviderRegistry
  defaultProviderId: ProviderId
  pluginMcp: Record<string, McpStdioSpec>
  currentClaudeModel: () => string
  claudeBin: string | undefined
  /**
   * In-process Knowledge Kernel accessors (facts/search/store/embedQuery/
   * embedder), assembled once in bootstrap/index.ts and threaded straight
   * into `makeOwnerGrounding` (daemon/social/owner-grounding.ts) below —
   * replaces the retired grounded-judge.ts plugin-spawn path (SJ Task 3).
   * Undefined whenever `knowledge_enabled` is off; the judge then grounds
   * on topic text alone (see the BOOT log this produces).
   */
  knowledge?: import('../social/owner-grounding').GroundingKnowledge
  resolveOperatorChatId: () => string | null
  sendAssistantText: SendAssistantText | undefined
  a2aRegistry: A2ARegistry
  a2aClient: A2AClient
  /** Peer-closeness ranking's read side (a2a_events, migration v12) — feeds
   *  `rankPeersByCloseness` (core/peer-closeness.ts) at both discover
   *  fan-out sites below (degree-1 `broker.discover` + the hop+1
   *  forward-to-own-peers path). Structurally satisfies `PeerEventsView`
   *  (its `counts`/`recentForAgent`), so it's passed straight through —
   *  no adapter needed. */
  eventsStore: import('../../core/a2a-events-store').A2AEventsStore
  /** Lazy read of the a2a server's base url — the server is constructed AFTER
   *  wireSocial runs (it consumes onIntent/onReveal). Currently unused by the
   *  penpal-repointed wiring (reveal crosses pubkey handles, not URLs/names);
   *  kept on the interface for index.ts's existing wiring + any future use. */
  getServerBaseUrl: () => string | null
  /**
   * busy-registry hold (spec 2026-08-11 §2, Task 4 step 4) — the broker's
   * forage() and the async responder's judge/echo/forward both run as
   * background fire-and-forget coroutines outside SessionManager, via each
   * core module's own `schedule` injection seam. Threaded into a custom
   * `schedule` closure below (label 'social-forage' / 'social-responder')
   * so the idle self-restart check can see them running. ABSENT ⇒ no-op,
   * exactly as before this feature existed.
   */
  holdBusy?: (label: string) => () => void
}

/**
 * Wraps a bare fire-and-forget coroutine so a busy-registry token is held
 * for its whole run, released once it settles (success or throw) — same
 * "still working" complement to markInboundActivity as the other three
 * Task-4 hold points. Matches the `schedule?(fn): void` seam shape both
 * social-broker.ts and social-async-responder.ts already expose (their own
 * defaults are a bare `void fn()` / `void fn().catch(() => {})`); this is
 * that same fire-and-forget shape with a hold/release wrapped around it.
 * Exported for direct unit testing — production wiring uses it below.
 */
export function makeBusySchedule(
  label: string,
  holdBusy?: (label: string) => () => void,
  // M2 (code review, 2026-08-11): this used to swallow the rejection
  // silently (`.catch(() => {})`). Both callers' own `fn` already swallow
  // THEIR internal errors (forage / the responder's judge+echo+forward
  // loop), so in ordinary operation this catch never fires at all — which
  // is exactly what made it dangerous: it's the ONLY place that would ever
  // see a bug in one of those swallow-paths (or a future caller that
  // doesn't swallow), and it's also the sole diagnostic signal for "forage
  // wedged/threw ⇒ its busy token never got the chance to release ⇒ busy()
  // stays permanently true ⇒ self-restart permanently blocked". Optional
  // (not required) so `makeBusySchedule('x')` without a log stays a valid,
  // silent-safe call — same posture as `holdBusy` itself.
  log?: (tag: string, line: string) => void,
): (fn: () => Promise<void>) => void {
  return (fn) => {
    let release: (() => void) | undefined
    try { release = holdBusy?.(label) } catch { release = undefined }
    void Promise.resolve().then(fn)
      .finally(() => {
        try { release?.() } catch { /* release 幂等且不抛,防御性 */ }
      })
      .catch(err => {
        try { log?.('SOCIAL_REC', `schedule(${label}) coroutine threw: ${err instanceof Error ? err.message : String(err)}`) } catch { /* logging must never become a failure source */ }
      })
  }
}

export interface SocialWiring {
  onIntent: A2AServerOpts['onIntent']
  /** v2 async echo return (spec §1) — undefined whenever social wiring itself
   *  is inert, same gate as `onIntent`/`onReveal`. */
  onEcho: A2AServerOpts['onEcho']
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
    broker: {
      propose(topic: string, opts?: { city?: string }): Promise<import('../../core/social-broker').ProposeOutcome>
      confirmSeek(id: string): import('../../core/social-broker').ConfirmOutcome
      cancelSeek(id: string): import('../../core/social-broker').CancelOutcome
    }
    seekStore: import('../../core/social-seek-store').SeekStore
    echoStore: import('../../core/social-echo-store').EchoStore
    pledgeStore: import('../../core/social-pledge-store').PledgeStore
    revealer: Revealer
    penpal: {
      sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string; letter_id?: string }>
      resendLetter(letterId: string): Promise<{ ok: boolean; error?: string; letter_id?: string }>
      channelStore: import('../../core/penpal-channel-store').ChannelStore
      letterStore: import('../../core/penpal-letter-store').LetterStore
    }
  }
  resumeForaging: () => void
  /** 补投:没送到的揭晓 + 没送到的明信片。信箱轮询每一拍调一次;社交未启用
   *  时为 undefined。见 social-reveal.ts / social-echo-retry.ts。 */
  sweepUndelivered?: () => Promise<{ reveals: number; echoes: number }>
}

export async function wireSocial(deps: SocialDeps): Promise<SocialWiring> {
  const {
    registry, configuredAgent, resolveOperatorChatId, sendAssistantText,
    a2aRegistry, a2aClient, selfId,
  } = deps

  // ── Agent-social M1 wiring (async foraging spine) ───────────────────────
  // Gated on BOTH social_enabled and social_disclosure_policy — absent
  // either, the feature stays fully inert: no onIntent/onReveal wired into
  // the a2a server below, no broker constructed, no /v1/social/seek
  // functionality (the route 503s). Wires the row-driven mutual reveal
  // (revealer + inbound onReveal), the non-blocking broker (propose/forage/
  // recordEcho/finishSeek), the answer-side pledge, and boot resume of any
  // seeks still `foraging` after a restart.
  let socialOnIntent: A2AServerOpts['onIntent']
  let socialOnEcho: A2AServerOpts['onEcho']
  let socialOnReveal: A2AServerOpts['onReveal']
  let socialOnLetter: A2AServerOpts['onLetter']
  let socialOnMailboxLetter: A2AServerOpts['onLetter']
  let socialBroker: {
    propose(topic: string, opts?: { city?: string }): Promise<import('../../core/social-broker').ProposeOutcome>
    confirmSeek(id: string): import('../../core/social-broker').ConfirmOutcome
    cancelSeek(id: string): import('../../core/social-broker').CancelOutcome
  } | undefined
  // Per-row resume closure (replaces the old raw socialForage). It knows how to
  // gate a legacy/bridge row before it reaches the now-DE-GATED forage — see its
  // assignment inside the social block for the full rationale.
  let socialResumeRow: ((row: import('../../core/social-seek-store').SeekRow) => Promise<void>) | undefined
  let socialSeekStore: import('../../core/social-seek-store').SeekStore | undefined
  let socialEchoStore: import('../../core/social-echo-store').EchoStore | undefined
  let socialPledgeStore: import('../../core/social-pledge-store').PledgeStore | undefined
  let socialRevealer: Revealer | undefined
  let socialSweep: (() => Promise<{ reveals: number; echoes: number }>) | undefined
  let socialPenpal: {
    sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string; letter_id?: string }>
    resendLetter(letterId: string): Promise<{ ok: boolean; error?: string; letter_id?: string }>
    channelStore: import('../../core/penpal-channel-store').ChannelStore
    letterStore: import('../../core/penpal-letter-store').LetterStore
  } | undefined

  if (configuredAgent.social_enabled && configuredAgent.social_disclosure_policy) {
    const socialPolicy = configuredAgent.social_disclosure_policy
    const socialCheapEval = registry.getCheapEval()
    // 闸门的超时由**实际会跑的 provider** 说了算,不再是写死的 12s。
    // 2026-09-01:agy 单次 10.3–14.3s,12s 的常数把派心愿卡成了「时灵时不灵」。
    const socialGateTimeoutMs = registry.getCheapEvalBudgetMs()
    if (!socialCheapEval) {
      // Same degrade pattern as the openai provider block above: log and
      // skip rather than throw. No registered provider implements cheapEval
      // is exotic in practice (claude always registers one), but the seam
      // must degrade gracefully like every other optional wiring here.
      deps.log('BOOT', 'social: no cheapEval available from any registered provider — social_enabled is on but wiring is skipped (inert)')
    } else {
      // 说出来 —— 这个数字决定派心愿会不会莫名其妙报 checker_unavailable,
      // 以前它是个藏在常数里的 12s,查了半天才查出来。
      deps.log('BOOT', `social: 披露闸门超时 ${socialGateTimeoutMs}ms(按实际 cheapEval provider 的延迟预算)`)
      // spec §2 — one stable-unique slug per daemon (env > config > generated),
      // resolved ONCE by bootstrap/index.ts and threaded in as `deps.selfId`
      // (shared with wirePairing + pipeline-deps' delegate path — see
      // SocialDeps.selfId's doc comment). Legacy 'wechat-cc' preserved when
      // no mailbox_relays is configured.
      const SOCIAL_SELF_ID = selfId
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

      // v2: transport-selected fire-and-forget POST to a registry peer —
      // 社交往来记账 —— `rankPeersByCloseness` 按 a2a_events 的 recency/volume/
      // reciprocity 给 peer 排序,但 social 侧从建成起【只读不写】这张表:真机
      // a2a_events 恒为 0 行,排序实际退化成 id 字典序,桌面「看往来」也只看得
      // 见 notify。这里补上出入站留痕。
      //
      // 事件 text 会被渲染进桌面活动流,所以只记【无内容标签】—— 心愿正文、
      // 明信片内容、信件一律不进来。信件(/a2a/letter)刻意完全不记:它是匿名
      // 层最敏感的一环,而对"亲密度"这个信号也最没有信息量。
      const SOCIAL_EVENT_LABEL: Record<'/a2a/intent' | '/a2a/echo', string> = {
        '/a2a/intent': '社交:派出心愿',
        '/a2a/echo': '社交:回明信片',
      }
      const recordSocialEvent = (direction: 'in' | 'out', agentId: string, text: string, ok = true): void => {
        try { deps.eventsStore.append({ direction, agent_id: agentId, text, status: ok ? 'ok' : 'http_error' }) }
        catch (err) { deps.log('SOCIAL_REC', `event append failed agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`) }
      }

      // mailbox coords when present, else push HTTP. Used by intent sends,
      // echo returns and relay echo returns alike (spec §1 selection rule).
      // Declared early (only needs mailboxSender/a2aRegistry/a2aClient,
      // already in scope) so every downstream construct below (broker.send,
      // socialOnIntent's postEcho, socialOnEcho's postEcho) can share it.
      // 投递本体搬去 social-post-seam.ts —— 它在这个闭包里的时候,「信箱掉了
      // 包」那条路径一次都没被测过,而那正是 2026-09-01 真机上明信片悄悄丢掉
      // 的地方。这里只剩两件本地的事:proto_version 的告警,和把 asked /
      // delivered 分给各自的调用方。
      const socialPost = makeSocialPost({
        selfId: SOCIAL_SELF_ID,
        mailboxSend: (req, peer) => mailboxSender.send(req as Parameters<typeof mailboxSender.send>[0], peer),
        pushSend: (req) => a2aClient.send(req as Parameters<typeof a2aClient.send>[0]),
        urlFor: (path, base) => (path === '/a2a/intent' ? intentUrl(base) : echoUrl(base)),
        recordEvent: (agentId, path, ok) => recordSocialEvent('out', agentId, SOCIAL_EVENT_LABEL[path], ok),
        log: deps.log,
      })
      const postToHand = async (hand: A2AAgentRecord, path: '/a2a/intent' | '/a2a/echo', body: Record<string, unknown>) => {
        // proto v2 (2026-07-22) retired the sync MatchReceipt echo: a v1 peer
        // still ACCEPTS an intent but can never echo back. a2a-intent.ts says
        // "fleet must upgrade", yet nothing ever checked before sending — so a
        // stale peer looks identical to "nobody happened to match", on both
        // ends, forever. Warn-only per that same spec (never refuse).
        // Only an EXPLICITLY recorded old version warns: the field is absent on
        // every pairing-code edge (pairing never writes it), and treating
        // absent as v1 would warn on almost every healthy peer.
        if (path === '/a2a/intent' && typeof hand.proto_version === 'number' && hand.proto_version < A2A_PROTO_VERSION) {
          deps.log('SOCIAL_REC', `peer ${hand.id} 记录的 proto_version=${hand.proto_version} < ${A2A_PROTO_VERSION}:v2 已退役同步回声,这台对端收得到心愿但回不来明信片 —— 让对方升级`)
        }
        return socialPost(hand, path, body)
      }
      const postToPeer = async (agentId: string, path: '/a2a/intent' | '/a2a/echo', body: Record<string, unknown>): Promise<PostOutcome> => {
        const hand = a2aRegistry.get(agentId)
        if (!hand) return { asked: false, delivered: false }
        return postToHand(hand, path, body)
      }

      // The judge's grounding seam (daemon/social/owner-grounding.ts, SJ
      // Tasks 1-3) — replaces the retired grounded-judge.ts plugin-spawn
      // path. `ground` reads the owner's derived Knowledge Kernel facts
      // in-process (no child session, no provider-specific adapter, no
      // plugin MCP tools) and hands the judge already-fetched text to
      // reason over; `runTurn` stays the registry's own cheapEval — the
      // judge never spawns anything of its own any more.
      const { makeOwnerGrounding } = await import('../social/owner-grounding')
      const ground = makeOwnerGrounding(deps.knowledge)
      const socialRunTurn = async (systemPrompt: string, userPrompt: string) => socialCheapEval(`${systemPrompt}\n\n${userPrompt}`)
      const socialJudge = makeJudge({ runTurn: socialRunTurn, ground, policy: socialPolicy })
      deps.log('BOOT', deps.knowledge?.facts
        ? 'social: in-process grounded judge (kernel facts + search, no spawn, provider-agnostic)'
        : 'social: judge reasons from topic only — knowledge not wired (kernel off?). Not plugin-grounded.')
      const answerIntent = makeAnswerIntent({ judge: socialJudge, policy: socialPolicy, cheapEval: socialCheapEval, gateTimeoutMs: socialGateTimeoutMs })

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
          // A url-less mailbox peer never reaches here in practice (mailbox
          // targets go via mailboxSend above), but guard anyway — a
          // malformed/partial mailbox record must fail closed, not throw.
          if (!hand.url) return false
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
      socialPenpal = { sendLetter: (channel, text) => correspondent.sendLetter(channel, text), resendLetter: (id) => correspondent.resendLetter(id), channelStore, letterStore }

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
        finalize(rowId, peerHandle) {
          // peerHandle is absent on the async (mailbox) path — it was already
          // stashed when the peer's reveal arrived. Opening is the explicit
          // status flip either way.
          if (peerHandle) channelStore.setPeerHandle(rowId, peerHandle)
          channelStore.setStatus(rowId, 'open')
        },
        stashPeer(rowId, peerHandle) { channelStore.setPeerHandle(rowId, peerHandle) },
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
        const body = { agent_id: SOCIAL_SELF_ID, intent_id: intentId, ...(relayToken ? { relay_token: relayToken } : {}), ...(myHandle ? { peer_handle: myHandle } : {}) }
        // A url-less record is a mailbox-only peer (both ends behind NAT — the
        // exact case the mailbox transport exists for). Was deferred (spec
        // §10) and returned null here, which made 揭晓 structurally impossible
        // for those peers: seeks and echoes flowed over the mailbox but the
        // connection could never actually be made. Drop the reveal async
        // instead. A successful drop means "told them, mutuality unknown" ⇒
        // {mutual:false}; the revealer derives the true state from its own two
        // rows once the peer's reveal lands in our mailbox (see
        // social-reveal.ts — mutuality is row-derived, not transport-derived).
        // Push peers keep the synchronous round-trip: its `mutual:true` fast
        // path is strictly better feedback when a url exists.
        // 传输选择走 chooseTransport —— 与 postToHand 同一个判定。这里原先
        // 写的是 `if (!hand.url)`(url 优先),与 postToHand 的信箱优先相反,
        // 于是配对对端(永远 transport:'mailbox',却可能带着 url)心愿/回声
        // 走信箱都到了,唯独揭晓走 HTTP 打到一个到不了的地址。见
        // mailbox-dispatch-seam.test.ts。
        const route = chooseTransport(hand)
        if (route.kind === 'unreachable') return null
        if (route.kind === 'mailbox') {
          const dropped = await mailboxSender.send({ path: '/a2a/reveal', bearer: hand.outbound_api_key, body }, route.peer)
          return dropped ? { mutual: false } : null
        }
        const r = await a2aClient.send({ url: revealUrl(route.url), bearer: hand.outbound_api_key, body })
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
        // peerMailboxOf(hand) returned null — normally this means push/ws
        // (url guaranteed by schema), but a partially-configured mailbox
        // record (missing one of mailbox_addr/enc_pub/relays) also lands
        // here and may have no url either. Fail closed instead of throwing.
        if (!hand.url) return
        void a2aClient.send({ url: revealUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } })
          .catch(err => deps.log('SOCIAL_REC', `relay reveal post failed intent=${body.intent_id} agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`))
      }

      const revealer = makeRevealer({ echoStore, pledgeStore, seekStore, postPeerReveal, channel, notify })
      socialRevealer = revealer
      // 一次扫描补两种欠账:没送到的揭晓 + 没送到的明信片。挂在信箱轮询
      // 同一拍上 —— 那一拍本来就是网络恢复后第一个动的东西。
      socialSweep = async () => {
        const reveals = await revealer.retryUndelivered()
        const echoes = await echoRetry.retryUndeliveredEchoes()
        return { reveals, echoes }
      }

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

      // v2 echo intake (spec §2) — the seeker-side landing of an async /a2a/echo:
      // maps a bearer-verified EchoMessage onto the durable EchoRecord shape.
      // `recordEcho` is the SAME closure the pre-v2 sync broker.recordEcho dep
      // used to be (byte-identical id/mask shapes + the M2 durable-first-echo
      // check + notify beat) — moved here unchanged since it no longer belongs
      // on BrokerDeps (forage's fast-ack send never sees an echo synchronously
      // any more; the intake is the only place echoes land now).
      const recordEcho = (e: import('../../core/social-broker').EchoRecord): void => {
        // M2 — `e.first` is unused here (always false from the intake — see
        // social-echo-intake.ts's comment); durable first-echo detection is
        // done BELOW from the store itself, so a restart-resume re-arrival
        // can never re-fire the "有回声了" beat for an echo the operator
        // already saw. Ask the durable store: this is the seek's first-ever
        // echo iff it currently has zero echo rows, checked BEFORE the
        // (possibly-duplicate) insert below.
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
      }
      // markEchoed — flip foraging → echoed on the first accepted echo. NOTE:
      // applyFinishSeek's real signature is `(stores, intentId, peersAsked)`
      // (peersAsked REQUIRED — see social-finish-seek.ts) and this call site
      // has no peersAsked to give it (an inbound echo isn't a forage
      // completion), so this is the plain direct version the brief calls for
      // instead of reusing applyFinishSeek: only flip foraging → echoed,
      // touch nothing else. `connected` must never be downgraded here either
      // — untouched, since only a `foraging` row is flipped.
      const markEchoed = (intentId: string): void => {
        try {
          const cur = seekStore.get(intentId)
          if (cur?.status === 'foraging') seekStore.update(intentId, { status: 'echoed' })
        } catch (err) {
          deps.log('SOCIAL_REC', `markEchoed failed intent=${intentId}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const echoIntake = makeEchoIntake({
        seekStatus: (intentId) => { try { return seekStore.get(intentId)?.status ?? null } catch { return null } },
        recordEcho,
        markEchoed,
      })
      // v2 shared /a2a/echo handler (spec §2+§4) — one bearer-verified entry,
      // two roles resolved from OUR OWN records only: my own seek → echoIntake;
      // an intent I forwarded (seenIntentStore.originOf) → mint the relay leg
      // NOW (async echoes arrive later, possibly after a restart — unlike the
      // old sync forwarder, which minted relays at forward-time) and pass the
      // echo onward to the origin. Hoisted once (not rebuilt per call) since
      // its deps are all stable closures.
      const echoHandler = makeEchoHandler({
        intake: echoIntake,
        originOf: (intentId) => { try { return seenIntentStore.originOf(intentId) } catch { return null } },
        recordRelay: (intentId, upstreamAgentId, downstreamAgentId) => {
          // upstreamAgentId = origin (the ORIGINAL sender we forwarded FOR),
          // downstreamAgentId = the peer who just echoed back. Same shape as
          // the retired forwarder's recordRelay — NOT SOCIAL_SELF_ID.
          const relayToken = randomUUID()
          try {
            relayStore.create({ id: `${intentId}:${relayToken}`, intentId, relayToken, upstreamAgentId, downstreamAgentId })
          } catch (err) {
            deps.log('SOCIAL_REC', `relay record failed intent=${intentId} downstream=${downstreamAgentId}: ${err instanceof Error ? err.message : String(err)}`)
          }
          return relayToken
        },
        // 回声要的是【真的送到了没有】—— 见 social-post-seam.ts。
        postEcho: async (to, m) => (await postToPeer(to, '/a2a/echo', m)).delivered,
        log: deps.log,
      })
      socialOnEcho = async ({ agent, msg }) => {
        recordSocialEvent('in', agent.id, '社交:收到明信片')
        return echoHandler(agent.id, msg)
      }

      // Answer path: the spine's judge + pledge-on-yes is the LOCAL answer. The
      // v2 async responder wraps it with fast-ack + background judge/echo/
      // forward (spec §3/§4) — judge locally then async-echo the sender on a
      // match; separately (within the hop cap + not-already-seen) forward the
      // hop+1 card to OUR own paired peers (minus the sender). Downstream
      // echoes come back later via /a2a/echo → the echoHandler's relay leg
      // above, not synchronously aggregated onto this response any more.
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
      // 我欠这一位的明信片,先记账再投递 —— 投不出去才补得回去。
      // 记账用的 pledge 行就是 answerLocally 刚建的那条(同一个确定性主键)。
      const postOwnEcho = async (to: string, m: { intent_id: string; echo: { blurb: string; degree: number } }): Promise<boolean> => {
        const pledgeId = `${m.intent_id}:${to}`
        try { pledgeStore.setPendingEcho(pledgeId, m.echo.blurb, m.echo.degree, new Date().toISOString()) }
        catch (err) { deps.log('SOCIAL_REC', `明信片记账失败 pledge=${pledgeId}: ${err instanceof Error ? err.message : String(err)}`) }
        // 回声要的是【真的送到了没有】—— 见 social-post-seam.ts。
        const { delivered } = await postToPeer(to, '/a2a/echo', m)
        if (delivered) {
          try { pledgeStore.setEchoDelivered(pledgeId, new Date().toISOString()) }
          catch { /* 记账失败最多多补一次,不影响正确性 */ }
        }
        return delivered
      }
      const echoRetry = makeEchoRetry({ pledgeStore, postEcho: postOwnEcho, log: deps.log })
      const asyncResponder = makeAsyncResponder({
        answerLocally,
        postEcho: postOwnEcho,
        // Forward to our OWN paired peers, minus the sender; same cap as discover.
        // Guarded: a registry lookup failure must NOT reject the whole /a2a/intent
        // — W still returns its own local match (fail-closed: forward nothing).
        forwardTargets: (excludeAgentId) => {
          // 2026-08-31: url-less mailbox peers are targets again. They used to
          // be filtered out here because forwardSend went straight to
          // a2aClient/intentUrl(hand.url) — so the friend-of-a-friend behind
          // NAT could never be reached at hop 2 even though degree-1 discover
          // had already opened to mailbox peers. forwardSend now goes through
          // postToHand (mailbox coord when present, else push), exactly like
          // broker.send, so the filter is no longer needed — and the echo
          // return leg was already transport-agnostic.
          try {
            return rankPeersByCloseness(
              a2aRegistry.list().filter(a => !a.paused && a.id !== excludeAgentId),
              deps.eventsStore, Date.now(), 5,
            )
          }
          catch (err) {
            deps.log('SOCIAL_REC', `forwardTargets lookup failed exclude=${excludeAgentId}: ${err instanceof Error ? err.message : String(err)}`)
            return []
          }
        },
        // Same send path as degree-1 (`broker.send` below): mailbox coord when
        // the peer has one, else push. Replaces a hand-rolled push-only call
        // that made hop-2 unreachable for NAT'd peers.
        forwardSend: async (hand, card) => (await postToHand(hand, '/a2a/intent', { card })).asked,
        markSeen: (intentId, expiresAt, origin) => {
          // The responder core swallows a markSeen throw (empty catch); log it
          // here so a dedup-write failure is observable at the wiring seam.
          // origin (the sender) is now recorded too — the async echo-relay
          // leg (echoHandler.originOf) routes a downstream echo home by it.
          try { seenIntentStore.markSeen({ intentId, expiresAt, originAgentId: origin }) }
          catch (err) { deps.log('SOCIAL_REC', `seen mark failed intent=${intentId}: ${err instanceof Error ? err.message : String(err)}`) }
        },
        hasSeen: (intentId) => { try { return seenIntentStore.hasSeen(intentId) } catch { return false } },
        withinBudget: withinForwardBudget,
        hopCap: 2,
        schedule: makeBusySchedule('social-responder', deps.holdBusy, deps.log),
        log: deps.log,
      })
      socialOnIntent = async (event) => {
        recordSocialEvent('in', event.agent.id, '社交:收到心愿')
        return asyncResponder(event)
      }

      const broker = makeBroker({
        policy: socialPolicy,
        cheapEval: socialCheapEval,
        gateTimeoutMs: socialGateTimeoutMs,
        // PC T2: ranked by a2a-interaction closeness (core/peer-closeness.ts)
        // — recency + volume + reciprocity over deps.eventsStore, descending,
        // capped at 5. v2: mailbox peers now first-class for degree-1 intents
        // — postToHand (via `send` below) picks the mailbox coord when the
        // peer has one, else falls back to push. Only `paused` still filters
        // eligibility; the ranker changes ordering + cap only.
        discover: async (_topic) => rankPeersByCloseness(a2aRegistry.list().filter(a => !a.paused), deps.eventsStore, Date.now(), 5),
        // 扇出统计要的是【问过了几个】—— 信箱是 store-and-forward,投出去
        // 就算问过,对方什么时候取件不归派心愿这一步管。
        send: async (hand, card) => (await postToHand(hand, '/a2a/intent', { card })).asked,
        // P4 propose leg: persist a `proposed` row carrying the owner-approved
        // redacted wording (+ optional redacted city) so confirmSeek can forage
        // it verbatim, and a crash-resumed row survives WYSIWYG (redacted_topic
        // is non-null → resume forages it without re-gating).
        proposeRow: (intentId, r) => {
          try { seekStore.propose({ id: intentId, kind: 'seek', topic: r.topic, redactedTopic: r.redactedTopic, ...(r.redactedCity ? { redactedCity: r.redactedCity } : {}) }) }
          catch (err) { deps.log('SOCIAL_REC', `propose failed intent=${intentId}: ${err instanceof Error ? err.message : String(err)}`) }
        },
        readSeek: (intentId) => seekStore.get(intentId),
        markStatus: (intentId, status) => {
          try { seekStore.update(intentId, { status }) }
          catch (err) { deps.log('SOCIAL_REC', `markStatus failed intent=${intentId} status=${status}: ${err instanceof Error ? err.message : String(err)}`) }
        },
        // v2 forage completion: record peers_asked only — the seek row's
        // status is left AS-IS (foraging), echoes now land one at a time via
        // /a2a/echo → echoIntake above, which is what flips foraging → echoed.
        // seekStore.update already treats an omitted `status` key as a
        // peers_asked-ONLY write (see social-seek-store.ts), so no dedicated
        // setPeersAsked method is needed on top of it.
        markForaged: (intentId, peersAsked) => {
          try { seekStore.update(intentId, { peersAsked }) }
          catch (err) { deps.log('SOCIAL_REC', `markForaged failed intent=${intentId}: ${err instanceof Error ? err.message : String(err)}`) }
        },
        schedule: makeBusySchedule('social-forage', deps.holdBusy, deps.log),
      })
      socialBroker = {
        propose: (topic, opts) => broker.propose(topic, opts),
        confirmSeek: (id) => broker.confirmSeek(id),
        cancelSeek: (id) => broker.cancelSeek(id),
      }
      socialResumeRow = async (row) => {
        // v2 心愿无自动 close(markForaged only bumps peers_asked, never status
        // — see broker.markForaged above) — a seek with zero yes-echoes would
        // otherwise stay `foraging` forever and get RE-FORAGED on every single
        // restart, indefinitely. Boot-resume is the scan-and-sweep backstop:
        // a `foraging` row older than 7 days is presumed abandoned and closed
        // here instead of being re-broadcast yet again (the owner can always
        // start a fresh seek; a live one that's still worth asking around for
        // gets re-forage'd below as before, well inside the 7-day window).
        if (Date.parse(row.created_at) < Date.now() - 7 * 24 * 3600_000) {
          try { seekStore.update(row.id, { status: 'closed', peersAsked: row.peers_asked ?? 0 }) }
          catch (err) { deps.log('SOCIAL_REC', `resume close (7d) failed intent=${row.id}: ${err instanceof Error ? err.message : String(err)}`) }
          return
        }
        // forage() is now DE-GATED (Task 2) — it broadcasts its argument
        // verbatim. A propose→confirm row carries redacted_topic (+ optional
        // redacted_city): forage it verbatim so WYSIWYG survives the restart.
        // A legacy row has redacted_topic=null (pre-v24 rows) — RE-GATE here
        // so a RAW topic can never reach the de-gated forage. (M1 city fix:
        // resume now carries redacted_city too;
        // a re-gated legacy row has no persisted city to carry.)
        if (row.redacted_topic != null) {
          await broker.forage(row.id, row.redacted_topic, row.redacted_city ? { city: row.redacted_city } : undefined)
          return
        }
        const gated = await gateOutbound(row.topic, { policy: socialPolicy, cheapEval: socialCheapEval, timeoutMs: socialGateTimeoutMs })
        if (!gated.ok) return   // blocked at resume → nothing exposed
        await broker.forage(row.id, gated.redacted)
      }
    }
  }

  // Boot-resume loop, wrapped as a returnable closure. index.ts's
  // buildBootstrap calls this after wireA2aServer starts the server, so a
  // resumed forage's outbound sends can reach peers over a live listener.
  const resumeForaging = (): void => {
    if (socialResumeRow && socialSeekStore) {
      const resume = socialResumeRow
      for (const row of socialSeekStore.list()) {
        if (row.status === 'foraging') {
          void resume(row).catch(err => deps.log('SOCIAL_REC', `resume forage failed intent=${row.id}: ${err instanceof Error ? err.message : String(err)}`))
        }
      }
    }
  }

  return {
    onIntent: socialOnIntent,
    onEcho: socialOnEcho,
    onReveal: socialOnReveal,
    onLetter: socialOnLetter,
    onMailboxLetter: socialOnMailboxLetter,
    ...(socialBroker
      ? { social: { broker: socialBroker, seekStore: socialSeekStore!, echoStore: socialEchoStore!, pledgeStore: socialPledgeStore!, revealer: socialRevealer!, penpal: socialPenpal! } }
      : {}),
    resumeForaging,
    ...(socialSweep ? { sweepUndelivered: socialSweep } : {}),
  }
}
