import type { CommitmentEval } from './commitment-analyzer'
import { CommitmentAnalysisError } from './commitment-analyzer'
import { CommitmentValidationError } from './commitment-contract'
import { analyzeCommitmentRangeRecovering, CommitmentPipelineError, type CommitmentPipelineOptions } from './commitment-pipeline'
import type {
  CustomerReviewEvidenceDetail,
  CustomerReviewHistoryContact,
  CustomerReviewItemStatus,
  CustomerReviewRecord,
  CustomerReviewStore,
} from './store'
import { CustomerReviewStoreError } from './store'
import type { CustomerChatSource, CustomerContact } from './types'
import { CustomerChatSourceError } from './wxvault-source'

export interface CreateCustomerReviewRequest {
  contact: Pick<CustomerContact, 'id' | 'displayName' | 'kind'>
  rangeFrom: string
  rangeTo: string
}

export interface CustomerReviewService {
  searchContacts(query: string): Promise<CustomerContact[]>
  createReview(input: CreateCustomerReviewRequest): Promise<string>
  runReview(id: string): Promise<CustomerReviewRecord>
  getReview(id: string): Promise<CustomerReviewRecord | null>
  listReviews(contactId: string): Promise<CustomerReviewRecord[]>
  listRecentReviewContacts(): Promise<CustomerReviewHistoryContact[]>
  getEvidence(id: string, sourceKey: string): Promise<CustomerReviewEvidenceDetail[]>
  reviewItem(id: string, sourceKey: string, input: {
    status: Exclude<CustomerReviewItemStatus, 'unreviewed'>
    correctedText?: string
  }): Promise<CustomerReviewRecord>
}

export type CustomerReviewServiceErrorCode =
  | 'INVALID_CONTACT'
  | 'INVALID_RANGE'
  | 'REVIEW_NOT_FOUND'
  | 'INTERNAL_ERROR'
  | `SOURCE_${string}`
  | `AI_${string}`
  | `STORE_${string}`

export class CustomerReviewServiceError extends Error {
  constructor(
    readonly code: CustomerReviewServiceErrorCode,
    message: string,
    readonly reviewId?: string,
  ) {
    super(message)
    this.name = 'CustomerReviewServiceError'
  }
}

export interface CustomerReviewServiceDeps {
  source: CustomerChatSource
  store: CustomerReviewStore
  evaluate: CommitmentEval
  /** Trusted daemon configuration, never supplied by the application request. */
  provider: string
  model?: string
  messageLimit?: number
  pipelineOptions?: CommitmentPipelineOptions
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function validDate(value: string): boolean {
  const match = DATE_RE.exec(value)
  if (!match) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function safeRunError(error: unknown): { code: CustomerReviewServiceErrorCode; message: string } {
  if (error instanceof CustomerChatSourceError) {
    return { code: `SOURCE_${error.code}`, message: '无法读取所选客户的聊天记录' }
  }
  if (error instanceof CommitmentAnalysisError
    || error instanceof CommitmentValidationError
    || error instanceof CommitmentPipelineError) {
    return { code: `AI_${error.code}`, message: '客户回顾分析未能完成' }
  }
  if (error instanceof CustomerReviewStoreError) {
    return { code: `STORE_${error.code}`, message: '客户回顾结果未能保存' }
  }
  return { code: 'INTERNAL_ERROR', message: '客户回顾暂时无法完成' }
}

/**
 * Application boundary for Customer Review. It is deliberately unaware of
 * wxvault transport and model-provider construction; daemon wiring supplies
 * those dependencies once, while UI/API callers only pass product inputs.
 */
export function makeCustomerReviewService(deps: CustomerReviewServiceDeps): CustomerReviewService {
  return {
    async searchContacts(query) {
      const normalized = query.trim()
      if (!normalized) return []
      return deps.source.searchContacts(normalized)
    },

    async createReview(input) {
      const contactId = input.contact.id.trim()
      const displayName = input.contact.displayName.trim()
      if (!contactId || !displayName || input.contact.kind !== 'private') {
        throw new CustomerReviewServiceError('INVALID_CONTACT', '请选择一个有效的单聊联系人')
      }
      if (!validDate(input.rangeFrom) || !validDate(input.rangeTo) || input.rangeFrom > input.rangeTo) {
        throw new CustomerReviewServiceError('INVALID_RANGE', '请选择有效的客户回顾日期范围')
      }
      return deps.store.create({
        contactId,
        contactDisplayName: displayName,
        rangeFrom: input.rangeFrom,
        rangeTo: input.rangeTo,
        provider: deps.provider,
        ...(deps.model ? { model: deps.model } : {}),
      })
    },

    async runReview(id) {
      const review = await deps.store.get(id)
      if (!review) {
        throw new CustomerReviewServiceError('REVIEW_NOT_FOUND', '客户回顾任务不存在', id)
      }

      let enteredAnalyzing = false
      try {
        await deps.store.markAnalyzing(id)
        enteredAnalyzing = true
        const messages = await deps.source.getMessages({
          contactId: review.contactId,
          from: review.rangeFrom,
          to: review.rangeTo,
          ...(deps.messageLimit ? { limit: deps.messageLimit } : {}),
        })

        // A range containing only images/files is a valid completed review
        // with no extractable commitments, not an infrastructure failure.
        const analysis = messages.some(message => message.text.trim())
          ? await analyzeCommitmentRangeRecovering(messages, deps.evaluate, deps.pipelineOptions)
          : { extraction: { version: 1 as const, commitments: [] }, issues: [] }
        await deps.store.complete(id, {
          extraction: analysis.extraction,
          messages,
          analysisIssues: analysis.issues,
        })
        const completed = await deps.store.get(id)
        if (!completed) {
          throw new CustomerReviewStoreError('REVIEW_NOT_FOUND', 'customer review disappeared after completion')
        }
        return completed
      } catch (error) {
        const safe = safeRunError(error)
        if (enteredAnalyzing) {
          try {
            await deps.store.fail(id, safe.code)
          } catch {
            // Keep the original safe failure classification. A later repair
            // can reconcile a task stranded in `analyzing` from durable state.
          }
        }
        throw new CustomerReviewServiceError(safe.code, safe.message, id)
      }
    },

    getReview(id) {
      return deps.store.get(id)
    },

    listReviews(contactId) {
      return deps.store.listByContact(contactId.trim())
    },

    listRecentReviewContacts() {
      return deps.store.listRecentContacts(12)
    },

    async getEvidence(id, sourceKey) {
      const review = await deps.store.get(id)
      if (!review) {
        throw new CustomerReviewServiceError('REVIEW_NOT_FOUND', '客户回顾任务不存在', id)
      }
      const item = review.items.find(candidate => candidate.sourceKey === sourceKey)
      if (!item) {
        throw new CustomerReviewStoreError('REVIEW_ITEM_NOT_FOUND', 'customer review item was not found')
      }
      try {
        const messages = await deps.source.getMessages({
          contactId: review.contactId,
          from: review.rangeFrom,
          to: review.rangeTo,
          ...(deps.messageLimit ? { limit: deps.messageLimit } : {}),
        })
        const byKey = new Map(messages.map(message => [message.evidenceKey, message]))
        return item.evidence.flatMap(evidence => {
          const message = byKey.get(evidence.evidenceKey)
          return message ? [{ ...evidence, text: message.text, messageType: message.type }] : []
        })
      } catch (error) {
        if (error instanceof CustomerChatSourceError) {
          throw new CustomerReviewServiceError(`SOURCE_${error.code}`, '无法读取所选客户的聊天记录', id)
        }
        throw error
      }
    },

    async reviewItem(id, sourceKey, input) {
      await deps.store.reviewItem(id, sourceKey, input)
      const review = await deps.store.get(id)
      if (!review) {
        throw new CustomerReviewServiceError('REVIEW_NOT_FOUND', '客户回顾任务不存在', id)
      }
      return review
    },
  }
}
