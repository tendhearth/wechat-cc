import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { makeCustomerReviewStore } from './store'
import {
  CustomerReviewServiceError,
  makeCustomerReviewService,
  type CustomerReviewServiceDeps,
} from './service'
import type { CustomerChatSource, CustomerMessage } from './types'
import { CustomerChatSourceError } from './wxvault-source'

const CONTACT = { id: 'wxid_customer', displayName: '测试客户', kind: 'private' as const }
const COMMIT = '111111111111111111111111'

const MESSAGES: CustomerMessage[] = [{
  evidenceKey: COMMIT,
  conversationId: CONTACT.id,
  time: '2026-07-10T10:00:00',
  sender: '我',
  isFromMe: true,
  type: 'text',
  text: '我明天发送虚构报价单',
}]

describe('customer review application service', () => {
  let db: Db
  let nextId: number

  beforeEach(() => {
    db = openTestDb()
    nextId = 0
  })
  afterEach(() => db.close())

  function setup(overrides: Partial<CustomerReviewServiceDeps> = {}) {
    const searchContacts = vi.fn(async () => [CONTACT])
    const getMessages = vi.fn(async () => MESSAGES)
    const source: CustomerChatSource = { searchContacts, getMessages }
    const evaluate = vi.fn(async () => JSON.stringify({
      version: 1,
      commitments: [{
        commitment: '发送虚构报价单',
        status: 'open',
        dueDate: null,
        confidence: 'high',
        commitmentEvidenceKeys: [COMMIT],
        completionEvidenceKeys: [],
        dueDateEvidenceKey: null,
      }],
    }))
    const store = makeCustomerReviewStore(db, {
      now: () => '2026-07-15T10:00:00.000Z',
      id: () => `crv_service_${++nextId}`,
    })
    const service = makeCustomerReviewService({
      source,
      store,
      evaluate,
      provider: 'codex',
      model: 'test-model',
      ...overrides,
    })
    return { service, source, searchContacts, getMessages, evaluate, store }
  }

  async function create(service: ReturnType<typeof setup>['service']) {
    return service.createReview({ contact: CONTACT, rangeFrom: '2026-04-15', rangeTo: '2026-07-15' })
  }

  it('searches contacts but does not query wxvault for a blank search', async () => {
    const { service, searchContacts } = setup()
    expect(await service.searchContacts('  ')).toEqual([])
    expect(searchContacts).not.toHaveBeenCalled()
    expect(await service.searchContacts(' 测试 ')).toEqual([CONTACT])
    expect(searchContacts).toHaveBeenCalledWith('测试')
  })

  it('creates a queued task from trusted provider metadata, then runs the full pipeline', async () => {
    const { service, getMessages, evaluate } = setup({ messageLimit: 800 })
    const id = await create(service)
    expect(await service.getReview(id)).toMatchObject({
      status: 'queued',
      provider: 'codex',
      model: 'test-model',
      contactId: CONTACT.id,
    })

    const result = await service.runReview(id)
    expect(getMessages).toHaveBeenCalledWith({
      contactId: CONTACT.id,
      from: '2026-04-15',
      to: '2026-07-15',
      limit: 800,
    })
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      status: 'ready',
      sourceMessageCount: 1,
      items: [{ commitment: '发送虚构报价单', reviewStatus: 'unreviewed' }],
    })
  })

  it('reads original evidence text on demand without persisting it in the review', async () => {
    const { service, getMessages } = setup({ messageLimit: 800 })
    const id = await create(service)
    const review = await service.runReview(id)
    const sourceKey = review.items[0]!.sourceKey

    await expect(service.getEvidence(id, sourceKey)).resolves.toEqual([{
      evidenceKey: COMMIT,
      role: 'commitment',
      messageTime: '2026-07-10T10:00:00',
      senderSide: 'me',
      text: '我明天发送虚构报价单',
      messageType: 'text',
    }])
    expect(getMessages).toHaveBeenLastCalledWith({
      contactId: CONTACT.id,
      from: '2026-04-15',
      to: '2026-07-15',
      limit: 800,
    })
    expect(JSON.stringify(await service.getReview(id))).not.toContain(MESSAGES[0]!.text)
  })

  it('completes a non-text-only range with zero candidates without calling the model', async () => {
    const nonText = [{ ...MESSAGES[0]!, type: 'image', text: '' }]
    const getMessages = vi.fn(async () => nonText)
    const { service, evaluate } = setup({
      source: { searchContacts: async () => [], getMessages },
    })
    const id = await create(service)
    const result = await service.runReview(id)
    expect(result).toMatchObject({ status: 'ready', sourceMessageCount: 1, items: [] })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('rejects invalid contacts and ranges before creating a task', async () => {
    const { service } = setup()
    await expect(service.createReview({
      contact: { ...CONTACT, id: '' }, rangeFrom: '2026-04-15', rangeTo: '2026-07-15',
    })).rejects.toMatchObject({ code: 'INVALID_CONTACT' })
    await expect(service.createReview({
      contact: CONTACT, rangeFrom: '2026-07-16', rangeTo: '2026-07-15',
    })).rejects.toMatchObject({ code: 'INVALID_RANGE' })
    await expect(service.createReview({
      contact: CONTACT, rangeFrom: '2026-02-30', rangeTo: '2026-07-15',
    })).rejects.toMatchObject({ code: 'INVALID_RANGE' })
    expect(await service.listReviews(CONTACT.id)).toEqual([])
  })

  it('stores only a safe source error code and supports retrying the same task', async () => {
    let calls = 0
    const getMessages = vi.fn(async () => {
      calls++
      if (calls === 1) {
        throw new CustomerChatSourceError('WXVAULT_ERROR', 'private transport details and chat text')
      }
      return MESSAGES
    })
    const { service } = setup({ source: { searchContacts: async () => [], getMessages } })
    const id = await create(service)

    await expect(service.runReview(id)).rejects.toEqual(expect.objectContaining({
      name: 'CustomerReviewServiceError',
      code: 'SOURCE_WXVAULT_ERROR',
      reviewId: id,
    }))
    const failed = await service.getReview(id)
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'SOURCE_WXVAULT_ERROR' })
    expect(JSON.stringify(failed)).not.toContain('private transport details')

    expect(await service.runReview(id)).toMatchObject({ status: 'ready' })
  })

  it('turns invalid model output into a safe failed task', async () => {
    const { service } = setup({ evaluate: async () => 'raw private model output' })
    const id = await create(service)
    let thrown: unknown
    try {
      await service.runReview(id)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CustomerReviewServiceError)
    expect(thrown).toMatchObject({ code: 'AI_INVALID_MODEL_JSON', reviewId: id })
    expect(await service.getReview(id)).toMatchObject({ status: 'failed', errorCode: 'AI_INVALID_MODEL_JSON' })
    expect(JSON.stringify(await service.getReview(id))).not.toContain('raw private model output')
  })

  it('keeps a review usable when only a model evidence window is invalid', async () => {
    const invalidEvaluate = vi.fn(async () => JSON.stringify({
      version: 1,
      commitments: [{
        commitment: '发送虚构报价单', status: 'open', dueDate: null, confidence: 'high',
        commitmentEvidenceKeys: ['ffffffffffffffffffffffff'], completionEvidenceKeys: [], dueDateEvidenceKey: null,
      }],
    }))
    const { service } = setup({ evaluate: invalidEvaluate })
    const id = await create(service)
    const result = await service.runReview(id)
    expect(result).toMatchObject({ status: 'ready', items: [], analysisIssues: [{ windowIndex: 0, attempts: 2 }] })
    expect(invalidEvaluate).toHaveBeenCalledTimes(2)
  })

  it('returns the refreshed review after user feedback', async () => {
    const { service } = setup()
    const id = await create(service)
    const ready = await service.runReview(id)
    const updated = await service.reviewItem(id, ready.items[0]!.sourceKey, {
      status: 'corrected',
      correctedText: '发送修正后的虚构报价单',
    })
    expect(updated.items[0]).toMatchObject({
      reviewStatus: 'corrected',
      correctedText: '发送修正后的虚构报价单',
    })
  })

  it('does not turn an already completed task into failed when run is called again', async () => {
    const { service } = setup()
    const id = await create(service)
    await service.runReview(id)
    await expect(service.runReview(id)).rejects.toMatchObject({
      code: 'STORE_INVALID_REVIEW_TRANSITION',
      reviewId: id,
    })
    const unchanged = await service.getReview(id)
    expect(unchanged).toMatchObject({ status: 'ready' })
    expect(unchanged).not.toHaveProperty('errorCode')
  })
})
