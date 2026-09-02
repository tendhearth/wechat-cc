/**
 * mailbox-dispatch-seam.ts — the small pure helpers wire-social uses to decide
 * whether an outbound social a2a call goes over the mailbox transport, and to
 * seal+drop it if so. Extracted so it's unit-testable without booting wireSocial.
 * See spec §3.3 / §6 (the third dispatch arm).
 */
import type { A2AAgentRecord } from '../../lib/agent-config'
import type { PeerMailbox } from '../../core/mailbox-crypto'
import type { PenpalHandle } from '../../core/penpal-crypto'

/** The peer's mailbox routing, or null if this peer isn't a (complete) mailbox peer. */
export function peerMailboxOf(hand: A2AAgentRecord): PeerMailbox | null {
  if (hand.transport !== 'mailbox') return null
  if (!hand.mailbox_addr || !hand.mailbox_enc_pub || !hand.relays || hand.relays.length === 0) return null
  return { addr: hand.mailbox_addr, enc_pub: hand.mailbox_enc_pub, relays: hand.relays }
}

/** chooseTransport 的结果 —— 调用方 switch 一次,不再各自判断。 */
export type TransportChoice =
  | { kind: 'mailbox'; peer: PeerMailbox }
  | { kind: 'push'; url: string }
  | { kind: 'unreachable' }

/**
 * 一个对端该走哪条腿 —— **全仓唯一的判定处**。
 *
 * WHY(2026-09-01,Mac↔Windows 真机闭环的最后一程死在这里):wire-social.ts
 * 里原先有两套互相矛盾的规则 —— postToHand(心愿/回声)信箱优先,
 * postPeerReveal(揭晓)`if (!hand.url)` 即 url 优先。配对码建立的对端
 * **永远是 transport:'mailbox'**,而配对卡片可能带着 url,于是同一个对端
 * 心愿到了、回声到了、揭晓 peer_unreachable。链路明明通着偏偏最后一步不通,
 * 是最难读的那种症状。
 *
 * 顺序刻意是「声明的 transport 优先」:transport 字段就是这个意思,
 * 记录里残留的 url 不该推翻它。坐标不全时才回落 url —— 声明了信箱却没坐标
 * 不能变成不可达。
 */
export function chooseTransport(hand: A2AAgentRecord): TransportChoice {
  const peer = peerMailboxOf(hand)
  if (peer) return { kind: 'mailbox', peer }
  if (hand.url) return { kind: 'push', url: hand.url }
  return { kind: 'unreachable' }
}

/**
 * C1 (Task 10) — the single home for building THIS daemon's crossing handle.
 * Enriches at the SOURCE (this daemon's own channel row + this daemon's own
 * mailbox identity), NOT from a bare channel row (which never held the
 * mailbox). Callers: wire-social's postPeerReveal (outbound POST), postReveal
 * implicitly (it forwards an already-enriched handle), and channel.openLocal
 * (the sync mutual-response path). `myMailbox` is undefined when this daemon
 * has no mailbox configured — the returned handle then omits `mailbox`
 * entirely, byte-identical to the pre-Task-10 handle (push peers unaffected).
 */
export function buildCrossedHandle(ch: { my_pubkey: string; my_channel_id: string }, myMailbox: PeerMailbox | undefined): PenpalHandle {
  return { pubkey: ch.my_pubkey, channel_id: ch.my_channel_id, ...(myMailbox ? { mailbox: myMailbox } : {}) }
}
