import z from 'zod'
import { randomUUID } from 'node:crypto'

/**
 * A2A wire-protocol version, advertised in the agent card
 * (GET /.well-known/agent.json → `proto_version`).
 *
 * Rules:
 * - Single integer; bumped ONLY on an incompatible wire change.
 * - A card WITHOUT the field means version 1 (every pre-versioning peer).
 * - Mismatch = best-effort interop + warn; never refuse (refusal/downgrade
 *   semantics get designed when a real v2 exists).
 * v2 (2026-07-22): sync MatchReceipt echoes retired — echoes arrive via the async /a2a/echo message. Old (v1) seekers get an empty receipt and cannot receive echoes; fleet must upgrade (spec §5).
 */
export const A2A_PROTO_VERSION = 2

export const IntentCardSchema = z.object({
  intent_id: z.string().min(1),
  kind: z.literal('seek'),                 // M1: seek only
  topic: z.string().min(1).max(280),       // policy-filtered NL — the intent, not raw data
  city: z.string().max(64).optional(),
  expires_at: z.string().min(1),           // ISO-8601; peer drops stale ones
  // spec #2 forwarding: a seek leaves the seeker with hop=1; a relay forwards
  // with hop+1 only while hop < 2. OPTIONAL with a default so an old seeker's
  // card (no hop) still safeParses and lands hop=1.
  hop: z.number().int().min(1).default(1),
})
export type IntentCard = z.infer<typeof IntentCardSchema>

// A degree-2 echo aggregated by an intermediary and returned to the seeker
// alongside the intermediary's own MatchReceipt. `relay_token` is opaque and
// meaningful only to the intermediary (it maps to the downstream peer there).
export const ForwardedEchoSchema = z.object({
  blurb: z.string().max(280),
  degree: z.number().int(),
  relay_token: z.string().min(1),
})
export type ForwardedEcho = z.infer<typeof ForwardedEchoSchema>

export const MatchReceiptSchema = z.object({
  intent_id: z.string().min(1),
  match: z.enum(['yes', 'no']),
  blurb: z.string().max(280).optional(),   // only on yes; policy-filtered; NO contact info
  // spec #2: degree-2 echoes forwarded by this responder. Backward-compatible
  // superset — an old seeker parsing with the OLD schema drops it silently.
  forwarded: z.array(ForwardedEchoSchema).optional(),
  // v2 fast-ack marker: receiver acked and will judge/echo asynchronously.
  async: z.boolean().optional(),
})
export type MatchReceipt = z.infer<typeof MatchReceiptSchema>

export function newIntentId(): string { return randomUUID() }

// v2 async echo — the return leg of a seek. Posted by the responder (or a
// relay) to the intent's SENDER; the receiver routes it by its OWN records
// (own seek → intake; forwarded intent → relay onward), never by anything
// inside the message. relay_token present ⇔ this echo crossed a relay leg.
export const EchoMessageSchema = z.object({
  agent_id: z.string().min(1),
  intent_id: z.string().min(1),
  echo: z.object({
    blurb: z.string().min(1).max(280),
    degree: z.number().int().min(1),
    relay_token: z.string().min(1).optional(),
  }),
})
export type EchoMessage = z.infer<typeof EchoMessageSchema>
