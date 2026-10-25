import { describe, expect, it } from 'vitest'
import { REVIEW_PROFILE, JOB_PROFILE, classifyToolUse, tierNameFromProfile, type TierProfile, type ToolKind } from '../domain/user-tier'
import { authorize } from '../domain/authorize'

/** 改之前这里测的是 permission-relay 的 effectivePolicy;判定收进 domain/authorize.ts 以后(C2)测同一格。 */
const effectivePolicy = (base: { askUser: 'per-tool' | 'never' }, tp: TierProfile, kind: ToolKind): 'allow' | 'relay' | 'deny' => {
  const v = authorize({ surface: 'chat', tier: tp, permissionMode: 'strict', executor: 'claude' }, { name: 'x', kind, askUser: base.askUser }).verdict
  return v === 'ask' ? 'relay' : v
}
import { codexNetworkOpts, tierProfileToCodexSdkOpts } from '../adapters/executors/codex/codex-agent-provider'

// 评审 #460:审查轮的 diff 直接在提示词里(不是读出来的)⇒「读过才断网」的污点规则一开始就没有;
// 被注入的 diff 能在读任何文件之前先 WebFetch,把仓库内容拼进 URL 发出去。审查轮全程不给网。
describe('REVIEW_PROFILE', () => {
  it('is the job profile without network: still guest-tier, can read and reply', () => {
    expect(tierNameFromProfile(REVIEW_PROFILE)).toBe('guest')
    expect(REVIEW_PROFILE.deny.has('network')).toBe(true)
    for (const k of ['reply', 'memory_read', 'fs_read'] as const) expect(REVIEW_PROFILE.allow.has(k), k).toBe(true)
    for (const k of [...REVIEW_PROFILE.allow]) expect(JOB_PROFILE.allow.has(k), k).toBe(true)
  })
  it('a first-call WebFetch / WebSearch in a review turn is denied', () => {
    const base = { askUser: 'never' } as never
    for (const t of ['WebFetch', 'WebSearch']) expect(effectivePolicy(base, REVIEW_PROFILE, classifyToolUse(t, {}))).toBe('deny')
    expect(effectivePolicy(base, JOB_PROFILE, classifyToolUse('WebFetch', {}))).toBe('allow')
  })
  it('codex: a profile that denies network turns off web search and network access in the thread', () => {
    expect(codexNetworkOpts(REVIEW_PROFILE)).toEqual({ webSearchEnabled: false, webSearchMode: 'disabled' })
    expect(tierProfileToCodexSdkOpts(REVIEW_PROFILE, 'strict').sandboxMode).toBe('read-only')   // shell 上不了网靠的是只读沙箱
    expect(codexNetworkOpts(JOB_PROFILE)).toEqual({})
  })
})
