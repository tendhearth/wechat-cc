import z from 'zod'

/** Daemon-owned identity of the actual execution turn. Never inferred from current settings. */
export const ReplyAttribution = z.object({
  speaker: z.enum(['cc', 'agent', 'notice']),
  provider: z.string().min(1).optional(),
  model: z.string().optional(),
  matterId: z.string().optional(),
  /** Execution run identity, when known (not a provider or a native session id). */
  agentId: z.string().optional(),
  turnId: z.string().optional(),
})
export type ReplyAttribution = z.infer<typeof ReplyAttribution>
/** Every wire field is optional so older records/daemons retain their original shape. */
export const OptionalReplyAttribution = ReplyAttribution.partial()
/** A data-only part of an existing combined reply. Indexes refer to the unchanged attachment/narration arrays. */
export const ReplyPart = OptionalReplyAttribution.extend({
  text: z.string(),
  truncated: z.boolean().optional(),
  attachmentIndexes: z.array(z.number().int().nonnegative()).optional(),
  narrationIndexes: z.array(z.number().int().nonnegative()).optional(),
})
export type ReplyPart = z.infer<typeof ReplyPart>
export const OptionalReplyMetadata = OptionalReplyAttribution.extend({ replyParts: z.array(ReplyPart).optional() })
export function replyAttributionFields(value: Partial<ReplyAttribution>): Partial<ReplyAttribution> {
  const out: Partial<ReplyAttribution> = {}
  for (const key of ['speaker', 'provider', 'model', 'matterId', 'agentId', 'turnId'] as const) {
    if (value[key] !== undefined) Object.assign(out, { [key]: value[key] })
  }
  return out
}
export function replyMetadataFields(value: Partial<ReplyAttribution> & { replyParts?: ReplyPart[] }, textLimit?: number) {
  let remaining = textLimit ?? Infinity
  const replyParts = value.replyParts?.map(p => {
    const text = p.text.slice(0, remaining)
    remaining = Math.max(0, remaining - text.length - 1)
    return { ...p, text, ...(text.length < p.text.length ? { truncated: true } : {}) }
  })
  return { ...replyAttributionFields(value), ...(replyParts?.length ? { replyParts } : {}) }
}
