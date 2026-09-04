/**
 * penpal-correspondent.ts — seals outbound letters and opens + persists
 * inbound ones for an open pen-pal channel. Plaintext NEVER goes on the wire:
 * only the sealed fields (nonce/ct/tag) + the peer's channel_id cross; the
 * local `plaintext` column on penpal_letter is for the owner's thread only.
 * See docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md.
 */
import { randomUUID } from 'node:crypto'
import { openEnvelope, sealEnvelope, type Envelope } from './envelope'
import { peerMailboxOfRow, type ChannelStore } from './penpal-channel-store'
import type { LetterStore } from './penpal-letter-store'
import { deriveSharedKey, sealLetter, openLetter } from './penpal-crypto'
import type { PeerMailbox } from './mailbox-crypto'

export interface CorrespondentDeps {
  channelStore: ChannelStore
  letterStore: LetterStore
  /** Outbound: POST the sealed letter to the peer. relayVia routes a 2-hop
   *  channel through the intermediary (Task 9) when the peer has no mailbox;
   *  `mailbox`, when present (the peer crossed one at reveal — Task 10), sends
   *  relay-direct instead (Task 11) — W is not in that path. channel_id = the
   *  PEER's inbound address. Returns ok. */
  postLetter(target: { agentId: string; relayVia: string | null; mailbox?: PeerMailbox }, body: { channel_id: string; nonce: string; ct: string; tag: string }): Promise<boolean>
  /** Owner notification on an inbound letter (preview of the decrypted text). */
  /**
   * 收到一封新东西 —— 信封已在这里解开(core/envelope.ts,唯一的解析点)。
   * 调用方按 `env.kind` 分发:'letter' 是主人的来信(ping 主人);'visit'
   * 是伙伴之间的串门;不认识的 kind 记日志忽略。`letterId` 让非信类型能
   * 立刻标已读 —— 伙伴之间的话不算主人的未读。
   */
  onInbound(ev: { channelRowId: string; letterId: string; plaintext: string; env: Envelope }): void
}

export interface Correspondent {
  /** `send_failed` carries the stored row's `letter_id` so the caller can
   *  retry via `resendLetter` — same bytes ⇒ same nonce ⇒ the receiver's
   *  (channel_id, nonce) dedupe (M3) makes the retry idempotent. Re-calling
   *  sendLetter with the same text instead would seal a NEW nonce and
   *  double-deliver whenever the first post actually landed but its ack was
   *  lost. */
  sendLetter(channelRowId: string, plaintext: string): Promise<{ ok: boolean; error?: string; letter_id?: string }>
  resendLetter(letterRowId: string): Promise<{ ok: boolean; error?: string; letter_id?: string }>
  receiveLetter(event: { channel_id: string; nonce: string; ct: string; tag: string }): { ok: boolean; error?: string }
  /** 发一个信封(非 letter 类型)。串门等交互走这里,不再往明文里塞头部。 */
  sendEnvelope(channelRowId: string, env: Envelope): Promise<{ ok: boolean; error?: string; letter_id?: string }>
}

/** Relay (degree-2) letters post to the intermediary (relay_via) so the 2-hop
 *  path stays content-blind; direct letters post straight to peer_agent_id.
 *  Mirrors social-reveal.ts's `echo.relay_via ?? echo.peer_agent_id`. A peer
 *  that crossed a mailbox at reveal (Task 10) additionally carries `mailbox`
 *  (relay-direct, Task 11) — W is never consulted for that leg. */
function routeOf(ch: NonNullable<ReturnType<ChannelStore['get']>>): { agentId: string; relayVia: string | null; mailbox?: PeerMailbox } | null {
  const agentId = ch.relay_via ?? ch.peer_agent_id
  if (!agentId) return null
  const mailbox = peerMailboxOfRow(ch)
  return { agentId, relayVia: ch.relay_via, ...(mailbox ? { mailbox } : {}) }
}

export function makeCorrespondent(deps: CorrespondentDeps): Correspondent {
  const sendSealed = (channelRowId: string, plaintext: string, kind: string, payload: unknown): Promise<{ ok: boolean; error?: string; letter_id?: string }> => {
    const ch = deps.channelStore.get(channelRowId)
    if (!ch || ch.status !== 'open' || !ch.peer_pubkey || !ch.peer_channel_id) return Promise.resolve({ ok: false, error: 'channel_not_open' })
    const route = routeOf(ch)
    if (!route) return Promise.resolve({ ok: false, error: 'no_route' })
    const key = deriveSharedKey(ch.my_privkey, ch.peer_pubkey)
    const sealed = sealLetter(key, plaintext)
    const id = randomUUID()
    deps.letterStore.create({ id, channelId: channelRowId, direction: 'out', sealedCiphertext: sealed.ct, nonce: sealed.nonce, tag: sealed.tag, plaintext, kind, payload })
    return deps.postLetter(route, { channel_id: ch.peer_channel_id, nonce: sealed.nonce, ct: sealed.ct, tag: sealed.tag })
      .then(ok => ok ? { ok: true } : { ok: false, error: 'send_failed', letter_id: id })
  }
  return {
    sendLetter(channelRowId, plaintext) { return sendSealed(channelRowId, plaintext, 'letter', null) },
    sendEnvelope(channelRowId, env) { return sendSealed(channelRowId, sealEnvelope(env), env.kind, env.payload) },
    resendLetter(letterRowId) {
      const row = deps.letterStore.get(letterRowId)
      // Inbound rows are not resendable — same error as unknown so a caller
      // can't probe which ids exist in the other direction.
      if (!row || row.direction !== 'out') return Promise.resolve({ ok: false, error: 'unknown_letter' })
      const ch = deps.channelStore.get(row.channel_id)
      if (!ch || ch.status !== 'open' || !ch.peer_pubkey || !ch.peer_channel_id) return Promise.resolve({ ok: false, error: 'channel_not_open' })
      const route = routeOf(ch)
      if (!route) return Promise.resolve({ ok: false, error: 'no_route' })
      return deps.postLetter(route, { channel_id: ch.peer_channel_id, nonce: row.nonce, ct: row.sealed_ciphertext, tag: row.tag })
        .then(ok => ok ? { ok: true } : { ok: false, error: 'send_failed', letter_id: row.id })
    },
    receiveLetter(ev) {
      const ch = deps.channelStore.getByMyChannelId(ev.channel_id)
      if (!ch || ch.status !== 'open' || !ch.peer_pubkey) return { ok: false, error: 'unknown_channel' }
      // M3 — idempotent re-delivery: a mailbox re-fetch after an ack failure
      // (or any other at-least-once redelivery) presents the same
      // (channel_id, nonce) again. No-op instead of a duplicate row + a
      // second owner ping.
      if (deps.letterStore.hasInbound(ch.id, ev.nonce)) return { ok: true }
      try {
        const pt = openLetter(deriveSharedKey(ch.my_privkey, ch.peer_pubkey), { nonce: ev.nonce, ct: ev.ct, tag: ev.tag })
        const letterId = randomUUID()
        const env = openEnvelope(pt)
        deps.letterStore.create({ id: letterId, channelId: ch.id, direction: 'in', sealedCiphertext: ev.ct, nonce: ev.nonce, tag: ev.tag, plaintext: pt,
          kind: env.kind, payload: env.kind === 'letter' ? null : env.payload })
        deps.onInbound({ channelRowId: ch.id, letterId, plaintext: pt, env })
        return { ok: true }
      } catch { return { ok: false, error: 'open_failed' } }
    },
  }
}
