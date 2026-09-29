import { describe, it, expect, vi } from 'vitest'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { MANAGED_NATIVE_CAPABILITIES, MANAGED_API_CAPABILITIES } from '../executor-capabilities'
import type { AgentProvider } from '../../agent-provider'
import { makeRuntimeState } from './state'
import { makeQuotaDomain } from './quota'
import type { ServiceActions, ServiceCtx, ServiceDeps } from './ctx'

const CODEX_QUOTA = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 10:00"
const provider: AgentProvider = { async spawn() { throw new Error('not spawned in this test') } }

/** 最小 ctx:quota 域不碰 store,但 ServiceCtx 要求有;给个 never 就行。 */
function setup(usage?: ServiceDeps['usage']) {
  const registry = createProviderRegistry()
  registry.register('codex', provider, { displayName: 'Codex', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  registry.register('openai', provider, { displayName: 'OpenAI', canResume: () => true, workbench: MANAGED_API_CAPABILITIES })   // background:'disabled'
  registry.register('kimi', provider, { displayName: 'Kimi', canResume: () => true })                                             // 没有 workbench 能力
  const state = makeRuntimeState()
  const ctx: ServiceCtx = { store: {} as never, stateDir: '/nowhere', state, hub: { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }, deps: { ownerChatId: () => 'owner', registry, ...(usage ? { usage } : {}) }, ensureAccepting: () => {}, now: Date.now, actions: new Ref<ServiceActions>('t') }
  return { domain: makeQuotaDomain(ctx), registry }
}

describe('makeQuotaDomain', () => {
  it('不传 usage 也能建;一开始谁都没耗尽、快照为空', () => {
    const { domain } = setup()
    expect(domain.providerQuota()).toEqual({})
    expect(domain.quotaExhausted('codex')).toBeNull()
  })
  it('fallbackExecutor:跳过 exhaustedId、跳过 background≠tracked、跳过没有 workbench 能力的;按登记顺序取第一个', () => {
    const { domain } = setup()
    expect(domain.fallbackExecutor('codex')).toBe('claude')
    expect(domain.fallbackExecutor('claude')).toBe('codex')
    expect(domain.fallbackExecutor('openai')).toBe('codex')
  })
  it('note 认出额度错误 ⇒ quotaExhausted 非空、快照里有它、fallbackExecutor 跳过它;clear 之后恢复(同一个登记处实例)', () => {
    const { domain } = setup()
    expect(domain.quota.note('claude', CODEX_QUOTA)).toBe('quota')
    expect(domain.quotaExhausted('claude')).toMatchObject({ kind: 'quota' })
    expect(Object.keys(domain.providerQuota())).toEqual(['claude'])
    expect(domain.fallbackExecutor('codex')).toBeNull()
    domain.quota.clear('claude')
    expect(domain.quotaExhausted('claude')).toBeNull()
    expect(domain.fallbackExecutor('codex')).toBe('claude')
  })
  it('usage 快照说耗尽 ⇒ 没 note 也算耗尽', () => {
    const { domain } = setup(id => id === 'codex' ? { providerId: 'codex', plan: null, windows: [{ name: '5h', usedPercent: 100, resetsAt: Date.now() + 3600_000 }], exhausted: true, fetchedAt: Date.now() } as never : null)
    expect(domain.quotaExhausted('codex')).toMatchObject({ kind: 'quota' })
    expect(domain.quotaExhausted('claude')).toBeNull()
    expect(domain.fallbackExecutor('claude')).toBeNull()
  })
  it('providerQuota 是快照:改返回值不影响下一次', () => {
    const { domain } = setup()
    domain.quota.note('codex', CODEX_QUOTA)
    const snap = domain.providerQuota(); delete snap['codex']
    expect(Object.keys(domain.providerQuota())).toEqual(['codex'])
  })
})
