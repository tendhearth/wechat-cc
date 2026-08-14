import { describe, expect, it } from 'vitest'
import type { CustomerMessage } from './types'
import {
  CommitmentValidationError,
  openCommitments,
  validateCommitmentExtraction,
} from './commitment-contract'

const MINE = '111111111111111111111111'
const THEIRS = '222222222222222222222222'
const DONE = '333333333333333333333333'

const MESSAGES: CustomerMessage[] = [
  {
    evidenceKey: MINE,
    conversationId: 'wxid_customer',
    time: '2026-07-12T14:32:00',
    sender: '我',
    isFromMe: true,
    type: 'text',
    text: '我周五前把新版报价发给你',
  },
  {
    evidenceKey: THEIRS,
    conversationId: 'wxid_customer',
    time: '2026-07-12T14:35:00',
    sender: '客户',
    isFromMe: false,
    type: 'text',
    text: '好的，等你新版',
  },
  {
    evidenceKey: DONE,
    conversationId: 'wxid_customer',
    time: '2026-07-14T09:00:00',
    sender: '客户',
    isFromMe: false,
    type: 'text',
    text: '新版报价收到了',
  },
]

function draft(overrides: Record<string, unknown> = {}) {
  return {
    commitment: '周五前发送新版报价',
    status: 'open',
    dueDate: '2026-07-17',
    confidence: 'high',
    commitmentEvidenceKeys: [MINE],
    completionEvidenceKeys: [],
    dueDateEvidenceKey: MINE,
    ...overrides,
  }
}

describe('validateCommitmentExtraction', () => {
  it('accepts a grounded owner commitment and assigns a deterministic id', () => {
    const raw = { version: 1, commitments: [draft()] }
    const first = validateCommitmentExtraction(raw, MESSAGES)
    const second = validateCommitmentExtraction(raw, MESSAGES)
    expect(first.commitments).toHaveLength(1)
    expect(first.commitments[0]?.id).toMatch(/^[a-f0-9]{24}$/)
    expect(first.commitments[0]?.id).toBe(second.commitments[0]?.id)
    expect(openCommitments(first)).toHaveLength(1)
  })

  it('allows an explicit action without a due date', () => {
    const result = validateCommitmentExtraction({
      version: 1,
      commitments: [draft({ dueDate: null, dueDateEvidenceKey: null })],
    }, MESSAGES)
    expect(result.commitments[0]).toMatchObject({ dueDate: null, status: 'open' })
  })

  it('retains a completed commitment but excludes it from the open list', () => {
    const result = validateCommitmentExtraction({
      version: 1,
      commitments: [draft({ status: 'completed', completionEvidenceKeys: [DONE] })],
    }, MESSAGES)
    expect(result.commitments[0]?.status).toBe('completed')
    expect(openCommitments(result)).toEqual([])
  })

  it('rejects unsupported uncertain status and low-confidence candidates', () => {
    expect(() => validateCommitmentExtraction({
      version: 1, commitments: [draft({ status: 'unclear' })],
    }, MESSAGES)).toMatchErrorCode('INVALID_AI_OUTPUT')
    expect(() => validateCommitmentExtraction({
      version: 1, commitments: [draft({ confidence: 'low' })],
    }, MESSAGES)).toMatchErrorCode('INVALID_AI_OUTPUT')
  })

  it('rejects standalone vague actions without an object or deliverable', () => {
    for (const commitment of ['我弄一下给你看', '我处理一下', '回头看看', '我确认一下']) {
      expect(() => validateCommitmentExtraction({
        version: 1, commitments: [draft({ commitment, dueDate: null, dueDateEvidenceKey: null })],
      }, MESSAGES)).toMatchErrorCode('INVALID_AI_OUTPUT')
    }
    expect(() => validateCommitmentExtraction({
      version: 1,
      commitments: [draft({
        commitment: '修改报价单后发给客户确认', dueDate: null, dueDateEvidenceKey: null,
      })],
    }, MESSAGES)).not.toThrow()
  })

  it('rejects missing, invented, or contact-authored commitment evidence', () => {
    expect(() => validateCommitmentExtraction({
      version: 1, commitments: [draft({ commitmentEvidenceKeys: [] })],
    }, MESSAGES)).toMatchErrorCode('INVALID_AI_OUTPUT')
    expect(() => validateCommitmentExtraction({
      version: 1, commitments: [draft({
        commitmentEvidenceKeys: ['aaaaaaaaaaaaaaaaaaaaaaaa'],
        dueDateEvidenceKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      })],
    }, MESSAGES)).toMatchErrorCode('UNKNOWN_EVIDENCE')
    expect(() => validateCommitmentExtraction({
      version: 1, commitments: [draft({ commitmentEvidenceKeys: [THEIRS], dueDateEvidenceKey: THEIRS })],
    }, MESSAGES)).toMatchErrorCode('COMMITMENT_NOT_OWNER_AUTHORED')
  })

  it('requires completion evidence only for completed commitments', () => {
    expect(() => validateCommitmentExtraction({
      version: 1, commitments: [draft({ status: 'completed' })],
    }, MESSAGES)).toMatchErrorCode('INVALID_AI_OUTPUT')
    expect(() => validateCommitmentExtraction({
      version: 1, commitments: [draft({ completionEvidenceKeys: [DONE] })],
    }, MESSAGES)).toMatchErrorCode('INVALID_AI_OUTPUT')
  })

  it('requires an explicit date evidence key when dueDate is present', () => {
    expect(() => validateCommitmentExtraction({
      version: 1, commitments: [draft({ dueDateEvidenceKey: null })],
    }, MESSAGES)).toMatchErrorCode('INVALID_AI_OUTPUT')
    expect(() => validateCommitmentExtraction({
      version: 1, commitments: [draft({ dueDateEvidenceKey: THEIRS })],
    }, MESSAGES)).toMatchErrorCode('INVALID_AI_OUTPUT')
  })

  it('requires textual owner evidence and rejects duplicate commitments', () => {
    const emptyOwner = [{ ...MESSAGES[0]!, text: '' }, ...MESSAGES.slice(1)]
    expect(() => validateCommitmentExtraction({ version: 1, commitments: [draft()] }, emptyOwner))
      .toMatchErrorCode('EMPTY_COMMITMENT_EVIDENCE')
    expect(() => validateCommitmentExtraction({ version: 1, commitments: [draft(), draft()] }, MESSAGES))
      .toMatchErrorCode('DUPLICATE_COMMITMENT')
  })

  it('never includes raw AI payload or private messages in validation errors', () => {
    const sensitive = '真实聊天正文不应出现在异常中'
    try {
      validateCommitmentExtraction({ sensitive }, MESSAGES)
      throw new Error('expected validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(CommitmentValidationError)
      expect(String(error)).not.toContain(sensitive)
      expect(String(error)).not.toContain(MESSAGES[0]!.text)
    }
  })
})

declare module 'vitest' {
  interface Assertion<T = any> {
    toMatchErrorCode(code: string): T
  }
}

expect.extend({
  toMatchErrorCode(received: unknown, expected: string) {
    if (typeof received !== 'function') {
      return { pass: false, message: () => 'expected a function' }
    }
    try {
      received()
      return { pass: false, message: () => `expected function to throw ${expected}` }
    } catch (error) {
      const actual = error instanceof CommitmentValidationError ? error.code : undefined
      return {
        pass: actual === expected,
        message: () => `expected error code ${expected}, received ${String(actual)}`,
      }
    }
  },
})
