import { describe, expect, it, vi } from 'vitest'
import type { CustomerMessage } from './types'
import {
  CommitmentPipelineError,
  analyzeCommitmentRange,
  analyzeCommitmentRangeRecovering,
  chunkCommitmentMessages,
  mergeCommitmentExtractions,
} from './commitment-pipeline'
import type { GroundedCommitmentExtraction } from './commitment-contract'
import { openCommitments } from './commitment-contract'

function key(index: number): string {
  return index.toString(16).padStart(24, '0')
}

function message(index: number, overrides: Partial<CustomerMessage> = {}): CustomerMessage {
  const day = 1 + Math.floor(index / 10)
  const minute = index % 60
  return {
    evidenceKey: key(index),
    conversationId: 'wxid_customer',
    time: `2026-06-${String(day).padStart(2, '0')}T10:${String(minute).padStart(2, '0')}:00`,
    sender: index % 2 === 0 ? '我' : '客户',
    isFromMe: index % 2 === 0,
    type: 'text',
    text: `普通消息 ${index}`,
    ...overrides,
  }
}

function extraction(overrides: Partial<GroundedCommitmentExtraction['commitments'][number]> = {}): GroundedCommitmentExtraction {
  return {
    version: 1,
    commitments: [{
      id: 'old-id',
      commitment: '发送新版报价',
      status: 'open',
      dueDate: null,
      confidence: 'medium',
      commitmentEvidenceKeys: [key(0)],
      completionEvidenceKeys: [],
      dueDateEvidenceKey: null,
      ...overrides,
    }],
  }
}

describe('chunkCommitmentMessages', () => {
  it('creates chronological overlapping windows without losing the tail', () => {
    const messages = Array.from({ length: 350 }, (_, index) => message(index))
    const windows = chunkCommitmentMessages(messages, { windowSize: 160, overlap: 20 })
    expect(windows.map(window => window.length)).toEqual([160, 160, 70])
    expect(windows[0]?.at(-1)?.evidenceKey).toBe(windows[1]?.[19]?.evidenceKey)
    expect(windows[1]?.at(-1)?.evidenceKey).toBe(windows[2]?.[19]?.evidenceKey)
    expect(windows.at(-1)?.at(-1)?.evidenceKey).toBe(key(349))
  })

  it('rejects unsafe window configurations', () => {
    const messages = [message(0)]
    expect(() => chunkCommitmentMessages(messages, { windowSize: 201 })).toThrow(CommitmentPipelineError)
    expect(() => chunkCommitmentMessages(messages, { windowSize: 20, overlap: 20 })).toThrow(/configuration/)
  })
})

describe('mergeCommitmentExtractions', () => {
  it('keeps two promises made in ONE message apart', () => {
    // "我明天把方案发你，周五前把合同寄出" — ordinary sales chat. Both
    // candidates cite the same evidence key, and matching on the key alone
    // merged them so the first promise vanished with no issue recorded
    // (reproduced against the real pipeline, 2026-07-28 review).
    const proposal = extraction({ id: 'a', commitment: '把方案发给客户' })
    const contract = extraction({ id: 'b', commitment: '把合同寄给客户' })
    const merged = mergeCommitmentExtractions(proposal, contract)
    expect(merged.commitments.map(c => c.commitment)).toEqual(['把方案发给客户', '把合同寄给客户'])
  })

  it('still merges one promise reworded across overlapping windows', () => {
    const first = extraction({ id: 'a', commitment: '发送新版报价' })
    const reworded = extraction({ id: 'b', commitment: '把新版报价发送给客户' })
    expect(mergeCommitmentExtractions(first, reworded).commitments).toHaveLength(1)
  })


  it('merges candidates sharing commitment evidence and lets completed win', () => {
    const result = mergeCommitmentExtractions(extraction(), extraction({
      id: 'new-id',
      commitment: '把新版报价发送给客户',
      status: 'completed',
      confidence: 'high',
      completionEvidenceKeys: [key(204)],
    }))
    expect(result.commitments).toHaveLength(1)
    expect(result.commitments[0]).toMatchObject({
      status: 'completed',
      confidence: 'high',
      completionEvidenceKeys: [key(204)],
      commitment: '把新版报价发送给客户',
    })
    expect(result.commitments[0]?.id).toMatch(/^[a-f0-9]{24}$/)
  })

  it('keeps unrelated commitments separate', () => {
    const result = mergeCommitmentExtractions(extraction(), extraction({
      id: 'another', commitment: '确认合同', commitmentEvidenceKeys: [key(10)],
    }))
    expect(result.commitments).toHaveLength(2)
  })
})

describe('analyzeCommitmentRange', () => {
  it('carries early open evidence into a later window and resolves distant completion', async () => {
    const messages = Array.from({ length: 205 }, (_, index) => message(index))
    messages[0] = message(0, { text: '我会发送新版报价', isFromMe: true, sender: '我' })
    messages[204] = message(204, { text: '新版报价收到了', isFromMe: false, sender: '客户' })

    const evaluate = vi.fn(async (prompt: string) => {
      const hasCommitment = prompt.includes(`[${key(0)}]`)
      const hasCompletion = prompt.includes(`[${key(204)}]`)
      if (!hasCommitment) return '{"version":1,"commitments":[]}'
      return JSON.stringify({
        version: 1,
        commitments: [{
          commitment: '发送新版报价',
          status: hasCompletion ? 'completed' : 'open',
          dueDate: null,
          confidence: 'high',
          commitmentEvidenceKeys: [key(0)],
          completionEvidenceKeys: hasCompletion ? [key(204)] : [],
          dueDateEvidenceKey: null,
        }],
      })
    })

    const result = await analyzeCommitmentRange(messages, evaluate)
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(result.commitments).toHaveLength(1)
    expect(result.commitments[0]?.status).toBe('completed')
    expect(openCommitments(result)).toEqual([])
    expect(evaluate.mock.calls[1]?.[0]).toContain(`[${key(0)}]`)
    expect(evaluate.mock.calls[1]?.[0]).toContain(`[${key(204)}]`)
  })

  it('deduplicates the same open commitment extracted from overlapping windows', async () => {
    const messages = Array.from({ length: 180 }, (_, index) => message(index))
    messages[170] = message(170, { text: '我会确认合同', isFromMe: true, sender: '我' })
    const evaluate = vi.fn(async (prompt: string) => JSON.stringify({
      version: 1,
      commitments: prompt.includes(`[${key(150)}]`) ? [{
        commitment: '确认合同', status: 'open', dueDate: null, confidence: 'medium',
        commitmentEvidenceKeys: [key(150)], completionEvidenceKeys: [], dueDateEvidenceKey: null,
      }] : [],
    }))
    const result = await analyzeCommitmentRange(messages, evaluate)
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(result.commitments).toHaveLength(1)
  })

  it('retries only an invalid window and preserves grounded results from the other windows', async () => {
    const messages = Array.from({ length: 180 }, (_, index) => message(index))
    messages[0] = message(0, { text: '我会发送新版报价', isFromMe: true, sender: '我' })
    messages[150] = message(150, { text: '我会确认合同', isFromMe: true, sender: '我' })
    const evaluate = vi.fn(async (prompt: string) => {
      if (prompt.includes(`[${key(170)}]`)) {
        return JSON.stringify({
          version: 1,
          commitments: [{
            commitment: '确认合同', status: 'open', dueDate: null, confidence: 'medium',
            commitmentEvidenceKeys: ['ffffffffffffffffffffffff'], completionEvidenceKeys: [], dueDateEvidenceKey: null,
          }],
        })
      }
      return JSON.stringify({
        version: 1,
        commitments: [{
          commitment: '发送新版报价', status: 'open', dueDate: null, confidence: 'high',
          commitmentEvidenceKeys: [key(0)], completionEvidenceKeys: [], dueDateEvidenceKey: null,
        }],
      })
    })

    const result = await analyzeCommitmentRangeRecovering(messages, evaluate)
    expect(result.extraction.commitments).toHaveLength(1)
    expect(result.extraction.commitments[0]?.commitment).toBe('发送新版报价')
    expect(result.issues).toEqual([expect.objectContaining({ windowIndex: 1, attempts: 2, errorCode: 'UNKNOWN_EVIDENCE' })])
    expect(evaluate).toHaveBeenCalledTimes(3)
    expect(evaluate.mock.calls[2]?.[0]).toContain('上一次输出没有通过格式或聊天依据校验')
  })
})
