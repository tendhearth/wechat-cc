/**
 * mailbox-dispatch.ts — replay a decrypted envelope's {path,bearer,body} into
 * the SAME inbound handlers the HTTP routes call. Per-message auth mirrors the
 * HTTP server: reveal envelopes are verifyBearer-gated (reveal-completion legs
 * are paired W↔endpoint); letter envelopes are NOT (S↔Q strangers — the
 * sealed-box + A's channel-key E2E in onLetter is the auth). Returns discard —
 * mailbox is one-way, the row-driven reveal reconciles. See spec §3.3 / §5.
 *
 * I1 CONTRACT: the `onLetter` handed to makeEnvelopeDispatch MUST be an
 * own-channel-ONLY handler (getByMyChannelId → receiveLetter, else DROP) —
 * it must NEVER be the HTTP `socialOnLetter`, which falls through to
 * letterRelay.routeLetter. Because letter envelopes carry no registry bearer,
 * an un-bearer'd mailbox drop must not make this daemon forward junk to a
 * third party. This dispatcher enforces shape/routing only; the own-channel
 * guarantee lives in the handler wired at the call site (Task 8).
 */
import type { A2ARegistry } from './a2a-registry'
import type { A2AServerOpts } from './a2a-server'
import type { EnvelopeInner } from './mailbox-crypto'

export interface EnvelopeDispatch { dispatch(inner: EnvelopeInner): Promise<void> }

export function makeEnvelopeDispatch(deps: {
  registry: A2ARegistry
  onReveal: A2AServerOpts['onReveal']
  /** MUST be an own-channel-only handler (getByMyChannelId → receiveLetter,
   *  else DROP). NEVER pass the HTTP socialOnLetter here — see file header. */
  onLetter: A2AServerOpts['onLetter']
  log: (tag: string, line: string) => void
}): EnvelopeDispatch {
  return {
    async dispatch(inner) {
      const b = inner.body
      if (!b || typeof b !== 'object') return
      const body = b as Record<string, unknown>
      try {
        if (inner.path === '/a2a/reveal') {
          if (typeof body.agent_id !== 'string' || typeof body.intent_id !== 'string' || !body.intent_id) return
          const agent = deps.registry.verifyBearer(body.agent_id, inner.bearer)
          if (!agent) { deps.log('MAILBOX', `reveal drop: bearer rejected for agent_id=${body.agent_id}`); return }
          if (!deps.onReveal) return
          const ph = body.peer_handle as { pubkey?: unknown; channel_id?: unknown; mailbox?: unknown } | undefined
          const peerHandle = (ph && typeof ph.pubkey === 'string' && typeof ph.channel_id === 'string')
            ? { pubkey: ph.pubkey, channel_id: ph.channel_id, ...(ph.mailbox && typeof ph.mailbox === 'object' ? { mailbox: ph.mailbox as any } : {}) } : undefined
          await deps.onReveal({
            agent_id: agent.id, intent_id: body.intent_id,
            ...(typeof body.relay_token === 'string' && body.relay_token ? { relay_token: body.relay_token } : {}),
            ...(peerHandle ? { peer_handle: peerHandle } : {}),
          })
          return
        }
        if (inner.path === '/a2a/letter') {
          if (typeof body.channel_id !== 'string' || typeof body.nonce !== 'string' || typeof body.ct !== 'string' || typeof body.tag !== 'string') return
          if (!deps.onLetter) return
          // No registry bearer: relay-direct letters are stranger↔stranger; the
          // sealed-box (only we could open the envelope) + channel-key E2E open
          // inside onLetter is the authentication. agent_id is routing metadata.
          await deps.onLetter({ agent_id: typeof body.agent_id === 'string' ? body.agent_id : 'mailbox', channel_id: body.channel_id, nonce: body.nonce, ct: body.ct, tag: body.tag })
          return
        }
        deps.log('MAILBOX', `unhandled envelope path=${inner.path} (v0 seam — not wired)`)
      } catch (err) {
        deps.log('MAILBOX', `dispatch failed path=${inner.path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}
