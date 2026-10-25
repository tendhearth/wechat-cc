import { describe, it, expect } from 'vitest'
import { compilePolicy, POLICY_TARGETS } from './policy'
import { TIER_PROFILES, type UserTier } from './user-tier'
import type { PermissionMode } from './permission-mode'

const TIERS: UserTier[] = ['admin', 'trusted', 'guest']
const MODES: PermissionMode[] = ['strict', 'dangerously']

describe('compilePolicy —— 档位 × 模式 → 每家执行者实际的设置,全表一处钉住', () => {
  // 全表快照(7 种连法 × 3 档 × 2 模式 = 42 格)。改了哪一格,快照的 diff 就在 PR 里摆着 —— 这是理念 1
  // 「推导关系由测试证明」:以前每家一个翻译函数各自有测试,哪一格整体长什么样从来没有一张表。
  it('the full table', () => {
    const table: Record<string, unknown> = {}
    for (const target of POLICY_TARGETS) for (const tier of TIERS) for (const mode of MODES) {
      table[`${target} / ${tier} / ${mode}`] = compilePolicy(target, TIER_PROFILES[tier], mode)
    }
    expect(table).toMatchSnapshot()
  })

  // 几条读得懂的不变式,不靠快照:dangerously 一律放开;strict 下访客 codex 只读。
  it('dangerously opens every target regardless of tier', () => {
    for (const tier of TIERS) {
      const tp = TIER_PROFILES[tier]
      expect(compilePolicy('claude', tp, 'dangerously').permissionMode).toBe('bypassPermissions')
      expect(compilePolicy('codex', tp, 'dangerously')).toMatchObject({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' })
      expect(compilePolicy('cursor-acp', tp, 'dangerously').answer).toBe('allow')
      expect(compilePolicy('cursor-sdk', tp, 'dangerously').sandboxOptions.enabled).toBe(false)
      expect(compilePolicy('openai', tp, 'dangerously').bypass).toBe(true)
      expect(compilePolicy('gemini', tp, 'dangerously').gateEnabled).toBe(false)
      expect(compilePolicy('agy', tp, 'dangerously').skipPermissions).toBe(true)
    }
  })
  it('strict: guest codex is read-only and offline; admin / trusted codex is workspace-write without per-command approval', () => {
    expect(compilePolicy('codex', TIER_PROFILES.guest, 'strict')).toMatchObject({ sandboxMode: 'read-only', approvalPolicy: 'untrusted', webSearchEnabled: false })
    for (const tier of ['admin', 'trusted'] as const) expect(compilePolicy('codex', TIER_PROFILES[tier], 'strict')).toMatchObject({ sandboxMode: 'workspace-write', approvalPolicy: 'never' })
  })
})
