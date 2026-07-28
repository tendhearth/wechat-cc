import { createHash, randomUUID } from 'node:crypto'
import type { Db } from '../../lib/db'
import type { CustomerMessage } from './types'
import type { GroundedCommitmentExtraction } from './commitment-contract'
import type { CommitmentWindowIssue } from './commitment-pipeline'

export type CustomerReviewStatus = 'queued' | 'analyzing' | 'ready' | 'failed'
/** Human review is separate from the AI's chat-evidence status. */
export type CustomerReviewItemStatus = 'unreviewed' | 'confirmed' | 'corrected' | 'completed_elsewhere' | 'rejected' | 'ignored'

export interface CustomerReviewRecord {
  id: string
  contactId: string
  contactDisplayName: string
  rangeFrom: string
  rangeTo: string
  status: CustomerReviewStatus
  provider: string
  model?: string
  sourceMessageCount: number
  sourceFirstAt?: string
  sourceLastAt?: string
  errorCode?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  analysisIssues: CustomerReviewAnalysisIssue[]
  items: CustomerReviewItemRecord[]
}

/** Safe coverage metadata for windows the model could not ground. */
export interface CustomerReviewAnalysisIssue {
  windowIndex: number
  rangeFrom: string
  rangeTo: string
  attempts: number
}

/** A compact, persisted entry for the customer-review landing list. */
export interface CustomerReviewHistoryContact {
  contactId: string
  displayName: string
  reviewCount: number
  lastReviewAt: string
  lastStatus: CustomerReviewStatus
}

export interface CustomerReviewEvidenceRecord {
  evidenceKey: string
  role: 'commitment' | 'completion' | 'due_date'
  messageTime: string
  senderSide: 'me' | 'contact'
}

/** Raw text is read from wxvault only when the owner expands an evidence row. */
export interface CustomerReviewEvidenceDetail extends CustomerReviewEvidenceRecord {
  text: string
  messageType: string
}

export interface CustomerReviewItemRecord {
  sourceKey: string
  commitment: string
  aiStatus: 'open' | 'completed'
  dueDate?: string
  confidence: 'medium' | 'high'
  reviewStatus: CustomerReviewItemStatus
  correctedText?: string
  createdAt: string
  updatedAt: string
  evidence: CustomerReviewEvidenceRecord[]
}

export interface CreateCustomerReviewInput {
  contactId: string
  contactDisplayName: string
  rangeFrom: string
  rangeTo: string
  provider: string
  model?: string
}

export interface CompleteCustomerReviewInput {
  extraction: GroundedCommitmentExtraction
  messages: readonly CustomerMessage[]
  analysisIssues?: readonly CommitmentWindowIssue[]
}

export interface CustomerReviewStore {
  create(input: CreateCustomerReviewInput): Promise<string>
  /**
   * Move every review stranded in `analyzing` to `failed`, returning how many.
   *
   * A run is minutes of sequential LLM calls held entirely in memory, so a
   * daemon restart (or a watchdog SIGKILL) in the middle leaves the row in
   * `analyzing` with nobody working on it. `markAnalyzing` only accepts
   * `queued`/`failed`, so nothing could ever move it again: the UI showed
   * 分析中 forever and 重新分析 answered INVALID_REVIEW_TRANSITION. Called once
   * at startup, before any request can arrive.
   */
  reclaimStranded(): Promise<number>
  markAnalyzing(id: string): Promise<void>
  complete(id: string, input: CompleteCustomerReviewInput): Promise<void>
  fail(id: string, errorCode: string): Promise<void>
  get(id: string): Promise<CustomerReviewRecord | null>
  listByContact(contactId: string): Promise<CustomerReviewRecord[]>
  listRecentContacts(limit: number): Promise<CustomerReviewHistoryContact[]>
  reviewItem(id: string, sourceKey: string, input: {
    status: Exclude<CustomerReviewItemStatus, 'unreviewed'>
    correctedText?: string
  }): Promise<void>
}

export type CustomerReviewStoreErrorCode =
  | 'REVIEW_NOT_FOUND'
  | 'REVIEW_ITEM_NOT_FOUND'
  | 'INVALID_REVIEW_TRANSITION'
  | 'INVALID_FEEDBACK'
  | 'MISSING_EVIDENCE'

export class CustomerReviewStoreError extends Error {
  constructor(readonly code: CustomerReviewStoreErrorCode, message: string) {
    super(message)
    this.name = 'CustomerReviewStoreError'
  }
}

interface ReviewRow {
  id: string
  contact_id: string
  contact_display_name: string
  range_from: string
  range_to: string
  status: CustomerReviewStatus
  provider: string
  model: string | null
  source_message_count: number
  source_first_at: string | null
  source_last_at: string | null
  error_code: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface ItemRow {
  review_id: string
  source_key: string
  commitment: string
  ai_status: 'open' | 'completed'
  due_date: string | null
  confidence: 'medium' | 'high'
  review_status: CustomerReviewItemStatus
  corrected_text: string | null
  created_at: string
  updated_at: string
}

interface EvidenceRow {
  review_id: string
  source_key: string
  evidence_key: string
  role: CustomerReviewEvidenceRecord['role']
  message_time: string
  sender_side: CustomerReviewEvidenceRecord['senderSide']
}

interface AnalysisIssueRow {
  review_id: string
  window_index: number
  range_from: string
  range_to: string
  error_code: string
  attempts: number
}

interface RecentContactRow {
  contact_id: string
  contact_display_name: string
  review_count: number
  last_review_at: string
  last_status: CustomerReviewStatus
}

function newReviewId(): string {
  return `crv_${randomUUID()}`
}

/** Stable across model wording changes as long as the grounding messages stay the same. */
export function customerReviewSourceKey(commitmentEvidenceKeys: readonly string[]): string {
  const identity = [...new Set(commitmentEvidenceKeys)].sort().join('|')
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 24)
}

function reviewRecord(
  row: ReviewRow,
  items: CustomerReviewItemRecord[],
  analysisIssues: CustomerReviewAnalysisIssue[],
): CustomerReviewRecord {
  return {
    id: row.id,
    contactId: row.contact_id,
    contactDisplayName: row.contact_display_name,
    rangeFrom: row.range_from,
    rangeTo: row.range_to,
    status: row.status,
    provider: row.provider,
    ...(row.model !== null ? { model: row.model } : {}),
    sourceMessageCount: row.source_message_count,
    ...(row.source_first_at !== null ? { sourceFirstAt: row.source_first_at } : {}),
    ...(row.source_last_at !== null ? { sourceLastAt: row.source_last_at } : {}),
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    analysisIssues,
    items,
  }
}

export function makeCustomerReviewStore(
  db: Db,
  options: { now?: () => string; id?: () => string } = {},
): CustomerReviewStore {
  const now = options.now ?? (() => new Date().toISOString())
  const makeId = options.id ?? newReviewId

  const selectReview = db.query<ReviewRow, [string]>(
    'SELECT * FROM customer_reviews WHERE id = ?',
  )
  const selectItems = db.query<ItemRow, [string]>(
    'SELECT * FROM customer_review_items WHERE review_id = ? ORDER BY rowid ASC',
  )
  const selectEvidence = db.query<EvidenceRow, [string]>(
    'SELECT * FROM customer_review_evidence WHERE review_id = ? ORDER BY rowid ASC',
  )
  const selectAnalysisIssues = db.query<AnalysisIssueRow, [string]>(
    'SELECT * FROM customer_review_analysis_issues WHERE review_id = ? ORDER BY window_index ASC',
  )
  const selectRecentContacts = db.query<RecentContactRow, [number]>(`
    SELECT latest.contact_id, latest.contact_display_name,
           COUNT(all_reviews.id) AS review_count,
           latest.created_at AS last_review_at, latest.status AS last_status
    FROM customer_reviews AS latest
    JOIN customer_reviews AS all_reviews ON all_reviews.contact_id = latest.contact_id
    WHERE latest.rowid = (
      SELECT candidate.rowid FROM customer_reviews AS candidate
      WHERE candidate.contact_id = latest.contact_id
      ORDER BY candidate.created_at DESC, candidate.rowid DESC LIMIT 1
    )
    GROUP BY latest.rowid
    ORDER BY latest.created_at DESC, latest.rowid DESC
    LIMIT ?
  `)

  function requireReview(id: string): ReviewRow {
    const row = selectReview.get(id)
    if (!row) throw new CustomerReviewStoreError('REVIEW_NOT_FOUND', 'customer review was not found')
    return row
  }

  function hydrate(row: ReviewRow): CustomerReviewRecord {
    const evidenceBySource = new Map<string, CustomerReviewEvidenceRecord[]>()
    for (const evidence of selectEvidence.all(row.id)) {
      const list = evidenceBySource.get(evidence.source_key) ?? []
      list.push({
        evidenceKey: evidence.evidence_key,
        role: evidence.role,
        messageTime: evidence.message_time,
        senderSide: evidence.sender_side,
      })
      evidenceBySource.set(evidence.source_key, list)
    }
    const items = selectItems.all(row.id).map(item => ({
      sourceKey: item.source_key,
      commitment: item.commitment,
      aiStatus: item.ai_status,
      ...(item.due_date !== null ? { dueDate: item.due_date } : {}),
      confidence: item.confidence,
      reviewStatus: item.review_status,
      ...(item.corrected_text !== null ? { correctedText: item.corrected_text } : {}),
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      evidence: evidenceBySource.get(item.source_key) ?? [],
    }))
    const analysisIssues = selectAnalysisIssues.all(row.id).map(issue => ({
      windowIndex: issue.window_index,
      rangeFrom: issue.range_from,
      rangeTo: issue.range_to,
      attempts: issue.attempts,
    }))
    return reviewRecord(row, items, analysisIssues)
  }

  return {
    async create(input) {
      const id = makeId()
      const ts = now()
      db.prepare(`
        INSERT INTO customer_reviews(
          id, contact_id, contact_display_name, range_from, range_to,
          status, provider, model, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
      `).run(
        id, input.contactId, input.contactDisplayName, input.rangeFrom, input.rangeTo,
        input.provider, input.model ?? null, ts, ts,
      )
      return id
    },

    async reclaimStranded() {
      const stranded = db.query<{ id: string }, []>(
        `SELECT id FROM customer_reviews WHERE status = 'analyzing'`,
      ).all()
      if (stranded.length === 0) return 0
      db.prepare(`
        UPDATE customer_reviews
        SET status = 'failed', error_code = 'INTERRUPTED_BY_RESTART', updated_at = ?
        WHERE status = 'analyzing'
      `).run(now())
      return stranded.length
    },

    async markAnalyzing(id) {
      const row = requireReview(id)
      if (row.status !== 'queued' && row.status !== 'failed') {
        throw new CustomerReviewStoreError('INVALID_REVIEW_TRANSITION', 'customer review cannot enter analyzing from its current state')
      }
      db.prepare(`
        UPDATE customer_reviews
        SET status = 'analyzing', error_code = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(now(), id)
    },

    async complete(id, input) {
      const row = requireReview(id)
      if (row.status !== 'analyzing') {
        throw new CustomerReviewStoreError('INVALID_REVIEW_TRANSITION', 'customer review must be analyzing before completion')
      }
      const messageByKey = new Map(input.messages.map(message => [message.evidenceKey, message]))
      const ts = now()

      db.transaction(() => {
        db.prepare('DELETE FROM customer_review_analysis_issues WHERE review_id = ?').run(id)
        const insertIssue = db.prepare(`
          INSERT INTO customer_review_analysis_issues(
            review_id, window_index, range_from, range_to, error_code, attempts
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        for (const issue of input.analysisIssues ?? []) {
          insertIssue.run(id, issue.windowIndex, issue.from, issue.to, issue.errorCode, issue.attempts)
        }
        for (const candidate of input.extraction.commitments) {
          const sourceKey = customerReviewSourceKey(candidate.commitmentEvidenceKeys)
          const feedback = db.prepare(`
            SELECT review_status, corrected_text
            FROM customer_review_feedback WHERE contact_id = ? AND source_key = ?
          `).get(row.contact_id, sourceKey) as { review_status: CustomerReviewItemStatus; corrected_text: string | null } | null

          db.prepare(`
            INSERT INTO customer_review_items(
              review_id, source_key, commitment, ai_status, due_date, confidence,
              review_status, corrected_text, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(review_id, source_key) DO UPDATE SET
              commitment = excluded.commitment,
              ai_status = excluded.ai_status,
              due_date = excluded.due_date,
              confidence = excluded.confidence,
              review_status = CASE
                WHEN customer_review_items.review_status = 'unreviewed' THEN excluded.review_status
                ELSE customer_review_items.review_status
              END,
              corrected_text = CASE
                WHEN customer_review_items.review_status = 'unreviewed' THEN excluded.corrected_text
                ELSE customer_review_items.corrected_text
              END,
              updated_at = excluded.updated_at
          `).run(
            id, sourceKey, candidate.commitment, candidate.status,
            candidate.dueDate, candidate.confidence,
            feedback?.review_status ?? 'unreviewed', feedback?.corrected_text ?? null,
            ts, ts,
          )

          db.prepare('DELETE FROM customer_review_evidence WHERE review_id = ? AND source_key = ?')
            .run(id, sourceKey)
          const insertEvidence = db.prepare(`
            INSERT INTO customer_review_evidence(
              review_id, source_key, evidence_key, role, message_time, sender_side
            ) VALUES (?, ?, ?, ?, ?, ?)
          `)
          const roles: ReadonlyArray<readonly [string, CustomerReviewEvidenceRecord['role']]> = [
            ...candidate.commitmentEvidenceKeys.map(key => [key, 'commitment'] as const),
            ...candidate.completionEvidenceKeys.map(key => [key, 'completion'] as const),
            ...(candidate.dueDateEvidenceKey ? [[candidate.dueDateEvidenceKey, 'due_date'] as const] : []),
          ]
          for (const [evidenceKey, role] of roles) {
            const message = messageByKey.get(evidenceKey)
            if (!message) {
              throw new CustomerReviewStoreError('MISSING_EVIDENCE', 'customer review evidence is missing from the source window')
            }
            insertEvidence.run(
              id, sourceKey, evidenceKey, role, message.time, message.isFromMe ? 'me' : 'contact',
            )
          }
        }

        const ordered = [...input.messages].sort((a, b) => a.time.localeCompare(b.time))
        db.prepare(`
          UPDATE customer_reviews SET
            status = 'ready', source_message_count = ?, source_first_at = ?, source_last_at = ?,
            error_code = NULL, completed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
          input.messages.length,
          ordered[0]?.time ?? null,
          ordered.at(-1)?.time ?? null,
          ts, ts, id,
        )
      })()
    },

    async fail(id, errorCode) {
      requireReview(id)
      db.prepare(`
        UPDATE customer_reviews
        SET status = 'failed', error_code = ?, completed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(errorCode.slice(0, 100), now(), id)
    },

    async get(id) {
      const row = selectReview.get(id)
      return row ? hydrate(row) : null
    },

    async listByContact(contactId) {
      const rows = db.query<ReviewRow, [string]>(
        'SELECT * FROM customer_reviews WHERE contact_id = ? ORDER BY created_at DESC, rowid DESC',
      ).all(contactId)
      return rows.map(hydrate)
    },

    async listRecentContacts(limit) {
      return selectRecentContacts.all(Math.max(1, Math.min(Math.trunc(limit) || 1, 30))).map(row => ({
        contactId: row.contact_id,
        displayName: row.contact_display_name,
        reviewCount: row.review_count,
        lastReviewAt: row.last_review_at,
        lastStatus: row.last_status,
      }))
    },

    async reviewItem(id, sourceKey, input) {
      const review = requireReview(id)
      const corrected = input.correctedText?.trim()
      if (input.status === 'corrected' && !corrected) {
        throw new CustomerReviewStoreError('INVALID_FEEDBACK', 'corrected review items require corrected text')
      }
      if (input.status !== 'corrected' && corrected) {
        throw new CustomerReviewStoreError('INVALID_FEEDBACK', 'corrected text is only valid for corrected review items')
      }
      const ts = now()
      db.transaction(() => {
        const result = db.prepare(`
          UPDATE customer_review_items
          SET review_status = ?, corrected_text = ?, updated_at = ?
          WHERE review_id = ? AND source_key = ?
        `).run(input.status, corrected ?? null, ts, id, sourceKey)
        if ((result.changes ?? 0) === 0) {
          throw new CustomerReviewStoreError('REVIEW_ITEM_NOT_FOUND', 'customer review item was not found')
        }
        db.prepare(`
          INSERT INTO customer_review_feedback(contact_id, source_key, review_status, corrected_text, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(contact_id, source_key) DO UPDATE SET
            review_status = excluded.review_status,
            corrected_text = excluded.corrected_text,
            updated_at = excluded.updated_at
        `).run(review.contact_id, sourceKey, input.status, corrected ?? null, ts)
      })()
    },
  }
}
