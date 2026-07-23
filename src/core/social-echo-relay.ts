/**
 * social-echo-relay.ts — the shared /a2a/echo handler (spec §2+§4). One
 * bearer-verified entry, two roles resolved from OUR OWN records only:
 * my own seek → seeker intake; an intent I forwarded (seen-intent origin)
 * → mint the relay leg NOW (the sync path minted it at forward-time; async
 * echoes arrive later, possibly after a restart) and pass the echo onward
 * to the origin. A relayed echo (already carrying relay_token) is NEVER
 * re-relayed — hop-2 is the ceiling and tokens are single-leg. stale is
 * swallowed ok:true so a peer can't probe which of my seeks are still open.
 */
import type { EchoMessage } from './a2a-intent'

export interface EchoHandlerDeps {
  intake(senderAgentId: string, msg: EchoMessage): 'recorded' | 'stale' | 'unknown'
  originOf(intentId: string): string | null
  recordRelay(intentId: string, upstreamAgentId: string, downstreamAgentId: string): string
  postEcho(toAgentId: string, msg: { intent_id: string; echo: { blurb: string; degree: number; relay_token: string } }): Promise<boolean>
  log?(tag: string, line: string): void
}

export function makeEchoHandler(deps: EchoHandlerDeps) {
  const log = deps.log ?? (() => {})
  return async (senderAgentId: string, msg: EchoMessage): Promise<{ ok: boolean }> => {
    const took = deps.intake(senderAgentId, msg)
    if (took === 'recorded' || took === 'stale') return { ok: true }
    // Not my seek — relay leg? Only for a FIRST-leg echo (no token yet).
    if (msg.echo.relay_token) return { ok: false }
    const origin = deps.originOf(msg.intent_id)
    if (!origin || origin === senderAgentId) return { ok: false }
    try {
      const token = deps.recordRelay(msg.intent_id, origin, senderAgentId)
      const ok = await deps.postEcho(origin, { intent_id: msg.intent_id, echo: { blurb: msg.echo.blurb, degree: msg.echo.degree, relay_token: token } })
      if (!ok) log('SOCIAL_REC', `relay echo post dropped intent=${msg.intent_id} to=${origin}`)
      return { ok }
    } catch (err) {
      log('SOCIAL_REC', `relay echo failed intent=${msg.intent_id}: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false }
    }
  }
}
