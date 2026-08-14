import { createHash } from 'node:crypto'
// zod v4: named `z` is undefined under this repo's Vitest/Bun transform.
import z from 'zod'
import type { CustomerMessage } from './types'

const EVIDENCE_KEY_RE = /^[a-f0-9]{24}$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function isCalendarDate(value: string): boolean {
  const match = DATE_RE.exec(value)
  if (!match) return false
  const normalized = `${match[1]}-${match[2]}-${match[3]}`
  const parsed = new Date(`${normalized}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized
}

const evidenceKeySchema = z.string().regex(EVIDENCE_KEY_RE)
const dateSchema = z.string().refine(isCalendarDate, 'must be a real YYYY-MM-DD date')

// Conservative product guard for standalone vague actions. This is not meant
// to replace model judgment; it blocks the exact class of false positive found
// in the first real-contact eval when the normalized
// statement still lacks an object or deliverable.
const VAGUE_STANDALONE_RE = /^(?:我)?(?:回头|之后|有空)?(?:弄|看|处理|确认)(?:一下)?(?:再)?(?:给你)?(?:看看|看|说)?[。！!？?]?$/

export function isSpecificCommitmentText(value: string): boolean {
  return !VAGUE_STANDALONE_RE.test(value.replace(/\s+/g, ''))
}

export const commitmentCandidateSchema = z.object({
  /** Concise action promised by the owner; not a quote or speculative advice. */
  commitment: z.string().trim().min(1).max(500)
    .refine(isSpecificCommitmentText, 'commitment must name a concrete action or deliverable'),
  /** Completed commitments are retained for review but excluded from the open list. */
  status: z.enum(['open', 'completed']),
  /** Null when no explicit due date appears in the cited messages. */
  dueDate: dateSchema.nullable(),
  confidence: z.enum(['medium', 'high']),
  /** At least one owner-authored message that explicitly makes the commitment. */
  commitmentEvidenceKeys: z.array(evidenceKeySchema).min(1).max(10),
  /** Required only when status=completed; may be authored by either side. */
  completionEvidenceKeys: z.array(evidenceKeySchema).max(10),
  /** Evidence containing the explicit date; null when dueDate is null. */
  dueDateEvidenceKey: evidenceKeySchema.nullable(),
}).strict().superRefine((candidate, ctx) => {
  const commitmentKeys = new Set(candidate.commitmentEvidenceKeys)
  if (commitmentKeys.size !== candidate.commitmentEvidenceKeys.length) {
    ctx.addIssue({ code: 'custom', path: ['commitmentEvidenceKeys'], message: 'evidence keys must be unique' })
  }
  const completionKeys = new Set(candidate.completionEvidenceKeys)
  if (completionKeys.size !== candidate.completionEvidenceKeys.length) {
    ctx.addIssue({ code: 'custom', path: ['completionEvidenceKeys'], message: 'evidence keys must be unique' })
  }
  if (candidate.status === 'open' && candidate.completionEvidenceKeys.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['completionEvidenceKeys'], message: 'open commitments cannot include completion evidence' })
  }
  if (candidate.status === 'completed' && candidate.completionEvidenceKeys.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['completionEvidenceKeys'], message: 'completed commitments require completion evidence' })
  }
  if (candidate.dueDate === null && candidate.dueDateEvidenceKey !== null) {
    ctx.addIssue({ code: 'custom', path: ['dueDateEvidenceKey'], message: 'date evidence requires a due date' })
  }
  if (candidate.dueDate !== null) {
    if (candidate.dueDateEvidenceKey === null) {
      ctx.addIssue({ code: 'custom', path: ['dueDateEvidenceKey'], message: 'an explicit due date requires evidence' })
    } else if (!commitmentKeys.has(candidate.dueDateEvidenceKey)) {
      ctx.addIssue({ code: 'custom', path: ['dueDateEvidenceKey'], message: 'date evidence must also be commitment evidence' })
    }
  }
})

export const commitmentExtractionSchema = z.object({
  version: z.literal(1),
  commitments: z.array(commitmentCandidateSchema).max(50),
}).strict()

export type CommitmentCandidateDraft = z.infer<typeof commitmentCandidateSchema>
export type CommitmentExtractionDraft = z.infer<typeof commitmentExtractionSchema>

export interface GroundedCommitment extends CommitmentCandidateDraft {
  id: string
}

export interface GroundedCommitmentExtraction {
  version: 1
  commitments: GroundedCommitment[]
}

export type CommitmentValidationErrorCode =
  | 'INVALID_AI_OUTPUT'
  | 'UNKNOWN_EVIDENCE'
  | 'COMMITMENT_NOT_OWNER_AUTHORED'
  | 'EMPTY_COMMITMENT_EVIDENCE'
  | 'DUPLICATE_COMMITMENT'

export class CommitmentValidationError extends Error {
  constructor(readonly code: CommitmentValidationErrorCode, message: string) {
    super(message)
    this.name = 'CommitmentValidationError'
  }
}

export function createGroundedCommitmentId(candidate: CommitmentCandidateDraft): string {
  const identity = JSON.stringify({
    commitment: candidate.commitment,
    evidence: [...candidate.commitmentEvidenceKeys].sort(),
  })
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 24)
}

/**
 * Parse model output and prove every cited key belongs to the supplied source
 * window. Raw messages and validation payloads are never included in errors.
 */
export function validateCommitmentExtraction(
  raw: unknown,
  messages: readonly CustomerMessage[],
): GroundedCommitmentExtraction {
  const parsed = commitmentExtractionSchema.safeParse(raw)
  if (!parsed.success) {
    throw new CommitmentValidationError('INVALID_AI_OUTPUT', 'AI returned an invalid commitment extraction')
  }

  const evidence = new Map(messages.map(message => [message.evidenceKey, message]))
  const seen = new Set<string>()
  const commitments = parsed.data.commitments.map(candidate => {
    const allKeys = [
      ...candidate.commitmentEvidenceKeys,
      ...candidate.completionEvidenceKeys,
      ...(candidate.dueDateEvidenceKey ? [candidate.dueDateEvidenceKey] : []),
    ]
    if (allKeys.some(key => !evidence.has(key))) {
      throw new CommitmentValidationError('UNKNOWN_EVIDENCE', 'AI cited evidence outside the selected chat range')
    }
    for (const key of candidate.commitmentEvidenceKeys) {
      const message = evidence.get(key)!
      if (!message.isFromMe) {
        throw new CommitmentValidationError('COMMITMENT_NOT_OWNER_AUTHORED', 'commitment evidence must be authored by the owner')
      }
      if (!message.text.trim()) {
        throw new CommitmentValidationError('EMPTY_COMMITMENT_EVIDENCE', 'commitment evidence must contain text')
      }
    }
    const id = createGroundedCommitmentId(candidate)
    if (seen.has(id)) {
      throw new CommitmentValidationError('DUPLICATE_COMMITMENT', 'AI returned the same commitment more than once')
    }
    seen.add(id)
    return { id, ...candidate }
  })

  return { version: 1, commitments }
}

export function openCommitments(extraction: GroundedCommitmentExtraction): GroundedCommitment[] {
  return extraction.commitments.filter(commitment => commitment.status === 'open')
}
