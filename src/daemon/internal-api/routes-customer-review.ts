import type { InternalApiDeps, RouteTable } from './types'
import type {
  CustomerReviewCreateRequestT,
  CustomerReviewIdRequestT,
  CustomerReviewItemRequestT,
} from './schema'
import { CustomerReviewServiceError } from '../customer-review/service'
import { CustomerReviewStoreError } from '../customer-review/store'

function handledError(error: unknown): { status: number; body: unknown } {
  if (error instanceof CustomerReviewServiceError) {
    const status = error.code === 'REVIEW_NOT_FOUND' ? 404
      : error.code === 'INVALID_CONTACT' || error.code === 'INVALID_RANGE' ? 400
      : error.code === 'STORE_INVALID_REVIEW_TRANSITION' ? 409
      : 500
    return { status, body: { error: error.code, message: error.message, ...(error.reviewId ? { review_id: error.reviewId } : {}) } }
  }
  if (error instanceof CustomerReviewStoreError) {
    const status = error.code === 'REVIEW_NOT_FOUND' || error.code === 'REVIEW_ITEM_NOT_FOUND' ? 404
      : error.code === 'INVALID_FEEDBACK' ? 400
      : 409
    return { status, body: { error: `STORE_${error.code}` } }
  }
  return { status: 500, body: { error: 'INTERNAL_ERROR' } }
}

/** Owner-only HTTP facade. Raw wxvault/model payloads never cross this layer. */
export function customerReviewRoutes(deps: InternalApiDeps): RouteTable {
  const inFlight = new Set<string>()

  function launch(id: string): void {
    if (!deps.customerReview || inFlight.has(id)) return
    inFlight.add(id)
    // busy-registry hold (spec 2026-08-11 §2, Task 4 step 2) — this is a
    // fire-and-forget task outside SessionManager; hold a token for its
    // whole run so the idle self-restart check doesn't kill a review
    // mid-flight. Released at the same point inFlight is cleared.
    let releaseBusy: (() => void) | undefined
    try { releaseBusy = deps.holdBusy?.('customer-review') } catch { releaseBusy = undefined }
    // M1 (code review, 2026-08-11): this used to call
    // `deps.customerReview.runReview(id)` directly and chain `.catch()` off
    // its return value — relying on runReview happening to be an async
    // function (so a throw becomes a rejection, not a synchronous throw).
    // Of the four Task-4 hold points, this was the only one NOT defended
    // against a synchronous throw: a sync throw here would escape `launch()`
    // before `.catch()`/`.finally()` ever attach, leaking BOTH the
    // `inFlight` entry and the busy-registry token forever. Wrapping the
    // call itself in `Promise.resolve().then(...)` routes a synchronous
    // throw through the same rejection path as an async one, so `.catch`/
    // `.finally` below always run — same posture as delegate.ts/wire-social.ts's
    // hold points, which don't call user code synchronously in the holder's
    // own stack frame at all.
    void Promise.resolve().then(() => deps.customerReview!.runReview(id))
      .catch(error => {
        const safe = handledError(error)
        deps.log?.('CUSTOMER_REVIEW', `task ${id} failed: ${(safe.body as { error?: string }).error ?? 'INTERNAL_ERROR'}`)
      })
      .finally(() => {
        inFlight.delete(id)
        try { releaseBusy?.() } catch { /* release 幂等且不抛,防御性 */ }
      })
  }

  return {
    'GET /v1/customer-review/contacts': async q => {
      if (!deps.customerReview) return { status: 503, body: { error: 'customer_review_not_wired' } }
      try {
        return { status: 200, body: { contacts: await deps.customerReview.searchContacts(q.get('query') ?? '') } }
      } catch (error) {
        return handledError(error)
      }
    },

    'POST /v1/customer-review': async (_q, body) => {
      if (!deps.customerReview) return { status: 503, body: { error: 'customer_review_not_wired' } }
      const input = body as CustomerReviewCreateRequestT
      try {
        const id = await deps.customerReview.createReview({
          contact: {
            id: input.contact_id,
            displayName: input.contact_display_name,
            kind: 'private',
          },
          rangeFrom: input.range_from,
          rangeTo: input.range_to,
        })
        launch(id)
        return { status: 202, body: { id, status: 'queued' } }
      } catch (error) {
        return handledError(error)
      }
    },

    'POST /v1/customer-review/run': async (_q, body) => {
      if (!deps.customerReview) return { status: 503, body: { error: 'customer_review_not_wired' } }
      const { id } = body as CustomerReviewIdRequestT
      try {
        const review = await deps.customerReview.getReview(id)
        if (!review) return { status: 404, body: { error: 'REVIEW_NOT_FOUND' } }
        if (review.status === 'ready') return { status: 409, body: { error: 'REVIEW_ALREADY_READY' } }
        if (review.status === 'analyzing' || inFlight.has(id)) {
          return { status: 202, body: { id, status: 'analyzing' } }
        }
        launch(id)
        return { status: 202, body: { id, status: review.status } }
      } catch (error) {
        return handledError(error)
      }
    },

    'GET /v1/customer-review': async q => {
      if (!deps.customerReview) return { status: 503, body: { error: 'customer_review_not_wired' } }
      try {
        const review = await deps.customerReview.getReview(q.get('id') ?? '')
        return review
          ? { status: 200, body: { review } }
          : { status: 404, body: { error: 'REVIEW_NOT_FOUND' } }
      } catch (error) {
        return handledError(error)
      }
    },

    'GET /v1/customer-review/evidence': async q => {
      if (!deps.customerReview) return { status: 503, body: { error: 'customer_review_not_wired' } }
      try {
        return {
          status: 200,
          body: { evidence: await deps.customerReview.getEvidence(q.get('id') ?? '', q.get('source_key') ?? '') },
        }
      } catch (error) {
        return handledError(error)
      }
    },

    'GET /v1/customer-review/recent': async () => {
      if (!deps.customerReview) return { status: 503, body: { error: 'customer_review_not_wired' } }
      try {
        return { status: 200, body: { contacts: await deps.customerReview.listRecentReviewContacts() } }
      } catch (error) {
        return handledError(error)
      }
    },

    'GET /v1/customer-review/history': async q => {
      if (!deps.customerReview) return { status: 503, body: { error: 'customer_review_not_wired' } }
      try {
        return { status: 200, body: { reviews: await deps.customerReview.listReviews(q.get('contact_id') ?? '') } }
      } catch (error) {
        return handledError(error)
      }
    },

    'POST /v1/customer-review/item': async (_q, body) => {
      if (!deps.customerReview) return { status: 503, body: { error: 'customer_review_not_wired' } }
      const input = body as CustomerReviewItemRequestT
      try {
        const review = await deps.customerReview.reviewItem(input.id, input.source_key, {
          status: input.status,
          ...(input.corrected_text !== undefined ? { correctedText: input.corrected_text } : {}),
        })
        return { status: 200, body: { review } }
      } catch (error) {
        return handledError(error)
      }
    },
  }
}
