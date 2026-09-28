import { describe, it, expect, vi } from 'vitest'
import { openTestDb } from '../../lib/db'
import { wrapCheapEvalWithAuthFailCheck, wireCoordinator } from './wire-coordinator'

describe('wrapCheapEvalWithAuthFailCheck', () => {
  it('null ⇒ undefined;auth-failed 文案 ⇒ 抛;正常文本原样回', async () => {
    expect(wrapCheapEvalWithAuthFailCheck(null, () => {})).toBeUndefined()
    const bad = wrapCheapEvalWithAuthFailCheck(async () => 'Not logged in · Please run /login', () => {})!
    await expect(bad('x')).rejects.toThrow()
    const ok = wrapCheapEvalWithAuthFailCheck(async () => 'fine', () => {})!
    await expect(ok('x')).resolves.toBe('fine')
  })
})

describe('wireCoordinator', () => {
  it('最小假件能构造:coordinator / sendAssistantText / 空的 anomalyNotes', () => {
    const log = vi.fn()
    const s = wireCoordinator(
      { ilink: { sendMessage: vi.fn(async () => ({ msgId: 'm' })) } as any, log, onTurnRecord: vi.fn() },
      { db: openTestDb() },
      {
        health: { onFailure: vi.fn(), onSuccess: vi.fn(), health: { get: () => ({}) } } as any,
        resolve: () => null,
        sessionManager: {} as any,
        conversationStore: {} as any,
        registry: { getCheapEval: () => null, getStrongEval: () => null } as any,
        defaultProviderId: 'claude',
        readAgentConfig: () => ({}) as any,
        permissionMode: 'strict',
        turnTimeoutMs: 1000,
      },
    )
    expect(s.coordinator).toBeDefined()
    expect(s.anomalyNotes.size).toBe(0)
    expect(typeof s.sendAssistantText).toBe('function')
  })
})
