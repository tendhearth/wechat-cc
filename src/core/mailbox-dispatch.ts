/**
 * mailbox-dispatch.ts — replay a decrypted envelope's {path,bearer,body} into
 * the SAME inbound handlers the HTTP routes call. Per-message auth mirrors the
 * HTTP server: reveal/intent/echo envelopes are verifyBearer-gated (度一 =
 * paired friend — reveal-completion legs are paired W↔endpoint, intent/echo
 * are the broker flow between registered agents); letter envelopes are NOT
 * (S↔Q strangers — the sealed-box + A's channel-key E2E in onLetter is the
 * auth). Returns discard — mailbox is one-way, the row-driven reveal/intake
 * reconciles. See spec §3.3 / §5.
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
import { IntentCardSchema, EchoMessageSchema } from './a2a-intent'

export interface EnvelopeDispatch { dispatch(inner: EnvelopeInner): Promise<void> }

export function makeEnvelopeDispatch(deps: {
  registry: A2ARegistry
  onReveal: A2AServerOpts['onReveal']
  /** MUST be an own-channel-only handler (getByMyChannelId → receiveLetter,
   *  else DROP). NEVER pass the HTTP socialOnLetter here — see file header. */
  onLetter: A2AServerOpts['onLetter']
  onIntent?: A2AServerOpts['onIntent']
  onEcho?: A2AServerOpts['onEcho']
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
            ? {
                pubkey: ph.pubkey, channel_id: ph.channel_id,
                // Mirror a2a-server.ts's reveal validation: a crossed mailbox
                // must have addr/enc_pub/relays ALL present, or it's dropped
                // (undefined) rather than stored partial — a partial mailbox
                // stored here would later throw in sealEnvelope on a missing
                // enc_pub.
                ...((ph.mailbox && typeof ph.mailbox === 'object'
                  && typeof (ph.mailbox as any).addr === 'string' && typeof (ph.mailbox as any).enc_pub === 'string' && Array.isArray((ph.mailbox as any).relays))
                  ? { mailbox: { addr: (ph.mailbox as any).addr, enc_pub: (ph.mailbox as any).enc_pub, relays: (ph.mailbox as any).relays } } : {}),
              } : undefined
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
        if (inner.path === '/a2a/intent') {
          if (!deps.onIntent) return
          if (typeof body.agent_id !== 'string') return
          const agent = deps.registry.verifyBearer(body.agent_id, inner.bearer)
          if (!agent) { deps.log('MAILBOX', `intent drop: bearer rejected for agent_id=${body.agent_id}`); return }
          const parsed = IntentCardSchema.safeParse(body.card)
          if (!parsed.success) { deps.log('MAILBOX', 'intent drop: invalid card'); return }
          await deps.onIntent({ agent, card: parsed.data })   // fast-ack receipt 丢弃 — mailbox 单向
          return
        }
        if (inner.path === '/a2a/echo') {
          if (!deps.onEcho) return
          const parsed = EchoMessageSchema.safeParse(body)
          if (!parsed.success) { deps.log('MAILBOX', 'echo drop: invalid shape'); return }
          const agent = deps.registry.verifyBearer(parsed.data.agent_id, inner.bearer)
          if (!agent) { deps.log('MAILBOX', `echo drop: bearer rejected for agent_id=${parsed.data.agent_id}`); return }
          await deps.onEcho({ agent, msg: parsed.data })
          return
        }
        deps.log('MAILBOX', `unhandled envelope path=${inner.path} (v0 seam — not wired)`)
      } catch (err) {
        deps.log('MAILBOX', `dispatch failed path=${inner.path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}
