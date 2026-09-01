/**
 * social-reveal.ts — the row-driven mutual reveal core (双向异步互揭). One
 * function, three entry points: revealEcho / revealPledge (outbound: my owner
 * clicked 揭晓) and onInboundReveal (a peer's /a2a/reveal arrived). Whoever
 * reveals SECOND learns mutual:true synchronously in their own round-trip; the
 * connection is two local rows on two machines, each side transitioning on
 * "both marked". No in-memory waiting — restart-survivability is a property of
 * the rows. See docs/superpowers/specs/2026-07-15-async-foraging-spine-design.md.
 *
 * Reveal crosses a per-connection PenpalHandle (X25519 pubkey + channel id),
 * never the real peer identity — see
 * docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md.
 * The masked label (第 N 度的某人) is permanent; only the ChannelPort, backed
 * by the channel store, learns the crossed handle.
 */
import type { EchoStore } from './social-echo-store'
import type { PledgeStore } from './social-pledge-store'
import type { SeekStore } from './social-seek-store'
import type { PenpalHandle } from './penpal-crypto'

export type { PenpalHandle } from './penpal-crypto'

/** 补投的时间上限。超过这么久还没送达的揭晓不再自动重投 —— 本仓库的
 *  no-retry-storm 规矩:每一条自动外发都得有界。中继的留存远短于此,拖到
 *  两周还没落地的连接需要人来看,不是机器每 2 分钟再敲一次。
 *  放弃的只是**自动**补投:owner 手动再点一次揭晓照样会重发。 */
export const REVEAL_RETRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
export type RevealBeat = 'first_echo' | 'await_reveal' | 'connected'
export interface NotifyCtx { intentId: string; peerAgentId?: string }
export interface RevealOutcome { state: 'connected' | 'awaiting_peer' | 'peer_unreachable' }

/** A small channel-store seam so the revealer stays pure (no DB knowledge).
 *  Backed by `makeChannelStore` (Task 6). */
export interface ChannelPort {
  /** Called at the ①→② opt-in (my consent) — idempotent: mint a keypair +
   *  channel id and a pending channel row keyed by `rowId` if absent, return
   *  THIS side's PenpalHandle. */
  openLocal(rowId: string, ctx: { seekId: string; degree: number; peerAgentId?: string | null; relayVia?: string | null }): PenpalHandle
  /** Called at the mutual instant: store the peer's crossed handle (when the
   *  transport handed one back) and open the channel. `peerHandle` is optional
   *  because an async transport (mailbox) reports no handle — by then it was
   *  already stashed by `stashPeer` when the peer's reveal arrived. */
  finalize(rowId: string, peerHandle?: PenpalHandle): void
  /** Peer revealed BEFORE me: persist their handle WITHOUT opening the channel
   *  (my owner hasn't consented yet). Over an async transport there is no
   *  second delivery of it, so dropping it here would strand me on a pending
   *  channel after I consent. */
  stashPeer(rowId: string, peerHandle: PenpalHandle): void
}

export interface RevealerDeps {
  echoStore: EchoStore
  pledgeStore: PledgeStore
  seekStore: SeekStore
  /** Outbound A2A POST to the peer's /a2a/reveal. `relayToken` addresses a 2-hop
   *  relay leg (routed to the intermediary). null when unreachable. */
  postPeerReveal(agentId: string, intentId: string, relayToken?: string): Promise<{ mutual: boolean; handle?: PenpalHandle } | null>
  /** Channel port: mints/persists the per-connection PenpalHandle. */
  channel: ChannelPort
  /** Notification beats (克制三拍). Only await_reveal + connected fire from here. */
  notify(beat: RevealBeat, ctx: NotifyCtx): void
}

export interface Revealer {
  revealEcho(echoId: string): Promise<RevealOutcome | null>
  revealPledge(pledgeId: string): Promise<RevealOutcome | null>
  onInboundReveal(ev: { agentId: string; intentId: string; relayToken?: string; peerHandle?: PenpalHandle }): { mutual: boolean; handle?: PenpalHandle }
  /** 补投:把所有「owner 已同意、但揭晓从没送到对端」的行重投一遍,返回
   *  这一拍真正送达的条数。挂在信箱轮询同一拍上 —— 网络恢复后它本来就是
   *  第一个动的东西。绝不代替 owner 同意:只碰 self_revealed_at 非空的行。 */
  retryUndelivered(): Promise<number>
}

export function makeRevealer(deps: RevealerDeps): Revealer {
  return {
    async revealEcho(echoId) {
      const echo = deps.echoStore.get(echoId)
      if (!echo) return null
      // 短路的前提是【三】件事都成立,不是两件:我同意了、对方也揭晓了、
      // **而且我的揭晓真的送到了**。第三件以前没人记,于是投递失败之后
      // 只要对方的揭晓恰好到达,重试就直接报「已连接」、一次都不重发,
      // 对端永远停在 awaiting_peer(2026-09-01 真机)。见 db.ts v32。
      if (echo.self_revealed_at && echo.peer_revealed_at && echo.self_reveal_delivered_at) return { state: 'connected' }
      const now = new Date().toISOString()
      if (!echo.self_revealed_at) {
        deps.echoStore.setSelfRevealed(echoId, now)                                       // my consent, idempotent
        deps.channel.openLocal(echoId, { seekId: echo.seek_id, degree: echo.degree, peerAgentId: echo.peer_agent_id, relayVia: echo.relay_via })
      }
      // Relay (degree-2) echo → reveal is addressed to the intermediary (relay_via),
      // carrying the relay_token; a direct echo posts to peer_agent_id (2-arg, unchanged).
      const target = echo.relay_via ?? echo.peer_agent_id
      if (!target) return { state: 'peer_unreachable' }                                   // legacy row, can't POST back
      const resp = echo.relay_token
        ? await deps.postPeerReveal(target, echo.seek_id, echo.relay_token)
        : await deps.postPeerReveal(target, echo.seek_id)
      if (!resp) return { state: 'peer_unreachable' }                                     // consent already persisted
      deps.echoStore.setSelfDelivered(echoId, now)                                       // 送达是独立事实 —— 只有这里能写
      // Mutuality is a property of the TWO LOCAL ROWS, not of the transport's
      // answer. A mailbox drop can only ever report `mutual:false` (there is no
      // synchronous response channel), so trusting `resp.mutual` alone would
      // leave an async second-revealer stuck on awaiting_peer even though both
      // sides have consented. `resp.mutual` stays authoritative for the push
      // fast-path; the row check covers everything else.
      if (!resp.mutual && !echo.peer_revealed_at) return { state: 'awaiting_peer' }
      if (!echo.peer_revealed_at) deps.echoStore.setPeerRevealed(echoId, now)
      deps.echoStore.setStatus(echoId, 'revealed')
      deps.seekStore.update(echo.seek_id, { status: 'connected' })
      deps.channel.finalize(echoId, resp.handle)
      deps.notify('connected', { intentId: echo.seek_id })
      return { state: 'connected' }
    },

    async revealPledge(pledgeId) {
      const pledge = deps.pledgeStore.get(pledgeId)
      if (!pledge) return null
      // 同 revealEcho:短路要三件事齐全,少了「已送达」就是那个毒化 bug。
      if (pledge.self_revealed_at && pledge.peer_revealed_at && pledge.self_reveal_delivered_at) return { state: 'connected' }
      const now = new Date().toISOString()
      if (!pledge.self_revealed_at) {
        deps.pledgeStore.setSelfRevealed(pledgeId, now)
        deps.channel.openLocal(pledgeId, { seekId: pledge.intent_id, degree: 0, peerAgentId: pledge.seeker_agent_id, relayVia: null })
      }
      const resp = await deps.postPeerReveal(pledge.seeker_agent_id, pledge.intent_id)
      if (!resp) return { state: 'peer_unreachable' }
      deps.pledgeStore.setSelfDelivered(pledgeId, now)
      // Same row-derived mutuality as revealEcho — see its comment.
      if (!resp.mutual && !pledge.peer_revealed_at) return { state: 'awaiting_peer' }
      if (!pledge.peer_revealed_at) deps.pledgeStore.setPeerRevealed(pledgeId, now)
      deps.channel.finalize(pledgeId, resp.handle)
      deps.notify('connected', { intentId: pledge.intent_id })
      return { state: 'connected' }
    },

    onInboundReveal({ agentId, intentId, relayToken, peerHandle }) {
      const now = new Date().toISOString()
      // Relay inbound → the relay echo id is intent_id:relay_via:relay_token (S may
      // hold several relay echoes for one intent, so the direct key is insufficient).
      const rowId = relayToken ? `${intentId}:${agentId}:${relayToken}` : `${intentId}:${agentId}`
      const echo = deps.echoStore.get(rowId)
      if (echo) {
        if (echo.peer_revealed_at) {
          // duplicate/retried inbound reveal — no writes, no notify, just a consistent answer
          if (!echo.self_revealed_at) return { mutual: false }
          const handle = deps.channel.openLocal(rowId, { seekId: intentId, degree: echo.degree, peerAgentId: echo.peer_agent_id, relayVia: echo.relay_via })
          deps.channel.finalize(rowId, peerHandle)
          return { mutual: true, handle }
        }
        deps.echoStore.setPeerRevealed(rowId, now)
        if (echo.self_revealed_at) {
          deps.echoStore.setStatus(rowId, 'revealed')
          deps.seekStore.update(intentId, { status: 'connected' })
          // Idempotent openLocal mints/returns MY handle at the mutual instant; the
          // peer's presented handle (if any) is stored via finalize now that the
          // channel row exists (opened at my earlier self-reveal, or here for the
          // first time if I'm revealing second synchronously).
          const handle = deps.channel.openLocal(rowId, { seekId: intentId, degree: echo.degree, peerAgentId: echo.peer_agent_id, relayVia: echo.relay_via })
          deps.channel.finalize(rowId, peerHandle)
          deps.notify('connected', { intentId, peerAgentId: agentId })
          return { mutual: true, handle }
        }
        // Peer revealed before me. Persist their handle NOW rather than waiting
        // to be handed it again in the mutual response when I reveal second:
        // over an async transport (mailbox drop) there IS no synchronous
        // response, so discarding it here strands me on a pending channel
        // forever — I would be "connected" with no way to open the letter
        // channel. Minting my channel row early is purely local (openLocal is
        // idempotent and only mints a keypair + pending row); my handle is not
        // sent anywhere until my owner actually consents, and pending rows are
        // invisible to the 信箱 surface (routes-penpal filters status==='open').
        if (peerHandle) {
          deps.channel.openLocal(rowId, { seekId: intentId, degree: echo.degree, peerAgentId: echo.peer_agent_id, relayVia: echo.relay_via })
          deps.channel.stashPeer(rowId, peerHandle)
        }
        deps.notify('await_reveal', { intentId, peerAgentId: agentId })
        return { mutual: false }
      }
      const pledge = deps.pledgeStore.get(rowId)
      if (pledge) {
        if (pledge.peer_revealed_at) {
          // duplicate/retried inbound reveal — no writes, no notify, just a consistent answer
          if (!pledge.self_revealed_at) return { mutual: false }
          const handle = deps.channel.openLocal(rowId, { seekId: intentId, degree: 0, peerAgentId: pledge.seeker_agent_id, relayVia: null })
          deps.channel.finalize(rowId, peerHandle)
          return { mutual: true, handle }
        }
        deps.pledgeStore.setPeerRevealed(rowId, now)
        if (pledge.self_revealed_at) {
          const handle = deps.channel.openLocal(rowId, { seekId: intentId, degree: 0, peerAgentId: pledge.seeker_agent_id, relayVia: null })
          deps.channel.finalize(rowId, peerHandle)
          deps.notify('connected', { intentId, peerAgentId: agentId })
          return { mutual: true, handle }
        }
        // Same early-persist as the echo branch above — see its comment.
        if (peerHandle) {
          deps.channel.openLocal(rowId, { seekId: intentId, degree: 0, peerAgentId: pledge.seeker_agent_id, relayVia: null })
          deps.channel.stashPeer(rowId, peerHandle)
        }
        deps.notify('await_reveal', { intentId, peerAgentId: agentId })
        return { mutual: false }
      }
      return { mutual: false }  // nothing to reveal against; respond without leaking
    },

    async retryUndelivered() {
      // 为什么必须自动补:出事的那次,owner 屏幕上写的是「已连接」——
      // 他没有任何理由再点一次揭晓。能重试而没人去重试,等于没修。
      let delivered = 0
      const cutoff = Date.now() - REVEAL_RETRY_WINDOW_MS
      const tooOld = (at: string | null) => at !== null && Date.parse(at) < cutoff
      for (const echo of deps.echoStore.listUndelivered()) {
        if (tooOld(echo.self_revealed_at)) continue              // 有界:见 REVEAL_RETRY_WINDOW_MS
        const target = echo.relay_via ?? echo.peer_agent_id
        if (!target) continue                                    // legacy row, can't POST back
        const resp = echo.relay_token
          ? await deps.postPeerReveal(target, echo.seek_id, echo.relay_token)
          : await deps.postPeerReveal(target, echo.seek_id)
        if (!resp) continue                                      // 还是不通,下一拍再来
        deps.echoStore.setSelfDelivered(echo.id, new Date().toISOString())
        delivered++
      }
      for (const pledge of deps.pledgeStore.listUndelivered()) {
        if (tooOld(pledge.self_revealed_at)) continue
        const resp = await deps.postPeerReveal(pledge.seeker_agent_id, pledge.intent_id)
        if (!resp) continue
        deps.pledgeStore.setSelfDelivered(pledge.id, new Date().toISOString())
        delivered++
      }
      return delivered
    },
  }
}
