import { describe, it, expect } from 'vitest'
import { openTestDb } from '../lib/db'
import { makePermissionDecisionsStore, DECISION_RETAIN_MS, type PermissionDecisionRow } from './permission-decisions-store'

const row = (over: Partial<Omit<PermissionDecisionRow, 'id'>> = {}): Omit<PermissionDecisionRow, 'id'> => ({
  at: 1_000, surface: 'terminal', provider: 'claude', project: '/w', tool: 'Bash', summary: 'npm test',
  verdict: 'allow', by: 'rule', ruleId: 'r1', reason: '规则放行', scope: 's1', ...over,
})

describe('permission decisions store', () => {
  it('records and reads back, newest first', () => {
    const s = makePermissionDecisionsStore(openTestDb())
    s.record(row({ at: 1 }))
    s.record(row({ at: 2, by: 'review', ruleId: null }))
    const got = s.since(0)
    expect(got.map(r => r.at)).toEqual([2, 1])
    expect(got[0]).toMatchObject({ by: 'review', ruleId: null, surface: 'terminal', verdict: 'allow', scope: 's1' })
  })
  it('redacts secrets and truncates the summary to 200', () => {
    const s = makePermissionDecisionsStore(openTestDb())
    s.record(row({ summary: 'curl -H "x: sk-ant-api03-abcdefghijklmnopqrstuvwxyz" localhost' }))
    s.record(row({ at: 2, summary: 'x'.repeat(500) }))
    const [secret, long] = s.since(0)
    expect(secret!.summary).not.toContain('abcdefghijklmnop')
    expect(secret!.summary).toContain('[已打码]')
    expect([...long!.summary].length).toBe(200)
  })
  it('countsSince counts allows only, split by rule / review', () => {
    const s = makePermissionDecisionsStore(openTestDb())
    s.record(row({ at: 10 }))
    s.record(row({ at: 11, by: 'review' }))
    s.record(row({ at: 12, by: 'review' }))
    s.record(row({ at: 13, verdict: 'deny' }))
    s.record(row({ at: 1 }))
    expect(s.countsSince(5)).toEqual({ rule: 1, review: 2 })
  })
  it('prune drops rows older than 30 days', () => {
    const s = makePermissionDecisionsStore(openTestDb())
    const now = 100 * 24 * 3600_000
    s.record(row({ at: now - DECISION_RETAIN_MS - 1 }))
    s.record(row({ at: now - 1000 }))
    expect(s.prune(now)).toBe(1)
    expect(s.since(0).length).toBe(1)
  })
})
