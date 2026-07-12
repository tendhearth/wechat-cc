import { z } from 'zod'
import { randomUUID } from 'node:crypto'

export const IntentCardSchema = z.object({
  intent_id: z.string().min(1),
  kind: z.literal('seek'),                 // M1: seek only
  topic: z.string().min(1).max(280),       // policy-filtered NL — the intent, not raw data
  city: z.string().max(64).optional(),
  expires_at: z.string().min(1),           // ISO-8601; peer drops stale ones
})
export type IntentCard = z.infer<typeof IntentCardSchema>

export const MatchReceiptSchema = z.object({
  intent_id: z.string().min(1),
  match: z.enum(['yes', 'no']),
  blurb: z.string().max(280).optional(),   // only on yes; policy-filtered; NO contact info
})
export type MatchReceipt = z.infer<typeof MatchReceiptSchema>

export function newIntentId(): string { return randomUUID() }
