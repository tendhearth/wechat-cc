import { describe, expect, it, vi } from 'vitest'
import type { CustomerReviewService } from '../customer-review/service'
import { CustomerReviewServiceError } from '../customer-review/service'
import { customerReviewRoutes } from './routes-customer-review'
import type { InternalApiDeps } from './types'

function review(status = 'ready') {
  return {
    id: 'crv_1', contactId: 'wxid_customer', contactDisplayName: '测试客户',
    rangeFrom: '2026-04-15', rangeTo: '2026-07-15', status,
    provider: 'codex', sourceMessageCount: 0,
    createdAt: '2026-07-15T10:00:00Z', updatedAt: '2026-07-15T10:00:00Z', items: [],
  } as never
}

function setup(overrides: Partial<CustomerReviewService> = {}) {
  const service: CustomerReviewService = {
    searchContacts: vi.fn(async () => []),
    createReview: vi.fn(async () => 'crv_1'),
    runReview: vi.fn(async () => review()),
    getReview: vi.fn(async () => review()),
    listReviews: vi.fn(async () => [review()]),
    listRecentReviewContacts: vi.fn(async () => []),
    getEvidence: vi.fn(async () => []),
    reviewItem: vi.fn(async () => review()),
    ...overrides,
  }
  const logs: string[] = []
  const deps = {
    stateDir: '/unused', daemonPid: 1, customerReview: service,
    log: (_tag: string, line: string) => logs.push(line),
  } satisfies InternalApiDeps
  return { service, routes: customerReviewRoutes(deps), logs }
}

describe('customer review internal API routes', () => {
  it('returns 503 while the optional daemon runtime is unavailable', async () => {
    const routes = customerReviewRoutes({ stateDir: '/unused', daemonPid: 1 })
    expect(await routes['GET /v1/customer-review/contacts']!(new URLSearchParams('query=x'), null))
      .toEqual({ status: 503, body: { error: 'customer_review_not_wired' } })
  })

  it('creates a task, returns immediately, and starts analysis in background', async () => {
    const { routes, service } = setup()
    const response = await routes['POST /v1/customer-review']!(new URLSearchParams(), {
      contact_id: 'wxid_customer', contact_display_name: '测试客户',
      range_from: '2026-04-15', range_to: '2026-07-15',
    })
    expect(response).toEqual({ status: 202, body: { id: 'crv_1', status: 'queued' } })
    await vi.waitFor(() => expect(service.runReview).toHaveBeenCalledWith('crv_1'))
  })

  it('serves contact search, one review, history, and refreshed item feedback', async () => {
    const { routes, service } = setup({
      searchContacts: vi.fn(async () => [{ id: 'wxid_customer', displayName: '测试客户', kind: 'private' as const }]),
    })
    expect(await routes['GET /v1/customer-review/contacts']!(new URLSearchParams('query=测试'), null))
      .toMatchObject({ status: 200, body: { contacts: [{ id: 'wxid_customer' }] } })
    expect(await routes['GET /v1/customer-review']!(new URLSearchParams('id=crv_1'), null))
      .toMatchObject({ status: 200, body: { review: { id: 'crv_1' } } })
    expect(await routes['GET /v1/customer-review/evidence']!(new URLSearchParams('id=crv_1&source_key=111111111111111111111111'), null))
      .toMatchObject({ status: 200, body: { evidence: [] } })
    expect(service.getEvidence).toHaveBeenCalledWith('crv_1', '111111111111111111111111')
    expect(await routes['GET /v1/customer-review/recent']!(new URLSearchParams(), null))
      .toMatchObject({ status: 200, body: { contacts: [] } })
    expect(service.listRecentReviewContacts).toHaveBeenCalledOnce()
    expect(await routes['GET /v1/customer-review/history']!(new URLSearchParams('contact_id=wxid_customer'), null))
      .toMatchObject({ status: 200, body: { reviews: [{ id: 'crv_1' }] } })
    expect(await routes['POST /v1/customer-review/item']!(new URLSearchParams(), {
      id: 'crv_1', source_key: '111111111111111111111111', status: 'confirmed',
    })).toMatchObject({ status: 200, body: { review: { id: 'crv_1' } } })
    expect(service.reviewItem).toHaveBeenCalledWith('crv_1', '111111111111111111111111', { status: 'confirmed' })
    expect(await routes['POST /v1/customer-review/item']!(new URLSearchParams(), {
      id: 'crv_1', source_key: '111111111111111111111111', status: 'completed_elsewhere',
    })).toMatchObject({ status: 200 })
    expect(service.reviewItem).toHaveBeenLastCalledWith('crv_1', '111111111111111111111111', { status: 'completed_elsewhere' })
  })

  it('returns safe errors without exposing private model details', async () => {
    const { routes } = setup({
      createReview: vi.fn(async () => {
        throw new CustomerReviewServiceError('INVALID_RANGE', '请选择有效的客户回顾日期范围')
      }),
    })
    const response = await routes['POST /v1/customer-review']!(new URLSearchParams(), {
      contact_id: 'wxid_customer', contact_display_name: '测试客户',
      range_from: '2026-07-16', range_to: '2026-07-15', private_payload: 'raw chat',
    })
    expect(response).toEqual({
      status: 400,
      body: { error: 'INVALID_RANGE', message: '请选择有效的客户回顾日期范围' },
    })
    expect(JSON.stringify(response)).not.toContain('raw chat')
  })

  it('does not relaunch an analyzing task and rejects an already ready task', async () => {
    const analyzing = setup({ getReview: vi.fn(async () => review('analyzing')) })
    expect(await analyzing.routes['POST /v1/customer-review/run']!(new URLSearchParams(), { id: 'crv_1' }))
      .toEqual({ status: 202, body: { id: 'crv_1', status: 'analyzing' } })
    expect(analyzing.service.runReview).not.toHaveBeenCalled()

    const ready = setup()
    expect(await ready.routes['POST /v1/customer-review/run']!(new URLSearchParams(), { id: 'crv_1' }))
      .toEqual({ status: 409, body: { error: 'REVIEW_ALREADY_READY' } })
  })
})
