import type { CustomerMessage } from './types'
import {
  analyzeCommitments,
  commitmentInputMessages,
  type CommitmentEval,
} from './commitment-analyzer'
import {
  CommitmentValidationError,
  createGroundedCommitmentId,
  type GroundedCommitment,
  type GroundedCommitmentExtraction,
} from './commitment-contract'

export interface CommitmentPipelineOptions {
  windowSize?: number
  overlap?: number
  maxCarryMessages?: number
  /** Includes the first attempt. Invalid model output is retried per window. */
  maxAttemptsPerWindow?: number
}

export interface CommitmentWindowIssue {
  windowIndex: number
  from: string
  to: string
  // Includes TOO_MANY_OPEN_COMMITMENTS: a window whose carried context had to
  // be trimmed is partially grounded, not failed — same class as an
  // unparseable model response, so it rides the same channel.
  errorCode: CommitmentValidationError['code'] | 'TOO_MANY_OPEN_COMMITMENTS'
  attempts: number
}

export interface CommitmentRangeAnalysisResult {
  extraction: GroundedCommitmentExtraction
  issues: CommitmentWindowIssue[]
}

export type CommitmentPipelineErrorCode = 'INVALID_WINDOW_CONFIG' | 'TOO_MANY_OPEN_COMMITMENTS'

export class CommitmentPipelineError extends Error {
  constructor(readonly code: CommitmentPipelineErrorCode, message: string) {
    super(message)
    this.name = 'CommitmentPipelineError'
  }
}

const DEFAULT_WINDOW_SIZE = 160
const DEFAULT_OVERLAP = 20
const DEFAULT_MAX_CARRY = 40
const DEFAULT_MAX_ATTEMPTS_PER_WINDOW = 2

export function chunkCommitmentMessages(
  messages: readonly CustomerMessage[],
  options: Pick<CommitmentPipelineOptions, 'windowSize' | 'overlap'> = {},
): CustomerMessage[][] {
  const input = commitmentInputMessages(messages, { enforceWindowLimit: false })
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE
  const overlap = options.overlap ?? DEFAULT_OVERLAP
  if (!Number.isInteger(windowSize) || windowSize < 1 || windowSize > 200
    || !Number.isInteger(overlap) || overlap < 0 || overlap >= windowSize) {
    throw new CommitmentPipelineError('INVALID_WINDOW_CONFIG', 'commitment window configuration is invalid')
  }
  if (input.length <= windowSize) return [[...input]]

  const windows: CustomerMessage[][] = []
  const step = windowSize - overlap
  for (let start = 0; start < input.length; start += step) {
    const window = input.slice(start, start + windowSize)
    if (window.length === 0) break
    windows.push(window)
    if (start + windowSize >= input.length) break
  }
  return windows
}

/** Strip whitespace and punctuation so paraphrase-free rewordings compare equal. */
function normalizeCommitmentText(text: string): string {
  return text.replace(/[\s，。、；;,.!！?？"'“”‘’()（）]/g, '').toLowerCase()
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 1 < text.length; i += 1) out.add(text.slice(i, i + 2))
  return out
}

/**
 * Dice coefficient over character bigrams — word-order tolerant, which matters
 * because Chinese rewordings reorder freely ("发送新版报价" ↔ "把新版报价发送
 * 给客户" is one promise) while two promises in one sentence share only the
 * boilerplate ("把方案发给客户" vs "把合同寄给客户" ≈ 0.33).
 */
function textSimilarity(a: string, b: string): number {
  const ga = bigrams(a)
  const gb = bigrams(b)
  if (ga.size === 0 || gb.size === 0) return a === b ? 1 : 0
  let shared = 0
  for (const gram of ga) if (gb.has(gram)) shared += 1
  return (2 * shared) / (ga.size + gb.size)
}

const SAME_COMMITMENT_SIMILARITY = 0.5

/**
 * Do two candidates describe the SAME promise?
 *
 * Sharing an evidence key is necessary but NOT sufficient. One message very
 * often contains two promises — "我明天把方案发你，周五前把合同寄出" is
 * ordinary sales chat — and both candidates then cite the same key. Matching on
 * the key alone merged them and `mergePair` kept only the incoming one, so the
 * first promise vanished with no issue recorded (verified against the real
 * pipeline, 2026-07-28 review).
 *
 * So the text has to agree too. Containment (not just equality) absorbs the
 * mild rewording the model does when the same promise reappears in the next
 * overlapping window, while keeping genuinely different promises apart. When
 * in doubt this errs toward NOT merging: a duplicate is visible to the owner
 * and correctable, a silent drop is neither.
 */
function sameCommitment(a: GroundedCommitment, b: GroundedCommitment): boolean {
  const aKeys = new Set(a.commitmentEvidenceKeys)
  if (!b.commitmentEvidenceKeys.some(key => aKeys.has(key))) return false
  const textA = normalizeCommitmentText(a.commitment)
  const textB = normalizeCommitmentText(b.commitment)
  if (!textA || !textB) return textA === textB
  if (textA === textB || textA.includes(textB) || textB.includes(textA)) return true
  return textSimilarity(textA, textB) >= SAME_COMMITMENT_SIMILARITY
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function confidence(a: GroundedCommitment['confidence'], b: GroundedCommitment['confidence']): GroundedCommitment['confidence'] {
  return a === 'high' || b === 'high' ? 'high' : 'medium'
}

function mergePair(existing: GroundedCommitment, incoming: GroundedCommitment): GroundedCommitment {
  const commitmentEvidenceKeys = unique([
    ...existing.commitmentEvidenceKeys,
    ...incoming.commitmentEvidenceKeys,
  ])
  const completionEvidenceKeys = unique([
    ...existing.completionEvidenceKeys,
    ...incoming.completionEvidenceKeys,
  ])
  const status = existing.status === 'completed' || incoming.status === 'completed'
    ? 'completed'
    : 'open'
  // A later pass sees more context. Prefer its wording/date when present, but
  // never erase an earlier explicit date with null.
  const dueDate = incoming.dueDate ?? existing.dueDate
  const dueDateEvidenceKey = incoming.dueDateEvidenceKey ?? existing.dueDateEvidenceKey
  const merged = {
    commitment: incoming.commitment || existing.commitment,
    status,
    dueDate,
    confidence: confidence(existing.confidence, incoming.confidence),
    commitmentEvidenceKeys,
    completionEvidenceKeys: status === 'completed' ? completionEvidenceKeys : [],
    dueDateEvidenceKey,
  } satisfies Omit<GroundedCommitment, 'id'>
  return { id: createGroundedCommitmentId(merged), ...merged }
}

export function mergeCommitmentExtractions(
  current: GroundedCommitmentExtraction,
  incoming: GroundedCommitmentExtraction,
): GroundedCommitmentExtraction {
  const merged = [...current.commitments]
  for (const candidate of incoming.commitments) {
    const index = merged.findIndex(existing => sameCommitment(existing, candidate))
    if (index === -1) merged.push(candidate)
    else merged[index] = mergePair(merged[index]!, candidate)
  }
  return { version: 1, commitments: merged }
}

function carryEvidence(
  extraction: GroundedCommitmentExtraction,
  messageByKey: ReadonlyMap<string, CustomerMessage>,
): CustomerMessage[] {
  const keys = unique(extraction.commitments
    .filter(commitment => commitment.status === 'open')
    .flatMap(commitment => commitment.commitmentEvidenceKeys))
  return keys.flatMap(key => {
    const message = messageByKey.get(key)
    return message ? [message] : []
  })
}

/**
 * Analyze chronological overlapping windows. Open commitments carry their
 * original evidence into later windows so a distant completion can be grounded
 * without giving the model the entire three-month chat at once.
 */
export async function analyzeCommitmentRange(
  messages: readonly CustomerMessage[],
  evaluate: CommitmentEval,
  options: CommitmentPipelineOptions = {},
): Promise<GroundedCommitmentExtraction> {
  const result = await analyzeCommitmentRangeRecovering(messages, evaluate, options)
  if (result.issues.length > 0) {
    const issue = result.issues[0]!
    // A trimmed-carry window is a coverage limit, not malformed model output —
    // keep the two error families distinct for callers that branch on them.
    if (issue.errorCode === 'TOO_MANY_OPEN_COMMITMENTS') {
      throw new CommitmentPipelineError('TOO_MANY_OPEN_COMMITMENTS', 'too many open commitments to reconcile in one analysis window')
    }
    throw new CommitmentValidationError(issue.errorCode, 'one or more commitment analysis windows failed validation')
  }
  return result.extraction
}

/**
 * A long chat should not become all-or-nothing because one model response was
 * malformed or cited the wrong message. Retry validation failures locally,
 * retain grounded windows, and report only the uncovered time spans.
 */
export async function analyzeCommitmentRangeRecovering(
  messages: readonly CustomerMessage[],
  evaluate: CommitmentEval,
  options: CommitmentPipelineOptions = {},
): Promise<CommitmentRangeAnalysisResult> {
  const sorted = [...messages].sort((a, b) => a.time.localeCompare(b.time))
  const windows = chunkCommitmentMessages(sorted, options)
  const messageByKey = new Map(sorted.map(message => [message.evidenceKey, message]))
  const maxCarry = options.maxCarryMessages ?? DEFAULT_MAX_CARRY
  const maxAttempts = Math.max(1, Math.min(options.maxAttemptsPerWindow ?? DEFAULT_MAX_ATTEMPTS_PER_WINDOW, 3))
  let result: GroundedCommitmentExtraction = { version: 1, commitments: [] }
  const issues: CommitmentWindowIssue[] = []

  for (const [windowIndex, window] of windows.entries()) {
    let carry = carryEvidence(result, messageByKey)
      .filter(message => !window.some(item => item.evidenceKey === message.evidenceKey))
    if (carry.length > maxCarry || window.length + carry.length > 200) {
      // DEGRADE, DON'T ABORT. This used to throw, and the throw escaped the
      // per-window recovery below (which only catches CommitmentValidationError)
      // — so a contact who accumulated more than `maxCarry` open commitments
      // failed the ENTIRE review and lost every window analyzed so far.
      // Deterministically, too, so retrying never helped. That is exactly the
      // heavy user this feature is for.
      //
      // Instead keep the most recent carry messages (the ones most likely to be
      // completed by what follows) and record the window as partially grounded,
      // the same way an unparseable model response degrades.
      const budget = Math.max(0, Math.min(maxCarry, 200 - window.length))
      carry = carry.slice(-budget)
      const firstMsg = window[0]!
      const lastMsg = window.at(-1)!
      issues.push({
        windowIndex,
        from: firstMsg.time,
        to: lastMsg.time,
        errorCode: 'TOO_MANY_OPEN_COMMITMENTS',
        attempts: 0,
      })
    }
    let extraction: GroundedCommitmentExtraction | null = null
    let validationError: CommitmentValidationError | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        extraction = await analyzeCommitments([...carry, ...window], prompt => evaluate(
          attempt === 1 ? prompt : `${prompt}\n\n上一次输出没有通过格式或聊天依据校验。请重新审查，只输出可验证的 JSON；不确定的内容直接忽略。`,
        ))
        break
      } catch (error) {
        if (!(error instanceof CommitmentValidationError)) throw error
        validationError = error
      }
    }
    if (extraction) {
      result = mergeCommitmentExtractions(result, extraction)
      continue
    }
    const first = window[0]!
    const last = window.at(-1)!
    issues.push({
      windowIndex,
      from: first.time,
      to: last.time,
      errorCode: validationError?.code ?? 'INVALID_AI_OUTPUT',
      attempts: maxAttempts,
    })
  }
  return { extraction: result, issues }
}
