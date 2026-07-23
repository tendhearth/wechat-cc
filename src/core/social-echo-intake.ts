/**
 * social-echo-intake.ts — the seeker side of the v2 async echo return
 * (spec §2). Maps a bearer-verified EchoMessage onto the EXISTING EchoRecord
 * shape (ids/masks/degrees byte-identical to the old sync-receipt path, so
 * the reveal machinery is none the wiser). Own-status gate: only an ACTIVE
 * seek accepts echoes (foraging/echoed/connected — connected because an
 * established match's seek can still collect more echoes, matching
 * applyFinishSeek's non-downgrade posture); proposed/cancelled/closed are
 * stale drops; an unknown intent is the caller's cue to try the relay leg.
 */
import type { EchoMessage } from './a2a-intent'
import type { EchoRecord } from './social-broker'

const ACTIVE = new Set(['foraging', 'echoed', 'connected'])

export interface EchoIntakeDeps {
  seekStatus(intentId: string): string | null
  recordEcho(e: EchoRecord): void
  /** Flip foraging → echoed on the first accepted echo. */
  markEchoed(intentId: string): void
}

/** Same defence-in-depth as social-broker.sanitizeBlurb (peer-controlled text). */
function sanitizeBlurb(blurb: string): string {
  return blurb.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function makeEchoIntake(deps: EchoIntakeDeps) {
  return (senderAgentId: string, msg: EchoMessage): 'recorded' | 'stale' | 'unknown' => {
    const status = deps.seekStatus(msg.intent_id)
    if (status == null) return 'unknown'
    if (!ACTIVE.has(status)) return 'stale'
    const relay = msg.echo.relay_token
    deps.recordEcho({
      intentId: msg.intent_id,
      peerAgentId: relay ? null : senderAgentId,
      ...(relay ? { relayVia: senderAgentId, relayToken: relay } : {}),
      peerMasked: `第 ${msg.echo.degree} 度的某人`,
      degree: msg.echo.degree,
      content: sanitizeBlurb(msg.echo.blurb),
      first: false,   // durable first-echo detection lives in the wire-social recordEcho closure (M2)
    })
    if (status === 'foraging') deps.markEchoed(msg.intent_id)
    return 'recorded'
  }
}
