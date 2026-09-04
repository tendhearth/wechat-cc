/**
 * mailbox-dispatch.ts — replay a decrypted envelope's {path,bearer,body} into
 * the SAME inbound handler the HTTP route calls. 心愿改写(2026-09-04)之后
 * 信箱里**只剩一种信封**:`/a2a/letter`。它不做 verifyBearer(S↔Q 是陌生人 ——
 * sealed-box「只有我能拆」+ onLetter 里的信道密钥 E2E 才是它的认证;
 * agent_id 只是路由元数据)。Returns discard — 信箱是单向的。
 * See spec §3.3 / §5.
 *
 * I1 CONTRACT: the `onLetter` handed to makeEnvelopeDispatch MUST be an
 * own-channel-ONLY handler (getByMyChannelId → receiveLetter, else DROP) —
 * it must NEVER be the HTTP `socialOnLetter`. Because letter envelopes carry
 * no registry bearer, an un-bearer'd mailbox drop must not make this daemon
 * act on a channel that isn't its own. This dispatcher enforces
 * shape/routing only; the own-channel guarantee lives in the handler wired
 * at the call site (Task 8).
 */
import type { A2ARegistry } from './a2a-registry'
import type { A2AServerOpts } from './a2a-server'
import type { EnvelopeInner } from './mailbox-crypto'

export interface EnvelopeDispatch { dispatch(inner: EnvelopeInner): Promise<void> }

export function makeEnvelopeDispatch(deps: {
  registry: A2ARegistry
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
