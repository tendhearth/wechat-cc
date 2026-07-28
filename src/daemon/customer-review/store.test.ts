import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import type { CustomerMessage } from './types'
import type { GroundedCommitmentExtraction } from './commitment-contract'
import { CustomerReviewStoreError, customerReviewSourceKey, makeCustomerReviewStore } from './store'

const COMMIT = '111111111111111111111111'
const DONE = '222222222222222222222222'

const MESSAGES: CustomerMessage[] = [
  {
    evidenceKey: COMMIT,
    conversationId: 'wxid_customer',
    time: '2026-07-10T10:00:00',
    sender: '我',
    isFromMe: true,
    type: 'text',
    text: '虚构承诺正文，仅用于测试',
  },
  {
    evidenceKey: DONE,
    conversationId: 'wxid_customer',
    time: '2026-07-11T10:00:00',
    sender: '客户',
    isFromMe: false,
    type: 'text',
    text: '虚构完成证据，仅用于测试',
  },
]

function extraction(overrides: Partial<GroundedCommitmentExtraction['commitments'][number]> = {}): GroundedCommitmentExtraction {
  return {
    version: 1,
    commitments: [{
      id: 'model-id-not-persisted-as-source-key',
      commitment: '发送虚构报价单',
      status: 'open',
      dueDate: null,
      confidence: 'high',
      commitmentEvidenceKeys: [COMMIT],
      completionEvidenceKeys: [],
      dueDateEvidenceKey: null,
      ...overrides,
    }],
  }
}

describe('customer review store', () => {
  let db: Db
  let tick: number
  let id: number

  beforeEach(() => {
    db = openTestDb()
    tick = 0
    id = 0
  })
  afterEach(() => db.close())

  function store() {
    return makeCustomerReviewStore(db, {
      now: () => `2026-07-15T10:00:0${tick++}.000Z`,
      id: () => `crv_test_${++id}`,
    })
  }

  async function createAnalyzing(s = store()): Promise<{ store: ReturnType<typeof store>; reviewId: string }> {
    const reviewId = await s.create({
      contactId: 'wxid_customer',
      contactDisplayName: '测试客户',
      rangeFrom: '2026-04-15',
      rangeTo: '2026-07-15',
      provider: 'codex',
      model: 'test-model',
    })
    await s.markAnalyzing(reviewId)
    return { store: s, reviewId }
  }

  it('creates a queued review and completes a valid zero-result review', async () => {
    const { store: s, reviewId } = await createAnalyzing()
    await s.complete(reviewId, { extraction: { version: 1, commitments: [] }, messages: MESSAGES })
    const review = await s.get(reviewId)
    expect(review).toMatchObject({
      id: reviewId,
      status: 'ready',
      provider: 'codex',
      model: 'test-model',
      sourceMessageCount: 2,
      sourceFirstAt: '2026-07-10T10:00:00',
      sourceLastAt: '2026-07-11T10:00:00',
      items: [],
    })
  })

  it('stores candidates and evidence metadata without copying message text', async () => {
    const { store: s, reviewId } = await createAnalyzing()
    await s.complete(reviewId, { extraction: extraction(), messages: MESSAGES })
    const review = await s.get(reviewId)
    const sourceKey = customerReviewSourceKey([COMMIT])
    expect(review?.items[0]).toMatchObject({
      sourceKey,
      commitment: '发送虚构报价单',
      aiStatus: 'open',
      confidence: 'high',
      reviewStatus: 'unreviewed',
      evidence: [{ evidenceKey: COMMIT, role: 'commitment', messageTime: '2026-07-10T10:00:00', senderSide: 'me' }],
    })
    const columns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('customer_review_evidence')").all()
    expect(columns.map(column => column.name)).not.toContain('text')
    expect(JSON.stringify(review)).not.toContain(MESSAGES[0]!.text)
  })

  it('persists safe coverage metadata for a skipped analysis window', async () => {
    const { store: s, reviewId } = await createAnalyzing()
    await s.complete(reviewId, {
      extraction: extraction(),
      messages: MESSAGES,
      analysisIssues: [{
        windowIndex: 2,
        from: '2026-07-12T10:00:00',
        to: '2026-07-13T10:00:00',
        errorCode: 'INVALID_AI_OUTPUT',
        attempts: 2,
      }],
    })
    expect((await s.get(reviewId))?.analysisIssues).toEqual([{
      windowIndex: 2,
      rangeFrom: '2026-07-12T10:00:00',
      rangeTo: '2026-07-13T10:00:00',
      attempts: 2,
    }])
    expect(JSON.stringify(await s.get(reviewId))).not.toContain('INVALID_AI_OUTPUT')
  })

  it('persists corrected feedback and overlays it onto a later review', async () => {
    const s = store()
    const first = await createAnalyzing(s)
    await s.complete(first.reviewId, { extraction: extraction(), messages: MESSAGES })
    const sourceKey = customerReviewSourceKey([COMMIT])
    await s.reviewItem(first.reviewId, sourceKey, {
      status: 'corrected',
      correctedText: '发送修改后的虚构报价单',
    })

    const second = await createAnalyzing(s)
    await s.complete(second.reviewId, {
      extraction: extraction({ commitment: '模型重新措辞的报价承诺' }),
      messages: MESSAGES,
    })
    expect((await s.get(second.reviewId))?.items[0]).toMatchObject({
      commitment: '模型重新措辞的报价承诺',
      reviewStatus: 'corrected',
      correctedText: '发送修改后的虚构报价单',
    })
  })

  it('persists completion through another channel without pretending WeChat proved it', async () => {
    const s = store()
    const first = await createAnalyzing(s)
    await s.complete(first.reviewId, { extraction: extraction(), messages: MESSAGES })
    const sourceKey = customerReviewSourceKey([COMMIT])
    await s.reviewItem(first.reviewId, sourceKey, { status: 'completed_elsewhere' })
    expect((await s.get(first.reviewId))?.items[0]).toMatchObject({
      aiStatus: 'open',
      reviewStatus: 'completed_elsewhere',
    })

    const second = await createAnalyzing(s)
    await s.complete(second.reviewId, { extraction: extraction(), messages: MESSAGES })
    expect((await s.get(second.reviewId))?.items[0]).toMatchObject({
      aiStatus: 'open',
      reviewStatus: 'completed_elsewhere',
    })
  })

  it('does not overwrite reviewed feedback when the same review is completed again', async () => {
    const { store: s, reviewId } = await createAnalyzing()
    await s.complete(reviewId, { extraction: extraction(), messages: MESSAGES })
    const sourceKey = customerReviewSourceKey([COMMIT])
    await s.reviewItem(reviewId, sourceKey, { status: 'rejected' })
    // Simulate an explicit re-run of the same task.
    db.prepare("UPDATE customer_reviews SET status='analyzing' WHERE id=?").run(reviewId)
    await s.complete(reviewId, {
      extraction: extraction({ commitment: '模型的新措辞' }),
      messages: MESSAGES,
    })
    expect((await s.get(reviewId))?.items[0]).toMatchObject({
      commitment: '模型的新措辞',
      reviewStatus: 'rejected',
    })
  })

  it('validates feedback shape and missing items', async () => {
    const { store: s, reviewId } = await createAnalyzing()
    await s.complete(reviewId, { extraction: extraction(), messages: MESSAGES })
    const sourceKey = customerReviewSourceKey([COMMIT])
    await expect(s.reviewItem(reviewId, sourceKey, { status: 'corrected' }))
      .rejects.toMatchObject({ code: 'INVALID_FEEDBACK' })
    await expect(s.reviewItem(reviewId, sourceKey, { status: 'confirmed', correctedText: '不允许' }))
      .rejects.toMatchObject({ code: 'INVALID_FEEDBACK' })
    await expect(s.reviewItem(reviewId, 'missing', { status: 'confirmed' }))
      .rejects.toMatchObject({ code: 'REVIEW_ITEM_NOT_FOUND' })
  })

  it('fails safely with a bounded error code and supports retry', async () => {
    const s = store()
    const reviewId = await s.create({
      contactId: 'wxid_customer', contactDisplayName: '测试客户',
      rangeFrom: '2026-04-15', rangeTo: '2026-07-15', provider: 'codex',
    })
    await s.fail(reviewId, 'MODEL_UNAVAILABLE_WITH_PRIVATE_DETAILS'.repeat(10))
    const failed = await s.get(reviewId)
    expect(failed?.status).toBe('failed')
    expect(failed?.errorCode?.length).toBeLessThanOrEqual(100)
    await s.markAnalyzing(reviewId)
    expect((await s.get(reviewId))?.status).toBe('analyzing')
  })

  it('enforces lifecycle transitions and rolls back missing evidence atomically', async () => {
    const s = store()
    const reviewId = await s.create({
      contactId: 'wxid_customer', contactDisplayName: '测试客户',
      rangeFrom: '2026-04-15', rangeTo: '2026-07-15', provider: 'codex',
    })
    await expect(s.complete(reviewId, { extraction: extraction(), messages: MESSAGES }))
      .rejects.toBeInstanceOf(CustomerReviewStoreError)
    await s.markAnalyzing(reviewId)
    await expect(s.complete(reviewId, { extraction: extraction(), messages: [] }))
      .rejects.toMatchObject({ code: 'MISSING_EVIDENCE' })
    expect((await s.get(reviewId))?.status).toBe('analyzing')
    expect((await s.get(reviewId))?.items).toEqual([])
  })

  it('lists review history by stable contact id in newest-first order', async () => {
    const s = store()
    await createAnalyzing(s)
    await createAnalyzing(s)
    const list = await s.listByContact('wxid_customer')
    expect(list.map(review => review.id)).toEqual(['crv_test_2', 'crv_test_1'])
    expect(await s.listByContact('wxid_other')).toEqual([])
  })

  it('lists previously reviewed contacts once, newest first, with their review count', async () => {
    const s = store()
    const first = await s.create({
      contactId: 'wxid_customer', contactDisplayName: '客户甲',
      rangeFrom: '2026-04-15', rangeTo: '2026-07-15', provider: 'codex',
    })
    const second = await s.create({
      contactId: 'wxid_other', contactDisplayName: '客户乙',
      rangeFrom: '2026-04-15', rangeTo: '2026-07-15', provider: 'codex',
    })
    await s.create({
      contactId: 'wxid_customer', contactDisplayName: '客户甲的新名称',
      rangeFrom: '2026-04-15', rangeTo: '2026-07-15', provider: 'codex',
    })

    expect(await s.listRecentContacts(12)).toEqual([
      { contactId: 'wxid_customer', displayName: '客户甲的新名称', reviewCount: 2, lastReviewAt: '2026-07-15T10:00:02.000Z', lastStatus: 'queued' },
      { contactId: 'wxid_other', displayName: '客户乙', reviewCount: 1, lastReviewAt: '2026-07-15T10:00:01.000Z', lastStatus: 'queued' },
    ])
    expect(first).toBe('crv_test_1')
    expect(second).toBe('crv_test_2')
  })

  it('reclaims reviews stranded in analyzing by a restart', async () => {
    // A run is minutes of in-memory LLM calls; a restart mid-run left the row
    // in `analyzing` with nobody working on it, and markAnalyzing only accepts
    // queued/failed — so 分析中 was permanent and 重新分析 always errored.
    const store = makeCustomerReviewStore(db)
    const id = await store.create({
      contactId: 'wxid_customer', contactDisplayName: '测试客户',
      rangeFrom: '2026-04-15', rangeTo: '2026-07-15', provider: 'claude',
    })
    await store.markAnalyzing(id)
    expect(await store.get(id)).toMatchObject({ status: 'analyzing' })

    expect(await store.reclaimStranded()).toBe(1)
    expect(await store.get(id)).toMatchObject({ status: 'failed', errorCode: 'INTERRUPTED_BY_RESTART' })

    // …and the row is workable again, which is the whole point.
    await store.markAnalyzing(id)
    expect(await store.get(id)).toMatchObject({ status: 'analyzing' })

    // No-op when nothing is stranded.
    await store.fail(id, 'X')
    expect(await store.reclaimStranded()).toBe(0)
  })
})
