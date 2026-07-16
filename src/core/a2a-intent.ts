import z from 'zod'
import { randomUUID } from 'node:crypto'

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
})
export type MatchReceipt = z.infer<typeof MatchReceiptSchema>

export function newIntentId(): string { return randomUUID() }
